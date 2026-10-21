import { withContext, type Db, type Tx } from '@conversaflow/database';
import type { ObjectStorage } from '../core/storage';
import { ChannelSendError, STATUS_RANK, type ChannelAdapter, type MediaSendInput, type Provider } from './channels';
import { outboundTypeFor } from './media';
import { stopTimerOnReply } from './sla';

/**
 * Reliable outbound sending (BRD v1.2 Wave 1; architecture extension AX-3).
 *
 * Every outbound message has exactly one send job (unique per message). The worker, and the API straight after a
 * reply, leases the job and processes it inside the message's company context:
 *
 *   1. Under a row lock, check the message is still `queued` and may still be sent: the sender still has permission
 *      to reply, the conversation is not assigned to someone else, replies are not paused, the customer has not opted
 *      out, the 24-hour window is open and the channel is on. Mark the message `submitting` and COMMIT, before
 *      anything is sent.
 *   2. Call the provider once, with our message id as the callback reference.
 *   3. Record the outcome.
 *
 * Two different results must never be confused:
 *
 *   - `failed` is a CONFIRMED failure: we know the customer did not receive the message. `failure_kind` says how we
 *     know: `blocked` (our own checks stopped it before sending), `rejected` (the provider refused it), `exhausted`
 *     (the provider answered "not accepted" on every attempt) or `provider_reported` (accepted, then the provider
 *     reported a delivery failure). A person may retry it.
 *   - `uncertain` means we do NOT know: the request may have reached the provider, but we never got its answer
 *     (timeout, lost connection, the process stopped mid-call). It is never re-sent automatically. A person may retry
 *     only after confirming that the customer could receive it twice. A later status webhook carrying our callback
 *     reference settles it (to sent, delivered, read or failed).
 *
 * What stops a message being sent twice when the provider receives the request but its answer is late or never
 * arrives:
 *
 *   a. The only path to the provider is step 1 moving the message from `queued` to `submitting` under a row lock, and
 *      that commit happens before the call. Any later attempt finds `submitting` (or `uncertain`) and does not call
 *      the provider again; it marks the message `uncertain` instead.
 *   b. Only the provider's explicit "not accepted" answer (for example a rate limit) sends a message back to
 *      `queued` for another attempt. A timeout, a reset connection, a server error or anything unrecognised is
 *      classified `uncertain`, because the provider may have accepted it.
 *   c. The provider timeout (`providerTimeoutMs`, 30 s) only limits how long we wait for an answer. It does not stop
 *      the provider from processing a request it has already received, so a timeout is always `uncertain`, never a
 *      failure. A late answer that arrives after we stopped waiting is discarded; the status webhook reconciles it.
 *      If the status webhook arrives first, while we are still waiting, it wins: a timeout or failure never overwrites
 *      a message that is no longer `submitting` (review of slice 3, finding 3).
 *   d. The timeout is well below the lease (120 s), so in normal operation no second worker can lease the job while
 *      the first is still waiting. Duplicate prevention does not depend on this timing: even if a worker stalls past
 *      its lease, rule (a) still applies, and a late `sent` from the stalled worker is recorded against the same
 *      message (allowed from `uncertain`), never as a second message.
 *   e. One send job per message (database constraint), and a person's retry is a new message with its own job,
 *      limited to one per original message across the whole chain (migration 0025).
 */
export const SEND_LIMITS = { maxAttempts: 5, leaseSeconds: 120, baseBackoffSeconds: 5, providerTimeoutMs: 30_000 };
export const SERVICE_WINDOW_MS = 24 * 3600_000;

/** Test hooks that simulate a process stopping at a given point. Never set in production code paths. */
export interface SendFaults { crashBeforeSubmit?: boolean; crashAfterSubmit?: boolean }
export class SimulatedCrash extends Error { constructor(at: string) { super(`simulated crash ${at}`); } }

export type JobOutcome = 'sent' | 'failed' | 'retry_later' | 'uncertain' | 'nothing_to_do';
/** How we know a failed message did not reach the customer (see the comment at the top of this file). */
export type FailureKind = 'blocked' | 'rejected' | 'exhausted' | 'provider_reported';

