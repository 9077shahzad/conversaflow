/**
 * Owner decisions of 20 Oct 2026:
 *  - every user of a pilot company must use two-step sign-in;
 *  - each pilot company gets a separate 10-seat allowance; the standard trial allowance stays unchanged.
 * Only a platform owner can enrol or end a pilot. Companies can read their enrolment but not change it.
 */
import { authenticator } from 'otplib';
import { createPool, withContext } from '@conversaflow/database';
import { sha256 } from '../src/core/crypto';
import { checkIsolation } from '@conversaflow/database/dist/check-rls';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addMember, asOwner, clearRateLimits, Client, enableMfa, newCompany, newStaff, newUser, nextTotp, PASSWORD, startApp, type TestApp,
} from './helpers';

let t: TestApp;
let lead: Client; // platform owner
let agentStaff: Client; // support agent (not allowed to enrol)
let pilotOwner: Client;
let pilotTenant: string;
let trialOwner: Client;
let trialTenant: string;
let member: Client; // pilot company member without two-step sign-in
let earlyLink: string; // a download link issued before the pilot started

const seats = async (c: Client) => (await c.get('/v1/entitlements').expect(200)).body.limits.seats.limit as number;
/** The platform audit trail is append-only with no reader; the test adds a read policy inside a rolled-back transaction. */
async function platformAudit(action: string, target: string): Promise<{ metadata: Record<string, unknown> }[]> {
  const c = await t.ownerDb.connect();
  try {
    await c.query('BEGIN');
    await c.query('CREATE POLICY test_read ON platform_audit_events FOR SELECT TO CURRENT_USER USING (true)');
    return (await c.query('SELECT metadata FROM platform_audit_events WHERE action = $1 AND target_id = $2', [action, target])).rows;
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
}
const trialCap = async () => (await asOwner(t, null, (tx) => tx.query("SELECT limit_value FROM trial_caps WHERE key = 'seats'"))).rows[0]!.limit_value;

beforeAll(async () => {
  t = await startApp();
  lead = await newStaff(t, 'plead', 'platform_owner');
  agentStaff = await newStaff(t, 'pagent', 'support_agent');
  pilotOwner = await newUser(t, 'powner');
  pilotTenant = await newCompany(pilotOwner, 'pilotco', 'growth');
  await enableMfa(pilotOwner);
  member = await addMember(t, pilotOwner, 'pmember', 'agent');
  const file = (await member.upload('rota.txt', 'text/plain', Buffer.from('shift rota')).expect(201)).body.id;
  earlyLink = (await member.post(`/v1/files/${file}/link`).expect(201)).body.url;
  trialOwner = await newUser(t, 'towner');
  trialTenant = await newCompany(trialOwner, 'trialco', 'growth');
}, 180_000);
afterAll(() => t?.close());

describe('who can enrol a pilot', () => {
  it('a support agent and a company owner are refused, and nothing is recorded', async () => {
    await agentStaff.post(`/v1/platform/tenants/${pilotTenant}/pilot`, { reason: 'Facilities pilot, sector one' }).expect(403);
    await pilotOwner.post(`/v1/platform/tenants/${pilotTenant}/pilot`, { reason: 'Facilities pilot, sector one' }).expect(403);
    const n = (await t.ownerDb.query('SELECT count(*)::int AS n FROM pilot_enrolments WHERE tenant_id = $1', [pilotTenant])).rows[0].n;
    expect(n).toBe(0);
    expect(await seats(pilotOwner)).toBe(3);
  });

  it('the business database role cannot create, change or end an enrolment', async () => {
    const as = (sql: string, args: unknown[]) => withContext(t.deps.db, { tenantId: pilotTenant, userId: pilotOwner.userId! }, (tx) => tx.query(sql, args));
    await expect(as(
      "INSERT INTO pilot_enrolments (tenant_id, seat_allowance, reason, ends_at, seat_override_id, enrolled_by) VALUES ($1, 50, 'self-granted pilot', now() + interval '1 year', gen_random_uuid(), $2)",
      [pilotTenant, pilotOwner.userId])).rejects.toMatchObject({ code: '42501' });
    await expect(as("INSERT INTO entitlement_overrides (tenant_id, key, limit_value, reason) VALUES ($1, 'seats', 50, 'self-granted')", [pilotTenant]))
      .rejects.toMatchObject({ code: '42501' });
    await expect(as('SELECT platform_enrol_pilot($1, $2, 10, 90, $3)', ['x', pilotTenant, 'self-granted pilot'])).rejects.toMatchObject({ code: '42501' });
  });

  it('out-of-range seats or length are refused', async () => {
    await lead.post(`/v1/platform/tenants/${pilotTenant}/pilot`, { seats: 51, reason: 'Facilities pilot, sector one' }).expect(400);
    await lead.post(`/v1/platform/tenants/${pilotTenant}/pilot`, { days: 365, reason: 'Facilities pilot, sector one' }).expect(400);
    await lead.post(`/v1/platform/tenants/${pilotTenant}/pilot`, { reason: 'short' }).expect(400);
  });
});

describe('a pilot company', () => {
  it('the platform owner enrols it: 10 seats for 90 days, two-step sign-in required, audited', async () => {
    const res = await lead.post(`/v1/platform/tenants/${pilotTenant}/pilot`, { reason: 'Facilities and home services pilot' }).expect(201);
    expect(res.body).toMatchObject({ seats: 10, requiresMfa: true });
    const days = (new Date(res.body.endsAt).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(89.9);
    expect(await seats(pilotOwner)).toBe(10);
    const audit = await platformAudit('pilot.enrolled', pilotTenant);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.metadata).toMatchObject({ seats: 10, requiresMfa: true });
    await lead.post(`/v1/platform/tenants/${pilotTenant}/pilot`, { reason: 'Facilities and home services pilot' }).expect(409);
  });

  it('the standard trial allowance is unchanged for every other company', async () => {
    expect(await trialCap()).toBe('3');
    expect(await seats(trialOwner)).toBe(3);
  });

  it('a member without two-step sign-in is refused on every company request, and sees nothing', async () => {
    for (const path of ['/v1/tenant', '/v1/files', '/v1/members', '/v1/settings']) {
      const res = await member.get(path).expect(403);
      expect(res.body.error.code).toBe('mfa_enrollment_required');
      expect(JSON.stringify(res.body)).not.toContain('rota.txt');
    }
    await member.upload('more.txt', 'text/plain', Buffer.from('x')).expect(403);
    const files = (await asOwner(t, pilotTenant, (tx) => tx.query('SELECT original_name, status, created_at FROM files WHERE tenant_id = $1 ORDER BY created_at', [pilotTenant]))).rows;
    expect(files.map((f) => `${f.original_name}:${f.status}`)).toEqual(['rota.txt:available']);
  });

  it('a download link issued before the pilot no longer works without two-step sign-in', async () => {
    const res = await member.agent.get(earlyLink).set('Cookie', member.cookie!).expect(403);
    expect(res.body.error.code).toBe('mfa_enrollment_required');
    expect(res.text).not.toContain('shift rota');
  });

  it('once the member sets up two-step sign-in, access returns', async () => {
    await enableMfa(member);
    await clearRateLimits(t);
    const s = new Client(t, member.email);
    await s.post('/v1/auth/login', { email: member.email, password: PASSWORD }).expect(200);
    await s.post('/v1/auth/mfa/challenge', { code: await nextTotp(member) }).expect(204);
    await s.get('/v1/tenant').expect(200);
    expect((await s.get('/v1/files').expect(200)).body.map((f: { name: string }) => f.name)).toContain('rota.txt');
  }, 45_000);

  it('the company can read its own enrolment, not another company\'s', async () => {
    const mine = await withContext(t.deps.db, { tenantId: pilotTenant, userId: pilotOwner.userId! }, (tx) =>
      tx.query('SELECT seat_allowance, requires_mfa FROM pilot_enrolments'));
    expect(mine.rows).toEqual([{ seat_allowance: 10, requires_mfa: true }]);
    const other = await withContext(t.deps.db, { tenantId: trialTenant, userId: trialOwner.userId! }, (tx) =>
      tx.query('SELECT * FROM pilot_enrolments'));
    expect(other.rows).toEqual([]);
  });

  it('ending the pilot lifts the requirement and returns the company to the trial allowance', async () => {
    await agentStaff.post(`/v1/platform/tenants/${pilotTenant}/pilot/end`).expect(403);
    await lead.post(`/v1/platform/tenants/${pilotTenant}/pilot/end`).expect(204);
    expect(await seats(pilotOwner)).toBe(3);
    expect(await platformAudit('pilot.ended', pilotTenant)).toHaveLength(1);
    await lead.post(`/v1/platform/tenants/${pilotTenant}/pilot/end`).expect(409);
  });

  it('a company can be enrolled again after its pilot ended, but never has two running pilots', async () => {
    await lead.post(`/v1/platform/tenants/${pilotTenant}/pilot`, { seats: 8, days: 30, reason: 'Second pilot round, same company' }).expect(201);
    expect(await seats(pilotOwner)).toBe(8);
    await lead.post(`/v1/platform/tenants/${pilotTenant}/pilot`, { reason: 'Attempt at a parallel pilot' }).expect(409);
    await lead.post(`/v1/platform/tenants/${pilotTenant}/pilot/end`).expect(204);
    expect(await seats(pilotOwner)).toBe(3);
  });
});

describe('candidate 2 follow-ups (independent recheck R4-3, R4-4)', () => {
  it('two enrolments at the same instant: one succeeds, the other gets 409, never a server error', async () => {
    const o = await newUser(t, 'race');
    const tenant = await newCompany(o, 'raceco', 'growth');
    const results = await Promise.all([1, 2, 3].map(() =>
      lead.post(`/v1/platform/tenants/${tenant}/pilot`, { reason: 'Concurrent enrolment test' })));
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    const n = (await asOwner(t, tenant, (tx) => tx.query('SELECT count(*)::int AS n FROM entitlement_overrides WHERE tenant_id = $1', [tenant]))).rows[0].n;
    expect(n).toBe(1);
  });

  it('the operations role can end a seat override but cannot extend or clear its expiry', async () => {
    const o = await newUser(t, 'expiry');
    const tenant = await newCompany(o, 'expiryco', 'growth');
    await lead.post(`/v1/platform/tenants/${tenant}/pilot`, { reason: 'Expiry policy test' }).expect(201);
    const asOps = async (sql: string) => {
      const c = await t.ownerDb.connect();
      try {
        await c.query('BEGIN'); await c.query('SET LOCAL ROLE cf_ops');
        const r = await c.query(sql, [tenant]); await c.query('COMMIT'); return r;
      } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
    };
    for (const sql of [
      "UPDATE entitlement_overrides SET expires_at = now() + interval '5 years' WHERE tenant_id = $1",
      'UPDATE entitlement_overrides SET expires_at = NULL WHERE tenant_id = $1',
    ]) await expect(asOps(sql), sql).rejects.toMatchObject({ code: '42501' });
    const before = (await asOwner(t, tenant, (tx) => tx.query('SELECT expires_at FROM entitlement_overrides WHERE tenant_id = $1', [tenant]))).rows[0].expires_at;
    expect(new Date(before).getTime()).toBeGreaterThan(Date.now() + 80 * 86_400_000);
    await lead.post(`/v1/platform/tenants/${tenant}/pilot/end`).expect(204);
    expect(await seats(o)).toBe(3);
  });
});

describe('the CI guard', () => {
  it('fails the build if the business role can write pilot records or overrides', async () => {
    const owner = createPool(process.env.DATABASE_URL!, 1);
    try {
      await owner.query('GRANT UPDATE ON pilot_enrolments TO cf_app');
      await owner.query('GRANT INSERT ON entitlement_overrides TO cf_app');
      expect(await checkIsolation(process.env.DATABASE_URL!)).toEqual(expect.arrayContaining([
        'cf_app can write pilot enrolments', 'cf_app can write limit overrides']));
    } finally {
      await owner.query('REVOKE UPDATE ON pilot_enrolments FROM cf_app');
      await owner.query('REVOKE INSERT ON entitlement_overrides FROM cf_app');
      await owner.end();
    }
    expect(await checkIsolation(process.env.DATABASE_URL!)).toEqual([]);
  });
});

describe('security notices (mitigation M5, migration 0012)', () => {
  it('turning on two-step sign-in emails the stored address, with no sign-in link', async () => {
    const u = await newUser(t, 'notice');
    await t.deliver();
    const before = t.mailer.sent.length;
    const setup = await u.post('/v1/auth/mfa/totp/setup').expect(201);
    const codes: string[] = (await u.post('/v1/auth/mfa/totp/confirm', { code: authenticator.generate(setup.body.secret) }).expect(201)).body.recoveryCodes;
    await t.deliver();
    const mail = t.mailer.sent.slice(before).find((m) => m.to === u.email);
    expect(mail?.subject).toBe('Two-step sign-in turned on');
    expect(mail?.text).toContain('If this was not you');
    expect(mail?.text).toContain('تم تفعيل التحقق بخطوتين');
    expect(mail?.text).not.toMatch(/token=/);

    // Using a recovery code also tells the owner.
    await clearRateLimits(t);
    const s2 = new Client(t, u.email);
    await s2.post('/v1/auth/login', { email: u.email, password: PASSWORD }).expect(200);
    await s2.post('/v1/auth/mfa/challenge', { recoveryCode: codes[0] }).expect(204);
    await t.deliver();
    expect(t.mailer.lastTo(u.email)?.subject).toBe('Recovery code used');
  }, 45_000);

  it('the sign-in role can neither queue a forged notice nor enable two-step sign-in silently', async () => {
    await expect(withContext(t.deps.identityDb, { tenantId: null, userId: null }, (tx) =>
      tx.query("SELECT auth_request_email('mfa_enabled', 'victim@example.test')"))).rejects.toMatchObject({ code: '42501' });
    // Replays E1 from the residual-risk note: a forged session for a user without two-step sign-in enrols the
    // attacker's authenticator. It succeeds (the accepted residual) but the real owner is emailed.
    const victim = await newUser(t, 'e1victim');
    await t.deliver();
    const token = 'forged-' + Math.random().toString(36).slice(2);
    await withContext(t.deps.identityDb, { tenantId: null, userId: victim.userId! }, (tx) =>
      tx.query('SELECT auth_open_session($1, $2, NULL, NULL, NULL, 12)', [victim.userId, sha256(token)]));
    const secret: string = await withContext(t.deps.identityDb, { tenantId: null, userId: victim.userId! }, async (tx) =>
      (await tx.query('SELECT auth_mfa_begin($1) AS s', [sha256(token)])).rows[0].s);
    const hashes = Array.from({ length: 10 }, (_, i) => sha256(`rc-${i}-${token}`));
    const ok = await withContext(t.deps.identityDb, { tenantId: null, userId: victim.userId! }, async (tx) =>
      (await tx.query('SELECT auth_mfa_confirm($1, $2, $3) AS ok', [sha256(token), authenticator.generate(secret), hashes])).rows[0].ok);
    expect(ok).toBe(true);
    await t.deliver();
    expect(t.mailer.lastTo(victim.email)?.subject).toBe('Two-step sign-in turned on');
  });
});
