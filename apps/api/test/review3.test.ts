/**
 * Regression tests for the independent post-fix recheck of commit 8d42a5b (19 Oct 2026).
 * N1 (Medium): the sign-in role could open a session for anyone and mark it MFA-verified, reaching platform-owner
 *              actions and MFA-protected customer data.
 * N2 (Low):    platform staff sessions ignored the user's status and the idle limit.
 * N3 (Low):    one recovery code could be spent twice by two requests at the same moment.
 * Each attack is replayed as the reviewer ran it; it must be REFUSED and the protected data left UNCHANGED.
 */
import { authenticator } from 'otplib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, withContext, type Db } from '@conversaflow/database';
import { checkIsolation } from '@conversaflow/database/dist/check-rls';
import { randomToken, sha256 } from '../src/core/crypto';
import { asAuthRole, Client, clearRateLimits, enableMfa, newCompany, newStaff, newUser, nextTotp, PASSWORD, startApp, type TestApp } from './helpers';

let t: TestApp;
let lead: Client; // platform owner, MFA on
let agent: Client; // support agent, MFA on
let customer: Client; // company Owner, MFA on
let tenantId: string;
let identity: Db;

/** Step 1 of the attack: as cf_identity, open a session for `userId` without knowing their password. */
async function forgeSession(userId: string): Promise<string> {
  const token = randomToken();
  await withContext(identity, { tenantId: null, userId }, (tx) =>
    tx.query('SELECT auth_open_session($1, $2, NULL, NULL, NULL, 12)', [userId, sha256(token)]));
  return token;
}

beforeAll(async () => {
  t = await startApp();
  identity = t.deps.identityDb;
  lead = await newStaff(t, 'r3lead', 'platform_owner');
  agent = await newStaff(t, 'r3agent', 'support_agent');
  customer = await newUser(t, 'r3cust');
  tenantId = await newCompany(customer, 'r3cust');
  await enableMfa(customer);
  await customer.upload('contract.txt', 'text/plain', Buffer.from('confidential')).expect(201);
}, 120_000);
afterAll(() => t?.close());

describe('N1: the sign-in role cannot produce an MFA-verified session', () => {
  it('replay: forge a session for the platform owner, mark it verified, approve a grant — every step refused', async () => {
    const grant = (await agent.post('/v1/platform/support-grants', { tenantId, reason: 'Replaying recheck finding N1 attack path', minutes: 30 }).expect(201)).body.grantId;
    const token = await forgeSession(lead.userId!);
    // The old step 2: a direct UPDATE of mfa_verified_at.
    await expect(withContext(identity, { tenantId: null, userId: lead.userId! }, (tx) =>
      tx.query('UPDATE sessions SET mfa_verified_at = now() WHERE token_hash = $1', [sha256(token)])))
      .rejects.toMatchObject({ code: '42501' });
    // The only remaining route is a correct code, which needs the owner's authenticator.
    const verified = await withContext(identity, { tenantId: null, userId: lead.userId! }, async (tx) =>
      (await tx.query('SELECT auth_mfa_verify($1, $2, NULL) AS ok', [sha256(token), '123456'])).rows[0].ok);
    expect(verified).toBe(false);
    // Step 3: the forged token is not accepted as a staff session.
    await expect(t.deps.platformDb.query('SELECT platform_approve_support($1, $2)', [token, grant])).rejects.toMatchObject({ code: '42501' });
    expect((await t.ownerDb.query('SELECT approved_at FROM support_access_grants WHERE id = $1', [grant])).rows[0].approved_at).toBeNull();
  });

  it('replay: a forged session for an MFA customer cannot read their files over HTTP', async () => {
    const token = await forgeSession(customer.userId!);
    const probe = new Client(t, 'probe');
    const res = await probe.agent.get('/v1/files').set('Cookie', `cf_session=${token}`).expect(401);
    expect(res.body.error.code).toBe('mfa_required');
    expect(JSON.stringify(res.body)).not.toContain('contract.txt');
  });

  it('the sign-in role cannot read secrets, recovery codes or the sealing key, nor write MFA data', async () => {
    const as = (sql: string, args: unknown[] = []) => withContext(identity, { tenantId: null, userId: customer.userId! }, (tx) => tx.query(sql, args));
    for (const sql of [
      'SELECT secret_sealed FROM mfa_factors', 'SELECT secret_enc FROM mfa_factors', 'SELECT last_used_step FROM mfa_factors',
      'SELECT * FROM mfa_recovery_codes', 'SELECT * FROM auth_keys', 'SELECT * FROM mfa_attempts',
      'DELETE FROM mfa_factors', "UPDATE mfa_factors SET confirmed_at = NULL", 'UPDATE mfa_recovery_codes SET used_at = NULL',
      "INSERT INTO mfa_factors (user_id, type, secret_sealed, confirmed_at) VALUES (app_user_id(), 'totp', '\\x00', now())",
    ]) {
      await expect(as(sql), sql).rejects.toMatchObject({ code: '42501' });
    }
    // Starting a new enrolment over an existing one is refused, so an attacker cannot swap in their own secret.
    const token = await forgeSession(customer.userId!);
    await expect(as('SELECT auth_mfa_begin($1)', [sha256(token)])).rejects.toMatchObject({ code: '23505' });
    // "Does this user have MFA?" still works (column-level read).
    expect((await as("SELECT count(confirmed_at)::int AS n FROM mfa_factors WHERE user_id = app_user_id()")).rows[0].n).toBe(1);
  });

  it('guessing codes directly in the database is limited to 10 wrong attempts per hour, whoever calls', async () => {
    const victim = await newUser(t, 'r3guess');
    await enableMfa(victim);
    const token = await forgeSession(victim.userId!);
    const call = () => withContext(identity, { tenantId: null, userId: victim.userId! }, async (tx) =>
      (await tx.query('SELECT auth_mfa_verify($1, $2, NULL) AS ok', [sha256(token), '000000'])).rows[0].ok);
    for (let i = 0; i < 10; i++) expect(await call()).toBe(false);
    await expect(call()).rejects.toMatchObject({ code: '54000' });
    // Even the right code is refused while locked: the limit cannot be beaten by guessing faster.
    await expect(withContext(identity, { tenantId: null, userId: victim.userId! }, (tx) =>
      tx.query('SELECT auth_mfa_verify($1, $2, NULL)', [sha256(token), authenticator.generate(victim.mfaSecret!)]))).rejects.toMatchObject({ code: '54000' });
    // The API reports the database limit as "too many attempts".
    await clearRateLimits(t);
    const s = new Client(t, victim.email);
    await s.post('/v1/auth/login', { email: victim.email, password: PASSWORD }).expect(200);
    expect((await s.post('/v1/auth/mfa/challenge', { code: '111111' }).expect(429)).body.error.code).toBe('rate_limited');
  });

  it('a real sign-in still works end to end, and the secret is stored only in sealed form', async () => {
    await clearRateLimits(t);
    const s = new Client(t, lead.email);
    await s.post('/v1/auth/login', { email: lead.email, password: PASSWORD }).expect(200);
    await s.post('/v1/auth/mfa/challenge', { code: await nextTotp(lead) }).expect(204);
    await s.get('/v1/platform/tenants').expect(200);
    const row = await asAuthRole(t, async (tx) => (await tx.query(
      'SELECT secret_enc, secret_sealed FROM mfa_factors WHERE user_id = $1', [lead.userId])).rows[0]);
    expect(row.secret_enc).toBeNull();
    expect(Buffer.isBuffer(row.secret_sealed)).toBe(true);
    expect(row.secret_sealed.toString('latin1')).not.toContain(lead.mfaSecret!);
  }, 45_000);
});

