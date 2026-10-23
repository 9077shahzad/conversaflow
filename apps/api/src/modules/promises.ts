import { withContext, type Db, type Tx } from '@conversaflow/database';
import { z } from 'zod';
import type { TenantActor } from '../core/context';
import { AppError, Errors } from '../core/errors';
import { parse } from '../core/validate';
import { AuditService } from './audit.service';
import { isUuid } from './members.service';
import { companyHours } from './sla';
import { detectPromise } from './promise-detect';

export { detectPromise } from './promise-detect';

/**
 * Customer promise tracking, first version (BRD v1.2 Wave 2, W2.6, CF-EXT-018; migration 0053).
 *
 * - A person records a promise from a conversation (what, by when, who is responsible), or confirms one a rule
 *   suggested. Rules only suggest; a company can approve automatic confirmation of what they detect.
 * - The detection rule reads the team's own outbound replies (never the customer's messages) for a commitment
 *   ("I will", "we'll", "سوف", "سأ", "سن") together with a time ("today", "tomorrow", "within 2 hours", "بكرة",
 *   "خلال ساعتين", a weekday). It proposes a deadline in the company's time zone; the person can change it.
 * - The worker warns the owner an hour before the deadline and marks the promise missed when it passes; a missed
 *   promise can still be kept late or marked recovered with a note. Everything is in the conversation's history.
 * - AI suggestions come later; this version uses only the rule below, which can be explained word for word.
 */
const DAY = 24 * 3600_000;
const CreateInput = z.object({
  description: z.string().trim().min(3).max(300),
  dueAt: z.string().datetime({ offset: true }),
  ownerMembershipId: z.string().uuid().optional(),
}).strict();
const ConfirmInput = z.object({
  description: z.string().trim().min(3).max(300).optional(),
  dueAt: z.string().datetime({ offset: true }).optional(),
  ownerMembershipId: z.string().uuid().optional(),
  expectedVersion: z.number().int().min(0),
}).strict();
const CloseInput = z.object({ outcome: z.enum(['kept', 'recovered', 'dismissed', 'cancelled']), note: z.string().trim().max(500).optional(), expectedVersion: z.number().int().min(0) }).strict();
const ListQuery = z.object({ scope: z.enum(['mine', 'all']).default('mine'), status: z.enum(['open', 'missed', 'closed']).default('open') }).strict();

const COLS = `p.id, p.conversation_id AS "conversationId", p.description, p.owner_membership_id AS "ownerMembershipId", p.due_at AS "dueAt",
  p.source, p.status, p.matched_text AS "matchedText", p.created_at AS "createdAt", p.confirmed_at AS "confirmedAt", p.warned_at AS "warnedAt",
  p.missed_at AS "missedAt", p.closed_at AS "closedAt", p.note, p.version`;

/**
 * Called in the transaction that queues a team member's reply: a commitment with a time becomes a suggested promise
 * (or a confirmed one, owned by the writer, when the company approved automatic confirmation).
 */
export async function suggestFromReply(tx: Tx, a: { tenantId: string; userId: string | null; membershipId: string | null; conversationId: string; messageId: string; text: string }) {
  if (!a.text || a.text.length > 4096) return;
  const { tz } = await companyHours(tx);
  const auto0 = (await tx.query<{ auto: boolean }>('SELECT promises_auto_confirm AS auto FROM tenant_settings')).rows[0]?.auto ?? false;
  // The company's current UTC offset in minutes (daylight saving included), from the database's time zone data.
  const offset = Number((await tx.query<{ m: number }>(`SELECT round(extract(epoch FROM (now() AT TIME ZONE $1) - (now() AT TIME ZONE 'UTC')) / 60)::int AS m`, [tz])).rows[0]!.m);
  const s = { auto: auto0 };
  const found = detectPromise(a.text, new Date(), offset);
  if (!found) return;
  const c = (await tx.query<{ contact_id: string }>('SELECT contact_id FROM conversations WHERE id = $1', [a.conversationId])).rows[0];
  if (!c) return;
  const auto = !!s?.auto && !!a.membershipId;
  const row = (await tx.query<{ id: string }>(
    `INSERT INTO promises (tenant_id, conversation_id, contact_id, description, owner_membership_id, due_at, source, source_message_id, status, matched_text, created_by, confirmed_at, confirmed_by)
     VALUES ($1, $2, $3, $4, $5, $6, 'rule', $7, $8, $9, $10, CASE WHEN $8 = 'confirmed' THEN now() END, CASE WHEN $8 = 'confirmed' THEN $10::uuid END)
     ON CONFLICT (tenant_id, source_message_id) DO NOTHING RETURNING id`,
    [a.tenantId, a.conversationId, c.contact_id, a.text.trim().slice(0, 300).padEnd(3, '.'), a.membershipId, found.dueAt, a.messageId,
      auto ? 'confirmed' : 'suggested', found.matched, a.userId])).rows[0];
  if (!row) return;
  await tx.query(`INSERT INTO conversation_events (tenant_id, conversation_id, kind, actor_membership_id, data) VALUES ($1, $2, $3, $4, $5)`,
    [a.tenantId, a.conversationId, auto ? 'promise_confirmed' : 'promise_suggested', auto ? a.membershipId : null, JSON.stringify({ promiseId: row.id, dueAt: found.dueAt, rule: true })]);
}

