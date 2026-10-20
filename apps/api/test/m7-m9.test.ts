/**
 * Candidate 3 (owner decision 20 Oct 2026, before the first pilot invitation):
 *  M7  a new authenticator activates only after a code emailed to the account's verified address is entered in the
 *      session that started set-up; the sign-in database credential cannot see, create or redirect that code;
 *  M8  two-person, identity-checked, audited reset of two-step sign-in, ending every session;
 *  M9  pilot invitations: single use, revocable, 72 hours.
 * Plus the CI guard: privileged functions that could write pilot or override records are flagged.
 */
import { authenticator } from 'otplib';
import { createPool, withContext, type Db } from '@conversaflow/database';
import { checkIsolation } from '@conversaflow/database/dist/check-rls';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomToken, sha256 } from '../src/core/crypto';
import {
  asAuthRole, clearRateLimits, Client, emailedMfaCode, enableMfa, newCompany, newStaff, newUser, nextTotp, PASSWORD, startApp,
  tokenFrom, type TestApp,
} from './helpers';

let t: TestApp;
let identity: Db;
beforeAll(async () => {
  t = await startApp();
  identity = t.deps.identityDb;
}, 120_000);
afterAll(() => t?.close());

const asIdentity = (userId: string | null, sql: string, args: unknown[] = []) =>
  withContext(identity, { tenantId: null, userId }, (tx) => tx.query(sql, args));
async function forgeSession(userId: string): Promise<string> {
  const token = randomToken();
  await asIdentity(userId, 'SELECT auth_open_session($1, $2, NULL, NULL, NULL, 12)', [userId, sha256(token)]);
  return token;
}
const hashes = (seed: string) => Array.from({ length: 10 }, (_, i) => sha256(`rc-${i}-${seed}`));
const mfaOn = async (c: Client) => (await c.get('/v1/me').expect(200)).body.mfaEnabled as boolean;
const factorState = (userId: string) => asAuthRole(t, async (tx) =>
  (await tx.query('SELECT confirmed_at, code_verified_at FROM mfa_factors WHERE user_id = $1', [userId])).rows);

