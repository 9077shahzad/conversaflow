import { withContext } from '@conversaflow/database';
import { z } from 'zod';
import type { Deps, TenantActor } from '../core/context';
import { Errors } from '../core/errors';
import { parse } from '../core/validate';
import { AuditService } from './audit.service';
import { isUuid } from './members.service';

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM (24-hour)');
const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
const interval = z.tuple([hhmm, hhmm]).refine(([a, b]) => a < b, 'Opening time must be before closing time');

export const SettingsRequest = z
  .object({
    businessHours: z.record(z.enum(DAYS), z.array(interval).max(4)),
    languages: z.array(z.enum(['en', 'ar'])).min(1).max(2),
    slaFirstResponseMinutes: z.number().int().min(1).max(10080).nullable(),
    slaResolutionMinutes: z.number().int().min(1).max(43200).nullable(),
  })
  .partial();
const HolidayRequest = z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), name: z.string().trim().min(1).max(120) });
const BranchRequest = z.object({
  name: z.string().trim().min(1).max(120),
  timezone: z.string().min(3).max(64).optional(),
  address: z.string().trim().max(500).optional(),
});
const TeamRequest = z.object({ name: z.string().trim().min(1).max(120), branchId: z.string().uuid().nullable().optional() });
const TeamMemberRequest = z.object({ membershipId: z.string().uuid() });

/** Company settings (FR-006), branches and teams. All rows are company-scoped and protected by RLS. */
export class SettingsService {
  constructor(private readonly deps: Deps) {}

  async getSettings(actor: TenantActor) {
    return withContext(this.deps.db, actor, async (tx) => {
      const s = await tx.query(
        `SELECT business_hours AS "businessHours", languages, sla_first_response_minutes AS "slaFirstResponseMinutes",
                sla_resolution_minutes AS "slaResolutionMinutes" FROM tenant_settings`);
      const h = await tx.query('SELECT id, day::text, name FROM tenant_holidays ORDER BY day');
      return { ...(s.rows[0] ?? {}), holidays: h.rows };
    });
  }

  async updateSettings(actor: TenantActor, input: unknown) {
    const body = parse(SettingsRequest, input);
    await withContext(this.deps.db, actor, async (tx) => {
      await tx.query(
        `INSERT INTO tenant_settings (tenant_id) VALUES ($1) ON CONFLICT DO NOTHING`, [actor.tenantId]);
      await tx.query(
        `UPDATE tenant_settings SET
           business_hours = coalesce($1::jsonb, business_hours),
           languages = coalesce($2::text[], languages),
           sla_first_response_minutes = CASE WHEN $3::boolean THEN $4::int ELSE sla_first_response_minutes END,
           sla_resolution_minutes = CASE WHEN $5::boolean THEN $6::int ELSE sla_resolution_minutes END,
           updated_at = now()`,
        [
          body.businessHours === undefined ? null : JSON.stringify(body.businessHours),
          body.languages ?? null,
          body.slaFirstResponseMinutes !== undefined, body.slaFirstResponseMinutes ?? null,
          body.slaResolutionMinutes !== undefined, body.slaResolutionMinutes ?? null,
        ]);
      await AuditService.record(tx, {
        tenantId: actor.tenantId, actorUserId: actor.userId, action: 'settings.updated', ip: actor.ip,
        metadata: { fields: Object.keys(body) },
      });
    });
    return this.getSettings(actor);
  }

  async addHoliday(actor: TenantActor, input: unknown) {
    const body = parse(HolidayRequest, input);
    return withContext(this.deps.db, actor, async (tx) => {
      try {
        const { rows } = await tx.query('INSERT INTO tenant_holidays (tenant_id, day, name) VALUES ($1, $2, $3) RETURNING id, day::text, name',
          [actor.tenantId, body.day, body.name]);
        return rows[0];
      } catch (err) {
        if ((err as { code?: string }).code === '23505') throw Errors.conflict('holiday_exists', 'That day is already a holiday.');
        throw err;
      }
    });
  }

  async removeHoliday(actor: TenantActor, id: string) {
    if (!isUuid(id)) throw Errors.notFound('Holiday');
    const n = await withContext(this.deps.db, actor, async (tx) => (await tx.query('DELETE FROM tenant_holidays WHERE id = $1', [id])).rowCount);
    if (!n) throw Errors.notFound('Holiday');
  }

