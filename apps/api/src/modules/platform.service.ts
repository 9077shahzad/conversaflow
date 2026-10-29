import { withContext, type Db } from '@conversaflow/database';
import { z } from 'zod';
import type { AuthSession } from '../core/context';
import { AppError, Errors } from '../core/errors';
import { parse } from '../core/validate';
import { isUuid } from './members.service';
import { partnerKeySealer } from './dialog360';
import { partnerFundingCheck } from './credits';

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
const MfaResetRequest = z.object({
  email: z.string().trim().email().max(320),
  reason: z.string().trim().min(20, 'Explain the situation (at least 20 characters)').max(1000),
  identityMethod: z.enum(['video_call_photo_id', 'callback_known_number', 'company_owner_confirmation', 'in_person']),
  identityReference: z.string().trim().min(10).max(200)
    // At most 5 digits in total, of any script, whatever separates them (recheck of candidate 3, L-A).
    .refine((v) => (v.match(/\p{Nd}/gu) ?? []).length < 6, 'Do not record document or account numbers; describe the check in words (write dates as "20 Oct")'),
});
// Prepaid message credits (migration 0061).
const CreditAccountRequest = z.object({ currency: z.enum(['SAR', 'AED', 'USD']), lowThresholdMinor: z.number().int().min(0).max(10_000_000).default(0) }).strict();
const CreditRatesRequest = z.object({
  currency: z.enum(['SAR', 'AED', 'USD']),
  effectiveFrom: z.string().datetime({ offset: true }),
  source: z.string().trim().min(3).max(300),
  lines: z.array(z.object({ market: z.string().regex(/^[a-z_]{2,40}$/), category: z.enum(['marketing', 'utility', 'authentication', 'service']),
    unitCostMinor: z.number().int().min(0).max(1_000_000) }).strict()).min(1).max(2000),
  markets: z.array(z.object({ prefix: z.string().regex(/^[0-9]{1,6}$/), market: z.string().regex(/^[a-z_]{2,40}$/) }).strict()).max(500).default([]),
}).strict();
const CreditMarginRequest = z.object({ tenantId: z.string().uuid().nullable(), marginBp: z.number().int().min(0).max(20000).nullable() }).strict();
const CreditAdjustRequest = z.object({ amountMinor: z.number().int().refine((v) => v !== 0, 'not zero').refine((v) => Math.abs(v) <= 100_000_000, 'too large'),
  note: z.string().trim().min(5).max(300) }).strict();
const PartnerCostRequest = z.object({ month: z.string().regex(/^\d{4}-\d{2}$/), currency: z.enum(['SAR', 'AED', 'USD']), costMinor: z.number().int().min(0),
  messageCount: z.number().int().min(0).nullable().default(null), reference: z.string().trim().min(2).max(200) }).strict();

const PilotRequest = z.object({
  seats: z.number().int().min(1).max(50).default(10),
  days: z.number().int().min(7).max(180).default(90),
  reason: z.string().trim().min(10, 'Say why this company is in the pilot (at least 10 characters)').max(500),
});

/**
 * Platform owner console. Uses its own database role (cf_platform):
 *  - company directory and plans: metadata only;
 *  - company content: only with an approved, unexpired support grant (two people, max 4 hours),
 *    enforced by row-level security; every read is written to that company's audit trail.
 */
const RouteRequest = z.object({ route: z.enum(['meta_direct', 'partner_360dialog']), note: z.string().trim().min(5).max(300) }).strict();
const PartnerChannelRequest = z.object({
  providerNumberId: z.string().regex(/^[0-9A-Za-z_-]{3,64}$/), displayPhone: z.string().trim().min(3).max(32), label: z.string().trim().min(1).max(80),
  accountId: z.string().regex(/^[0-9A-Za-z_-]{3,64}$/), apiKey: z.string().min(10).max(500),
}).strict();
const ConsentAdd = z.object({ locale: z.enum(['en', 'ar']), text: z.string().trim().min(20).max(2000) }).strict();
const ConsentSet = z.object({ status: z.enum(['approved', 'retired']), legalReference: z.string().trim().min(3).max(200).optional() }).strict();
const PartnerRecord = z.discriminatedUnion('what', [
  z.object({ what: z.literal('balance'), amountMinor: z.number().int(), currency: z.string().regex(/^[A-Z]{3}$/), at: z.string().datetime({ offset: true }).optional() }).strict(),
  z.object({ what: z.literal('entry'), kind: z.enum(['funding', 'invoice', 'fee', 'adjustment']), amountMinor: z.number().int().refine((v) => v !== 0),
    currency: z.string().regex(/^[A-Z]{3}$/), reference: z.string().trim().min(2).max(200), at: z.string().datetime({ offset: true }).optional() }).strict(),
]);
const PartnerSettings = z.object({
  fx: z.record(z.string().regex(/^[A-Z]{3}$/), z.number().positive()).optional(), lowBalanceMinor: z.number().int().min(0).optional(),
  minDaysCover: z.number().positive().max(365).optional(), topupLeadDays: z.number().min(0).max(60).optional(), safetyBp: z.number().int().min(0).max(20000).optional(),
}).strict();