describe('M7: an authenticator activates only with the code emailed to the verified address', () => {
  it('the first authenticator code switches nothing on; the emailed code does', async () => {
    const c = await newUser(t, 'm7flow');
    const setup = await c.post('/v1/auth/mfa/totp/setup').expect(201);
    c.mfaSecret = setup.body.secret;
    const res = await c.post('/v1/auth/mfa/totp/confirm', { code: authenticator.generate(c.mfaSecret!) }).expect(202);
    expect(res.body).toEqual({ status: 'confirmation_email_sent', expiresInMinutes: 15 });
    expect(await mfaOn(c)).toBe(false);
    await t.deliver();
    const mail = t.mailer.lastTo(c.email)!;
    expect(mail.subject).toBe('Your code to finish setting up two-step sign-in');
    expect(mail.text).toMatch(/confirmation code is \d{4} \d{4}/);
    expect(mail.text).toContain('Never share this code');
    expect(mail.text).not.toMatch(/token=|https?:\/\/\S+\?/);
    const act = await c.post('/v1/auth/mfa/totp/activate', { code: await emailedMfaCode(t, c.email) }).expect(201);
    expect(act.body.recoveryCodes).toHaveLength(10);
    expect(await mfaOn(c)).toBe(true);
  });

  it('the emailed code works only in the session that started set-up, only once, and not after 15 minutes', async () => {
    const c = await newUser(t, 'm7bound');
    const setup = await c.post('/v1/auth/mfa/totp/setup').expect(201);
    c.mfaSecret = setup.body.secret;
    await c.post('/v1/auth/mfa/totp/confirm', { code: authenticator.generate(c.mfaSecret!) }).expect(202);
    const code = await emailedMfaCode(t, c.email);
    // Another session of the same user cannot use it.
    await clearRateLimits(t);
    const other = new Client(t, c.email);
    await other.post('/v1/auth/login', { email: c.email, password: PASSWORD }).expect(200);
    await other.post('/v1/auth/mfa/totp/activate', { code }).expect(400);
    expect((await factorState(c.userId!))[0].confirmed_at).toBeNull();
    // Expired: refused even in the right session.
    await asAuthRole(t, (tx) => tx.query("UPDATE mfa_activation_codes SET expires_at = now() - interval '1 minute' WHERE user_id = $1", [c.userId]));
    await c.post('/v1/auth/mfa/totp/activate', { code }).expect(400);
    expect((await factorState(c.userId!))[0].confirmed_at).toBeNull();
    // A fresh code (new authenticator code) works once; the old one never again.
    await c.post('/v1/auth/mfa/totp/confirm', { code: await nextTotp(c) }).expect(202);
    const fresh = await emailedMfaCode(t, c.email);
    expect(fresh).not.toBe(code);
    await c.post('/v1/auth/mfa/totp/activate', { code }).expect(400);
    await c.post('/v1/auth/mfa/totp/activate', { code: fresh }).expect(201);
    await c.post('/v1/auth/mfa/totp/activate', { code: fresh }).expect(400);
  }, 60_000);

  it('guessing the emailed code counts towards the database limit of 10 wrong attempts an hour', async () => {
    const c = await newUser(t, 'm7guess');
    const setup = await c.post('/v1/auth/mfa/totp/setup').expect(201);
    await c.post('/v1/auth/mfa/totp/confirm', { code: authenticator.generate(setup.body.secret) }).expect(202);
    // The database allows 10 wrong attempts an hour and refuses the 11th, even with the right code.
    for (let i = 0; i < 10; i++) await c.post('/v1/auth/mfa/totp/activate', { code: String(10_000_000 + i) }).expect(400);
    await c.post('/v1/auth/mfa/totp/activate', { code: '19999999' }).expect(429);
    await c.post('/v1/auth/mfa/totp/activate', { code: await emailedMfaCode(t, c.email) }).expect(429);
  });

  it('at most 5 confirmation emails per user per hour', async () => {
    const c = await newUser(t, 'm7cap');
    const setup = await c.post('/v1/auth/mfa/totp/setup').expect(201);
    c.mfaSecret = setup.body.secret;
    for (let i = 0; i < 5; i++) await c.post('/v1/auth/mfa/totp/confirm', { code: await nextTotp(c) }).expect(202);
    await c.post('/v1/auth/mfa/totp/confirm', { code: await nextTotp(c) }).expect(429);
  }, 240_000);

  it('replay of E1: a forged session can start set-up but cannot finish it, and the code goes only to the real owner', async () => {
    const victim = await newUser(t, 'm7victim');
    await t.deliver();
    const token = await forgeSession(victim.userId!);
    const secret: string = (await asIdentity(victim.userId!, 'SELECT auth_mfa_begin($1) AS s', [sha256(token)])).rows[0].s;
    const ok = (await asIdentity(victim.userId!, 'SELECT auth_mfa_confirm_code($1, $2) AS ok', [sha256(token), authenticator.generate(secret)])).rows[0].ok;
    expect(ok).toBe(true); // first step accepted ...
    await t.deliver();
    expect(t.mailer.lastTo(victim.email)?.subject).toBe('Your code to finish setting up two-step sign-in'); // ... the code goes to the victim
    // Without the mailbox, finishing is refused.
    for (const guess of ['00000000', '12345678']) {
      const r = (await asIdentity(victim.userId!, 'SELECT auth_mfa_activate($1, $2, $3) AS ok', [sha256(token), sha256(guess), hashes(token)])).rows[0].ok;
      expect(r).toBe(false);
    }
    expect((await factorState(victim.userId!))[0].confirmed_at).toBeNull();
    const verified = await asAuthRole(t, async (tx) => (await tx.query('SELECT mfa_verified_at FROM sessions WHERE token_hash = $1', [sha256(token)])).rows[0].mfa_verified_at);
    expect(verified).toBeNull();
    // The old one-step confirmation no longer exists.
    await expect(asIdentity(victim.userId!, "SELECT auth_mfa_confirm($1, '000000', $2)", [sha256(token), hashes(token)])).rejects.toMatchObject({ code: '42883' });
  });

  it('the sign-in credential cannot read, create or redirect confirmation codes, or change the address', async () => {
    const u = await newUser(t, 'm7walls');
    for (const [sql, args] of [
      ['SELECT * FROM mfa_activation_codes', []],
      ["SELECT auth_mfa_issue_activation(gen_random_uuid(), '\\x" + '00'.repeat(32) + "'::bytea)", []],
      ["UPDATE users SET email = 'attacker@example.test' WHERE id = $1", [u.userId]],
      ['UPDATE users SET email_verified_at = now() WHERE id = $1', [u.userId]],
      ["INSERT INTO auth_email_requests (purpose, email, factor_id) VALUES ('mfa_activate', 'attacker@example.test', gen_random_uuid())", []],
      ["SELECT auth_request_email('mfa_activate', 'attacker@example.test')", []],
      ["INSERT INTO mfa_activation_codes (factor_id, user_id, session_id, code_hash, sent_to, expires_at) VALUES (gen_random_uuid(), $1, gen_random_uuid(), '\\x00', 'x', now())", [u.userId]],
    ] as const) {
      await expect(asIdentity(u.userId!, sql, [...args] as unknown[]), sql).rejects.toMatchObject({ code: '42501' });
    }
    expect((await t.ownerDb.query('SELECT email FROM users WHERE id = $1', [u.userId])).rows[0].email).toBe(u.email);
  });

  it('a leaked emailed code is useless in a forged session (bound to the session that started set-up)', async () => {
    const victim = await newUser(t, 'm7leak');
    const setup = await victim.post('/v1/auth/mfa/totp/setup').expect(201);
    await victim.post('/v1/auth/mfa/totp/confirm', { code: authenticator.generate(setup.body.secret) }).expect(202);
    const leaked = await emailedMfaCode(t, victim.email);
    const token = await forgeSession(victim.userId!);
    const r = (await asIdentity(victim.userId!, 'SELECT auth_mfa_activate($1, $2, $3) AS ok', [sha256(token), sha256(leaked), hashes(token)])).rows[0].ok;
    expect(r).toBe(false);
    await victim.post('/v1/auth/mfa/totp/activate', { code: leaked }).expect(201);
  });
});

