/** Plans, seat limits (including under concurrency), metered usage, warnings and frozen price versions. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EntitlementsService } from '../src/modules/entitlements.service';
import { asOwner, Client, clearRateLimits, enableMfa, invite, newCompany, newUser, PASSWORD, startApp, tokenFrom, uniqueEmail, type TestApp } from './helpers';

let t: TestApp;
let owner: Client;
let tenantId: string;

beforeAll(async () => {
  t = await startApp();
  owner = await newUser(t, 'limits');
  tenantId = await newCompany(owner, 'limits', 'starter'); // Starter: 3 seats, 1,000 automation runs
  await enableMfa(owner);
});
afterAll(() => t?.close());

describe('seats', () => {
  it('20 people accepting invitations at the same moment on a 3-seat plan: exactly 2 get in', async () => {
    // Prepare 20 verified, signed-in users with invitations (owner already holds seat 1).
    const people: Array<{ c: Client; token: string }> = [];
    for (let i = 0; i < 20; i++) {
      await clearRateLimits(t);
      const c = new Client(t, uniqueEmail(`seat${i}`));
      await c.post('/v1/auth/signup', { email: c.email, password: PASSWORD, fullName: `Seat ${i}` }).expect(202);
      await c.post('/v1/auth/verify-email', { token: tokenFrom(t.mailer, c.email) }).expect(204);
      await c.post('/v1/auth/login', { email: c.email, password: PASSWORD }).expect(200);
      people.push({ c, token: await invite(t, owner, c.email, 'agent') });
    }
    const results = await Promise.all(people.map(({ c, token }) => c.post('/v1/invitations/accept', { token })));
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 201)).toHaveLength(2);
    expect(statuses.filter((s) => s === 402)).toHaveLength(18);
    expect(results.find((r) => r.status === 402)!.body.error.code).toBe('limit_reached');

    const summary = (await owner.get('/v1/entitlements').expect(200)).body;
    expect(summary.limits.seats).toEqual({ limit: 3, used: 3 });
  }, 120_000);

  it('a platform override raises the limit for one company only', async () => {
    await asOwner(t, tenantId, (tx) =>
      tx.query("INSERT INTO entitlement_overrides (tenant_id, key, limit_value, reason) VALUES ($1, 'seats', 4, 'pilot customer')", [tenantId]));
    expect((await owner.get('/v1/entitlements').expect(200)).body.limits.seats).toEqual({ limit: 4, used: 3 });
  });
});

describe('metered usage (automation runs)', () => {
  it('counts usage, warns once at 80% and 95%, and hard-stops at the limit', async () => {
    const svc = new EntitlementsService(t.deps);
    const actor = { tenantId, userId: owner.userId! };
    expect(await svc.consume(actor, 'automation_executions', 799)).toEqual({ used: 799, limit: 1000, warning: null });
    expect((await svc.consume(actor, 'automation_executions', 1)).warning).toBe('80');
    expect((await svc.consume(actor, 'automation_executions', 1)).warning).toBe(null); // warned once only
    expect((await svc.consume(actor, 'automation_executions', 149)).warning).toBe('95');
    expect(await svc.consume(actor, 'automation_executions', 50)).toEqual({ used: 1000, limit: 1000, warning: null });
    await expect(svc.consume(actor, 'automation_executions', 1)).rejects.toMatchObject({ status: 402, code: 'limit_reached' });
    expect((await owner.get('/v1/entitlements').expect(200)).body.limits.automation_executions).toEqual({ limit: 1000, used: 1000 });
  });

  it('parallel usage never overshoots the limit', async () => {
    const other = await newUser(t, 'burst');
    const otherTenant = await newCompany(other, 'burst', 'starter');
    const svc = new EntitlementsService(t.deps);
    const actor = { tenantId: otherTenant, userId: other.userId! };
    await svc.consume(actor, 'automation_executions', 990);
    const results = await Promise.allSettled(Array.from({ length: 30 }, () => svc.consume(actor, 'automation_executions', 1)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(10);
    // ...and this company's usage is separate from the first company's.
    expect((await other.get('/v1/entitlements').expect(200)).body.limits.automation_executions.used).toBe(1000);
  });
});

describe('plan catalogue', () => {
  it('loads the BRD v1.1 proposed prices and limits as data', async () => {
    const { rows } = await t.ownerDb.query(
      `SELECT p.code, v.price_monthly_cents AS price, e.key, e.limit_value::int AS lim, e.addon_price_cents AS addon
       FROM plans p JOIN plan_versions v ON v.plan_id = p.id JOIN plan_entitlements e ON e.plan_version_id = v.id
       WHERE e.key = 'seats' ORDER BY v.price_monthly_cents`);
    expect(rows).toEqual([
      { code: 'starter', price: 2900, key: 'seats', lim: 3, addon: null },
      { code: 'growth', price: 7900, key: 'seats', lim: 10, addon: 800 },
      { code: 'business', price: 19900, key: 'seats', lim: 25, addon: 700 },
      { code: 'enterprise', price: 49900, key: 'seats', lim: 50, addon: null },
    ]);
  });

  it('a price version in use cannot be edited; a new version must be published', async () => {
    await expect(
      t.ownerDb.query("UPDATE plan_versions SET price_monthly_cents = 1 WHERE plan_id = (SELECT id FROM plans WHERE code = 'starter')"),
    ).rejects.toThrow(/in use; publish a new version/);
    await expect(
      t.ownerDb.query(`UPDATE plan_entitlements SET limit_value = 999 WHERE key = 'seats' AND plan_version_id =
        (SELECT v.id FROM plan_versions v JOIN plans p ON p.id = v.plan_id WHERE p.code = 'starter')`),
    ).rejects.toThrow(/in use/);
    // ...and no new limit can be slipped into a version that is in use.
    await expect(
      t.ownerDb.query(`INSERT INTO plan_entitlements (plan_version_id, key, limit_value)
        SELECT v.id, 'ai_credits', 999999 FROM plan_versions v JOIN plans p ON p.id = v.plan_id WHERE p.code = 'starter'`),
    ).rejects.toThrow(/in use/);
  });

  it('overrides only accept known limit names', async () => {
    await expect(asOwner(t, tenantId, (tx) =>
      tx.query("INSERT INTO entitlement_overrides (tenant_id, key, limit_value, reason) VALUES ($1, 'unlimited_everything', 1, 'x')", [tenantId])))
      .rejects.toMatchObject({ code: '23514' });
  });

  it('the application role cannot change prices or limits at all', async () => {
    await expect(t.deps.db.query('UPDATE plan_versions SET price_monthly_cents = 1')).rejects.toMatchObject({ code: '42501' });
    await expect(t.deps.db.query("INSERT INTO entitlement_overrides (tenant_id, key, limit_value, reason) VALUES (gen_random_uuid(), 'seats', 99, 'x')"))
      .rejects.toMatchObject({ code: '42501' });
  });
});