export class PlatformService {
  /** Seals partner API keys before they are stored; only the 360dialog adapter can open them. */
  private readonly sealKey: ((apiKey: string) => string) | null;
  /**
   * `prepaidAllowed` is false in production until the owner approves launch: no company can be moved to the partner
   * route and no credit account opened there (review of 0064, M3).
   */
  constructor(private readonly db: Db, serverSecret?: Buffer, private readonly checkDb?: Db, private readonly prepaidAllowed = true) {
    this.sealKey = serverSecret ? partnerKeySealer(serverSecret).seal : null;
  }

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
      // Two requests racing past a check hit the database's unique rule; the loser gets the same answer as a later
      // request would (independent recheck R4-3).
      if (err.code === '23505') throw new AppError(409, 'not_allowed', 'This was just done by another request.');
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

  /** Pilot enrolment: separate seat allowance (default 10) and mandatory two-step sign-in for every member. */
  async enrolPilot(staff: StaffActor, tenantId: string, input: unknown) {
    const body = parse(PilotRequest, input);
    if (!isUuid(tenantId)) throw Errors.notFound('Company');
    const endsAt = await this.run(staff, async (tx) => (await tx.query<{ ends: Date }>(
      'SELECT platform_enrol_pilot($1, $2, $3, $4, $5) AS ends', [staff.token, tenantId, body.seats, body.days, body.reason])).rows[0]!.ends);
    return { tenantId, seats: body.seats, requiresMfa: true, endsAt: new Date(endsAt).toISOString() };
  }

  async endPilot(staff: StaffActor, tenantId: string) {
    if (!isUuid(tenantId)) throw Errors.notFound('Company');
    await this.run(staff, (tx) => tx.query('SELECT platform_end_pilot($1, $2)', [staff.token, tenantId]));
  }

  /** M8 step 1: a platform owner records the identity check and requests a two-step reset for a user. */
  async requestMfaReset(staff: StaffActor, input: unknown) {
    const b = parse(MfaResetRequest, input);
    const id = await this.run(staff, async (tx) => (await tx.query<{ id: string }>(
      'SELECT platform_request_mfa_reset($1, $2, $3, $4, $5) AS id', [staff.token, b.email, b.reason, b.identityMethod, b.identityReference])).rows[0]!.id);
    return { requestId: id, status: 'awaiting_second_approver', expiresInHours: 24 };
  }

  /** M8: open reset requests with their reason and identity check, so the second owner can review before approving. */
  async listMfaResets(staff: StaffActor) {
    return this.run(staff, async (tx) => (await tx.query<{ rows: unknown }>('SELECT platform_list_mfa_resets($1) AS rows', [staff.token])).rows[0]!.rows);
  }

  /** M8 step 2: a DIFFERENT platform owner approves; the reset happens in the same transaction. */
  async approveMfaReset(staff: StaffActor, requestId: string) {
    if (!isUuid(requestId)) throw Errors.notFound('Request');
    await this.run(staff, (tx) => tx.query('SELECT platform_approve_mfa_reset($1, $2)', [staff.token, requestId]));
    return { status: 'reset_done' };
  }

