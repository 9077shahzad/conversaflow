/**
 * Pre-pilot item 1: credential-change permissions (closes review finding 4 / ADR-024).
 * The business API's database role (cf_app) must not be able to change, mint or read anything that controls
 * sign-in. Each attempt below must be REFUSED, and the victim's credentials must be UNCHANGED afterwards.
 */
import { authenticator } from 'otplib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, withContext, type Db } from '@conversaflow/database';
import { checkIsolation } from '@conversaflow/database/dist/check-rls';
import { sha256 } from '../src/core/crypto';
import { Notifier } from '../src/worker/notifier';
import { asAuthRole, Client, clearRateLimits, enableMfa, newUser, nextTotp, PASSWORD, startApp, type TestApp } from './helpers';

let t: TestApp;
let victim: Client;
let app: Db; // cf_app — what a SQL-injection flaw in business code would run as

/** Everything that controls the victim's sign-in, read through the identity role. */
async function fingerprint() {
  // Read as cf_auth: since migration 0010 no login role can read MFA secrets or recovery codes.
  return asAuthRole(t, async (tx) => ({
    password: (await tx.query('SELECT password_hash FROM user_credentials WHERE user_id = $1', [victim.userId])).rows[0].password_hash,
    mfa: (await tx.query('SELECT id, secret_sealed, confirmed_at FROM mfa_factors WHERE user_id = $1 ORDER BY id', [victim.userId])).rows,
    recovery: (await tx.query('SELECT id, code_hash, used_at FROM mfa_recovery_codes WHERE user_id = $1 ORDER BY id', [victim.userId])).rows,
    sessions: (await tx.query('SELECT id, revoked_at, mfa_verified_at FROM sessions WHERE user_id = $1 ORDER BY id', [victim.userId])).rows,
    user: (await tx.query('SELECT email, email_verified_at, status FROM users WHERE id = $1', [victim.userId])).rows[0],
  }));
}

beforeAll(async () => {
  t = await startApp();
  app = t.deps.db;
  victim = await newUser(t, 'victim');
  await enableMfa(victim);
});
afterAll(() => t?.close());

