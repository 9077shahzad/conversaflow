/** Owner decisions of 19 Oct 2026, as configuration: trial, annual draft pricing, retention, automation usage, Meta rates. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withContext } from '@conversaflow/database';
import { AutomationMetering, marketingMessagesAllowed } from '../src/modules/entitlements.service';
import { providerRateOn } from '../src/modules/provider-rates';
import { activateSubscription, asOwner, enableMfa, newCompany, newUser, startApp, type Client, type TestApp } from './helpers';

let t: TestApp;
let owner: Client;
let tenantId: string;
const actor = () => ({ tenantId, userId: owner.userId! });

beforeAll(async () => {
  t = await startApp();
  owner = await newUser(t, 'commerce');
  tenantId = await newCompany(owner, 'commerce', 'business');
  await enableMfa(owner);
});
afterAll(() => t?.close());

describe('trial (14 days, caps, no marketing; configurable)', () => {
  it('a new company starts a 14-day trial from the trial policy', async () => {
    const sub = (await owner.get('/v1/entitlements').expect(200)).body.subscription;
    expect(sub.status).toBe('trialing');
    const days = (new Date(sub.trialEndsAt).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(13.9);
    expect(days).toBeLessThan(14.1);
  });

  it('trial caps apply over the plan limits, and lift when the trial ends', async () => {
    const trial = (await owner.get('/v1/entitlements').expect(200)).body.limits;
    expect(trial.seats.limit).toBe(3); // Business plan has 25
    expect(trial.automation_executions.limit).toBe(200); // Business plan has 25,000
    const other = await newUser(t, 'paid');
    const paidTenant = await newCompany(other, 'paid', 'business');
    await activateSubscription(t, paidTenant);
    const paid = (await other.get('/v1/entitlements').expect(200)).body.limits;
    expect(paid.seats.limit).toBe(25);
    expect(paid.automation_executions.limit).toBe(25000);
  });

  it('marketing messages are refused during a trial, and the rule is configurable', async () => {
    const check = () => withContext(t.deps.db, actor(), (tx) => marketingMessagesAllowed(tx));
    expect(await check()).toBe(false);
    await t.ownerDb.query('UPDATE trial_policy SET marketing_messages_allowed = true');
    try {
      expect(await check()).toBe(true);
    } finally {
      await t.ownerDb.query('UPDATE trial_policy SET marketing_messages_allowed = false');
    }
    expect(await check()).toBe(false);
  });

  it('the application cannot change trial settings', async () => {
    await expect(t.deps.db.query('UPDATE trial_policy SET trial_days = 90')).rejects.toMatchObject({ code: '42501' });
    await expect(t.deps.db.query('UPDATE trial_caps SET limit_value = 1000000')).rejects.toMatchObject({ code: '42501' });
  });
});

describe('annual pricing draft (10 x monthly, unpublished)', () => {
  it('each plan has an unpublished draft with annual = 10 x monthly and the same limits', async () => {
    const { rows } = await t.ownerDb.query(
      `SELECT p.code, v.price_monthly_cents AS m, v.price_annual_cents AS a, v.published_at IS NOT NULL AS published,
              (SELECT count(*)::int FROM plan_entitlements e WHERE e.plan_version_id = v.id) AS limits
       FROM plan_versions v JOIN plans p ON p.id = v.plan_id WHERE v.version = 2 ORDER BY m`);
    expect(rows).toEqual([
      { code: 'starter', m: 2900, a: 29000, published: false, limits: 3 },
      { code: 'growth', m: 7900, a: 79000, published: false, limits: 3 },
      { code: 'business', m: 19900, a: 199000, published: false, limits: 3 },
      { code: 'enterprise', m: 49900, a: 499000, published: false, limits: 3 },
    ]);
  });

  it('new companies get the published monthly version, never the draft', async () => {
    const sub = (await owner.get('/v1/entitlements').expect(200)).body.subscription;
    expect(sub.version).toBe(1);
  });

  it('nobody can subscribe a company to a draft version, and the app cannot publish one', async () => {
    await expect(asOwner(t, tenantId, (tx) => tx.query(
      `UPDATE subscriptions SET plan_version_id = (SELECT v.id FROM plan_versions v JOIN plans p ON p.id = v.plan_id
         WHERE p.code = 'business' AND v.version = 2)`))).rejects.toThrow(/draft and cannot be subscribed/);
    await expect(t.deps.db.query('UPDATE plan_versions SET published_at = now() WHERE version = 2')).rejects.toMatchObject({ code: '42501' });
  });
});

describe('retention (proposals only; no automatic deletion without an approved policy)', () => {
  it('holds the proposed periods by data type', async () => {
    const { rows } = await t.deps.db.query('SELECT data_type, retain_days, status, auto_delete_enabled FROM retention_policies ORDER BY data_type');
    expect(rows).toEqual([
      { data_type: 'audit_events', retain_days: 2557, status: 'proposed', auto_delete_enabled: false },
      { data_type: 'files', retain_days: 730, status: 'proposed', auto_delete_enabled: false },
      { data_type: 'message_media', retain_days: 730, status: 'proposed', auto_delete_enabled: false },
      { data_type: 'messages', retain_days: 730, status: 'proposed', auto_delete_enabled: false },
    ]);
  });

  it('automatic deletion cannot be switched on for a proposal', async () => {
    await expect(t.ownerDb.query("UPDATE retention_policies SET auto_delete_enabled = true WHERE data_type = 'messages'"))
      .rejects.toMatchObject({ code: '23514' });
    await expect(t.ownerDb.query("UPDATE retention_policies SET status = 'approved' WHERE data_type = 'messages'"))
      .rejects.toMatchObject({ code: '23514' }); // approval needs who and when
    await expect(t.deps.db.query('UPDATE retention_policies SET retain_days = 1')).rejects.toMatchObject({ code: '42501' });
  });
});

describe('automation usage (one completed run = one; retries never double-count; failures separate)', () => {
  const metering = () => new AutomationMetering(t.deps);
  const counters = () => withContext(t.deps.db, actor(), async (tx) => {
    const { rows } = await tx.query<{ key: string; used: string }>(
      "SELECT key, used FROM usage_counters WHERE period_start = date_trunc('month', now())::date AND key LIKE 'automation%'");
    return Object.fromEntries(rows.map((r) => [r.key, Number(r.used)]));
  });

  it('the same completed run reported three times counts once', async () => {
    for (let i = 0; i < 3; i++) await metering().recordRunOutcome(actor(), 'run-001', 'completed');
    expect(await counters()).toEqual({ automation_executions: 1 });
  });

  it('a failed run is tracked separately; failing again on retry does not add', async () => {
    await metering().recordRunOutcome(actor(), 'run-002', 'failed');
    await metering().recordRunOutcome(actor(), 'run-002', 'failed');
    expect(await counters()).toEqual({ automation_executions: 1, automation_executions_failed: 1 });
  });

  it('a failed run that is resumed and completes moves from failed to completed, once', async () => {
    await metering().recordRunOutcome(actor(), 'run-002', 'completed');
    await metering().recordRunOutcome(actor(), 'run-002', 'completed');
    expect(await counters()).toEqual({ automation_executions: 2, automation_executions_failed: 0 });
  });

  it('ten parallel reports of one run count once', async () => {
    await Promise.all(Array.from({ length: 10 }, () => metering().recordRunOutcome(actor(), 'run-003', 'completed')));
    expect((await counters()).automation_executions).toBe(3);
  });

  it('new runs are refused once the limit is reached (trial cap 200 here)', async () => {
    await withContext(t.deps.db, actor(), (tx) => tx.query(
      "UPDATE usage_counters SET used = 200 WHERE key = 'automation_executions' AND period_start = date_trunc('month', now())::date"));
    await expect(metering().assertRunAllowed(actor())).rejects.toMatchObject({ status: 402, code: 'limit_reached' });
  });
});

describe('Meta rates: dated, configurable, verified before customers see them', () => {
  const q = (on: string, includeDrafts = false) => withContext(t.deps.db, actor(), (tx) =>
    providerRateOn(tx, { market: 'global', category: 'business_agent', currency: 'USD', on, includeDrafts }));

  it('finds the verified Business Agent rate by date', async () => {
    expect((await q('2026-10-19'))?.rate).toBe(2);
    expect(await q('2026-07-15')).toBeNull(); // before it took effect
  });

  it('draft rates are never returned for customer use', async () => {
    await t.ownerDb.query(`INSERT INTO provider_rates (provider, market, category, unit, currency, rate, effective_from, source_url, source_checked_on)
      VALUES ('meta_whatsapp', 'SA', 'marketing', 'message', 'USD', 0.05, '2026-10-01', 'https://example.test/rate-card', '2026-10-19')`);
    const draft = () => withContext(t.deps.db, actor(), (tx) => providerRateOn(tx, { market: 'SA', category: 'marketing', currency: 'USD', on: '2026-10-19' }));
    expect(await draft()).toBeNull();
    const internal = await withContext(t.deps.db, actor(), (tx) =>
      providerRateOn(tx, { market: 'SA', category: 'marketing', currency: 'USD', on: '2026-10-19', includeDrafts: true }));
    expect(internal?.rate).toBe(0.05);
  });

  it('a rate cannot be verified without a reconciliation note, and verified rates cannot overlap', async () => {
    await expect(t.ownerDb.query("UPDATE provider_rates SET status = 'verified' WHERE market = 'SA'")).rejects.toMatchObject({ code: '23514' });
    await expect(t.ownerDb.query(`INSERT INTO provider_rates (provider, market, category, unit, currency, rate, effective_from, source_url, source_checked_on, status, reconciliation_note)
      VALUES ('meta_whatsapp', 'global', 'business_agent', 'million_tokens', 'USD', 3, '2026-09-01', 'https://x.test', '2026-10-19', 'verified', 'test')`))
      .rejects.toMatchObject({ code: '23P01' }); // exclusion: overlaps the existing verified rate
  });

  it('the 1,000 free service messages allowance is recorded but still pending reconciliation', async () => {
    const { rows } = await t.deps.db.query("SELECT free_units, per, status FROM provider_allowances WHERE category = 'service'");
    expect(rows).toEqual([{ free_units: 1000, per: 'phone_number_month', status: 'draft' }]);
  });
});
