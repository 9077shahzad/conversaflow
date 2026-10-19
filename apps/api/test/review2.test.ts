/**
 * Regression tests for the second independent review (19 Oct 2026).
 * Each attack is replayed as the reviewer ran it; every one must be REFUSED, with the protected data unchanged.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, withContext } from '@conversaflow/database';
import { checkIsolation } from '@conversaflow/database/dist/check-rls';
import { sha256 } from '../src/core/crypto';
import { AutomationMetering } from '../src/modules/entitlements.service';
import { Client, clearRateLimits, enableMfa, newCompany, newStaff, newUser, nextTotp, PASSWORD, startApp, type TestApp } from './helpers';

let t: TestApp;
let lead: Client; // platform owner
let agent: Client; // support agent
let customer: Client;
let tenantId: string;

beforeAll(async () => {
  t = await startApp();
  lead = await newStaff(t, 'r2lead', 'platform_owner');
  agent = await newStaff(t, 'r2agent', 'support_agent');
  customer = await newUser(t, 'r2cust');
  tenantId = await newCompany(customer, 'r2cust');
  await enableMfa(customer);
  await customer.upload('secret.txt', 'text/plain', Buffer.from('secret')).expect(201);
}, 120_000);
afterAll(() => t?.close());

const platform = () => t.deps.platformDb;
const asUser = (db: typeof t.deps.platformDb, userId: string | null, fn: Parameters<typeof withContext<unknown>>[2]) =>
  withContext(db, { tenantId: null, userId }, fn);

describe('finding 1 (high): spoofing app.user_id on the platform connection', () => {
  it('a support agent holding the platform credential cannot approve their own request by pretending to be an owner', async () => {
    const grant = (await agent.post('/v1/platform/support-grants', { tenantId, reason: 'Replaying the reviewer\'s attack path', minutes: 30 }).expect(201)).body.grantId;
    // The old attack: set app.user_id to the platform owner's id and approve. The function now ignores app.user_id
    // and needs the OWNER'S session token, which the agent does not have.
    await expect(asUser(platform(), lead.userId!, (tx) => tx.query('SELECT platform_approve_support($1, $2)', [agent.cookie!.split('=')[1], grant])))
      .rejects.toMatchObject({ code: '42501' });
    await expect(asUser(platform(), lead.userId!, (tx) => tx.query("SELECT platform_approve_support($1, $2)", ['made-up-token', grant])))
      .rejects.toMatchObject({ code: '42501' });
    const status = await t.ownerDb.query('SELECT approved_at FROM support_access_grants WHERE id = $1', [grant]);
    expect(status.rows[0].approved_at).toBeNull();
    // ...and the company's files are still unreadable to the agent through any path.
    await expect(asUser(platform(), agent.userId!, (tx) => tx.query('SELECT * FROM files'))).rejects.toMatchObject({ code: '42501' });
    await expect(asUser(platform(), agent.userId!, (tx) => tx.query("SELECT platform_support_view($1, $2, 'files')", [agent.cookie!.split('=')[1], tenantId])))
      .rejects.toMatchObject({ code: '42501' });
  });

  it('feature flags and plan publishing need a real platform-owner session token too', async () => {
    const fake = (fn: string, args: unknown[]) => asUser(platform(), lead.userId!, (tx) => tx.query(`SELECT ${fn}`, args));
    await expect(fake('platform_set_feature_flag($1, $2, $3, $4)', [agent.cookie!.split('=')[1], tenantId, 'ai_agents', true])).rejects.toMatchObject({ code: '42501' });
    const draft = await t.ownerDb.query("SELECT id FROM plan_versions WHERE version = 2 LIMIT 1");
    await expect(fake('platform_publish_plan_version($1, $2)', [agent.cookie!.split('=')[1], draft.rows[0].id])).rejects.toMatchObject({ code: '42501' });
    expect((await t.ownerDb.query('SELECT published_at FROM plan_versions WHERE id = $1', [draft.rows[0].id])).rows[0].published_at).toBeNull();
  });

  it('the platform role has no direct access to any company table or the audit trails (reviewer finding 7 and 8)', async () => {
    for (const table of ['files', 'memberships', 'users', 'audit_events', 'platform_audit_events', 'support_access_grants', 'sessions', 'tenants']) {
      await expect(asUser(platform(), lead.userId!, (tx) => tx.query(`SELECT * FROM ${table} LIMIT 1`)), table).rejects.toMatchObject({ code: '42501' });
      await expect(asUser(platform(), lead.userId!, (tx) => tx.query(`INSERT INTO ${table} DEFAULT VALUES`)), table).rejects.toMatchObject({ code: '42501' });
    }
    // The directory needs a staff session now (finding 8).
    await expect(platform().query("SELECT * FROM platform_tenant_directory('nope')")).rejects.toMatchObject({ code: '42501' });
  });

  it('a session that is signed out or past its MFA step is not accepted as staff', async () => {
    await clearRateLimits(t);
    const s = new Client(t, lead.email);
    const login = await s.post('/v1/auth/login', { email: lead.email, password: PASSWORD }).expect(200);
    const token = String(login.headers['set-cookie']).split(';')[0]!.split('=')[1]!;
    // Password accepted, MFA not yet entered: not staff.
    const pending = await platform().query('SELECT user_id FROM platform_session_staff($1)', [token]);
    expect(pending.rows[0]?.user_id ?? null).toBeNull();
    expect((await s.get('/v1/platform/tenants').expect(401)).body.error.code).toBe('mfa_required');
  });
});

describe('finding 2 (medium): the identity role cannot forge sessions', () => {
  it('cannot insert a session at all, and cannot open one with MFA pre-verified or a long lifetime', async () => {
    const victim = customer.userId!;
    const id = t.deps.identityDb;
    await expect(asUser(id, victim, (tx) => tx.query(
      "INSERT INTO sessions (token_hash, user_id, expires_at, mfa_verified_at) VALUES ($1, $2, now() + interval '10 years', now())", [sha256('forged'), victim])))
      .rejects.toMatchObject({ code: '42501' });
    await expect(asUser(id, victim, (tx) => tx.query('SELECT auth_open_session($1, $2, NULL, NULL, NULL, 240)', [victim, sha256('long')])))
      .rejects.toThrow(/1 to 12 hours/);
    // A session opened the proper way starts WITHOUT MFA verified, so the forged cookie is useless against MFA.
    await asUser(id, victim, (tx) => tx.query('SELECT auth_open_session($1, $2, NULL, NULL, NULL, 1)', [victim, sha256('opened')]));
    const probe = new Client(t, customer.email);
    expect((await probe.agent.get('/v1/files').set('Cookie', 'cf_session=opened').expect(401)).body.error.code).toBe('mfa_required');
    // Other users' MFA secrets stay invisible.
    const other = await newUser(t, 'r2other');
    const seen = await asUser(id, other.userId!, async (tx) => (await tx.query('SELECT count(*)::int AS n FROM mfa_factors WHERE user_id = $1', [victim])).rows[0].n);
    expect(seen).toBe(0);
  });

  it('the database itself ends sessions older than 12 hours, whatever the row says', async () => {
    const owner = createPool(process.env.DATABASE_URL!, 1);
    try {
      await owner.query("UPDATE sessions SET created_at = now() - interval '13 hours', expires_at = now() + interval '1 day' WHERE user_id = $1", [customer.userId]);
    } finally {
      await owner.end();
    }
    await customer.get('/v1/me').expect(401);
    await clearRateLimits(t);
    await customer.post('/v1/auth/login', { email: customer.email, password: PASSWORD }).expect(200);
    await customer.post('/v1/auth/mfa/challenge', { code: await nextTotp(customer) }).expect(204);
    await customer.get('/v1/me').expect(200);
  });
});

describe('finding 3 (medium): the business API cannot change billing state', () => {
  it('cannot activate a trial, change plan, add seats or move the period', async () => {
    const before = (await t.ownerDb.query('SELECT status, plan_version_id, extra_seats, trial_ends_at FROM subscriptions WHERE tenant_id = $1', [tenantId])).rows[0];
    const attempts = [
      "UPDATE subscriptions SET status = 'active', trial_ends_at = NULL",
      'UPDATE subscriptions SET extra_seats = 100',
      "UPDATE subscriptions SET plan_version_id = (SELECT v.id FROM plan_versions v JOIN plans p ON p.id = v.plan_id WHERE p.code = 'enterprise' AND v.version = 1)",
    ];
    for (const sql of attempts) {
      await expect(withContext(t.deps.db, { tenantId, userId: customer.userId! }, (tx) => tx.query(sql)), sql).rejects.toMatchObject({ code: '42501' });
    }
    expect((await t.ownerDb.query('SELECT status, plan_version_id, extra_seats, trial_ends_at FROM subscriptions WHERE tenant_id = $1', [tenantId])).rows[0]).toEqual(before);
  });

  it('a subscription inserted by the API is forced to a trial, whatever values it tries to set', async () => {
    const fresh = await newUser(t, 'r2fresh');
    const fid = await newCompany(fresh, 'r2fresh', 'enterprise');
    await expect(withContext(t.deps.db, { tenantId: fid, userId: fresh.userId! }, (tx) => tx.query('DELETE FROM subscriptions')))
      .rejects.toMatchObject({ code: '42501' }); // the API cannot remove a trial to replace it
    // Operations removes it, then the API tries to insert a fully paid Enterprise subscription.
    const owner = createPool(process.env.DATABASE_URL!, 1);
    try {
      await withContext(owner, { tenantId: fid, userId: null }, (tx) => tx.query('DELETE FROM subscriptions'));
    } finally {
      await owner.end();
    }
    await withContext(t.deps.db, { tenantId: fid, userId: fresh.userId! }, (tx) => tx.query(
      `INSERT INTO subscriptions (tenant_id, plan_version_id, status, extra_seats, billing_interval, trial_ends_at, current_period_end, payment_provider)
       SELECT $1, v.id, 'active', 500, 'year', NULL, now() + interval '10 years', 'stripe'
       FROM plan_versions v JOIN plans p ON p.id = v.plan_id WHERE p.code = 'enterprise' AND v.version = 1`, [fid]));
    const row = (await t.ownerDb.query('SELECT status, extra_seats, billing_interval, payment_provider, trial_ends_at FROM subscriptions WHERE tenant_id = $1', [fid])).rows[0];
    expect(row).toMatchObject({ status: 'trialing', extra_seats: 0, billing_interval: 'month', payment_provider: null });
    expect(row.trial_ends_at).not.toBeNull();
  });
});

describe('findings 4, 6, 11: idle NULL, token lifetimes, stored address', () => {
  it('a NULL idle timeout is refused', async () => {
    await expect(t.deps.identityDb.query('SELECT * FROM auth_session_lookup($1, NULL)', [sha256('x')])).rejects.toThrow(/idle timeout out of range/);
  });

  it('the notifier cannot mint long-lived tokens', async () => {
    await expect(t.notifyDb.query("SELECT auth_issue_token($1, 'reset_password', $2, interval '100 years')", [customer.userId, sha256('t')]))
      .rejects.toThrow(/token lifetime not allowed/);
    await expect(t.notifyDb.query("SELECT auth_issue_token($1, 'verify_email', $2, interval '25 hours')", [customer.userId, sha256('t')]))
      .rejects.toThrow(/token lifetime not allowed/);
    await expect(t.notifyDb.query("SELECT auth_user_id_by_email($1)", [customer.email])).rejects.toMatchObject({ code: '42501' });
  });

  it('reset emails go to the stored address exactly as stored', async () => {
    const typed = customer.email.toUpperCase();
    await new Client(t, 'x').post('/v1/auth/password/forgot', { email: typed }).expect(202);
    await t.deliver();
    expect(t.mailer.sent.at(-1)!.to).toBe(customer.email);
  });
});

describe('finding 9: metering under concurrency', () => {
  it('a run reported failed and completed at the same moment ends up counted once as completed', async () => {
    const m = new AutomationMetering(t.deps);
    const actor = { tenantId, userId: customer.userId! };
    await Promise.all([m.recordRunOutcome(actor, 'race-1', 'failed'), m.recordRunOutcome(actor, 'race-1', 'completed')]);
    const row = (await withContext(t.deps.db, actor, (tx) => tx.query("SELECT outcome FROM usage_events WHERE source_id = 'race-1'"))).rows[0];
    expect(row.outcome).toBe('completed');
    const counters = Object.fromEntries((await withContext(t.deps.db, actor, (tx) => tx.query(
      "SELECT key, used FROM usage_counters WHERE key LIKE 'automation%'"))).rows.map((r) => [r.key, Number(r.used)]));
    expect(counters.automation_executions).toBe(1);
    expect(counters.automation_executions_failed ?? 0).toBe(0);
  });

  it('parallel starts cannot overshoot the limit', async () => {
    const m = new AutomationMetering(t.deps);
    const actor = { tenantId, userId: customer.userId! };
    await withContext(t.deps.db, actor, (tx) => tx.query(
      "UPDATE usage_counters SET used = 199 WHERE key = 'automation_executions' AND period_start = date_trunc('month', now())::date"));
    // Each start reserves its run under the per-company lock; only one of ten may get through at 199/200.
    const results = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => (async () => {
      await m.startRun(actor, `burst-${i}`);
      await m.recordRunOutcome(actor, `burst-${i}`, 'completed');
    })()));
    const used = Number((await withContext(t.deps.db, actor, (tx) => tx.query(
      "SELECT used FROM usage_counters WHERE key = 'automation_executions' AND period_start = date_trunc('month', now())::date"))).rows[0].used);
    expect(used).toBeLessThanOrEqual(200);
    expect(results.filter((r) => r.status === 'rejected').length).toBeGreaterThanOrEqual(9);
  });
});

describe('the CI guard now catches these regressions', () => {
  it('flags direct platform table access, unbound platform functions and billing updates', async () => {
    const owner = createPool(process.env.DATABASE_URL!, 1);
    try {
      await owner.query('GRANT SELECT ON files TO cf_platform');
      await owner.query('GRANT UPDATE ON subscriptions TO cf_app');
      await owner.query('GRANT EXECUTE ON FUNCTION platform_staff_role(uuid) TO cf_app');
      const problems = await checkIsolation(process.env.DATABASE_URL!);
      expect(problems).toEqual(expect.arrayContaining([
        'cf_platform has direct access to files; it must act only through token-bound functions',
        'cf_app can update subscriptions (billing state)',
        'cf_app can execute platform_staff_role(uuid)',
      ]));
    } finally {
      await owner.query('REVOKE SELECT ON files FROM cf_platform');
      await owner.query('REVOKE UPDATE ON subscriptions FROM cf_app');
      await owner.query('REVOKE EXECUTE ON FUNCTION platform_staff_role(uuid) FROM cf_app');
      await owner.end();
    }
    expect(await checkIsolation(process.env.DATABASE_URL!)).toEqual([]);
  });
});
