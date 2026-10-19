import { withContext, type Db } from '@conversaflow/database';
import { randomToken, sha256 } from '../core/crypto';
import type { Mailer } from '../core/mailer';

type Purpose = 'verify_email' | 'reset_password' | 'signup_existing';

const TTL: Record<Exclude<Purpose, 'signup_existing'>, string> = {
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
          await this.handle(tx, req);
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

  private async handle(tx: import('@conversaflow/database').Tx, req: { purpose: Purpose; email: string }): Promise<void> {
    await tx.query('SAVEPOINT notify');
    if (req.purpose === 'signup_existing') {
      await this.mailer.send({
        to: req.email,
        subject: 'Sign-up attempt on ConversaFlow',
        text: 'Someone tried to create a ConversaFlow account with this email. You already have one; you can sign in or reset your password.',
      });
      return;
    }
    const { rows } = await tx.query<{ id: string | null }>('SELECT auth_user_id_by_email($1) AS id', [req.email]);
    const userId = rows[0]?.id;
    if (!userId) return; // no account: nothing is sent, and the API already answered the same either way
    const token = randomToken();
    await tx.query('SELECT auth_issue_token($1, $2, $3, $4::interval)', [userId, req.purpose, sha256(token), TTL[req.purpose]]);
    if (req.purpose === 'verify_email') {
      await this.mailer.send({
        to: req.email,
        subject: 'Verify your email for ConversaFlow',
        text: `Open this link to verify your email: ${this.appOrigin}/verify-email?token=${token}`,
      });
    } else {
      await this.mailer.send({
        to: req.email,
        subject: 'Reset your ConversaFlow password',
        text: `Open this link within one hour to choose a new password: ${this.appOrigin}/reset-password?token=${token}`,
      });
    }
  }
}
