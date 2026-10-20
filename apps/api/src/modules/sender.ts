import { withContext, type Db, type Tx } from '@conversaflow/database';
import { ChannelSendError, STATUS_RANK, type ChannelAdapter, type Provider } from './channels';

/**
 * Reliable outbound sending (BRD v1.2 Wave 1, slice 2; architecture extension AX-3).
 *
 * Every outbound message has exactly one send job. The worker (and, for speed, the API right after a reply) leases a
 * job and processes it inside the message's company context:
 *
 *   1. Under a row lock, check the message is still `queued` and that it may still be sent (opt-out, pause, window,
 *      channel). Mark it `submitting` and COMMIT, before calling the provider.
 *   2. Call the provider with our message id as the callback reference.
 *   3. Record the outcome: `sent` (with the provider id), `failed` (definitely refused), back to `queued` with a later
 *      attempt (definitely not accepted, within the retry limit), or `uncertain` (outcome unknown).
 *
 * If the process stops between 1 and 3, the lease expires and the next attempt finds `submitting`: the provider may
 * have the message, so it is marked `uncertain`, never sent again automatically. A later status webhook carrying our
 * callback reference settles it. A person can retry a failed or uncertain message; that creates a new message.
 */
export const SEND_LIMITS = { maxAttempts: 5, leaseSeconds: 120, baseBackoffSeconds: 5 };
export const SERVICE_WINDOW_MS = 24 * 3600_000;

/** Test hooks that simulate a process stopping at a given point. Never set in production code paths. */
export interface SendFaults { crashBeforeSubmit?: boolean; crashAfterSubmit?: boolean }
export class SimulatedCrash extends Error { constructor(at: string) { super(`simulated crash ${at}`); } }

export type JobOutcome = 'sent' | 'failed' | 'retry_later' | 'uncertain' | 'nothing_to_do';

type JobRow = {
  job_id: string; job_state: string; job_attempts: number; message_id: string; status: string; body: string | null;
  sent_by_membership_id: string | null; conversation_id: string;
};

export class Sender {
  constructor(
    private readonly db: Db,
    private readonly channels: Partial<Record<Provider, ChannelAdapter>>,
    readonly faults: SendFaults = {},
  ) {}

  /** Worker entry point: leases due jobs across companies and processes them. Returns how many were processed. */
  async dispatchDue(limit = 20): Promise<number> {
    const jobs = await withContext(this.db, { tenantId: null, userId: null }, async (tx) =>
      (await tx.query<{ job_id: string; tenant_id: string }>('SELECT * FROM dispatch_claim($1, $2)', [limit, SEND_LIMITS.leaseSeconds])).rows);
    for (const j of jobs) {
      try {
        await this.processJob(j.tenant_id, j.job_id);
      } catch (err) {
        if (err instanceof SimulatedCrash) throw err;
        console.error('send job error', j.job_id, err instanceof Error ? err.message : err);
      }
    }
    return jobs.length;
  }

  /** Leases one job of a company now (used right after a reply, so the agent sees "sent" without waiting). */
  async leaseNow(tenantId: string, jobId: string): Promise<boolean> {
    return withContext(this.db, { tenantId, userId: null }, async (tx) => (await tx.query(
      `UPDATE send_jobs SET state = 'leased', lease_until = now() + make_interval(secs => $2), updated_at = now()
       WHERE id = $1 AND state = 'pending' RETURNING id`, [jobId, SEND_LIMITS.leaseSeconds])).rowCount === 1);
  }

