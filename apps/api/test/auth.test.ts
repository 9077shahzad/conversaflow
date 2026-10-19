/** Sign-up, email verification, sign-in, two-step verification, sessions and password reset. */
import { authenticator } from 'otplib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clearRateLimits, Client, enableMfa, newUser, nextTotp, PASSWORD, startApp, tokenFrom, uniqueEmail, type TestApp } from './helpers';

let t: TestApp;
beforeAll(async () => {
  t = await startApp();
});
afterAll(() => t?.close());

describe('sign-up and email verification', () => {
  it('signs up, verifies the email, signs in and reads the profile', async () => {
    const c = await newUser(t, 'sam');
    const me = (await c.get('/v1/me').expect(200)).body;
    expect(me).toMatchObject({ email: c.email, emailVerified: true, mfaEnabled: false, activeTenantId: null });
  });

  it('answers sign-up identically for an existing email, and warns the owner by email instead', async () => {
    const c = await newUser(t, 'dup');
    const again = await new Client(t, c.email).post('/v1/auth/signup', { email: c.email, password: PASSWORD, fullName: 'X' }).expect(202);
    const fresh = await new Client(t, 'x').post('/v1/auth/signup', { email: uniqueEmail('new'), password: PASSWORD, fullName: 'Y' }).expect(202);
    expect(again.body).toEqual(fresh.body);
    expect(t.mailer.lastTo(c.email)?.subject).toBe('Sign-up attempt on ConversaFlow');
  });

  it('refuses weak passwords', async () => {
    await clearRateLimits(t);
    const email = uniqueEmail('weak');
    const res = await new Client(t, email).post('/v1/auth/signup', { email, password: 'short', fullName: 'W' }).expect(400);
    expect(res.body.error.code).toBe('bad_request');
    await new Client(t, email).post('/v1/auth/signup', { email, password: 'password1234', fullName: 'W' }).expect(400);
  });

  it('does not allow sign-in before the email is verified', async () => {
    await clearRateLimits(t);
    const c = new Client(t, uniqueEmail('unverified'));
    await c.post('/v1/auth/signup', { email: c.email, password: PASSWORD, fullName: 'U' }).expect(202);
    const res = await c.post('/v1/auth/login', { email: c.email, password: PASSWORD }).expect(403);
    expect(res.body.error.code).toBe('email_not_verified');
  });

  it('a verification link works once only', async () => {
    await clearRateLimits(t);
    const c = new Client(t, uniqueEmail('once'));
    await c.post('/v1/auth/signup', { email: c.email, password: PASSWORD, fullName: 'O' }).expect(202);
    const token = tokenFrom(t.mailer, c.email);
    await c.post('/v1/auth/verify-email', { token }).expect(204);
    await c.post('/v1/auth/verify-email', { token }).expect(403);
  });
});

