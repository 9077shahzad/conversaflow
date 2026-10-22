import { withContext, type Tx } from '@conversaflow/database';
import { z } from 'zod';
import type { Deps, TenantActor } from '../core/context';
import { Errors } from '../core/errors';
import { parse } from '../core/validate';
import { AuditService } from './audit.service';
import { companyHours, isWithinBusinessHours } from './sla';

/**
 * Automatic assignment of new conversations (BRD v1.2 Wave 1, CF-EXT-002, migration 0039).
 *
 * Runs in the same transaction that creates a new conversation from a customer's first message. It never reassigns a
 * conversation someone already has, and only picks members on the company's assignment list who are active and whose
 * role can reply. Concurrent first messages are handled one at a time per company (a lock), so round robin hands out
 * conversations strictly in turn and "least busy" counts are never read stale by two transactions at once.
 */
export type AssignmentMode = 'off' | 'round_robin' | 'least_busy';

const SettingsInput = z.object({
  mode: z.enum(['off', 'round_robin', 'least_busy']),
  hoursOnly: z.boolean().default(false),
  memberIds: z.array(z.string().uuid()).max(500).default([]),
});

/** Members who can receive conversations right now: on the list, active, and allowed to reply. Stable order. */
async function eligible(tx: Tx): Promise<Array<{ id: string; open: number }>> {
  return (await tx.query<{ id: string; open: number }>(
    `SELECT m.id,
            (SELECT count(*)::int FROM conversations c WHERE c.assigned_membership_id = m.id AND c.status IN ('open', 'pending')) AS open
     FROM assignment_members a JOIN memberships m ON m.id = a.membership_id
     WHERE m.status = 'active'
       AND EXISTS (SELECT 1 FROM membership_roles mr JOIN role_permissions rp ON rp.role_id = mr.role_id AND rp.permission_key = 'inbox.reply'
                   WHERE mr.membership_id = m.id)
     ORDER BY m.created_at, m.id`)).rows;
}

/**
 * Takes the company's assignment lock up front, before any per-customer lock, when automatic assignment is on. A
 * webhook delivery can carry messages from several customers in one transaction; taking this lock first keeps the
 * lock order the same in every transaction (assignment, then customers), so two deliveries cannot deadlock.
 */
export async function lockAssignmentIfOn(tx: Tx, tenantId: string): Promise<boolean> {
  const mode = (await tx.query<{ mode: AssignmentMode }>('SELECT assignment_mode AS mode FROM tenant_settings')).rows[0]?.mode;
  if (!mode || mode === 'off') return false;
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${tenantId}:auto-assign`]);
  return true;
}

/**
 * Gives an unassigned conversation to the next member, if automatic assignment is on. Called for a customer's first
 * message in a conversation (a new one, or one a campaign started).
 * Returns the chosen membership id, or null when nothing was assigned (off, outside hours, nobody eligible).
 */
export async function autoAssignNewConversation(tx: Tx, tenantId: string, conversationId: string, at: Date): Promise<string | null> {
  const mode = (await tx.query<{ mode: AssignmentMode }>('SELECT assignment_mode AS mode FROM tenant_settings')).rows[0]?.mode;
  if (!mode || mode === 'off') return null;
  // The lock comes before reading the turn order, so simultaneous first messages each see the previous one's choice.
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${tenantId}:auto-assign`]);
  const s = (await tx.query<{ mode: AssignmentMode; hours_only: boolean; last: string | null }>(
    `SELECT assignment_mode AS mode, assignment_hours_only AS hours_only, assignment_last_membership AS last FROM tenant_settings`)).rows[0];
  if (!s || s.mode === 'off') return null;
  if (s.hours_only) {
    const h = await companyHours(tx);
    if (!isWithinBusinessHours(at, h.hours, h.tz, h.holidays)) return null;
  }
  const people = await eligible(tx);
  if (people.length === 0) return null;
  // Round robin: the next member after the last one assigned (wrapping round). Least busy: fewest open conversations,
  // ties broken in the same turn order, so equally busy members also take turns.
  const start = s.last ? people.findIndex((p) => p.id === s.last) + 1 : 0;
  const turn = [...people.slice(start), ...people.slice(0, start)];
  const chosen = s.mode === 'round_robin' ? turn[0]! : turn.reduce((best, p) => (p.open < best.open ? p : best), turn[0]!);
  const updated = await tx.query(
    `UPDATE conversations SET assigned_membership_id = $2, version = version + 1, activity_seq = activity_seq + 1
     WHERE id = $1 AND assigned_membership_id IS NULL`, [conversationId, chosen.id]);
  if (!updated.rowCount) return null;
  await tx.query('UPDATE tenant_settings SET assignment_last_membership = $1', [chosen.id]);
  await tx.query(`INSERT INTO conversation_events (tenant_id, conversation_id, kind, actor_membership_id, data) VALUES ($1, $2, 'auto_assigned', NULL, $3)`,
    [tenantId, conversationId, JSON.stringify({ membershipId: chosen.id, mode: s.mode })]);
  return chosen.id;
}