  async processJob(tenantId: string, jobId: string): Promise<JobOutcome> {
    // Step 1: decide and mark `submitting`, committed before anything leaves.
    const prepared = await withContext(this.db, { tenantId, userId: null }, async (tx) => {
      const row = (await tx.query<JobRow>(
        `SELECT j.id AS job_id, j.state AS job_state, j.attempts AS job_attempts, m.id AS message_id, m.status, m.body,
                m.sent_by_membership_id, m.conversation_id
         FROM send_jobs j JOIN messages m ON m.id = j.message_id WHERE j.id = $1 FOR UPDATE OF j, m`, [jobId])).rows[0];
      if (!row || row.job_state === 'done' || row.job_state === 'dead') return { done: 'nothing_to_do' as const };

      if (row.status === 'submitting') {
        // A previous attempt stopped after it may have reached the provider. Never send again automatically.
        await this.finish(tx, row, 'uncertain', 'interrupted', 'done');
        return { done: 'uncertain' as const };
      }
      if (row.status !== 'queued') {
        await tx.query(`UPDATE send_jobs SET state = 'done', lease_until = NULL, updated_at = now() WHERE id = $1`, [jobId]);
        return { done: 'nothing_to_do' as const };
      }

      const ctx = (await tx.query<{
        opted_out: boolean; last_inbound_at: Date | null; paused: boolean; paused_by: string | null; channel_status: string;
        provider: Provider; number: string; wa: string | null;
      }>(
        `SELECT (ct.opted_out_at IS NOT NULL) AS opted_out, c.last_inbound_at,
                (c.paused_at IS NOT NULL AND (c.paused_until IS NULL OR c.paused_until > now())) AS paused,
                c.paused_by_membership_id AS paused_by, ch.status AS channel_status, ch.provider, ch.provider_number_id AS number,
                (SELECT value FROM contact_identifiers ci WHERE ci.contact_id = ct.id AND ci.kind = 'whatsapp' LIMIT 1) AS wa
         FROM conversations c JOIN contacts ct ON ct.id = c.contact_id JOIN channel_connections ch ON ch.id = c.connection_id
         WHERE c.id = $1`, [row.conversation_id])).rows[0]!;
      // Conditions can change while a message waits; they are checked again at the moment of sending.
      const refusal =
        ctx.opted_out ? 'contact_opted_out'
        : ctx.paused && ctx.paused_by !== row.sent_by_membership_id ? 'replies_paused'
        : ctx.channel_status !== 'active' ? 'channel_disabled'
        : !ctx.last_inbound_at || Date.now() - ctx.last_inbound_at.getTime() >= SERVICE_WINDOW_MS ? 'template_required'
        : !ctx.wa ? 'no_whatsapp_identifier'
        : null;
      if (refusal) {
        await this.finish(tx, row, 'failed', refusal, 'done');
        return { done: 'failed' as const };
      }
      if (this.faults.crashBeforeSubmit) throw new SimulatedCrash('before submission');
      await tx.query(`UPDATE messages SET status = 'submitting', attempts = attempts + 1 WHERE id = $1`, [row.message_id]);
      await tx.query(`UPDATE send_jobs SET attempts = attempts + 1, updated_at = now() WHERE id = $1`, [jobId]);
      return { row, provider: ctx.provider, number: ctx.number, to: ctx.wa as string };
    });
    if ('done' in prepared) return prepared.done as JobOutcome;

    // Step 2: the provider call.
    let providerMessageId: string | null = null;
    let failure: ChannelSendError | null = null;
    try {
      const adapter = this.channels[prepared.provider];
      if (!adapter) throw new ChannelSendError('provider_not_available', 'Provider not available.', 'rejected');
      providerMessageId = (await adapter.sendText({
        providerNumberId: prepared.number, to: prepared.to, body: prepared.row.body ?? '', callbackData: prepared.row.message_id,
      })).providerMessageId;
    } catch (err) {
      // Anything we cannot classify is treated as uncertain: it may have been accepted.
      failure = err instanceof ChannelSendError ? err : new ChannelSendError('send_error', 'Unexpected send error.', 'uncertain');
    }
    if (this.faults.crashAfterSubmit) throw new SimulatedCrash('after submission');

    // Step 3: record the outcome.
    return withContext(this.db, { tenantId, userId: null }, async (tx) => {
      const row = (await tx.query<JobRow>(
        `SELECT j.id AS job_id, j.state AS job_state, j.attempts AS job_attempts, m.id AS message_id, m.status, m.body,
                m.sent_by_membership_id, m.conversation_id
         FROM send_jobs j JOIN messages m ON m.id = j.message_id WHERE j.id = $1 FOR UPDATE OF j, m`, [jobId])).rows[0]!;
      if (providerMessageId) {
        await lockProviderId(tx, providerMessageId);
        // `uncertain` is allowed too: another attempt may have given up on this one while it was still running.
        await tx.query(
          `UPDATE messages SET status = 'sent', provider_message_id = $2, error_code = NULL WHERE id = $1 AND status IN ('submitting', 'uncertain')`,
          [row.message_id, providerMessageId]);
        await tx.query(`UPDATE send_jobs SET state = 'done', lease_until = NULL, last_error = NULL, updated_at = now() WHERE id = $1`, [jobId]);
        await applyOrphanStatuses(tx, row.message_id, providerMessageId);
        return 'sent' as const;
      }
      const f = failure!;
      if (f.kind === 'not_accepted' && row.job_attempts < SEND_LIMITS.maxAttempts) {
        const delay = SEND_LIMITS.baseBackoffSeconds * 2 ** (row.job_attempts - 1);
        await tx.query(`UPDATE messages SET status = 'queued', error_code = $2 WHERE id = $1 AND status = 'submitting'`, [row.message_id, f.code]);
        await tx.query(
          `UPDATE send_jobs SET state = 'pending', lease_until = NULL, last_error = $2,
                  next_attempt_at = now() + make_interval(secs => $3), updated_at = now() WHERE id = $1`,
          [jobId, f.code, delay]);
        return 'retry_later' as const;
      }
      if (f.kind === 'not_accepted') {
        await this.finish(tx, row, 'failed', `retries_exhausted:${f.code}`.slice(0, 100), 'dead');
        return 'failed' as const;
      }
      await this.finish(tx, row, f.kind === 'uncertain' ? 'uncertain' : 'failed', f.code, 'done');
      return f.kind === 'uncertain' ? ('uncertain' as const) : ('failed' as const);
    });
  }