// --- People -------------------------------------------------------------------------------------------------------

export class PromisesService {
  constructor(private readonly deps: { db: Db }) {}

  private async visible(tx: Tx, actor: TenantActor, conversationId: string) {
    if (!isUuid(conversationId)) throw Errors.notFound('Conversation');
    const c = (await tx.query<{ id: string; contact_id: string; assigned: string | null }>(
      `SELECT id, contact_id, assigned_membership_id AS assigned FROM conversations c WHERE c.id = $1
       AND ($2::boolean OR c.assigned_membership_id IS NULL OR c.assigned_membership_id = $3::uuid)`,
      [conversationId, actor.permissions.has('inbox.read_all'), actor.membershipId])).rows[0];
    if (!c) throw Errors.notFound('Conversation');
    return c;
  }

  private async member(tx: Tx, id: string | undefined, fallback: string) {
    const m = id ?? fallback;
    const ok = (await tx.query(`SELECT 1 FROM memberships m WHERE m.id = $1 AND m.status = 'active'
      AND EXISTS (SELECT 1 FROM membership_roles mr JOIN role_permissions rp ON rp.role_id = mr.role_id WHERE mr.membership_id = m.id AND rp.permission_key = 'inbox.reply')`, [m])).rowCount;
    if (!ok) throw Errors.badRequest('Choose an active team member who can reply to customers.');
    return m;
  }

  forConversation(actor: TenantActor, conversationId: string) {
    return withContext(this.deps.db, actor, async (tx) => {
      const c = await this.visible(tx, actor, conversationId);
      return (await tx.query(`SELECT ${COLS} FROM promises p WHERE p.conversation_id = $1 ORDER BY p.due_at`, [c.id])).rows;
    });
  }

  list(actor: TenantActor, query: unknown) {
    const q = parse(ListQuery, query ?? {});
    return withContext(this.deps.db, actor, async (tx) => {
      const statuses = q.status === 'open' ? ['suggested', 'confirmed'] : q.status === 'missed' ? ['missed'] : ['kept', 'recovered', 'dismissed', 'cancelled'];
      const all = q.scope === 'all' && actor.permissions.has('inbox.read_all');
      return (await tx.query(
        `SELECT ${COLS} FROM promises p JOIN conversations c ON c.id = p.conversation_id
         WHERE p.status = ANY($1::text[])
           AND ($2::boolean OR p.owner_membership_id = $3::uuid OR (p.status = 'suggested' AND (c.assigned_membership_id = $3::uuid OR c.assigned_membership_id IS NULL)))
         ORDER BY p.due_at LIMIT 200`, [statuses, all, actor.membershipId])).rows;
    });
  }