export class AssignmentService {
  constructor(private readonly deps: Deps) {}

  get(actor: TenantActor) {
    return withContext(this.deps.db, actor, async (tx) => {
      const s = (await tx.query<{ mode: AssignmentMode; hours_only: boolean }>(
        'SELECT assignment_mode AS mode, assignment_hours_only AS hours_only FROM tenant_settings')).rows[0];
      const members = (await tx.query(
        `SELECT m.id, coalesce(u.full_name, u.email) AS name, m.status,
                EXISTS (SELECT 1 FROM assignment_members a WHERE a.membership_id = m.id) AS "onList",
                EXISTS (SELECT 1 FROM membership_roles mr JOIN role_permissions rp ON rp.role_id = mr.role_id AND rp.permission_key = 'inbox.reply'
                        WHERE mr.membership_id = m.id) AS "canReply"
         FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.status = 'active' ORDER BY m.created_at, m.id`)).rows;
      const h = await companyHours(tx);
      const hasBusinessHours = Object.values(h.hours).some((list) => (list ?? []).length > 0);
      return { mode: s?.mode ?? 'off', hoursOnly: s?.hours_only ?? false, hasBusinessHours, members };
    });
  }

  async update(actor: TenantActor, input: unknown) {
    const body = parse(SettingsInput, input);
    return withContext(this.deps.db, actor, async (tx) => {
      const ids = [...new Set(body.memberIds)];
      if (ids.length) {
        const ok = (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM memberships WHERE id = ANY($1) AND status = 'active'`, [ids])).rows[0]!.n;
        if (ok !== ids.length) throw Errors.badRequest('Choose active members of this company.');
      }
      if (body.mode !== 'off' && ids.length === 0) throw Errors.badRequest('Choose at least one member to receive conversations, or turn automatic assignment off.');
      await tx.query(`INSERT INTO tenant_settings (tenant_id) VALUES ($1) ON CONFLICT (tenant_id) DO NOTHING`, [actor.tenantId]);
      const before = (await tx.query<{ mode: string; hours_only: boolean }>('SELECT assignment_mode AS mode, assignment_hours_only AS hours_only FROM tenant_settings')).rows[0]!;
      await tx.query('UPDATE tenant_settings SET assignment_mode = $1, assignment_hours_only = $2', [body.mode, body.hoursOnly]);
      await tx.query('DELETE FROM assignment_members WHERE NOT (membership_id = ANY($1))', [ids]);
      for (const id of ids) {
        await tx.query('INSERT INTO assignment_members (tenant_id, membership_id, added_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [actor.tenantId, id, actor.membershipId]);
      }
      await AuditService.record(tx, { tenantId: actor.tenantId, actorUserId: actor.userId, action: 'assignment.updated', ip: actor.ip,
        targetType: 'tenant', targetId: actor.tenantId, metadata: { from: before, mode: body.mode, hoursOnly: body.hoursOnly, members: ids.length } });
    }).then(() => this.get(actor));
  }
}