  private async finish(tx: Tx, row: JobRow, status: 'failed' | 'uncertain', code: string, jobState: 'done' | 'dead') {
    await tx.query(`UPDATE messages SET status = $2, error_code = $3 WHERE id = $1`, [row.message_id, status, code.slice(0, 100)]);
    await tx.query(`UPDATE send_jobs SET state = $2, lease_until = NULL, last_error = $3, updated_at = now() WHERE id = $1`,
      [row.job_id, jobState, code.slice(0, 200)]);
  }
}

/** Serialises everything that touches one provider message id, so a status can never slip between two steps. */
export async function lockProviderId(tx: Tx, providerMessageId: string) {
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`wamid:${providerMessageId}`]);
}

/** Applies a delivery status. Statuses only move forward. Matches by provider id, or by our callback reference. */
export async function applyStatus(
  tx: Tx, providerMessageId: string, status: string, errorCode: string | null, callbackData: string | null,
): Promise<'applied' | 'stale_status' | 'orphan_status'> {
  await lockProviderId(tx, providerMessageId);
  const rank = STATUS_RANK[status];
  const byId = await tx.query(
    `UPDATE messages SET status = $2, error_code = CASE WHEN $2 = 'failed' THEN coalesce($3, error_code) ELSE NULL END
     WHERE provider_message_id = $1 AND direction = 'out'
       AND (CASE status WHEN 'queued' THEN 0 WHEN 'submitting' THEN 0 WHEN 'uncertain' THEN 0 WHEN 'sent' THEN 1
                        WHEN 'delivered' THEN 2 WHEN 'read' THEN 3 WHEN 'failed' THEN 4 END) < $4
     RETURNING id`, [providerMessageId, status, errorCode, rank]);
  if (byId.rowCount) return 'applied';
  if (callbackData && /^[0-9a-f-]{36}$/i.test(callbackData)) {
    // A send we did not hear back from (uncertain or still submitting): the callback reference settles it.
    const byRef = await tx.query(
      `UPDATE messages SET status = $2, provider_message_id = $1,
              error_code = CASE WHEN $2 = 'failed' THEN coalesce($3, error_code) ELSE NULL END
       WHERE id = $4::uuid AND direction = 'out' AND provider_message_id IS NULL AND status IN ('submitting', 'uncertain')
       RETURNING id`, [providerMessageId, status, errorCode, callbackData]);
    if (byRef.rowCount) {
      await tx.query(`UPDATE send_jobs SET state = 'done', lease_until = NULL, updated_at = now() WHERE message_id = $1::uuid AND state <> 'dead'`, [callbackData]);
      return 'applied';
    }
  }
  const exists = await tx.query(`SELECT 1 FROM messages WHERE provider_message_id = $1 AND direction = 'out'`, [providerMessageId]);
  return exists.rowCount ? 'stale_status' : 'orphan_status';
}

/** Statuses that arrived before the provider id was recorded (out of order) are applied once it is. */
export async function applyOrphanStatuses(tx: Tx, messageId: string, providerMessageId: string) {
  const orphans = await tx.query<{ id: string; status: string; code: string | null }>(
    `SELECT id, payload->>'status' AS status, payload#>>'{errors,0,code}' AS code FROM webhook_events
     WHERE kind = 'status' AND outcome = 'orphan_status' AND (payload->>'id' = $1 OR payload->>'biz_opaque_callback_data' = $2)
     ORDER BY received_at`, [providerMessageId, messageId]);
  for (const o of orphans.rows) {
    await applyStatus(tx, providerMessageId, o.status, o.code, null);
    await tx.query(`UPDATE webhook_events SET outcome = 'applied', processed_at = now() WHERE id = $1`, [o.id]);
  }
}