describe('the business API role cannot change credentials', () => {
  it('every credential-changing attempt is refused, and the victim is unchanged', async () => {
    const before = await fingerprint();
    const asVictim = { tenantId: null, userId: victim.userId! }; // an attacker can set any context
    const attempts: Array<[string, (db: Db) => Promise<unknown>]> = [
      ['mint a password-reset token', (db) => db.query("SELECT auth_issue_token($1, 'reset_password', $2, interval '1 hour')", [victim.userId, sha256('attacker-token')])],
      ['reset a password with a token', (db) => db.query('SELECT auth_reset_password($1, $2)', [sha256('attacker-token'), '$argon2id$fake'])],
      ['mark an email verified', (db) => db.query('SELECT auth_verify_email($1)', [sha256('x')])],
      ['look up a user by email for token minting', (db) => db.query('SELECT auth_user_id_by_email($1)', [victim.email])],
      ['read password hashes', (db) => db.query('SELECT * FROM auth_credentials_by_email($1)', [victim.email])],
      ['overwrite the password hash', (db) => withContext(db, asVictim, (tx) => tx.query("UPDATE user_credentials SET password_hash = 'x'"))],
      ['insert credentials', (db) => withContext(db, asVictim, (tx) => tx.query("INSERT INTO user_credentials (user_id, password_hash) VALUES ($1, 'x')", [victim.userId]))],
      ['delete the MFA factor', (db) => withContext(db, asVictim, (tx) => tx.query('DELETE FROM mfa_factors'))],
      ['add an attacker MFA factor', (db) => withContext(db, asVictim, (tx) => tx.query("INSERT INTO mfa_factors (user_id, type, secret_enc, confirmed_at) VALUES ($1, 'totp', 'x', now())", [victim.userId]))],
      ['reset recovery codes', (db) => withContext(db, asVictim, (tx) => tx.query('UPDATE mfa_recovery_codes SET used_at = NULL'))],
      ['open a session for the victim', (db) => withContext(db, asVictim, (tx) => tx.query("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')", [sha256('s'), victim.userId]))],
      ['mark a session MFA-verified', (db) => withContext(db, asVictim, (tx) => tx.query('UPDATE sessions SET mfa_verified_at = now()'))],
      ['read session token hashes', (db) => withContext(db, asVictim, (tx) => tx.query('SELECT token_hash FROM sessions'))],
      ['read queued account emails', (db) => db.query('SELECT * FROM auth_email_requests')],
      ['read issued tokens', (db) => db.query('SELECT * FROM auth_tokens')],
      ['change the email address', (db) => withContext(db, asVictim, (tx) => tx.query("UPDATE users SET email = 'attacker@example.test'"))],
      ['set email verified', (db) => withContext(db, asVictim, (tx) => tx.query('UPDATE users SET email_verified_at = now()'))],
    ];
    for (const [what, run] of attempts) {
      await expect(run(app), `cf_app could ${what}`).rejects.toMatchObject({ code: '42501' });
    }
    expect(await fingerprint()).toEqual(before);

    // ...and the victim can still sign in exactly as before, with MFA still required.
    await clearRateLimits(t);
    const s = new Client(t, victim.email);
    expect((await s.post('/v1/auth/login', { email: victim.email, password: PASSWORD }).expect(200)).body).toEqual({ mfaRequired: true });
    await s.get('/v1/me').expect(401);
  });

  it('the identity role cannot mint email tokens or read company data', async () => {
    const id = t.deps.identityDb;
    await expect(id.query("SELECT auth_issue_token($1, 'reset_password', $2, interval '1 hour')", [victim.userId, sha256('x')]))
      .rejects.toMatchObject({ code: '42501' });
    for (const table of ['files', 'tenants', 'audit_events', 'invitations', 'roles', 'user_credentials', 'auth_tokens']) {
      await expect(id.query(`SELECT * FROM ${table} LIMIT 1`), table).rejects.toMatchObject({ code: '42501' });
    }
    // Another user's MFA data is invisible even to the identity role.
    const other = await newUser(t, 'other');
    const seen = await withContext(id, { tenantId: null, userId: other.userId! }, async (tx) =>
      (await tx.query('SELECT count(*)::int AS n FROM mfa_factors WHERE user_id = $1', [victim.userId])).rows[0].n);
    expect(seen).toBe(0);
  });

  it('the notifier role can only read the email queue', async () => {
    for (const table of ['users', 'sessions', 'user_credentials', 'files', 'tenants', 'auth_tokens', 'mfa_factors']) {
      await expect(t.notifyDb.query(`SELECT * FROM ${table} LIMIT 1`), table).rejects.toMatchObject({ code: '42501' });
    }
  });

  it('reset links are only created by the notifier, and the API response never contains one', async () => {
    const res = await new Client(t, 'x').post('/v1/auth/password/forgot', { email: victim.email }).expect(202);
    expect(JSON.stringify(res.body)).not.toMatch(/token/i);
    const before = t.mailer.sent.length;
    expect(await t.deliver()).toBeGreaterThan(0);
    expect(t.mailer.sent.length).toBe(before + 1);
    expect(t.mailer.lastTo(victim.email)?.subject).toBe('Reset your ConversaFlow password');
  });

  it('if the email cannot be sent, no usable token is left behind and the request is retried', async () => {
    const failing = new Notifier(t.notifyDb, { send: async () => { throw new Error('SMTP down'); } }, 'http://x');
    const email = victim.email;
    await new Client(t, 'y').post('/v1/auth/password/forgot', { email }).expect(202);
    await failing.processPending();
    const pending = await t.notifyDb.query('SELECT attempts, processed_at, last_error FROM auth_email_requests WHERE email = $1 ORDER BY requested_at DESC LIMIT 1', [email]);
    expect(pending.rows[0]).toMatchObject({ attempts: 1, processed_at: null, last_error: 'SMTP down' });
    expect(await failing.processPending()).toBe(0); // backing off: not retried immediately
    await t.notifyDb.query('UPDATE auth_email_requests SET next_attempt_at = now() WHERE email = $1 AND processed_at IS NULL', [email]);
    await t.deliver(); // the real notifier succeeds on retry
    const done = await t.notifyDb.query('SELECT processed_at FROM auth_email_requests WHERE email = $1 ORDER BY requested_at DESC LIMIT 1', [email]);
    expect(done.rows[0].processed_at).not.toBeNull();
  });

  it('the CI guard fails the build if the API role ever regains a credential right', async () => {
    const owner = createPool(process.env.DATABASE_URL!, 1);
    try {
      await owner.query('GRANT UPDATE ON user_credentials TO cf_app');
      const problems = await checkIsolation(process.env.DATABASE_URL!);
      expect(problems).toContain('cf_app has privileges on credential table user_credentials');
    } finally {
      await owner.query('REVOKE UPDATE ON user_credentials FROM cf_app');
      await owner.end();
    }
    expect(await checkIsolation(process.env.DATABASE_URL!)).toEqual([]);
  });
});

