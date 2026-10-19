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
  const { rows } = await tx.query<{
    plan_limit: string | null; extra_seats: number; override: string | null; trialing: boolean; trial_cap: string | null;
  }>(
    `SELECT e.limit_value AS plan_limit, s.extra_seats, s.status = 'trialing' AS trialing,
            (SELECT c.limit_value FROM trial_caps c WHERE c.key = $1) AS trial_cap,
            (SELECT o.limit_value FROM entitlement_overrides o
             WHERE o.key = $1 AND (o.expires_at IS NULL OR o.expires_at > now())
             ORDER BY o.created_at DESC LIMIT 1) AS override
     FROM subscriptions s
     LEFT JOIN plan_entitlements e ON e.plan_version_id = s.plan_version_id AND e.key = $1`,
    [key],
  );
  const row = rows[0];
  if (!row) return 0; // no subscription: nothing is allowed
  // 1. A per-company override set by the platform is a deliberate decision and wins (e.g. a pilot customer).
  if (row.override !== null) return Number(row.override);
  let limit = row.plan_limit === null ? null : Number(row.plan_limit) + (key === 'seats' ? row.extra_seats : 0);
  // 2. During a trial the lower of the plan limit and the configurable trial cap applies.
  if (row.trialing && row.trial_cap !== null) limit = limit === null ? Number(row.trial_cap) : Math.min(limit, Number(row.trial_cap));
  return limit;
}

/** Marketing templates are refused during a trial unless the trial policy allows them (it does not, by default). */
export async function marketingMessagesAllowed(tx: Tx): Promise<boolean> {
  const { rows } = await tx.query<{ allowed: boolean }>(
    `SELECT s.status <> 'trialing' OR (SELECT marketing_messages_allowed FROM trial_policy) AS allowed FROM subscriptions s`);
  return rows[0]?.allowed ?? false;
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
   * Records metered usage (AI credits, outbound messages) against the monthly limit.
   * Automation runs must go through AutomationMetering instead, which de-duplicates retries and resumes.
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

/**
 * Automation usage (owner decision 19 Oct 2026):
 *   one completed workflow execution = one run; retries and resumed executions never count twice;
 *   failed executions are tracked separately and are not billed.
 * Each run is identified by its run id, so the same run reported many times is counted once.
 */
export class AutomationMetering {
  constructor(private readonly deps: Pick<Deps, 'db'>) {}

  /** Call before starting a new run: refuses when the month's completed-run limit is used up. */
  async assertRunAllowed(actor: Pick<TenantActor, 'tenantId' | 'userId'>): Promise<void> {
    await withContext(this.deps.db, actor, async (tx) => {
      const limit = await limitFor(tx, 'automation_executions');
      if (limit === null) return;
      const { rows } = await tx.query<{ used: string }>(
        `SELECT coalesce((SELECT used FROM usage_counters WHERE key = 'automation_executions'
                          AND period_start = date_trunc('month', now())::date), 0) AS used`);
      if (Number(rows[0]!.used) >= limit) throw Errors.limitReached('automation_executions', limit);
    });
  }

  /**
   * Records the outcome of a run. Safe to call repeatedly (retries, resumes, duplicate events):
   *   new run, completed  -> completed +1
   *   new run, failed     -> failed +1
   *   failed -> completed (resumed and finished) -> failed -1, completed +1
   *   completed -> anything                        -> no change
   */
  async recordRunOutcome(
    actor: Pick<TenantActor, 'tenantId' | 'userId'>, runId: string, outcome: 'completed' | 'failed',
  ): Promise<{ counted: 'completed' | 'failed' | 'none' }> {
    return withContext(this.deps.db, actor, async (tx) => {
      const existing = await tx.query<{ outcome: 'completed' | 'failed'; period_start: string }>(
        "SELECT outcome, period_start::text FROM usage_events WHERE key = 'automation_run' AND source_id = $1 FOR UPDATE", [runId]);
      const prev = existing.rows[0];
      if (prev?.outcome === 'completed' || (prev?.outcome === 'failed' && outcome === 'failed')) return { counted: 'none' as const };

      if (!prev) {
        const ins = await tx.query(
          `INSERT INTO usage_events (tenant_id, key, source_id, outcome, period_start)
           VALUES ($1, 'automation_run', $2, $3, date_trunc('month', now())::date) ON CONFLICT DO NOTHING`,
          [actor.tenantId, runId, outcome]);
        if (ins.rowCount === 0) return { counted: 'none' as const }; // a parallel report won the race
      } else {
        await tx.query("UPDATE usage_events SET outcome = 'completed', updated_at = now() WHERE key = 'automation_run' AND source_id = $1", [runId]);
        await bump(tx, actor.tenantId, 'automation_executions_failed', -1, prev.period_start);
      }
      await bump(tx, actor.tenantId, outcome === 'completed' ? 'automation_executions' : 'automation_executions_failed', 1);
      return { counted: outcome };
    });
  }
}

async function bump(tx: Tx, tenantId: string, key: string, delta: number, period?: string): Promise<void> {
  await tx.query(
    `INSERT INTO usage_counters (tenant_id, key, period_start, used)
     VALUES ($1, $2, coalesce($4::date, date_trunc('month', now())::date), greatest($3, 0))
     ON CONFLICT (tenant_id, key, period_start) DO UPDATE SET used = greatest(usage_counters.used + $3, 0)`,
    [tenantId, key, delta, period ?? null]);
}
