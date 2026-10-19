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
  /** Session token, passed to every platform database function as proof of identity. */
  token: string;
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

  /**
   * Staff identity is proven to the DATABASE by the session token: every platform function re-derives the caller
   * from a live, MFA-verified session. The API cannot vouch for a user id on its own.
   */
  async requireStaff(session: AuthSession, need?: StaffRole): Promise<StaffActor> {
    const { rows } = await this.db.query<{ user_id: string | null; role: StaffRole | null }>(
      'SELECT user_id, role FROM platform_session_staff($1)', [session.token]);
    const row = rows[0];
    if (!row?.user_id || !row.role) {
      if (!(session.userHasMfa && session.mfaVerified)) throw Errors.mfaEnrollmentRequired();
      throw Errors.forbidden('Platform access only.');
    }
    if (need && row.role !== need) throw Errors.forbidden('A platform owner must do this.');
    return { userId: row.user_id, role: row.role, token: session.token };
  }

  private run<T>(staff: StaffActor, fn: Parameters<typeof withContext<T>>[2]) {
    return withContext(this.db, { tenantId: null, userId: null }, fn).catch((err: { code?: string; message?: string }) => {
      if (err.code === '42501') throw Errors.forbidden(err.message);
      if (err.code === '23514') throw new AppError(409, 'not_allowed', String(err.message));
      throw err;
    });
  }

  directory(staff: StaffActor) {
    return this.run(staff, async (tx) => (await tx.query(
      `SELECT tenant_id AS "tenantId", slug, legal_name AS "legalName", country, status, data_region AS "dataRegion",
              plan_code AS plan, plan_version AS "planVersion", subscription_status AS "subscriptionStatus",
              trial_ends_at AS "trialEndsAt", active_members AS "activeMembers", files_count AS "filesCount", created_at AS "createdAt"
       FROM platform_tenant_directory($1)`, [staff.token])).rows);
  }

  plans(staff: StaffActor) {
    return this.run(staff, async (tx) => (await tx.query(
      `SELECT v.id, p.code, v.version, v.currency, v.price_monthly_cents AS "monthlyCents", v.price_annual_cents AS "annualCents",
              v.published_at AS "publishedAt", v.note
       FROM plan_versions v JOIN plans p ON p.id = v.plan_id ORDER BY p.code, v.version`)).rows);
  }

  async publishPlanVersion(staff: StaffActor, versionId: string) {
    if (!isUuid(versionId)) throw Errors.notFound('Plan version');
    await this.run(staff, (tx) => tx.query('SELECT platform_publish_plan_version($1, $2)', [staff.token, versionId]));
  }

  async setFeatureFlag(staff: StaffActor, tenantId: string, key: string, input: unknown) {
    const { enabled } = parse(FlagRequest, input);
    if (!isUuid(tenantId) || !/^[a-z][a-z0-9_]{1,60}$/.test(key)) throw Errors.notFound('Company or flag');
    await this.run(staff, (tx) => tx.query('SELECT platform_set_feature_flag($1, $2, $3, $4)', [staff.token, tenantId, key, enabled]));
  }

  async requestSupport(staff: StaffActor, input: unknown) {
    const body = parse(SupportRequest, input);
    const id = await this.run(staff, async (tx) =>
      (await tx.query<{ id: string }>('SELECT platform_request_support($1, $2, $3, $4) AS id', [staff.token, body.tenantId, body.reason, body.minutes])).rows[0]!.id);
    return { grantId: id, status: 'awaiting_approval' };
  }

  async approveSupport(staff: StaffActor, grantId: string) {
    if (!isUuid(grantId)) throw Errors.notFound('Grant');
    const expiresAt = await this.run(staff, async (tx) =>
      (await tx.query<{ e: Date }>('SELECT platform_approve_support($1, $2) AS e', [staff.token, grantId])).rows[0]!.e);
    return { grantId, expiresAt };
  }

  async revokeSupport(staff: StaffActor, grantId: string) {
    if (!isUuid(grantId)) throw Errors.notFound('Grant');
    await this.run(staff, (tx) => tx.query('SELECT platform_revoke_support($1, $2)', [staff.token, grantId]));
  }

  /** Support read of a company's files or members. The database refuses it without an active grant and records it. */
  async supportView(staff: StaffActor, tenantId: string, what: 'files' | 'members') {
    if (!isUuid(tenantId)) throw Errors.notFound('Company');
    return this.run(staff, async (tx) =>
      (await tx.query<{ rows: unknown[] }>('SELECT platform_support_view($1, $2, $3) AS rows', [staff.token, tenantId, what])).rows[0]!.rows);
  }
}