describe('sign-in', () => {
  it('gives the same answer for a wrong password and an unknown email', async () => {
    const c = await newUser(t, 'pw');
    const wrong = await new Client(t, c.email).post('/v1/auth/login', { email: c.email, password: 'Wrong-password-123' }).expect(401);
    const unknown = await new Client(t, 'u').post('/v1/auth/login', { email: uniqueEmail('nobody'), password: 'Wrong-password-123' }).expect(401);
    expect(wrong.body).toEqual(unknown.body);
  });

  it('locks out repeated attempts on one account (rate limit)', async () => {
    const c = await newUser(t, 'brute');
    const attacker = new Client(t, c.email);
    for (let i = 0; i < 10; i++) await attacker.post('/v1/auth/login', { email: c.email, password: `Guess-number-${i}x` }).expect(401);
    const res = await attacker.post('/v1/auth/login', { email: c.email, password: PASSWORD }).expect(429);
    expect(res.body.error.code).toBe('rate_limited');
  });

  it('blocks state-changing requests without the anti-forgery header', async () => {
    const c = await newUser(t, 'csrf');
    const res = await c.agent.post('/v1/tenants').send({}).expect(403);
    expect(res.body.error.code).toBe('csrf');
    await c.agent.post('/v1/auth/logout').set('X-Requested-With', 'conversaflow').set('Origin', 'https://evil.example').expect(403);
  });

  it('sets a hardened session cookie and stores only hashes of secrets', async () => {
    await clearRateLimits(t);
    const c = await newUser(t, 'cookie');
    const res = await new Client(t, c.email).post('/v1/auth/login', { email: c.email, password: PASSWORD }).expect(200);
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/cf_session=/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    const value = decodeURIComponent(cookie.match(/cf_session=([^;]+)/)![1]!);
    const { withContext } = await import('@conversaflow/database');
    const stored = await withContext(t.deps.db, { tenantId: null, userId: c.userId! }, async (tx) => ({
      password: (await tx.query('SELECT password_hash FROM user_credentials')).rows[0].password_hash as string,
      tokens: (await tx.query('SELECT token_hash FROM sessions')).rows.map((r) => r.token_hash as Buffer),
    }));
    expect(stored.password.startsWith('$argon2id$')).toBe(true);
    expect(stored.password).not.toContain(PASSWORD);
    for (const h of stored.tokens) {
      expect(h).toHaveLength(32); // SHA-256 digest, never the cookie value itself
      expect(h.toString('utf8')).not.toContain(value);
    }
    const viaHash = await t.deps.db.query("SELECT count(*)::int AS n FROM auth_session_lookup(sha256(convert_to($1, 'UTF8')))", [value]);
    expect(viaHash.rows[0].n).toBe(1);
  });
});

describe('two-step verification (TOTP)', () => {
  it('after enabling, sign-in requires the code; the account is unusable until it is entered', { timeout: 45_000 }, async () => {
    const c = await newUser(t, 'mfa');
    await enableMfa(c);
    await c.post('/v1/auth/logout').expect(204);
    await c.get('/v1/me').expect(401);

    await clearRateLimits(t);
    const login = await c.post('/v1/auth/login', { email: c.email, password: PASSWORD }).expect(200);
    expect(login.body).toEqual({ mfaRequired: true });
    const blocked = await c.get('/v1/me').expect(401);
    expect(blocked.body.error.code).toBe('mfa_required');

    await c.post('/v1/auth/mfa/challenge', { code: '000000' }).expect(401);
    await c.post('/v1/auth/mfa/challenge', { code: await nextTotp(c) }).expect(204);
    expect((await c.get('/v1/me').expect(200)).body.mfaEnabled).toBe(true);
  });

  it('recovery codes work exactly once', async () => {
    const c = await newUser(t, 'recover');
    const setup = await c.post('/v1/auth/mfa/totp/setup').expect(201);
    const confirm = await c.post('/v1/auth/mfa/totp/confirm', { code: authenticator.generate(setup.body.secret) }).expect(201);
    const codes: string[] = confirm.body.recoveryCodes;
    expect(codes).toHaveLength(10);

    await clearRateLimits(t);
    const s1 = new Client(t, c.email);
    await s1.post('/v1/auth/login', { email: c.email, password: PASSWORD }).expect(200);
    await s1.post('/v1/auth/mfa/challenge', { recoveryCode: codes[0] }).expect(204);
    await s1.get('/v1/me').expect(200);

    const s2 = new Client(t, c.email);
    await s2.post('/v1/auth/login', { email: c.email, password: PASSWORD }).expect(200);
    await s2.post('/v1/auth/mfa/challenge', { recoveryCode: codes[0] }).expect(401);
  });

  it('limits guessing of codes per session', async () => {
    const c = await newUser(t, 'guess');
    await enableMfa(c);
    await clearRateLimits(t);
    const s = new Client(t, c.email);
    await s.post('/v1/auth/login', { email: c.email, password: PASSWORD }).expect(200);
    for (let i = 0; i < 6; i++) await s.post('/v1/auth/mfa/challenge', { code: '123456' }).expect(401);
    await s.post('/v1/auth/mfa/challenge', { code: authenticator.generate(c.mfaSecret!) }).expect(429);
  });
});