describe('session expiry (pre-pilot item 2)', () => {
  const setLastSeen = (c: Client, minutesAgo: number) =>
    withContext(t.deps.identityDb, { tenantId: null, userId: c.userId! }, (tx) =>
      tx.query("UPDATE sessions SET last_seen_at = now() - make_interval(mins => $1) WHERE revoked_at IS NULL", [minutesAgo]));

  it('a session idle for longer than the limit is ended for good; data stays unchanged', async () => {
    const c = await newUser(t, 'idle');
    const name = (await c.get('/v1/me').expect(200)).body.fullName;
    await setLastSeen(c, t.deps.config.SESSION_IDLE_MINUTES + 1);
    expect((await c.get('/v1/me').expect(401)).body.error.code).toBe('unauthenticated');
    await setLastSeen(c, 0); // even "activity" afterwards cannot revive it
    await c.get('/v1/me').expect(401);
    const row = await withContext(t.deps.identityDb, { tenantId: null, userId: c.userId! }, async (tx) =>
      (await tx.query('SELECT revoke_reason FROM sessions ORDER BY created_at DESC LIMIT 1')).rows[0]);
    expect(row.revoke_reason).toBe('idle');
    await clearRateLimits(t);
    const again = new Client(t, c.email);
    await again.post('/v1/auth/login', { email: c.email, password: PASSWORD }).expect(200);
    expect((await again.get('/v1/me').expect(200)).body.fullName).toBe(name);
  });

  it('a session still in use but past its absolute lifetime is refused', async () => {
    const c = await newUser(t, 'absolute');
    const owner = createPool(process.env.DATABASE_URL!, 1);
    try {
      await owner.query("UPDATE sessions SET expires_at = now() - interval '1 second' WHERE user_id = $1", [c.userId]);
    } finally {
      await owner.end();
    }
    await c.get('/v1/me').expect(401);
  });

  it('new sessions last the configured absolute lifetime', async () => {
    const c = await newUser(t, 'lifetime');
    const row = await withContext(t.deps.identityDb, { tenantId: null, userId: c.userId! }, async (tx) =>
      (await tx.query('SELECT extract(epoch FROM expires_at - created_at)::int AS secs FROM sessions LIMIT 1')).rows[0]);
    expect(Math.abs(row.secs - t.deps.config.SESSION_ABSOLUTE_HOURS * 3600)).toBeLessThan(5);
  });

  it('turning on two-step verification signs out the other sessions', async () => {
    const c = await newUser(t, 'mfaon');
    await clearRateLimits(t);
    const laptop = new Client(t, c.email);
    await laptop.post('/v1/auth/login', { email: c.email, password: PASSWORD }).expect(200);
    await laptop.get('/v1/me').expect(200);
    await enableMfa(c);
    await laptop.get('/v1/me').expect(401);
    await c.get('/v1/me').expect(200);
  });

  it('the database refuses unreasonable idle settings', async () => {
    await expect(t.deps.identityDb.query("SELECT * FROM auth_session_lookup($1, interval '1 minute')", [sha256('x')]))
      .rejects.toThrow(/idle timeout out of range/);
  });
});

describe('two-step codes after sign-in', () => {
  it('a fresh code works once', async () => {
    await clearRateLimits(t);
    const s = new Client(t, victim.email);
    await s.post('/v1/auth/login', { email: victim.email, password: PASSWORD }).expect(200);
    const code = await nextTotp(victim);
    expect(authenticator.check(code, victim.mfaSecret!)).toBe(true);
    await s.post('/v1/auth/mfa/challenge', { code }).expect(204);
    await s.get('/v1/me').expect(200);
  }, 45_000);
});
