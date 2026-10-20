import { authenticator } from 'otplib';
import { withAnonymous, withContext, type Tx } from '@conversaflow/database';
import { ForgotPasswordRequest, LoginRequest, ResetPasswordRequest, SignupRequest } from '@conversaflow/contracts';
import type { AuthSession, Deps } from '../core/context';
import { randomToken, sha256 } from '../core/crypto';
import { Errors } from '../core/errors';
import { burnPasswordCheck, checkPasswordPolicy, hashPassword, verifyPassword } from '../core/passwords';
import { RATE_RULES } from '../core/rate-limit';
import { parse } from '../core/validate';

authenticator.options = { window: 1 }; // accept the previous and next 30-second code for clock drift

const RECOVERY_CODES = 10;

export interface ClientInfo {
  ip: string;
  userAgent?: string;
}

export class AuthService {
  constructor(private readonly deps: Deps) {}

  /** Same response whether or not the email already has an account (no account enumeration). */
  async signup(input: unknown, client: ClientInfo): Promise<void> {
    const body = parse(SignupRequest, input);
    await this.deps.rateLimiter.hit(RATE_RULES.signupPerIp, client.ip);
    const problem = checkPasswordPolicy(body.password, body.email);
    if (problem) throw Errors.badRequest(problem, [{ field: 'password', message: problem }]);

    const passwordHash = await hashPassword(body.password);
    const userId = await withAnonymous(this.deps.identityDb, async (tx) => {
      const { rows } = await tx.query<{ id: string | null }>('SELECT auth_register_user($1, $2, $3, $4) AS id', [
        body.email, body.fullName, body.locale, passwordHash,
      ]);
      return rows[0]?.id ?? null;
    });

    // The API never sees or mints the token: it queues a request; the notifier (cf_notify) issues and sends it.
    await this.requestEmail(userId ? 'verify_email' : 'signup_existing', body.email);
  }

  private async requestEmail(purpose: 'verify_email' | 'reset_password' | 'signup_existing', email: string): Promise<void> {
    await withAnonymous(this.deps.identityDb, (tx) => tx.query('SELECT auth_request_email($1, $2)', [purpose, email]));
  }

  async verifyEmail(token: string): Promise<void> {
    const userId = await withAnonymous(this.deps.identityDb, async (tx) => {
      const { rows } = await tx.query<{ id: string | null }>('SELECT auth_verify_email($1) AS id', [sha256(String(token))]);
      return rows[0]?.id ?? null;
    });
    if (!userId) throw Errors.invalidLink();
  }

  async login(input: unknown, client: ClientInfo): Promise<{ token: string; mfaRequired: boolean }> {
    const body = parse(LoginRequest, input);
    await this.deps.rateLimiter.hit(RATE_RULES.loginPerIp, client.ip);
    await this.deps.rateLimiter.hit(RATE_RULES.loginPerEmail, body.email);

    const cred = await withAnonymous(this.deps.identityDb, async (tx) => {
      const { rows } = await tx.query<{
        user_id: string; password_hash: string; status: string; email_verified: boolean; has_mfa: boolean;
      }>('SELECT * FROM auth_credentials_by_email($1)', [body.email]);
      return rows[0];
    });
    if (!cred) {
      await burnPasswordCheck(body.password);
      throw Errors.invalidCredentials();
    }
    if (!(await verifyPassword(cred.password_hash, body.password)) || cred.status !== 'active') {
      throw Errors.invalidCredentials();
    }
    if (!cred.email_verified) throw Errors.emailNotVerified();
    await this.deps.rateLimiter.reset(RATE_RULES.loginPerEmail, body.email);

    const token = randomToken();
    await withContext(this.deps.identityDb, { tenantId: null, userId: cred.user_id }, async (tx) => {
      // Default to the first company the user belongs to.
      const { rows } = await tx.query<{ tenant_id: string }>(
        "SELECT tenant_id FROM memberships WHERE user_id = $1 AND status = 'active' ORDER BY created_at LIMIT 1",
        [cred.user_id],
      );
      // Sessions are opened only through a database function that fixes the lifetime (max 12 h) and starts
      // without MFA verified; the identity role cannot insert sessions directly.
      await tx.query('SELECT auth_open_session($1, $2, $3, $4, $5, $6)', [
        cred.user_id, sha256(token), rows[0]?.tenant_id ?? null, client.ip, client.userAgent ?? null,
        this.deps.config.SESSION_ABSOLUTE_HOURS,
      ]);
    });
    return { token, mfaRequired: cred.has_mfa };
  }