type JobRow = {
  job_id: string; job_state: string; job_attempts: number; message_id: string; status: string; body: string | null;
  sent_by_membership_id: string | null; conversation_id: string; kind: string; template_id: string | null; template_params: string[] | null;
  file_id: string | null;
};
const JOB_SELECT = `SELECT j.id AS job_id, j.state AS job_state, j.attempts AS job_attempts, m.id AS message_id, m.status, m.body,
                m.sent_by_membership_id, m.conversation_id, m.kind, m.template_id, m.template_params, m.file_id
         FROM send_jobs j JOIN messages m ON m.id = j.message_id WHERE j.id = $1 FOR UPDATE OF j, m`;

export class Sender {
  constructor(
    private readonly db: Db,
    private readonly channels: Partial<Record<Provider, ChannelAdapter>>,
    readonly faults: SendFaults = {},
    private readonly providerTimeoutMs = SEND_LIMITS.providerTimeoutMs,
    /** Needed to send media messages; without it a media message is blocked before anything is sent. */
    private readonly storage?: ObjectStorage,
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
      const row = (await tx.query<JobRow>(JOB_SELECT, [jobId])).rows[0];
      if (!row || row.job_state === 'done' || row.job_state === 'dead') return { done: 'nothing_to_do' as const };
      // Only the holder of a live lease may process a job (leaseNow or dispatch_claim). Explicit, as the review noted.
      const lease = (await tx.query<{ live: boolean }>(
        `SELECT state = 'leased' AND lease_until > now() AS live FROM send_jobs WHERE id = $1`, [jobId])).rows[0]!;
      if (!lease.live) return { done: 'nothing_to_do' as const };

      if (row.status === 'submitting') {
        // A previous attempt stopped after it may have reached the provider. Never send again automatically.
        await this.finishUncertain(tx, row, 'interrupted');
        return { done: 'uncertain' as const };
      }
      if (row.status !== 'queued') {
        await tx.query(`UPDATE send_jobs SET state = 'done', lease_until = NULL, updated_at = now() WHERE id = $1`, [jobId]);
        return { done: 'nothing_to_do' as const };
      }

      const ctx = (await tx.query<{
        opted_out: boolean; last_inbound_at: Date | null; paused: boolean; paused_by: string | null; channel_status: string;
        provider: Provider; number: string; wa: string | null; assigned: string | null; sender_may_reply: boolean;
        marketing_consent: boolean; conn_account: string;
      }>(
        `SELECT (ct.opted_out_at IS NOT NULL) AS opted_out, c.last_inbound_at,
                (c.paused_at IS NOT NULL AND (c.paused_until IS NULL OR c.paused_until > now())) AS paused,
                c.paused_by_membership_id AS paused_by, ch.status AS channel_status, ch.provider, ch.provider_number_id AS number,
                (SELECT value FROM contact_identifiers ci WHERE ci.contact_id = ct.id AND ci.kind = 'whatsapp' LIMIT 1) AS wa,
                c.assigned_membership_id AS assigned,
                EXISTS (SELECT 1 FROM memberships mb JOIN membership_roles mr ON mr.membership_id = mb.id
                        JOIN role_permissions rp ON rp.role_id = mr.role_id AND rp.permission_key = 'inbox.reply'
                        WHERE mb.id = $2 AND mb.status = 'active') AS sender_may_reply,
                (ct.marketing_consent_at IS NOT NULL) AS marketing_consent, ch.account_ref AS conn_account
         FROM conversations c JOIN contacts ct ON ct.id = c.contact_id JOIN channel_connections ch ON ch.id = c.connection_id
         WHERE c.id = $1`, [row.conversation_id, row.sent_by_membership_id])).rows[0]!;
      // A template must still be approved, belong to this number's business account and, for marketing, have consent.
      const tpl = row.kind === 'template'
        ? (await tx.query<{ name: string; language: string; status: string; category: string; account_ref: string }>(
            'SELECT name, language, status, category, account_ref FROM message_templates WHERE id = $1', [row.template_id])).rows[0]!
        : null;
      // Conditions can change while a message waits (owner decision 21 Oct 2026); they are all checked again now.
      const refusal =
        !ctx.sender_may_reply ? 'sender_not_allowed'
        : ctx.paused && ctx.paused_by !== row.sent_by_membership_id ? 'replies_paused'
        : ctx.assigned !== null && ctx.assigned !== row.sent_by_membership_id ? 'assigned_to_other'
        : ctx.opted_out ? 'contact_opted_out'
        : ctx.channel_status !== 'active' ? 'channel_disabled'
        : tpl && tpl.account_ref !== ctx.conn_account ? 'template_account_mismatch'
        : tpl && tpl.status !== 'approved' ? 'template_not_approved'
        : tpl && tpl.category === 'marketing' && !ctx.marketing_consent ? 'marketing_consent_required'
        : !tpl && (!ctx.last_inbound_at || Date.now() - ctx.last_inbound_at.getTime() >= SERVICE_WINDOW_MS) ? 'template_required'
        : !ctx.wa ? 'no_whatsapp_identifier'
        : null;
      // A media message's file must still be this company's, clean and acceptable; it is read before anything is sent.
      let media: Omit<MediaSendInput, 'providerNumberId' | 'to' | 'callbackData' | 'signal'> | null = null;
      let mediaRefusal: string | null = null;
      if (!refusal && row.kind === 'media') {
        const f = (await tx.query<{ status: string; content_type: string; size_bytes: string; original_name: string; storage_key: string }>(
          'SELECT status, content_type, size_bytes, original_name, storage_key FROM files WHERE id = $1', [row.file_id])).rows[0];
        const type = f ? outboundTypeFor(f.content_type, Number(f.size_bytes)) : null;
        if (!f || f.status !== 'available' || !type || !this.storage || !f.storage_key.startsWith(`tenants/${tenantId}/`)) mediaRefusal = 'file_unavailable';
        else {
          try {
            media = { mediaType: type, data: await this.storage.get(f.storage_key), contentType: f.content_type, filename: f.original_name, caption: row.body };
          } catch { mediaRefusal = 'file_unavailable'; }
        }
      }
      if (refusal || mediaRefusal) {
        await this.finishFailed(tx, row, 'blocked', (refusal ?? mediaRefusal)!, 'done');
        return { done: 'failed' as const };
      }
      if (this.faults.crashBeforeSubmit) throw new SimulatedCrash('before submission');
      await tx.query(`UPDATE messages SET status = 'submitting', attempts = attempts + 1 WHERE id = $1`, [row.message_id]);
      await tx.query(`UPDATE send_jobs SET attempts = attempts + 1, updated_at = now() WHERE id = $1`, [jobId]);
      if (tpl) await tx.query('UPDATE messages SET pricing_category = $2 WHERE id = $1', [row.message_id, tpl.category]);
      return { row, provider: ctx.provider, number: ctx.number, to: ctx.wa as string, tpl, media };
    });
    if ('done' in prepared) return prepared.done as JobOutcome;

    // Step 2: the provider call.
    let providerMessageId: string | null = null;
    let failure: ChannelSendError | null = null;
    try {
      const adapter = this.channels[prepared.provider];
      if (!adapter) throw new ChannelSendError('provider_not_available', 'Provider not available.', 'rejected');
      const abort = new AbortController();
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          abort.abort();
          reject(new ChannelSendError('provider_timeout', 'No answer from the provider in time.', 'uncertain'));
        }, this.providerTimeoutMs);
      });
      try {
        const base = { providerNumberId: prepared.number, to: prepared.to, callbackData: prepared.row.message_id, signal: abort.signal };
        const call = prepared.tpl
          ? adapter.sendTemplate({ ...base, templateName: prepared.tpl.name, language: prepared.tpl.language, params: prepared.row.template_params ?? [] })
          : prepared.media
            ? adapter.sendMedia({ ...base, ...prepared.media })
            : adapter.sendText({ ...base, body: prepared.row.body ?? '' });
        providerMessageId = (await Promise.race([call, timeout])).providerMessageId;
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      // Anything we cannot classify is uncertain: the provider may have accepted it (rule b above).
      failure = err instanceof ChannelSendError ? err : new ChannelSendError('send_error', 'Unexpected send error.', 'uncertain');
    }
    if (this.faults.crashAfterSubmit) throw new SimulatedCrash('after submission');

    // Step 3: record the outcome.
    return withContext(this.db, { tenantId, userId: null }, async (tx) => {
      const row = (await tx.query<JobRow>(JOB_SELECT, [jobId])).rows[0]!;
      if (providerMessageId) {
        await lockProviderId(tx, providerMessageId);
        // `uncertain` is allowed too: another attempt may have given up on this one while it was still running.
        const marked = await tx.query(
          `UPDATE messages SET status = 'sent', provider_message_id = $2, error_code = NULL, failure_kind = NULL
           WHERE id = $1 AND status IN ('submitting', 'uncertain')`,
          [row.message_id, providerMessageId]);
        await tx.query(`UPDATE send_jobs SET state = 'done', lease_until = NULL, last_error = NULL, updated_at = now() WHERE id = $1`, [jobId]);
        await applyOrphanStatuses(tx, row.message_id, providerMessageId);
        // Only a reply this call actually recorded as sent answers the customer (review finding 7); a status webhook
        // that settled it first has already stopped the timer.
        if (marked.rowCount === 1) await stopTimerOnReply(tx, tenantId, row.conversation_id, row.sent_by_membership_id, new Date());
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
        await this.finishFailed(tx, row, 'exhausted', `retries_exhausted:${f.code}`, 'dead');
        return 'failed' as const;
      }
      if (f.kind === 'uncertain') {
        await this.finishUncertain(tx, row, f.code);
        return 'uncertain' as const;
      }
      await this.finishFailed(tx, row, 'rejected', f.code, 'done');
      return 'failed' as const;
    });
  }

  /**
   * A confirmed failure: the customer did not receive this message. Only a message still `queued` or `submitting` is
   * changed: a status webhook may already have settled it while the provider call was running (review of slice 3,
   * finding 3), and that answer wins. The job is closed either way.
   */
  private async finishFailed(tx: Tx, row: JobRow, kind: Exclude<FailureKind, 'provider_reported'>, code: string, jobState: 'done' | 'dead') {
    await tx.query(`UPDATE messages SET status = 'failed', failure_kind = $2, error_code = $3 WHERE id = $1 AND status IN ('queued', 'submitting')`,
      [row.message_id, kind, code.slice(0, 100)]);
    await this.closeJob(tx, row.job_id, jobState, code);
  }

  /** Outcome unknown: it may have reached the customer. Never sent again automatically. Same guard as above. */
  private async finishUncertain(tx: Tx, row: JobRow, code: string) {
    await tx.query(`UPDATE messages SET status = 'uncertain', failure_kind = NULL, error_code = $2 WHERE id = $1 AND status = 'submitting'`,
      [row.message_id, code.slice(0, 100)]);
    await this.closeJob(tx, row.job_id, 'done', code);
  }

  private async closeJob(tx: Tx, jobId: string, state: 'done' | 'dead', code: string) {
    await tx.query(`UPDATE send_jobs SET state = $2, lease_until = NULL, last_error = $3, updated_at = now() WHERE id = $1`,
      [jobId, state, code.slice(0, 200)]);
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
    `UPDATE messages SET status = $2, error_code = CASE WHEN $2 = 'failed' THEN coalesce($3, error_code) ELSE NULL END,
            failure_kind = CASE WHEN $2 = 'failed' THEN 'provider_reported' END
     WHERE provider_message_id = $1 AND direction = 'out'
       AND (CASE status WHEN 'queued' THEN 0 WHEN 'submitting' THEN 0 WHEN 'uncertain' THEN 0 WHEN 'sent' THEN 1
                        WHEN 'delivered' THEN 2 WHEN 'read' THEN 3 WHEN 'failed' THEN 4 END) < $4
     RETURNING id`, [providerMessageId, status, errorCode, rank]);
  if (byId.rowCount) return 'applied';
  if (callbackData && /^[0-9a-f-]{36}$/i.test(callbackData)) {
    // A send we did not hear back from (uncertain or still submitting): the callback reference settles it.
    const byRef = await tx.query(
      `UPDATE messages SET status = $2, provider_message_id = $1,
              error_code = CASE WHEN $2 = 'failed' THEN coalesce($3, error_code) ELSE NULL END,
              failure_kind = CASE WHEN $2 = 'failed' THEN 'provider_reported' END
       WHERE id = $4::uuid AND direction = 'out' AND provider_message_id IS NULL AND status IN ('submitting', 'uncertain')
       RETURNING id`, [providerMessageId, status, errorCode, callbackData]);
    if (byRef.rowCount) {
      await tx.query(`UPDATE send_jobs SET state = 'done', lease_until = NULL, updated_at = now() WHERE message_id = $1::uuid AND state <> 'dead'`, [callbackData]);
      // An uncertain reply turned out to be accepted: it answered the customer.
      if (status !== 'failed') {
        const m = (await tx.query<{ tenant_id: string; conversation_id: string; sent_by_membership_id: string | null }>(
          'SELECT tenant_id, conversation_id, sent_by_membership_id FROM messages WHERE id = $1::uuid', [callbackData])).rows[0]!;
        await stopTimerOnReply(tx, m.tenant_id, m.conversation_id, m.sent_by_membership_id, new Date());
      }
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