describe('sessions and password reset', () => {
  it('a user can see their sessions and sign one out remotely', async () => {
    const c = await newUser(t, 'multi');
    await clearRateLimits(t);
    const laptop = new Client(t, c.email);
    await laptop.post('/v1/auth/login', { email: c.email, password: PASSWORD }).expect(200);
    const list = (await c.get('/v1/auth/sessions').expect(200)).body;
    expect(list).toHaveLength(2);
    const other = list.find((s: { current: boolean }) => !s.current);
    await c.delete(`/v1/auth/sessions/${other.id}`).expect(204);
    await laptop.get('/v1/me').expect(401);
    await c.get('/v1/me').expect(200);
  });

  it("one user cannot sign out another user's session", async () => {
    const x = await newUser(t, 'x');
    const y = await newUser(t, 'y');
    const ySession = (await y.get('/v1/auth/sessions').expect(200)).body[0].id;
    await x.delete(`/v1/auth/sessions/${ySession}`).expect(404);
    await y.get('/v1/me').expect(200);
  });

  it('password reset: same answer for unknown emails, link works once, all old sessions end', async () => {
    const c = await newUser(t, 'reset');
    const a = await new Client(t, c.email).post('/v1/auth/password/forgot', { email: c.email }).expect(202);
    const b = await new Client(t, 'z').post('/v1/auth/password/forgot', { email: uniqueEmail('ghost') }).expect(202);
    expect(a.body).toEqual(b.body);

    const token = tokenFrom(t.mailer, c.email);
    const newPassword = 'Another-Strong-Pass-42';
    await c.post('/v1/auth/password/reset', { token, password: newPassword }).expect(204);
    await c.post('/v1/auth/password/reset', { token, password: 'Third-Strong-Pass-77' }).expect(403);
    await c.get('/v1/me').expect(401); // old session revoked

    await clearRateLimits(t);
    await new Client(t, c.email).post('/v1/auth/login', { email: c.email, password: PASSWORD }).expect(401);
    await new Client(t, c.email).post('/v1/auth/login', { email: c.email, password: newPassword }).expect(200);
  });
});

describe('two-step verification hardening (independent review findings)', () => {
  it('signing in again does not reset the allowance for guessing codes', async () => {
    const c = await newUser(t, 'relog');
    await enableMfa(c);
    await clearRateLimits(t);
    let refused = false;
    for (let attempt = 0; attempt < 4 && !refused; attempt++) {
      const s = new Client(t, c.email);
      await t.deps.redis.del(`rl:login:email:${c.email}`, 'rl:login:ip:::ffff:127.0.0.1', 'rl:login:ip:127.0.0.1');
      await s.post('/v1/auth/login', { email: c.email, password: PASSWORD }).expect(200);
      for (let i = 0; i < 6; i++) {
        const r = await s.post('/v1/auth/mfa/challenge', { code: '111111' });
        if (r.status === 429) refused = true;
      }
    }
    expect(refused).toBe(true); // per-user limit (10 per hour) kicks in across sessions
  });

  it('a code cannot be used twice, even inside its 30-second window', async () => {
    const c = await newUser(t, 'replay');
    await enableMfa(c);
    // The confirmation code was just used; wait for a fresh step so the next one is unused.
    const step = () => Math.floor(Date.now() / 30000);
    const start = step();
    while (step() === start) await new Promise((r) => setTimeout(r, 250));
    const code = authenticator.generate(c.mfaSecret!);
    await clearRateLimits(t);
    const s1 = new Client(t, c.email);
    await s1.post('/v1/auth/login', { email: c.email, password: PASSWORD }).expect(200);
    await s1.post('/v1/auth/mfa/challenge', { code }).expect(204);
    const s2 = new Client(t, c.email);
    await s2.post('/v1/auth/login', { email: c.email, password: PASSWORD }).expect(200);
    await s2.post('/v1/auth/mfa/challenge', { code }).expect(401);
  }, 45_000);
});