describe('N2: platform staff sessions honour user status, idle and absolute limits', () => {
  async function staffToken(c: Client): Promise<string> {
    await clearRateLimits(t);
    const s = new Client(t, c.email);
    const login = await s.post('/v1/auth/login', { email: c.email, password: PASSWORD }).expect(200);
    await s.post('/v1/auth/mfa/challenge', { code: await nextTotp(c) }).expect(204);
    return String(login.headers['set-cookie']).split(';')[0]!.split('=')[1]!;
  }
  const isStaff = async (token: string) =>
    (await t.deps.platformDb.query('SELECT user_id FROM platform_session_staff($1)', [token])).rows[0]?.user_id ?? null;

  it('a staff session idle for over 60 minutes is not accepted by the database', async () => {
    const token = await staffToken(agent);
    expect(await isStaff(token)).toBe(agent.userId);
    await asAuthRole(t, (tx) => tx.query("UPDATE sessions SET last_seen_at = now() - interval '61 minutes' WHERE token_hash = $1", [sha256(token)]));
    expect(await isStaff(token)).toBeNull();
  }, 60_000);

  it('a session older than 12 hours, or of a disabled user, is not accepted', async () => {
    const token = await staffToken(agent);
    await asAuthRole(t, (tx) => tx.query("UPDATE sessions SET created_at = now() - interval '13 hours' WHERE token_hash = $1", [sha256(token)]));
    expect(await isStaff(token)).toBeNull();

    const temp = await newStaff(t, 'r3temp', 'support_agent');
    const tempToken = await staffToken(temp);
    expect(await isStaff(tempToken)).toBe(temp.userId);
    await asAuthRole(t, (tx) => tx.query("UPDATE users SET status = 'disabled' WHERE id = $1", [temp.userId]));
    expect(await isStaff(tempToken)).toBeNull();
  }, 90_000);
});

describe('N3: a recovery code works exactly once, even when two requests race', () => {
  it('two simultaneous uses of one code: exactly one succeeds', async () => {
    const c = await newUser(t, 'r3race');
    const code: string = (await enableMfa(c))[0]!;
    const [a, b] = [await forgeSession(c.userId!), await forgeSession(c.userId!)];
    const use = (token: string) => withContext(identity, { tenantId: null, userId: c.userId! }, async (tx) =>
      (await tx.query('SELECT auth_mfa_verify($1, NULL, $2) AS ok', [sha256(token), sha256(code)])).rows[0].ok as boolean);
    const results = await Promise.all([use(a), use(b)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const used = await asAuthRole(t, async (tx) => (await tx.query(
      'SELECT count(*)::int AS n FROM mfa_recovery_codes WHERE user_id = $1 AND used_at IS NOT NULL', [c.userId])).rows[0].n);
    expect(used).toBe(1);
  });
});

describe('the CI guard catches a regression of N1', () => {
  it('flags the sign-in role regaining the right to mark sessions verified or read secrets', async () => {
    const owner = createPool(process.env.DATABASE_URL!, 1);
    try {
      await owner.query('GRANT UPDATE (mfa_verified_at) ON sessions TO cf_identity');
      await owner.query('GRANT SELECT (secret_sealed) ON mfa_factors TO cf_identity');
      const problems = await checkIsolation(process.env.DATABASE_URL!);
      expect(problems).toEqual(expect.arrayContaining([
        'cf_identity can mark sessions as MFA-verified directly',
        'cf_identity can read TOTP secrets',
      ]));
    } finally {
      await owner.query('REVOKE UPDATE (mfa_verified_at) ON sessions FROM cf_identity');
      await owner.query('REVOKE SELECT (secret_sealed) ON mfa_factors FROM cf_identity');
      await owner.end();
    }
    expect(await checkIsolation(process.env.DATABASE_URL!)).toEqual([]);
  });
});