  async create(actor: TenantActor, conversationId: string, input: unknown) {
    const body = parse(CreateInput, input);
    const due = new Date(body.dueAt);
    if (due.getTime() <= Date.now()) throw Errors.badRequest('Choose a deadline in the future.');
    if (due.getTime() > Date.now() + 365 * DAY) throw Errors.badRequest('Choose a deadline within a year.');
    return withContext(this.deps.db, actor, async (tx) => {
      const c = await this.visible(tx, actor, conversationId);
      const owner = await this.member(tx, body.ownerMembershipId, actor.membershipId);
      const row = (await tx.query<{ id: string }>(
        `INSERT INTO promises (tenant_id, conversation_id, contact_id, description, owner_membership_id, due_at, source, status, created_by, confirmed_at, confirmed_by)
         VALUES ($1, $2, $3, $4, $5, $6, 'manual', 'confirmed', $7, now(), $7) RETURNING id`,
        [actor.tenantId, c.id, c.contact_id, body.description, owner, due, actor.userId])).rows[0]!;
      await this.event(tx, actor, c.id, 'promise_confirmed', { promiseId: row.id, dueAt: due, owner });
      await AuditService.record(tx, { tenantId: actor.tenantId, actorUserId: actor.userId, action: 'promise.created', ip: actor.ip, targetType: 'promise', targetId: row.id, metadata: { dueAt: due } });
      return { id: row.id };
    });
  }

  async confirm(actor: TenantActor, id: string, input: unknown) {
    const body = parse(ConfirmInput, input);
    return this.change(actor, id, body.expectedVersion, async (tx, p) => {
      if (p.status !== 'suggested' && p.status !== 'confirmed') throw Errors.conflict('promise_closed', 'This promise is no longer open.');
      const due = body.dueAt ? new Date(body.dueAt) : p.due_at;
      if (due.getTime() <= Date.now() && p.status === 'suggested') throw Errors.badRequest('Choose a deadline in the future.');
      const owner = await this.member(tx, body.ownerMembershipId, p.owner_membership_id ?? actor.membershipId);
      await tx.query(`UPDATE promises SET status = 'confirmed', description = coalesce($2, description), due_at = $3, owner_membership_id = $4,
                        confirmed_at = coalesce(confirmed_at, now()), confirmed_by = coalesce(confirmed_by, $5),
                        warned_at = CASE WHEN due_at IS DISTINCT FROM $3 THEN NULL ELSE warned_at END, version = version + 1 WHERE id = $1`,
        [p.id, body.description ?? null, due, owner, actor.userId]);
      await this.event(tx, actor, p.conversation_id, 'promise_confirmed', { promiseId: p.id, dueAt: due, owner, changed: p.status === 'confirmed' });
      return 'promise.confirmed';
    });
  }

  async close(actor: TenantActor, id: string, input: unknown) {
    const body = parse(CloseInput, input);
    return this.change(actor, id, body.expectedVersion, async (tx, p) => {
      const allowed: Record<string, string[]> = { suggested: ['dismissed'], confirmed: ['kept', 'cancelled'], missed: ['kept', 'recovered'] };
      if (!(allowed[p.status] ?? []).includes(body.outcome)) throw Errors.conflict('promise_state', `A ${p.status} promise cannot be marked ${body.outcome}.`);
      if (body.outcome === 'recovered' && !body.note) throw Errors.badRequest('Say how the miss was put right.');
      await tx.query(`UPDATE promises SET status = $2, note = coalesce($3, note), closed_at = now(), closed_by = $4, version = version + 1 WHERE id = $1`,
        [p.id, body.outcome, body.note ?? null, actor.userId]);
      await this.event(tx, actor, p.conversation_id, `promise_${body.outcome}`, { promiseId: p.id });
      return `promise.${body.outcome}`;
    });
  }

