import { withContext, type Tx } from '@conversaflow/database';
import type { Deps, TenantActor } from '../core/context';
import { Errors } from '../core/errors';

export type EntitlementKey = 'seats' | 'whatsapp_numbers' | 'automation_executions' | 'ai_credits' | 'outbound_messages';
const METERED: EntitlementKey[] = ['automation_executions', 'ai_credits', 'outbound_messages'];

export interface UsageResult {
  used: number;
  limit: number | null;
  warning: '80' | '95' | null;
}

/** Current limit for one entitlement. An active override replaces the plan value; extra seats add to it. */
export async function limitFor(tx: Tx, key: EntitlementKey): Promise<number | null> {
  const { rows } = await tx.query<{ plan_limit: string | null; extra_seats: number; override: string | null; found: boolean }>(
    `SELECT e.limit_value AS plan_limit, s.extra_seats,
            (SELECT o.limit_value FROM entitlement_overrides o
             WHERE o.key = $1 AND (o.expires_at IS NULL OR o.expires_at > now())
             ORDER BY o.created_at DESC LIMIT 1) AS override,
            true AS found
     FROM subscriptions s
     LEFT JOIN plan_entitlements e ON e.plan_version_id = s.plan_version_id AND e.key = $1`,
    [key],
  );
  const row = rows[0];
  if (!row) return 0; // no subscription: nothing is allowed
  if (row.override !== null) return Number(row.override);
  if (row.plan_limit === null) return null;
  return Number(row.plan_limit) + (key === 'seats' ? row.extra_seats : 0);
}

/**
 * Seat check, safe under concurrency: locks the company's subscription row so parallel invitation
 * acceptances queue up and the count is exact. Must run in the same transaction as the membership insert.
 */
export async function assertSeatAvailable(tx: Tx): Promise<void> {
  const sub = await tx.query("SELECT 1 FROM subscriptions WHERE status IN ('trialing', 'active', 'past_due') FOR UPDATE");
  if (sub.rowCount !== 1) throw Errors.forbidden('This workspace has no active subscription.');
  const limit = await limitFor(tx, 'seats');
  if (limit === null) return;
  const { rows } = await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM memberships WHERE status = 'active'");
  if (rows[0]!.n >= limit) throw Errors.limitReached('seats', limit);
}

export class EntitlementsService {
  constructor(private readonly deps: Deps) {}

  /** Plan, limits and this month's usage, for the billing and usage screen. */
  async summary(actor: TenantActor) {
    return withContext(this.deps.db, actor, async (tx) => {
      const sub = await tx.query(
        `SELECT p.code AS plan, v.version, s.status, s.billing_interval AS interval, s.trial_ends_at AS "trialEndsAt",
                s.extra_seats AS "extraSeats"
         FROM subscriptions s JOIN plan_versions v ON v.id = s.plan_version_id JOIN plans p ON p.id = v.plan_id`,
      );
      const seatsUsed = (await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM memberships WHERE status = 'active'")).rows[0]!.n;
      const usage = await tx.query<{ key: string; used: string }>(
        "SELECT key, used FROM usage_counters WHERE period_start = date_trunc('month', now())::date",
      );
      const used = new Map(usage.rows.map((r) => [r.key, Number(r.used)]));
      const limits: Record<string, { limit: number | null; used: number }> = {};
      for (const key of ['seats', 'whatsapp_numbers', ...METERED] as EntitlementKey[]) {
        limits[key] = { limit: await limitFor(tx, key), used: key === 'seats' ? seatsUsed : (used.get(key) ?? 0) };
      }
      return { subscription: sub.rows[0] ?? null, limits };
    });
  }

  /**
   * Records metered usage (automation runs, AI credits, outbound messages) against the monthly limit.
   * Hard limit: the call is refused if it would go over. Warnings are raised once at 80% and 95%.
   */
  async consume(actor: Pick<TenantActor, 'tenantId' | 'userId'>, key: EntitlementKey, amount = 1): Promise<UsageResult> {
    if (!METERED.includes(key)) throw new Error(`${key} is not a metered entitlement`);
    if (!Number.isInteger(amount) || amount < 1) throw new Error('amount must be a positive integer');
    return withContext(this.deps.db, actor, async (tx) => {
      await tx.query(
        `INSERT INTO usage_counters (tenant_id, key, period_start) VALUES ($1, $2, date_trunc('month', now())::date)
         ON CONFLICT DO NOTHING`,
        [actor.tenantId, key],
      );
      const { rows } = await tx.query<{ used: string; warned_80_at: Date | null; warned_95_at: Date | null }>(
        `SELECT used, warned_80_at, warned_95_at FROM usage_counters
         WHERE key = $1 AND period_start = date_trunc('month', now())::date FOR UPDATE`,
        [key],
      );
      const current = rows[0]!;
      const limit = await limitFor(tx, key);
      const next = Number(current.used) + amount;
      if (limit !== null && next > limit) throw Errors.limitReached(key, limit);

      let warning: UsageResult['warning'] = null;
      if (limit !== null && limit > 0) {
        if (next >= limit * 0.95 && !current.warned_95_at) warning = '95';
        else if (next >= limit * 0.8 && !current.warned_80_at) warning = '80';
      }
      await tx.query(
        `UPDATE usage_counters SET used = $1,
                warned_80_at = CASE WHEN $2::boolean THEN coalesce(warned_80_at, now()) ELSE warned_80_at END,
                warned_95_at = CASE WHEN $3::boolean THEN coalesce(warned_95_at, now()) ELSE warned_95_at END
         WHERE key = $4 AND period_start = date_trunc('month', now())::date`,
        [next, warning !== null, warning === '95', key],
      );
      return { used: next, limit, warning };
    });
  }
}