describe('M8: two-person, identity-checked, audited reset of two-step sign-in', () => {
  let ownerA: Client; let ownerB: Client; let agentStaff: Client;
  beforeAll(async () => {
    ownerA = await newStaff(t, 'm8a', 'platform_owner');
    ownerB = await newStaff(t, 'm8b', 'platform_owner');
    agentStaff = await newStaff(t, 'm8agent', 'support_agent');
  }, 120_000);
  const req = (email: string, extra: Record<string, unknown> = {}) => ({
    email, reason: 'User lost phone and all recovery codes; confirmed on a call', identityMethod: 'video_call_photo_id',
    identityReference: 'Video call 10:20 GST, matched profile photo and company role', ...extra,
  });

  it('one owner requests, a different owner approves: factors removed, every session ended, user told, audited', async () => {
    const u = await newUser(t, 'm8user');
    await enableMfa(u);
    await agentStaff.post('/v1/platform/mfa-resets', req(u.email)).expect(403);
    for (const bad of ['Passport number 12345678 checked', 'passport 123 456 789 checked', 'id 12-34-56-78-90 seen on call',
      'iqama ١٢٣٤٥٦٧٨٩٠ seen on call', 'card １２３４５６７８ shown on call', 'no 1, 2, 3, 4, 5, 6 on the card',
      'no 12_34_56 on the card', 'id 12 – 34 – 56 checked', 'id 1  2  3  4  5  6 checked', 'id 12:34:56:78 checked', 'id 1a2b3c4d5e6f checked']) {
      await ownerA.post('/v1/platform/mfa-resets', req(u.email, { identityReference: bad })).expect(400);
    }
    const id = (await ownerA.post('/v1/platform/mfa-resets', req(u.email)).expect(201)).body.requestId;
    expect((await ownerA.post(`/v1/platform/mfa-resets/${id}/approve`).expect(403)).body.error.message).toMatch(/second platform owner/);
    // The second owner sees the reason and the identity check before approving (review of candidate 3, L-B).
    await agentStaff.get('/v1/platform/mfa-resets').expect(403);
    const open = (await ownerB.get('/v1/platform/mfa-resets').expect(200)).body as Array<Record<string, unknown>>;
    expect(open.find((r) => r.id === id)).toMatchObject({
      user: u.email, identityMethod: 'video_call_photo_id', requestedBy: ownerA.email, requestedByYou: false,
      identityReference: 'Video call 10:20 GST, matched profile photo and company role',
    });
    expect(await mfaOn(u)).toBe(true); // nothing changed yet
    const appr = await ownerB.post(`/v1/platform/mfa-resets/${id}/approve`);
    expect(appr.status, JSON.stringify(appr.body)).toBe(200);
    await u.get('/v1/me').expect(401); // every session ended
    const left = await asAuthRole(t, async (tx) => ({
      factors: (await tx.query('SELECT count(*)::int AS n FROM mfa_factors WHERE user_id = $1', [u.userId])).rows[0].n,
      codes: (await tx.query('SELECT count(*)::int AS n FROM mfa_recovery_codes WHERE user_id = $1', [u.userId])).rows[0].n,
    }));
    expect(left).toEqual({ factors: 0, codes: 0 });
    await t.deliver();
    expect(t.mailer.lastTo(u.email)?.subject).toBe('Two-step sign-in was reset on your account');
    const audit = await (async () => {
      const c = await t.ownerDb.connect();
      try {
        await c.query('BEGIN');
        await c.query('CREATE POLICY test_read ON platform_audit_events FOR SELECT TO CURRENT_USER USING (true)');
        return (await c.query("SELECT action FROM platform_audit_events WHERE target_id = $1 ORDER BY created_at", [u.userId])).rows.map((r) => r.action);
      } finally { await c.query('ROLLBACK'); c.release(); }
    })();
    expect(audit).toEqual(['mfa_reset.requested', 'mfa_reset.approved_and_done']);
    // The user signs in with the password and sets up two-step sign-in again (with M7's email check).
    await clearRateLimits(t);
    const again = new Client(t, u.email);
    const login = await again.post('/v1/auth/login', { email: u.email, password: PASSWORD }).expect(200);
    again.cookie = String(login.headers['set-cookie']).split(';')[0];
    again.userId = u.userId;
    await enableMfa(again);
    expect(await mfaOn(again)).toBe(true);
  }, 90_000);

  it('one open request per user; rejection; expired requests cannot be approved; no reset of your own account', async () => {
    const u = await newUser(t, 'm8rules');
    await enableMfa(u);
    const id = (await ownerA.post('/v1/platform/mfa-resets', req(u.email)).expect(201)).body.requestId;
    await ownerB.post('/v1/platform/mfa-resets', req(u.email)).expect(409);
    await ownerB.post(`/v1/platform/mfa-resets/${id}/reject`).expect(204);
    await ownerB.post(`/v1/platform/mfa-resets/${id}/approve`).expect(409);
    const id2 = (await ownerA.post('/v1/platform/mfa-resets', req(u.email)).expect(201)).body.requestId;
    await setExpired(id2);
    expect((await ownerB.post(`/v1/platform/mfa-resets/${id2}/approve`).expect(409)).body.error.message).toMatch(/expired/);
    expect(await mfaOn(u)).toBe(true);
    await ownerA.post('/v1/platform/mfa-resets', req(ownerA.email)).expect(409);
  });

  it('no login role can run the reset itself', async () => {
    for (const db of [t.deps.db, identity, t.deps.platformDb]) {
      await expect(withContext(db, { tenantId: null, userId: null }, (tx) => tx.query('SELECT auth_mfa_reset_execute(gen_random_uuid())')))
        .rejects.toMatchObject({ code: '42501' });
    }
  });
});