  async rejectMfaReset(staff: StaffActor, requestId: string) {
    if (!isUuid(requestId)) throw Errors.notFound('Request');
    await this.run(staff, (tx) => tx.query('SELECT platform_reject_mfa_reset($1, $2)', [staff.token, requestId]));
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

  // --- Messaging route per company, and the partner (owner instructions of 29 Oct 2026) ---
  async setRoute(staff: StaffActor, tenantId: string, input: unknown) {
    if (!isUuid(tenantId)) throw Errors.notFound('Company');
    const b = parse(RouteRequest, input);
    if (b.route === 'partner_360dialog' && !this.prepaidAllowed) throw Errors.conflict('not_approved', 'The partner route is not approved for production yet.');
    await this.run(staff, (tx) => tx.query('SELECT platform_set_messaging_route($1, $2, $3, $4)', [staff.token, tenantId, b.route, b.note]));
    return { tenantId, route: b.route };
  }
  async connectPartnerChannel(staff: StaffActor, tenantId: string, input: unknown) {
    if (!isUuid(tenantId)) throw Errors.notFound('Company');
    const b = parse(PartnerChannelRequest, input);
    if (!this.sealKey) throw Errors.conflict('provider_not_available', 'The partner route is not configured here.');
    const id = await this.run(staff, async (tx) => (await tx.query<{ id: string }>('SELECT platform_partner_connect_channel($1, $2, $3, $4, $5, $6, $7) AS id',
      [staff.token, tenantId, b.providerNumberId, b.displayPhone, b.label, b.accountId, this.sealKey!(b.apiKey)])).rows[0]!.id);
    return { id };
  }
  /** The wording versions (platform-wide, not company data; read with the business role after the staff check). */
  async consentList(_staff: StaffActor) {
    if (!this.checkDb) return [];
    return withContext(this.checkDb, { tenantId: null, userId: null }, async (tx) => (await tx.query(
      `SELECT version, locale, text, status, legal_reference AS "legalReference", approved_at AS "approvedAt" FROM credit_consent_texts ORDER BY locale, version`)).rows);
  }
  async consentAdd(staff: StaffActor, input: unknown) {
    const b = parse(ConsentAdd, input);
    const version = await this.run(staff, async (tx) => (await tx.query<{ v: number }>('SELECT platform_credit_consent_add($1, $2, $3) AS v', [staff.token, b.locale, b.text])).rows[0]!.v);
    return { version, locale: b.locale, status: 'awaiting_legal_review' };
  }
  async consentSet(staff: StaffActor, version: string, locale: string, input: unknown) {
    const b = parse(ConsentSet, input);
    if (!/^\d{1,6}$/.test(version) || !['en', 'ar'].includes(locale)) throw Errors.notFound('Wording');
    await this.run(staff, (tx) => tx.query('SELECT platform_credit_consent_set($1, $2, $3, $4, $5)', [staff.token, Number(version), locale, b.status, b.legalReference ?? null]));
    return { version: Number(version), locale, status: b.status };
  }
  async partnerRecord(staff: StaffActor, input: unknown) {
    const b = parse(PartnerRecord, input);
    await this.run(staff, (tx) => tx.query('SELECT platform_partner_record($1, $2, $3, $4, $5, $6, $7, $8)',
      [staff.token, '360dialog', b.what, b.what === 'entry' ? b.kind : null, b.amountMinor, b.currency, b.what === 'entry' ? b.reference : null, b.at ?? null]));
    return { ok: true };
  }
  async partnerSettings(staff: StaffActor, input: unknown) {
    const b = parse(PartnerSettings, input);
    await this.run(staff, (tx) => tx.query('SELECT platform_partner_settings($1, $2, $3)', [staff.token, '360dialog', JSON.stringify(b)]));
    return { ok: true };
  }
  /** Partner funding: the ledger totals, the monitor's figures (computed now) and open alerts. */
  async partnerOverview(staff: StaffActor) {
    const ledger = await this.run(staff, async (tx) => (await tx.query<Record<string, unknown>>('SELECT * FROM platform_partner_overview($1, $2)', [staff.token, '360dialog'])).rows[0]!);
    const status = this.checkDb ? await partnerFundingCheck(this.checkDb) : null;
    const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
    return { partner: '360dialog', fundedMinor: n(ledger.funded_minor), invoicedMinor: n(ledger.invoiced_minor), feesMinor: n(ledger.fees_minor),
      adjustmentsMinor: n(ledger.adjustments_minor), alerts: ledger.alerts, monitor: status };
  }

  // --- Prepaid message credits (owner decision of 29 Oct 2026) ---
  async creditOpenAccount(staff: StaffActor, tenantId: string, input: unknown) {
    if (!isUuid(tenantId)) throw Errors.notFound('Company');
    const b = parse(CreditAccountRequest, input);
    if (!this.prepaidAllowed) throw Errors.conflict('not_approved', 'Prepaid messaging is not approved for production yet.');
    await this.run(staff, (tx) => tx.query('SELECT platform_credit_open_account($1, $2, $3, $4)', [staff.token, tenantId, b.currency, b.lowThresholdMinor]));
    return { tenantId, currency: b.currency };
  }
  async creditPublishRates(staff: StaffActor, input: unknown) {
    const b = parse(CreditRatesRequest, input);
    const id = await this.run(staff, async (tx) => (await tx.query<{ id: string }>('SELECT platform_credit_publish_rates($1, $2, $3, $4, $5, $6) AS id',
      [staff.token, b.currency, b.effectiveFrom, b.source, JSON.stringify(b.lines), JSON.stringify(b.markets)])).rows[0]!.id);
    return { id };
  }
  async creditSetMargin(staff: StaffActor, input: unknown) {
    const b = parse(CreditMarginRequest, input);
    if (b.tenantId === null && b.marginBp === null) throw Errors.badRequest('The default margin needs a value.');
    await this.run(staff, (tx) => tx.query('SELECT platform_credit_set_margin($1, $2, $3)', [staff.token, b.tenantId, b.marginBp]));
    return { ok: true };
  }
  async creditAdjust(staff: StaffActor, tenantId: string, input: unknown) {
    if (!isUuid(tenantId)) throw Errors.notFound('Company');
    const b = parse(CreditAdjustRequest, input);
    const id = await this.run(staff, async (tx) => (await tx.query<{ id: string }>('SELECT platform_credit_adjust($1, $2, $3, $4) AS id',
      [staff.token, tenantId, b.amountMinor, b.note])).rows[0]!.id);
    return { id };
  }
  async creditPartnerCost(staff: StaffActor, tenantId: string, input: unknown) {
    if (!isUuid(tenantId)) throw Errors.notFound('Company');
    const b = parse(PartnerCostRequest, input);
    await this.run(staff, (tx) => tx.query('SELECT platform_credit_record_partner_cost($1, $2, $3, $4, $5, $6, $7)',
      [staff.token, tenantId, `${b.month}-01`, b.currency, b.costMinor, b.messageCount, b.reference]));
    return { ok: true };
  }
  async creditReconciliation(staff: StaffActor, month: string) {
    if (!/^\d{4}-\d{2}$/.test(month)) throw Errors.badRequest('Month as YYYY-MM.');
    const rows = await this.run(staff, async (tx) => (await tx.query<Record<string, unknown>>(
      `SELECT tenant_id AS "tenantId", currency, charges, price_minor::bigint AS price, cost_minor AS cost, margin_minor AS margin,
              partner_cost_minor AS "partnerCost", partner_count AS "partnerCount", difference_minor AS difference, partner_reference AS "partnerReference"
       FROM platform_credit_reconciliation($1, $2)`, [staff.token, `${month}-01`])).rows);
    const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
    return { month, rows: rows.map((r) => ({ tenantId: r.tenantId, currency: r.currency, charges: r.charges, priceMinor: n(r.price), costMinor: n(r.cost), marginMinor: n(r.margin),
      partnerCostMinor: n(r.partnerCost), partnerCount: r.partnerCount, differenceMinor: n(r.difference), partnerReference: r.partnerReference,
      status: r.partnerCost === null ? 'awaiting_partner_figure' : Number(r.difference) === 0 ? 'matched' : 'difference' })) };
  }

  /** Support read of a company's files or members. The database refuses it without an active grant and records it. */
  async supportView(staff: StaffActor, tenantId: string, what: 'files' | 'members') {
    if (!isUuid(tenantId)) throw Errors.notFound('Company');
    return this.run(staff, async (tx) =>
      (await tx.query<{ rows: unknown[] }>('SELECT platform_support_view($1, $2, $3) AS rows', [staff.token, tenantId, what])).rows[0]!.rows);
  }
}
