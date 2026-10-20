import { withContext, type Db } from '@conversaflow/database';
import { randomInt } from 'node:crypto';
import { randomToken, sha256 } from '../core/crypto';
import type { Mailer } from '../core/mailer';

type Purpose = 'verify_email' | 'reset_password' | 'signup_existing' | 'mfa_enabled' | 'recovery_code_used' | 'mfa_activate' | 'mfa_reset';

const TTL: Record<'verify_email' | 'reset_password', string> = {
  verify_email: '24 hours',
  reset_password: '1 hour',
};

/**
 * Sends account emails queued by the API. Runs in the worker process under the cf_notify database role —
 * the only role that can issue email-verification and password-reset tokens. The API role cannot.
 * One request per transaction: a token is only recorded if its email was handed to the mail provider.
 */
export class Notifier {
  constructor(
    private readonly db: Db,
    private readonly mailer: Mailer,
    private readonly appOrigin: string,
  ) {}

  /** Processes up to `limit` pending requests; returns how many were handled. */
  async processPending(limit = 50): Promise<number> {
    let handled = 0;
    for (let i = 0; i < limit; i++) {
      const did = await withContext(this.db, { tenantId: null, userId: null }, async (tx) => {
        const { rows } = await tx.query<{ id: string; purpose: Purpose; email: string }>(
          `SELECT id, purpose, email FROM auth_email_requests
           WHERE processed_at IS NULL AND attempts < 5 AND next_attempt_at <= now()
           ORDER BY next_attempt_at LIMIT 1 FOR UPDATE SKIP LOCKED`,
        );
        const req = rows[0];
        if (!req) return false;
        try {
          await this.handle(tx, req as { id: string; purpose: Purpose; email: string });
          await tx.query('UPDATE auth_email_requests SET processed_at = now(), attempts = attempts + 1 WHERE id = $1', [req.id]);
        } catch (err) {
          // Keep the request for a retry; the token issued in this attempt is rolled back with the savepoint.
          await tx.query('ROLLBACK TO SAVEPOINT notify');
          // Back off: 1, 2, 3, 4 minutes; after 5 attempts the request stops and shows up in monitoring.
          await tx.query(
            `UPDATE auth_email_requests SET attempts = attempts + 1, last_error = $2,
                    next_attempt_at = now() + make_interval(mins => attempts + 1) WHERE id = $1`, [
            req.id, String((err as Error).message).slice(0, 300),
          ]);
        }
        return true;
      });
      if (!did) break;
      handled++;
    }
    return handled;
  }

  private async handle(tx: import('@conversaflow/database').Tx, req: { id: string; purpose: Purpose; email: string }): Promise<void> {
    await tx.query('SAVEPOINT notify');
    if (req.purpose === 'mfa_activate') {
      // M7: the database records the code's hash and returns the destination (the stored, verified address).
      const code = String(randomInt(0, 100_000_000)).padStart(8, '0');
      const { rows } = await tx.query<{ to: string | null }>('SELECT auth_mfa_issue_activation($1, $2) AS "to"', [req.id, sha256(code)]);
      const to = rows[0]?.to;
      if (!to) return; // not a live activation any more: nothing is sent
      const shown = `${code.slice(0, 4)} ${code.slice(4)}`;
      await this.mailer.send({
        to,
        subject: 'Your code to finish setting up two-step sign-in',
        text: `Your confirmation code is ${shown}. Enter it on the screen where you are setting up two-step sign-in. It expires in 15 minutes and works only once.\n`
          + 'Never share this code. ConversaFlow staff will never ask for it. If you are not setting up two-step sign-in, ignore this email and '
          + `reset your password at ${this.appOrigin}/forgot-password.\n\n`
          + `رمز التأكيد الخاص بك هو ${shown}. أدخله في الشاشة التي تُعدّ فيها التحقق بخطوتين. ينتهي خلال 15 دقيقة ويُستخدم مرة واحدة فقط.\n`
          + `لا تشارك هذا الرمز مع أي شخص، فموظفو ConversaFlow لن يطلبوه أبدًا. إذا لم تكن تُعدّ التحقق بخطوتين، فتجاهل هذه الرسالة وأعد تعيين كلمة المرور من ${this.appOrigin}/forgot-password.`,
      });
      return;
    }
    if (req.purpose === 'signup_existing') {
      await this.mailer.send({
        to: req.email,
        subject: 'Sign-up attempt on ConversaFlow',
        text: 'Someone tried to create a ConversaFlow account with this email. You already have one; you can sign in or reset your password.',
      });
      return;
    }
    const { rows } = await tx.query<{ user_id: string | null; email: string | null }>('SELECT user_id, email FROM auth_user_for_email($1)', [req.email]);
    const userId = rows[0]?.user_id;
    const to = rows[0]?.email; // the STORED address, never the one typed into the form
    if (!userId || !to) return; // no account: nothing is sent, and the API already answered the same either way
    if (req.purpose === 'mfa_reset') {
      await this.mailer.send({
        to,
        subject: 'Two-step sign-in was reset on your account',
        text: 'Two Meronatic platform owners approved a reset of two-step sign-in on your ConversaFlow account, after checking your identity. '
          + 'All your sessions were signed out. Sign in and set up two-step sign-in again.\n'
          + `If you did not ask for this, reset your password now at ${this.appOrigin}/forgot-password and tell your company administrator.\n\n`
          + 'وافق مالكان من فريق منصة Meronatic على إعادة تعيين التحقق بخطوتين لحسابك في ConversaFlow بعد التحقق من هويتك. تم تسجيل خروجك من جميع الجلسات. سجّل الدخول وأعد إعداد التحقق بخطوتين.\n'
          + `إذا لم تطلب ذلك، أعد تعيين كلمة المرور الآن من ${this.appOrigin}/forgot-password وأبلغ مسؤول شركتك.`,
      });
      return;
    }
    if (req.purpose === 'mfa_enabled' || req.purpose === 'recovery_code_used') {
      // Security notices (mitigation M5): no token, no link that signs anyone in; the reset page is public anyway.
      const what = req.purpose === 'mfa_enabled'
        ? ['Two-step sign-in was turned on for your ConversaFlow account.', 'تم تفعيل التحقق بخطوتين لحسابك في ConversaFlow.']
        : ['A recovery code was used to sign in to your ConversaFlow account.', 'تم استخدام رمز استرداد لتسجيل الدخول إلى حسابك في ConversaFlow.'];
      await this.mailer.send({
        to,
        subject: req.purpose === 'mfa_enabled' ? 'Two-step sign-in turned on' : 'Recovery code used',
        text: `${what[0]}\nIf this was not you, reset your password now at ${this.appOrigin}/forgot-password and tell your company administrator.\n\n`
          + `${what[1]}\nإذا لم تقم بذلك، أعد تعيين كلمة المرور الآن من ${this.appOrigin}/forgot-password وأبلغ مسؤول شركتك.`,
      });
      return;
    }
    const token = randomToken();
    await tx.query('SELECT auth_issue_token($1, $2, $3, $4::interval)', [userId, req.purpose, sha256(token), TTL[req.purpose]]);
    if (req.purpose === 'verify_email') {
      await this.mailer.send({
        to,
        subject: 'Verify your email for ConversaFlow',
        text: `Open this link to verify your email: ${this.appOrigin}/verify-email?token=${token}`,
      });
    } else {
      await this.mailer.send({
        to,
        subject: 'Reset your ConversaFlow password',
        text: `Open this link within one hour to choose a new password: ${this.appOrigin}/reset-password?token=${token}`,
      });
    }
  }
}