  async listBranches(actor: TenantActor) {
    return withContext(this.deps.db, actor, async (tx) =>
      (await tx.query('SELECT id, name, timezone, address FROM branches ORDER BY name')).rows);
  }

  async createBranch(actor: TenantActor, input: unknown) {
    const body = parse(BranchRequest, input);
    return withContext(this.deps.db, actor, async (tx) => {
      try {
        const { rows } = await tx.query(
          'INSERT INTO branches (tenant_id, name, timezone, address) VALUES ($1, $2, $3, $4) RETURNING id, name, timezone, address',
          [actor.tenantId, body.name, body.timezone ?? null, body.address ?? null]);
        await AuditService.record(tx, { tenantId: actor.tenantId, actorUserId: actor.userId, action: 'branch.created', targetType: 'branch', targetId: rows[0].id, ip: actor.ip });
        return rows[0];
      } catch (err) {
        if ((err as { code?: string }).code === '23505') throw Errors.conflict('branch_exists', 'A branch with that name exists.');
        throw err;
      }
    });
  }

  async listTeams(actor: TenantActor) {
    return withContext(this.deps.db, actor, async (tx) => (await tx.query(
      `SELECT t.id, t.name, t.branch_id AS "branchId",
              coalesce(array_agg(tm.membership_id) FILTER (WHERE tm.membership_id IS NOT NULL), '{}') AS "memberIds"
       FROM teams t LEFT JOIN team_members tm ON tm.team_id = t.id GROUP BY t.id ORDER BY t.name`)).rows);
  }

  async createTeam(actor: TenantActor, input: unknown) {
    const body = parse(TeamRequest, input);
    return withContext(this.deps.db, actor, async (tx) => {
      try {
        const { rows } = await tx.query('INSERT INTO teams (tenant_id, name, branch_id) VALUES ($1, $2, $3) RETURNING id, name, branch_id AS "branchId"',
          [actor.tenantId, body.name, body.branchId ?? null]);
        await AuditService.record(tx, { tenantId: actor.tenantId, actorUserId: actor.userId, action: 'team.created', targetType: 'team', targetId: rows[0].id, ip: actor.ip });
        return rows[0];
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === '23505') throw Errors.conflict('team_exists', 'A team with that name exists.');
        if (code === '23503') throw Errors.notFound('Branch'); // includes a branch of another company
        throw err;
      }
    });
  }

  async addTeamMember(actor: TenantActor, teamId: string, input: unknown) {
    const { membershipId } = parse(TeamMemberRequest, input);
    if (!isUuid(teamId)) throw Errors.notFound('Team');
    await withContext(this.deps.db, actor, async (tx) => {
      try {
        await tx.query('INSERT INTO team_members (tenant_id, team_id, membership_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
          [actor.tenantId, teamId, membershipId]);
      } catch (err) {
        // Composite foreign keys refuse a team or member of another company: reported as not found.
        if ((err as { code?: string }).code === '23503') throw Errors.notFound('Team or member');
        throw err;
      }
      await AuditService.record(tx, { tenantId: actor.tenantId, actorUserId: actor.userId, action: 'team.member_added', targetType: 'team', targetId: teamId, ip: actor.ip, metadata: { membershipId } });
    });
  }

  async features(actor: TenantActor) {
    return withContext(this.deps.db, actor, async (tx) => (await tx.query(
      `SELECT f.key, coalesce(t.enabled, f.default_on) AS enabled FROM feature_flags f
       LEFT JOIN tenant_feature_flags t ON t.key = f.key ORDER BY f.key`)).rows);
  }

  /** Transparency: the company can see every support access grant that concerns it. */
  async supportGrants(actor: TenantActor) {
    return withContext(this.deps.db, actor, async (tx) => (await tx.query(
      `SELECT id, reason, requested_at AS "requestedAt", approved_at AS "approvedAt", expires_at AS "expiresAt", revoked_at AS "revokedAt"
       FROM support_access_grants ORDER BY requested_at DESC`)).rows);
  }
}