  /** Resolves a cookie value to a live session, or null. */
  async authenticate(token: string | undefined): Promise<AuthSession | null> {
    if (!token || token.length > 200) return null;
    const row = await withAnonymous(this.deps.identityDb, async (tx) => {
      const { rows } = await tx.query<{
        session_id: string; user_id: string; active_tenant_id: string | null; mfa_verified_at: Date | null;
      }>('SELECT * FROM auth_session_lookup($1, make_interval(mins => $2))', [sha256(token), this.deps.config.SESSION_IDLE_MINUTES]);
      return rows[0];
    });
    if (!row) return null;
    const userHasMfa = await withContext(this.deps.identityDb, { tenantId: null, userId: row.user_id }, async (tx) => {
      const { rowCount } = await tx.query('SELECT 1 FROM mfa_factors WHERE user_id = $1 AND confirmed_at IS NOT NULL', [row.user_id]);
      return (rowCount ?? 0) > 0;
    });
    return {
      token,
      sessionId: row.session_id,
      userId: row.user_id,
      activeTenantId: row.active_tenant_id,
      mfaVerified: row.mfa_verified_at !== null,
      userHasMfa,
    };
  }

  /**
   * Runs one of the database MFA functions. The database identifies the user from the session token (never from a
   * user id the API supplies), checks the code itself and limits wrong guesses per user.
   */
  private async mfaCall<T>(session: AuthSession, fn: (tx: Tx, tokenHash: Buffer) => Promise<T>): Promise<T> {
    try {
      return await withContext(this.deps.identityDb, { tenantId: null, userId: session.userId }, (tx) => fn(tx, sha256(session.token)));
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === '54000') throw Errors.tooManyRequests(); // database-side guessing limit
      if (code === '23505') throw Errors.conflict('mfa_already_enabled', 'Two-step verification is already on.');
      if (code === '42501') throw Errors.unauthenticated();
      throw err;
    }
  }

  /** Second step of sign-in when the user has two-step verification. */
  async completeMfa(session: AuthSession, input: { code?: string; recoveryCode?: string }): Promise<void> {
    await this.deps.rateLimiter.hit(RATE_RULES.mfaPerSession, session.sessionId);
    await this.deps.rateLimiter.hit(RATE_RULES.mfaPerUser, session.userId);
    const ok = await this.mfaCall(session, async (tx, tokenHash) => {
      const { rows } = await tx.query<{ ok: boolean }>('SELECT auth_mfa_verify($1, $2, $3) AS ok', [
        tokenHash, input.recoveryCode ? null : (input.code ?? null), input.recoveryCode ? sha256(normaliseRecovery(input.recoveryCode)) : null,
      ]);
      return rows[0]!.ok;
    });
    if (!ok) throw Errors.invalidCredentials();
  }

  /** Starts TOTP enrolment. The database creates and seals the secret and returns it once, for the QR code. */
  async beginTotpSetup(session: AuthSession): Promise<{ secret: string; otpauthUrl: string }> {
    if (session.userHasMfa) throw Errors.conflict('mfa_already_enabled', 'Two-step verification is already on.');
    const { secret, email } = await this.mfaCall(session, async (tx, tokenHash) => {
      const s = (await tx.query<{ secret: string }>('SELECT auth_mfa_begin($1) AS secret', [tokenHash])).rows[0]!.secret;
      const e = (await tx.query<{ email: string }>('SELECT email FROM users WHERE id = $1', [session.userId])).rows[0]!.email;
      return { secret: s, email: e };
    });
    return { secret, otpauthUrl: authenticator.keyuri(email, 'ConversaFlow', secret) };
  }

  /**
   * Step 2 of set-up: checks the first authenticator code. Nothing is switched on yet: the database emails a
   * confirmation code to the account's verified address (M7), to be entered in this same session.
   */
  async confirmTotp(session: AuthSession, code: string): Promise<{ status: 'confirmation_email_sent'; expiresInMinutes: number }> {
    const ok = await this.mfaCall(session, async (tx, tokenHash) =>
      (await tx.query<{ ok: boolean }>('SELECT auth_mfa_confirm_code($1, $2) AS ok', [tokenHash, code])).rows[0]!.ok);
    if (!ok) throw Errors.badRequest('That code is not correct. Check the time on your phone and try again.');
    return { status: 'confirmation_email_sent', expiresInMinutes: 15 };
  }

  /**
   * Step 3 of set-up: the code from the confirmation email. Switches two-step verification on, returns single-use
   * recovery codes (shown once; only their hashes are stored), and signs out every other session.
   */
  async activateTotp(session: AuthSession, emailCode: string): Promise<{ recoveryCodes: string[] }> {
    const digits = String(emailCode ?? '').replace(/\D/g, '');
    if (digits.length !== 8) throw Errors.badRequest('Enter the 8-digit code from the confirmation email.');
    const codes = Array.from({ length: RECOVERY_CODES }, () => randomToken(8).replace(/[-_]/g, 'x').slice(0, 10).toLowerCase());
    const ok = await this.mfaCall(session, async (tx, tokenHash) =>
      (await tx.query<{ ok: boolean }>('SELECT auth_mfa_activate($1, $2, $3) AS ok', [tokenHash, sha256(digits), codes.map((c) => sha256(c))])).rows[0]!.ok);
    if (!ok) throw Errors.badRequest('That confirmation code is not correct or has expired. Request a new one by entering an authenticator code again.');
    return { recoveryCodes: codes };
  }

  async logout(session: AuthSession): Promise<void> {
    await this.revokeSession(session, session.sessionId);
  }

  async listSessions(session: AuthSession) {
    return withContext(this.deps.identityDb, { tenantId: null, userId: session.userId }, async (tx) => {
      const { rows } = await tx.query(
        `SELECT id, ip, user_agent AS "userAgent", created_at AS "createdAt", last_seen_at AS "lastSeenAt",
                id = $1 AS current
         FROM sessions WHERE revoked_at IS NULL AND expires_at > now() ORDER BY last_seen_at DESC`,
        [session.sessionId],
      );
      return rows;
    });
  }

  async revokeSession(session: AuthSession, sessionId: string): Promise<void> {
    const count = await withContext(this.deps.identityDb, { tenantId: null, userId: session.userId }, async (tx) => {
      const { rowCount } = await tx.query("UPDATE sessions SET revoked_at = now(), revoke_reason = $2 WHERE id = $1 AND revoked_at IS NULL",
        [sessionId, sessionId === session.sessionId ? 'logout' : 'revoked_by_user']);
      return rowCount ?? 0;
    });
    if (count === 0) throw Errors.notFound('Session');
  }

  /** Always answers the same way, whether or not the account exists. */
  async forgotPassword(input: unknown): Promise<void> {
    const { email } = parse(ForgotPasswordRequest, input);
    await this.deps.rateLimiter.hit(RATE_RULES.forgotPerEmail, email);
    // Queued for the notifier, which only sends if the account exists. Same answer either way.
    await this.requestEmail('reset_password', email);
  }

  async resetPassword(input: unknown): Promise<void> {
    const body = parse(ResetPasswordRequest, input);
    const problem = checkPasswordPolicy(body.password, '');
    if (problem) throw Errors.badRequest(problem, [{ field: 'password', message: problem }]);
    const hash = await hashPassword(body.password);
    const userId = await withAnonymous(this.deps.identityDb, async (tx) => {
      const { rows } = await tx.query<{ id: string | null }>('SELECT auth_reset_password($1, $2) AS id', [sha256(body.token), hash]);
      return rows[0]?.id ?? null;
    });
    if (!userId) throw Errors.invalidLink();
  }

  async me(session: AuthSession) {
    return withContext(this.deps.identityDb, { tenantId: null, userId: session.userId }, async (tx) => {
      const { rows } = await tx.query(
        `SELECT id, email, full_name AS "fullName", locale, email_verified_at IS NOT NULL AS "emailVerified"
         FROM users WHERE id = $1`,
        [session.userId],
      );
      return { ...rows[0], mfaEnabled: session.userHasMfa, activeTenantId: session.activeTenantId };
    });
  }
}

const normaliseRecovery = (code: string) => code.trim().toLowerCase().replace(/\s+/g, '');