/** Makes a reset request look 25 hours old (operations role; the table has row security for it). */
async function setExpired(id: string) {
  const c = await t.ownerDb.connect();
  try {
    await c.query('BEGIN');
    await c.query('CREATE POLICY test_expire ON mfa_reset_requests FOR UPDATE TO CURRENT_USER USING (true) WITH CHECK (true)');
    await c.query('CREATE POLICY test_expire_read ON mfa_reset_requests FOR SELECT TO CURRENT_USER USING (true)');
    await c.query("UPDATE mfa_reset_requests SET expires_at = now() - interval '1 hour', created_at = now() - interval '25 hours' WHERE id = $1", [id]);
    await c.query('DROP POLICY test_expire ON mfa_reset_requests');
    await c.query('DROP POLICY test_expire_read ON mfa_reset_requests');
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}

describe('M9: pilot invitations are single use, revocable and last 72 hours', () => {
  let lead: Client; let pilotOwner: Client; let pilotTenant: string; let trialOwner: Client;
  beforeAll(async () => {
    lead = await newStaff(t, 'm9lead', 'platform_owner');
    pilotOwner = await newUser(t, 'm9owner');
    pilotTenant = await newCompany(pilotOwner, 'm9pilot', 'growth');
    await enableMfa(pilotOwner);
    await lead.post(`/v1/platform/tenants/${pilotTenant}/pilot`, { reason: 'M9 invitation lifetime test' }).expect(201);
    trialOwner = await newUser(t, 'm9trial');
    await newCompany(trialOwner, 'm9trialco', 'growth');
    await enableMfa(trialOwner);
  }, 120_000);
  const hoursLeft = (iso: string) => (new Date(iso).getTime() - Date.now()) / 3_600_000;

  it('a pilot company invitation lasts 72 hours; other companies keep 7 days', async () => {
    const p = await pilotOwner.post('/v1/invitations', { email: 'p72@example.test', roleKey: 'agent' }).expect(201);
    expect(hoursLeft(p.body.expiresAt)).toBeGreaterThan(71.9);
    expect(hoursLeft(p.body.expiresAt)).toBeLessThan(72.1);
    expect((await tokenFrom(t, 'p72@example.test')).length).toBeGreaterThan(20);
    expect(t.mailer.lastTo('p72@example.test')?.text).toContain('within 72 hours');
    const n = await trialOwner.post('/v1/invitations', { email: 'n7d@example.test', roleKey: 'agent' }).expect(201);
    expect(hoursLeft(n.body.expiresAt)).toBeGreaterThan(167.9);
  });

  it('enrolling a company in the pilot cuts its pending invitations to 72 hours, and the database caps any later change', async () => {
    const o = await newUser(t, 'm9before');
    const tenant = await newCompany(o, 'm9beforeco', 'growth');
    await enableMfa(o);
    const inv = await o.post('/v1/invitations', { email: 'before-pilot@example.test', roleKey: 'agent' }).expect(201);
    expect(hoursLeft(inv.body.expiresAt)).toBeGreaterThan(167.9);
    await lead.post(`/v1/platform/tenants/${tenant}/pilot`, { reason: 'Invitation cut test, review L-C' }).expect(201);
    const left = async () => hoursLeft((await withContext(t.deps.db, { tenantId: tenant, userId: o.userId! }, (tx) =>
      tx.query('SELECT expires_at FROM invitations WHERE id = $1', [inv.body.invitationId]))).rows[0].expires_at.toISOString());
    expect(await left()).toBeLessThan(72.1);
    // Even the business role cannot lengthen it while the pilot runs.
    await withContext(t.deps.db, { tenantId: tenant, userId: o.userId! }, (tx) =>
      tx.query("UPDATE invitations SET expires_at = now() + interval '30 days' WHERE id = $1", [inv.body.invitationId]));
    expect(await left()).toBeLessThan(72.1);
    // ...nor reset the clock by changing the creation time (final recheck of candidate 3, L-C).
    await expect(withContext(t.deps.db, { tenantId: tenant, userId: o.userId! }, (tx) =>
      tx.query("UPDATE invitations SET created_at = now() + interval '1 year' WHERE id = $1", [inv.body.invitationId]))).rejects.toMatchObject({ code: '42501' });
    await expect(withContext(t.deps.db, { tenantId: tenant, userId: o.userId! }, (tx) =>
      tx.query("INSERT INTO invitations (tenant_id, email, role_id, token_hash, invited_by, expires_at, created_at) SELECT $1, 'x@example.test', id, '\\x01', $2, now() + interval '1 day', now() + interval '1 year' FROM roles LIMIT 1",
        [tenant, o.userId]))).rejects.toMatchObject({ code: '42501' });
  });

  it('a revoked invitation stops working at once; the list never shows tokens', async () => {
    const invitee = await newUser(t, 'm9revoked');
    const inv = await pilotOwner.post('/v1/invitations', { email: invitee.email, roleKey: 'agent' }).expect(201);
    const token = await tokenFrom(t, invitee.email);
    const list = (await pilotOwner.get('/v1/invitations').expect(200)).body;
    expect(list.map((i: { id: string }) => i.id)).toContain(inv.body.invitationId);
    expect(JSON.stringify(list)).not.toContain(token);
    await pilotOwner.agent.delete(`/v1/invitations/${inv.body.invitationId}`).set('X-Requested-With', 'conversaflow').expect(204);
    expect((await invitee.post('/v1/invitations/accept', { token }).expect(403)).body.error.code).toBe('invalid_link');
    expect((await pilotOwner.get('/v1/invitations').expect(200)).body.map((i: { id: string }) => i.id)).not.toContain(inv.body.invitationId);
    await pilotOwner.agent.delete(`/v1/invitations/${inv.body.invitationId}`).set('X-Requested-With', 'conversaflow').expect(404);
  });

  it('an invitation works once, and not after it expires', async () => {
    const a = await newUser(t, 'm9once');
    await pilotOwner.post('/v1/invitations', { email: a.email, roleKey: 'agent' }).expect(201);
    const token = await tokenFrom(t, a.email);
    await a.post('/v1/invitations/accept', { token }).expect(201);
    expect((await a.post('/v1/invitations/accept', { token }).expect(403)).body.error.code).toBe('invalid_link');
    const b = await newUser(t, 'm9late');
    const inv = await pilotOwner.post('/v1/invitations', { email: b.email, roleKey: 'agent' }).expect(201);
    const late = await tokenFrom(t, b.email);
    await withContext(t.deps.db, { tenantId: pilotTenant, userId: pilotOwner.userId! }, (tx) =>
      tx.query("UPDATE invitations SET expires_at = now() - interval '1 minute' WHERE id = $1", [inv.body.invitationId]));
    expect((await b.post('/v1/invitations/accept', { token: late }).expect(403)).body.error.code).toBe('invalid_link');
  });
});

describe('CI guard: privileged functions that could write pilot or override records', () => {
  it('flags such a function granted to a login role (direct or via dynamic SQL), and a misplaced code issuer', async () => {
    const owner = createPool(process.env.DATABASE_URL!, 1);
    try {
      await owner.query(`CREATE FUNCTION test_sneaky_grant(p uuid) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
        AS $$ INSERT INTO entitlement_overrides (tenant_id, key, limit_value, reason, expires_at) VALUES (p, 'seats', 99, 'x', now() + interval '1 day') $$`);
      await owner.query('ALTER FUNCTION test_sneaky_grant(uuid) OWNER TO cf_pilot');
      await owner.query(`CREATE FUNCTION test_sneaky_dynamic(q text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
        AS $$ BEGIN EXECUTE format('%s', q); END $$`);
      await owner.query('ALTER FUNCTION test_sneaky_dynamic(text) OWNER TO cf_pilot');
      // Review of candidate 3, L-D: a wrapper that only calls a writer helper, and dynamic SQL built with concat().
      await owner.query(`CREATE FUNCTION zz_helper_grant(p uuid) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
        AS $$ INSERT INTO entitlement_overrides (tenant_id, key, limit_value, reason, expires_at) VALUES (p, 'seats', 99, 'x', now() + interval '1 day') $$`);
      await owner.query('ALTER FUNCTION zz_helper_grant(uuid) OWNER TO cf_pilot');
      await owner.query('REVOKE ALL ON FUNCTION zz_helper_grant(uuid) FROM PUBLIC');
      await owner.query('GRANT EXECUTE ON FUNCTION zz_helper_grant(uuid) TO cf_ops');
      await owner.query(`CREATE FUNCTION test_wrapper(p uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
        AS $$ BEGIN PERFORM zz_helper_grant(p); END $$`);
      await owner.query('ALTER FUNCTION test_wrapper(uuid) OWNER TO cf_ops');
      await owner.query(`CREATE FUNCTION test_concat(p uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
        AS $$ BEGIN EXECUTE (concat('INSERT INTO entitle', 'ment_overrides (tenant_id, key, limit_value, reason, expires_at) VALUES ($1, ''seats'', 99, ''x'', now() + interval ''1 day'')')) USING p; END $$`);
      await owner.query('ALTER FUNCTION test_concat(uuid) OWNER TO cf_pilot');
      await owner.query('GRANT EXECUTE ON FUNCTION test_sneaky_grant(uuid), test_sneaky_dynamic(text), test_wrapper(uuid), test_concat(uuid) TO cf_app');
      // Recheck of candidate 3, L-D: another schema, a privileged trigger, and a rule.
      await owner.query('CREATE SCHEMA zz_other');
      await owner.query('GRANT USAGE ON SCHEMA zz_other TO cf_app, cf_pilot');
      await owner.query('GRANT CREATE ON SCHEMA zz_other TO cf_pilot');
      await owner.query(`CREATE FUNCTION zz_other.g(p uuid) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
        AS $$ INSERT INTO entitlement_overrides (tenant_id, key, limit_value, reason, expires_at) VALUES (p, 'seats', 99, 'x', now() + interval '1 day') $$`);
      await owner.query('ALTER FUNCTION zz_other.g(uuid) OWNER TO cf_pilot');
      await owner.query('GRANT EXECUTE ON FUNCTION zz_other.g(uuid) TO cf_app');
      await owner.query(`CREATE FUNCTION test_trg() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
        AS $$ BEGIN INSERT INTO entitlement_overrides (tenant_id, key, limit_value, reason, expires_at) VALUES (NEW.tenant_id, 'seats', 99, 'x', now() + interval '1 day'); RETURN NEW; END $$`);
      await owner.query('ALTER FUNCTION test_trg() OWNER TO cf_pilot');
      await owner.query('CREATE TRIGGER test_trg AFTER INSERT ON branches FOR EACH ROW EXECUTE FUNCTION test_trg()');
      // G2: a privileged trigger on a table only privileged functions write.
      await owner.query('CREATE TRIGGER test_trg_g2 AFTER INSERT ON mfa_attempts FOR EACH ROW EXECUTE FUNCTION test_trg()');
      await owner.query(`CREATE RULE test_rule AS ON INSERT TO teams DO ALSO
        INSERT INTO entitlement_overrides (tenant_id, key, limit_value, reason, expires_at) VALUES (NEW.tenant_id, 'seats', 99, 'x', now() + interval '1 day')`);
      await owner.query('GRANT EXECUTE ON FUNCTION auth_mfa_issue_activation(uuid, bytea) TO cf_identity');
      const problems = await checkIsolation(process.env.DATABASE_URL!);
      expect(problems).toEqual(expect.arrayContaining([
        'cf_app can run test_sneaky_grant(uuid), a privileged function able to write pilot or override records',
        'cf_app can run test_sneaky_dynamic(text), a privileged function able to write pilot or override records',
        'cf_app can run test_wrapper(uuid), a privileged function able to write pilot or override records',
        'cf_app can run test_concat(uuid), a privileged function able to write pilot or override records',
        'cf_app can run zz_other.g(uuid), a privileged function able to write pilot or override records',
        'trigger test_trg on branches runs as a role able to write pilot or override records',
        'trigger test_trg_g2 on mfa_attempts runs as a role able to write pilot or override records',
        "rule test_rule on teams: rules are not allowed (they run with the table owner's rights)",
        'cf_identity can issue two-step confirmation codes; only cf_notify may',
      ]));
    } finally {
      await owner.query('DROP FUNCTION IF EXISTS test_sneaky_grant(uuid)');
      await owner.query('DROP FUNCTION IF EXISTS test_sneaky_dynamic(text)');
      await owner.query('DROP FUNCTION IF EXISTS test_wrapper(uuid)');
      await owner.query('DROP FUNCTION IF EXISTS test_concat(uuid)');
      await owner.query('DROP FUNCTION IF EXISTS zz_helper_grant(uuid)');
      await owner.query('DROP RULE IF EXISTS test_rule ON teams');
      await owner.query('DROP TRIGGER IF EXISTS test_trg ON branches');
      await owner.query('DROP TRIGGER IF EXISTS test_trg_g2 ON mfa_attempts');
      await owner.query('DROP FUNCTION IF EXISTS test_trg()');
      await owner.query('DROP SCHEMA IF EXISTS zz_other CASCADE');
      await owner.query('REVOKE EXECUTE ON FUNCTION auth_mfa_issue_activation(uuid, bytea) FROM cf_identity');
      await owner.end();
    }
    expect(await checkIsolation(process.env.DATABASE_URL!)).toEqual([]);
  });

  it('a reviewed trigger function is allowed only with its reviewed body', async () => {
    const owner = createPool(process.env.DATABASE_URL!, 1);
    const original = (await owner.query<{ src: string }>(
      "SELECT pg_get_functiondef('plan_version_frozen()'::regprocedure) AS src")).rows[0]!.src;
    try {
      // Same name and signature, new body that writes an override: must be flagged until reviewed again.
      await owner.query(`CREATE OR REPLACE FUNCTION plan_version_frozen() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
        SET search_path = public, pg_temp AS $$ BEGIN UPDATE entitlement_overrides SET expires_at = now() WHERE false;
        RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END; END $$`);
      expect(await checkIsolation(process.env.DATABASE_URL!)).toContain(
        'trigger plan_versions_frozen on plan_versions runs as a role able to write pilot or override records');
    } finally {
      await owner.query(original);
      await owner.end();
    }
    expect(await checkIsolation(process.env.DATABASE_URL!)).toEqual([]);
  });
});