  private async change(actor: TenantActor, id: string, expectedVersion: number,
    fn: (tx: Tx, p: { id: string; status: string; conversation_id: string; due_at: Date; owner_membership_id: string | null; version: number }) => Promise<string>) {
    if (!isUuid(id)) throw Errors.notFound('Promise');
    return withContext(this.deps.db, actor, async (tx) => {
      const p = (await tx.query<{ id: string; status: string; conversation_id: string; due_at: Date; owner_membership_id: string | null; version: number }>(
        'SELECT id, status, conversation_id, due_at, owner_membership_id, version FROM promises WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!p) throw Errors.notFound('Promise');
      await this.visible(tx, actor, p.conversation_id);
      if (p.version !== expectedVersion) throw new AppError(409, 'promise_changed', 'Someone else changed this promise. Reload and try again.');
      const action = await fn(tx, p);
      await AuditService.record(tx, { tenantId: actor.tenantId, actorUserId: actor.userId, action, ip: actor.ip, targetType: 'promise', targetId: p.id, metadata: {} });
      return { id: p.id, version: p.version + 1 };
    });
  }

  private async event(tx: Tx, actor: TenantActor, conversationId: string, kind: string, data: Record<string, unknown>) {
    await tx.query(`INSERT INTO conversation_events (tenant_id, conversation_id, kind, actor_membership_id, data) VALUES ($1, $2, $3, $4, $5)`,
      [actor.tenantId, conversationId, kind, actor.membershipId, JSON.stringify(data)]);
  }

  async settings(actor: TenantActor) {
    return withContext(this.deps.db, actor, async (tx) => ({
      autoConfirm: (await tx.query<{ a: boolean }>('SELECT promises_auto_confirm AS a FROM tenant_settings')).rows[0]?.a ?? false }));
  }

  async saveSettings(actor: TenantActor, input: unknown) {
    const body = parse(z.object({ autoConfirm: z.boolean() }).strict(), input);
    return withContext(this.deps.db, actor, async (tx) => {
      const r = await tx.query('UPDATE tenant_settings SET promises_auto_confirm = $1', [body.autoConfirm]);
      if (!r.rowCount) await tx.query('INSERT INTO tenant_settings (tenant_id, promises_auto_confirm) VALUES ($1, $2)', [actor.tenantId, body.autoConfirm]);
      await AuditService.record(tx, { tenantId: actor.tenantId, actorUserId: actor.userId, action: 'promise.settings_changed', ip: actor.ip, targetType: 'tenant', targetId: actor.tenantId, metadata: body });
      return body;
    });
  }
}

// --- Worker -------------------------------------------------------------------------------------------------------

/** Warns owners an hour before a deadline and marks promises missed when it passes. */
export class PromiseWatcher {
  constructor(private readonly db: Db) {}

  async dispatchDue(limit = 200): Promise<number> {
    const due = await withContext(this.db, { tenantId: null, userId: null }, async (tx) =>
      (await tx.query<{ promise_id: string; tenant_id: string }>('SELECT * FROM promises_due($1)', [limit])).rows);
    let n = 0;
    for (const d of due) {
      n += await withContext(this.db, { tenantId: d.tenant_id, userId: null }, async (tx) => {
        const p = (await tx.query<{ id: string; conversation_id: string; owner: string | null; due_at: Date; warned_at: Date | null; status: string }>(
          `SELECT id, conversation_id, owner_membership_id AS owner, due_at, warned_at, status FROM promises WHERE id = $1 FOR UPDATE SKIP LOCKED`, [d.promise_id])).rows[0];
        if (!p || p.status !== 'confirmed') return 0;
        const missed = p.due_at.getTime() <= Date.now();
        if (missed) {
          await tx.query(`UPDATE promises SET status = 'missed', missed_at = now(), version = version + 1 WHERE id = $1`, [p.id]);
        } else if (!p.warned_at) {
          await tx.query('UPDATE promises SET warned_at = now() WHERE id = $1', [p.id]);
        } else return 0;
        await tx.query(`INSERT INTO conversation_events (tenant_id, conversation_id, kind, data) VALUES ($1, $2, $3, $4)`,
          [d.tenant_id, p.conversation_id, missed ? 'promise_missed' : 'promise_due_soon', JSON.stringify({ promiseId: p.id, dueAt: p.due_at })]);
        // The owner's devices are told (W2.5), without the promise's wording.
        if (p.owner) {
          await tx.query(`INSERT INTO push_jobs (tenant_id, subscription_id, kind, conversation_id)
                          SELECT $1, s.id, $3, $2 FROM push_subscriptions s WHERE s.membership_id = $4
                          ON CONFLICT DO NOTHING`,
            [d.tenant_id, p.conversation_id, missed ? 'promise_missed' : 'promise_due_soon', p.owner]);
        }
        return 1;
      });
    }
    return n;
  }
}
