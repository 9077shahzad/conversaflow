import { withContext, type Db } from '@conversaflow/database';
import { z } from 'zod';
import type { AuthSession } from '../core/context';
import { AppError, Errors } from '../core/errors';
import { parse } from '../core/validate';
import { isUuid } from './members.service';

export type StaffRole = 'platform_owner' | 'support_agent';
export interface StaffActor {
  userId: string;
  role: StaffRole;
}

const SupportRequest = z.object({
  tenantId: z.string().uuid(),
  reason: z.string().trim().min(20, 'Give a specific reason (at least 20 characters)').max(1000),
  minutes: z.number().int().min(5).max(240),
});
const FlagRequest = z.object({ enabled: z.boolean() });

/**
 * Platform owner console. Uses its own database role (cf_platform):
 *  - company directory and plans: metadata only;
 *  - company content: only with an approved, unexpired support grant (two people, max 4 hours),
 *    enforced by row-level security; every read is written to that company's audit trail.
 */
export class PlatformService {
  constructor(private readonly db: Db) {}

  async staffRole(userId: string): Promise<StaffRole | null> {
    const { rows } = await this.db.query<{ role: StaffRole | null }>('SELECT platform_staff_role($1) AS role', [userId]);
    return rows[0]?.role ?? null;
  }

  /** Staff must exist, and must have completed two-step verification in this session. */
  async requireStaff(session: AuthSession, need?: StaffRole): Promise<StaffActor> {
    const role = await this.staffRole(session.userId);
    if (!role) throw Errors.forbidden('Platform access only.');
    if (!(session.userHasMfa && session.mfaVerified)) throw Errors.mfaEnrollmentRequired();
    if (need && role !== need) throw Errors.forbidden('A platform owner must do this.');
    return { userId: session.userId, role };
  }

  private run<T>(staff: StaffActor, tenantId: string | null, fn: Parameters<typeof withContext<T>>[2]) {
    return withContext(this.db, { tenantId, userId: staff.userId }, fn).catch((err: { code?: string; message?: string }) => {
      if (err.code === '42501') throw Errors.forbidden(err.message);
      if (err.code === '23514') throw new AppError(409, 'not_allowed', String(err.message));
      throw err;
    });
  }

  directory(staff: StaffActor) {
    return this.run(staff, null, async (tx) => (await tx.query(
      `SELECT tenant_id AS "tenantId", slug, legal_name AS "legalName", country, status, data_region AS "dataRegion",
              plan_code AS plan, plan_version AS "planVersion", subscription_status AS "subscriptionStatus",
              trial_ends_at AS "trialEndsAt", active_members AS "activeMembers", files_count AS "filesCount", created_at AS "createdAt"
       FROM platform_tenant_directory()`)).rows);
  }

  plans(staff: StaffActor) {
    return this.run(staff, null, async (tx) => (await tx.query(
      `SELECT v.id, p.code, v.version, v.currency, v.price_monthly_cents AS "monthlyCents", v.price_annual_cents AS "annualCents",
              v.published_at AS "publishedAt", v.note
       FROM plan_versions v JOIN plans p ON p.id = v.plan_id ORDER BY p.code, v.version`)).rows);
  }

  async publishPlanVersion(staff: StaffActor, versionId: string) {
    if (!isUuid(versionId)) throw Errors.notFound('Plan version');
    await this.run(staff, null, (tx) => tx.query('SELECT platform_publish_plan_version($1)', [versionId]));
  }

  async setFeatureFlag(staff: StaffActor, tenantId: string, key: string, input: unknown) {
    const { enabled } = parse(FlagRequest, input);
    if (!isUuid(tenantId) || !/^[a-z][a-z0-9_]{1,60}$/.test(key)) throw Errors.notFound('Company or flag');
    await this.run(staff, null, (tx) => tx.query('SELECT platform_set_feature_flag($1, $2, $3)', [tenantId, key, enabled]));
  }

  async requestSupport(staff: StaffActor, input: unknown) {
    const body = parse(SupportRequest, input);
    const id = await this.run(staff, null, async (tx) =>
      (await tx.query<{ id: string }>('SELECT platform_request_support($1, $2, $3) AS id', [body.tenantId, body.reason, body.minutes])).rows[0]!.id);
    return { grantId: id, status: 'awaiting_approval' };
  }

  async approveSupport(staff: StaffActor, grantId: string) {
    if (!isUuid(grantId)) throw Errors.notFound('Grant');
    const expiresAt = await this.run(staff, null, async (tx) =>
      (await tx.query<{ e: Date }>('SELECT platform_approve_support($1) AS e', [grantId])).rows[0]!.e);
    return { grantId, expiresAt };
  }

  async revokeSupport(staff: StaffActor, grantId: string) {
    if (!isUuid(grantId)) throw Errors.notFound('Grant');
    await this.run(staff, null, (tx) => tx.query('SELECT platform_revoke_support($1)', [grantId]));
  }

  /** Support read of a company's files and members. Refused by the database without an active grant. */
  async supportView(staff: StaffActor, tenantId: string, what: 'files' | 'members') {
    if (!isUuid(tenantId)) throw Errors.notFound('Company');
    return this.run(staff, tenantId, async (tx) => {
      const active = (await tx.query<{ ok: boolean }>('SELECT support_grant_active($1, $2) AS ok', [tenantId, staff.userId])).rows[0]!.ok;
      if (!active) throw Errors.forbidden('No active, approved support access for this company.');
      // Recorded in the company's own audit trail before any data is returned.
      await tx.query(
        `INSERT INTO audit_events (tenant_id, actor_user_id, action, target_type, metadata, hash)
         VALUES ($1, $2, 'support.viewed', $3, '{}'::jsonb, ''::bytea)`, [tenantId, staff.userId, what]);
      const sql = what === 'files'
        ? `SELECT id, original_name AS name, content_type AS "contentType", size_bytes AS "sizeBytes", status, created_at AS "createdAt" FROM files ORDER BY created_at DESC`
        : `SELECT m.id, u.full_name AS "fullName", u.email, m.status FROM memberships m JOIN users u ON u.id = m.user_id ORDER BY u.full_name`;
      return (await tx.query(sql)).rows;
    });
  }
}
