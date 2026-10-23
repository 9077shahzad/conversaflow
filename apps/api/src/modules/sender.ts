import { withContext, type Db, type Tx } from '@conversaflow/database';
import type { ObjectStorage } from '../core/storage';
import { ChannelSendError, STATUS_RANK, type ChannelAdapter, type MediaSendInput, type Provider } from './channels';
import { outboundTypeFor } from './media';
import { claimCampaignSend } from './campaign-limits';
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
/**
 * providerTimeoutMs: how long we wait before treating the attempt as uncertain. lateWindowMs: how much longer the
 * request is kept open after that, only so that a late answer's message id can be recorded for reconciliation; the
 * request is cancelled at the end of it. Both together stay well inside the lease.
 */
export const SEND_LIMITS = { maxAttempts: 5, leaseSeconds: 120, baseBackoffSeconds: 5, providerTimeoutMs: 30_000, lateWindowMs: 60_000 };
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
  file_id: string | null; campaign_id: string | null; automation_run_id: string | null;
};
const JOB_SELECT = `SELECT j.id AS job_id, j.state AS job_state, j.attempts AS job_attempts, m.id AS message_id, m.status, m.body,
                m.sent_by_membership_id, m.conversation_id, m.kind, m.template_id, m.template_params, m.file_id, m.campaign_id, m.automation_run_id
         FROM send_jobs j JOIN messages m ON m.id = j.message_id WHERE j.id = $1 FOR UPDATE OF j, m`;

export class Sender {
  constructor(
    private readonly db: Db,
    private readonly channels: Partial<Record<Provider, ChannelAdapter>>,
    readonly faults: SendFaults = {},
    private readonly providerTimeoutMs = SEND_LIMITS.providerTimeoutMs,
    /** Needed to send media messages; without it a media message is blocked before anything is sent. */
    private readonly storage?: ObjectStorage,
    private readonly lateWindowMs = SEND_LIMITS.lateWindowMs,
  ) {}

  /** Late answers still being awaited (tests wait for them with settleLate()). */
  private readonly late = new Set<Promise<void>>();
  async settleLate() { await Promise.all([...this.late]); }

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
        await recordAttempt(tx, tenantId, row.message_id, null, 'interrupted', 'interrupted', null);
        await this.finishUncertain(tx, row, 'interrupted');
        return { done: 'uncertain' as const };
      }
      if (row.status !== 'queued') {
        await tx.query(`UPDATE send_jobs SET state = 'done', lease_until = NULL, updated_at = now() WHERE id = $1`, [jobId]);
        return { done: 'nothing_to_do' as const };
      }

      // Campaign messages: a paused campaign holds its queued messages (nothing is sent, no attempt is counted) until it
      // is resumed; a cancelled one stops them. The campaign's creator must still be allowed to run campaigns.
      const camp = row.campaign_id
        ? (await tx.query<{ status: string; creator_ok: boolean }>(
            `SELECT c.status, EXISTS (SELECT 1 FROM memberships mb JOIN membership_roles mr ON mr.membership_id = mb.id
                       JOIN role_permissions rp ON rp.role_id = mr.role_id AND rp.permission_key = 'campaigns.manage'
                       WHERE mb.id = c.created_by AND mb.status = 'active') AS creator_ok
             FROM campaigns c WHERE c.id = $1 FOR SHARE OF c`, [row.campaign_id])).rows[0]!
        : null;
      if (camp && (camp.status === 'paused' || camp.status === 'scheduled')) {
        await tx.query(`UPDATE send_jobs SET state = 'pending', lease_until = NULL, next_attempt_at = now() + interval '60 seconds', updated_at = now() WHERE id = $1`, [jobId]);
        return { done: 'retry_later' as const };
      }

      // Automation messages: sent only while their run has not been stopped (a person replied or paused replies, the
      // automation was paused) and the automation is still active (W2.1, FR-206).
      const auto = row.automation_run_id
        ? (await tx.query<{ status: string; mode: string; workflow_status: string; person_since: boolean; resolved: boolean; assigned_since: boolean }>(
            // FOR SHARE: a person stopping the run at this moment waits for this check, or this check sees it (L5).
            `SELECT r.status, r.mode, w.status AS workflow_status,
                    EXISTS (SELECT 1 FROM messages h WHERE h.conversation_id = m.conversation_id AND h.direction = 'out'
                            AND h.sent_by_membership_id IS NOT NULL AND h.created_at > m.created_at) AS person_since,
                    -- A person assigned or taking over after the message was queued (recheck of W2.1, L4).
                    EXISTS (SELECT 1 FROM conversation_events e WHERE e.conversation_id = m.conversation_id AND e.kind IN ('assigned', 'takeover')
                            AND e.actor_membership_id IS NOT NULL AND e.created_at > m.created_at) AS assigned_since,
                    (c.status = 'resolved') AS resolved
             FROM workflow_runs r JOIN workflows w ON w.id = r.workflow_id JOIN messages m ON m.id = $2
             JOIN conversations c ON c.id = m.conversation_id WHERE r.id = $1 FOR SHARE OF r`,
            [row.automation_run_id, row.message_id])).rows[0] ?? null
        : null;
      const ctx = (await tx.query<{
        opted_out: boolean; last_inbound_at: Date | null; paused: boolean; paused_by: string | null; channel_status: string;
        provider: Provider; number: string; wa: string | null; assigned: string | null; sender_may_reply: boolean;
        marketing_consent: boolean; conn_account: string; suppressed: boolean;
      }>(
        `SELECT (ct.opted_out_at IS NOT NULL) AS opted_out, c.last_inbound_at,
                (c.paused_at IS NOT NULL AND (c.paused_until IS NULL OR c.paused_until > now())) AS paused,
                c.paused_by_membership_id AS paused_by, ch.status AS channel_status, ch.provider, ch.provider_number_id AS number,
                (SELECT value FROM contact_identifiers ci WHERE ci.contact_id = ct.id AND ci.kind = 'whatsapp' LIMIT 1) AS wa,
                c.assigned_membership_id AS assigned,
                EXISTS (SELECT 1 FROM memberships mb JOIN membership_roles mr ON mr.membership_id = mb.id
                        JOIN role_permissions rp ON rp.role_id = mr.role_id AND rp.permission_key = 'inbox.reply'
                        WHERE mb.id = $2 AND mb.status = 'active') AS sender_may_reply,
                (ct.marketing_consent_at IS NOT NULL) AS marketing_consent, ch.account_ref AS conn_account,
                EXISTS (SELECT 1 FROM suppressions s JOIN contact_identifiers ci ON ci.value = s.wa_number AND ci.kind = 'whatsapp'
                        WHERE ci.contact_id = ct.id) AS suppressed
         FROM conversations c JOIN contacts ct ON ct.id = c.contact_id JOIN channel_connections ch ON ch.id = c.connection_id
         WHERE c.id = $1`, [row.conversation_id, row.sent_by_membership_id])).rows[0]!;
      // A template must still be approved, belong to this number's business account and, for marketing, have consent.
      const tpl = row.kind === 'template'
        ? (await tx.query<{ name: string; language: string; status: string; category: string; account_ref: string }>(
            'SELECT name, language, status, category, account_ref FROM message_templates WHERE id = $1', [row.template_id])).rows[0]!
        : null;
      // Conditions can change while a message waits (owner decision 21 Oct 2026); they are all checked again now.
      const refusal =
        camp ? (
          camp.status === 'cancelled' ? 'campaign_cancelled'
          : !camp.creator_ok ? 'sender_not_allowed'
          : ctx.paused ? 'replies_paused'
          : ctx.opted_out ? 'contact_opted_out'
          : !ctx.marketing_consent ? 'marketing_consent_required'
          : ctx.suppressed ? 'suppressed'
          : null)
        : auto ? (
          auto.mode !== 'live' ? 'rehearsal_only'
          : auto.status === 'stopped' || auto.status === 'skipped' ? 'automation_stopped'
          // Even a finished run's message is not sent once a person has written or the conversation is resolved (M4).
          : auto.person_since ? 'person_replied'
          : auto.resolved ? 'conversation_resolved'
          : auto.assigned_since ? 'person_assigned'
          : auto.workflow_status !== 'active' ? 'automation_paused'
          : ctx.paused ? 'replies_paused'
          : null)
        : !ctx.sender_may_reply ? 'sender_not_allowed'
        : ctx.paused && ctx.paused_by !== row.sent_by_membership_id ? 'replies_paused'
        : ctx.assigned !== null && ctx.assigned !== row.sent_by_membership_id ? 'assigned_to_other'
        : null;
      const refusal2 = refusal
        ?? (ctx.opted_out ? 'contact_opted_out'
        : ctx.channel_status !== 'active' ? 'channel_disabled'
        : tpl && tpl.account_ref !== ctx.conn_account ? 'template_account_mismatch'
        : tpl && tpl.status !== 'approved' ? 'template_not_approved'
        : tpl && tpl.category === 'marketing' && !ctx.marketing_consent ? 'marketing_consent_required'
        : !tpl && (!ctx.last_inbound_at || Date.now() - ctx.last_inbound_at.getTime() >= SERVICE_WINDOW_MS) ? 'template_required'
        : !ctx.wa ? 'no_whatsapp_identifier'
        : null);
      // A media message's file must still be this company's, clean and acceptable; it is read before anything is sent.
      let media: Omit<MediaSendInput, 'providerNumberId' | 'to' | 'callbackData' | 'signal'> | null = null;
      let mediaRefusal: string | null = null;
      if (!refusal2 && row.kind === 'media') {
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
      if (refusal2 || mediaRefusal) {
        await this.finishFailed(tx, row, 'blocked', (refusal2 ?? mediaRefusal)!, 'done');
        return { done: 'failed' as const };
      }
      // Campaign limits, checked again now and atomically (owner instruction of 21 Oct 2026): a contact over its
      // frequency limits is not sent the message; a number with no room left under its daily limit holds it (no attempt
      // counted) until room frees up. On success the message is counted in this same transaction.
      if (camp) {
        const v = await claimCampaignSend(tx, tenantId, { messageId: row.message_id, campaignId: row.campaign_id!, conversationId: row.conversation_id });
        if (!v.ok && v.reason === 'frequency_limit') {
          await this.finishFailed(tx, row, 'blocked', 'frequency_limit', 'done');
          return { done: 'failed' as const };
        }
        if (!v.ok) {
          await tx.query(`UPDATE send_jobs SET state = 'pending', lease_until = NULL, next_attempt_at = $2, last_error = 'daily_limit', updated_at = now() WHERE id = $1`,
            [jobId, v.retryAt]);
          return { done: 'retry_later' as const };
        }
      }
      if (this.faults.crashBeforeSubmit) throw new SimulatedCrash('before submission');
      const attempt = (await tx.query<{ attempts: number }>(
        `UPDATE messages SET status = 'submitting', attempts = attempts + 1 WHERE id = $1 RETURNING attempts`, [row.message_id])).rows[0]!.attempts;
      await tx.query(`UPDATE send_jobs SET attempts = attempts + 1, updated_at = now() WHERE id = $1`, [jobId]);
      if (tpl) await tx.query('UPDATE messages SET pricing_category = $2 WHERE id = $1', [row.message_id, tpl.category]);
      return { row, provider: ctx.provider, number: ctx.number, to: ctx.wa as string, tpl, media, attempt };
    });
    if ('done' in prepared) return prepared.done as JobOutcome;

    // Step 2: the provider call. After providerTimeoutMs the attempt counts as uncertain; the request stays open for
    // lateWindowMs more so that a late answer's message id can still be recorded (never re-sent), then it is cancelled.
    let providerMessageId: string | null = null;
    let failure: ChannelSendError | null = null;
    try {
      const adapter = this.channels[prepared.provider];
      if (!adapter) throw new ChannelSendError('provider_not_available', 'Provider not available.', 'rejected');
      const abort = new AbortController();
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ChannelSendError('provider_timeout', 'No answer from the provider in time.', 'uncertain')), this.providerTimeoutMs);
      });
      const base = { providerNumberId: prepared.number, to: prepared.to, callbackData: prepared.row.message_id, signal: abort.signal };
      const call = prepared.tpl
        ? adapter.sendTemplate({ ...base, templateName: prepared.tpl.name, language: prepared.tpl.language, params: prepared.row.template_params ?? [] })
        : prepared.media
          ? adapter.sendMedia({ ...base, ...prepared.media })
          : adapter.sendText({ ...base, body: prepared.row.body ?? '' });
      try {
        providerMessageId = (await Promise.race([call, timeout])).providerMessageId;
      } catch (err) {
        if (err instanceof ChannelSendError && err.code === 'provider_timeout') {
          const cancel = setTimeout(() => abort.abort(), this.lateWindowMs);
          const late = call
            .then((r) => this.recordLateAnswer(tenantId, prepared.row.message_id, prepared.attempt, r.providerMessageId))
            .catch(() => undefined)
            .finally(() => { clearTimeout(cancel); this.late.delete(late); });
          this.late.add(late);
        }
        throw err;
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      // Anything we cannot classify is uncertain: the provider may have accepted it (rule b above).
      failure = err instanceof ChannelSendError ? err : new ChannelSendError('send_error', 'Unexpected send error.', 'uncertain');
    }
    if (this.faults.crashAfterSubmit) throw new SimulatedCrash('after submission');

    // Step 3: record the outcome, and the evidence for it.
    return withContext(this.db, { tenantId, userId: null }, async (tx) => {
      const row = (await tx.query<JobRow>(JOB_SELECT, [jobId])).rows[0]!;
      if (providerMessageId) {
        await lockProviderId(tx, providerMessageId);
        await recordAttempt(tx, tenantId, row.message_id, prepared.attempt, 'accepted', null, providerMessageId);
        // `uncertain` is allowed too: another attempt may have given up on this one while it was still running.
        const marked = await tx.query(
          `UPDATE messages SET status = 'sent', provider_message_id = $2, error_code = NULL, failure_kind = NULL
           WHERE id = $1 AND status IN ('submitting', 'uncertain')`,
          [row.message_id, providerMessageId]);
        // A status webhook may have settled it first (e.g. delivered): keep that status, but keep the id too.
        if (marked.rowCount === 0) await keepProviderId(tx, row.message_id, providerMessageId);
        await tx.query(`UPDATE send_jobs SET state = 'done', lease_until = NULL, last_error = NULL, updated_at = now() WHERE id = $1`, [jobId]);
        await applyOrphanStatuses(tx, row.message_id, providerMessageId);
        // Only a reply this call actually recorded as sent answers the customer (review finding 7); a status webhook
        // that settled it first has already stopped the timer.
        if (marked.rowCount === 1) await stopTimerOnReply(tx, tenantId, row.conversation_id, row.sent_by_membership_id, new Date());
        return 'sent' as const;
      }
      const f = failure!;
      await recordAttempt(tx, tenantId, row.message_id, prepared.attempt,
        f.kind === 'not_accepted' ? 'not_accepted' : f.kind === 'rejected' ? 'rejected' : 'uncertain', f.code, null);
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
        // "Not accepted after 5 attempts" needs five recorded, definite refusals. If any attempt of this message had
        // an ambiguous outcome, the provider may have it: uncertain, never a confirmed failure.
        const evidence = (await tx.query<{ definite: number; other: number }>(
          `SELECT count(*) FILTER (WHERE outcome = 'not_accepted')::int AS definite, count(*) FILTER (WHERE outcome <> 'not_accepted')::int AS other
           FROM send_attempts WHERE message_id = $1`, [row.message_id])).rows[0]!;
        if (evidence.definite >= SEND_LIMITS.maxAttempts && evidence.other === 0) {
          await this.finishFailed(tx, row, 'exhausted', `retries_exhausted:${f.code}`, 'dead');
          return 'failed' as const;
        }
        await this.finishUncertain(tx, row, 'mixed_attempt_outcomes');
        return 'uncertain' as const;
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
   * The provider's answer arrived after we had stopped waiting. Its message id is recorded so status webhooks match
   * by id as well as by our reference. Statuses only move forward: an uncertain message becomes sent; a delivered,
   * read or failed message keeps its status. Nothing is sent again.
   */
  private async recordLateAnswer(tenantId: string, messageId: string, attempt: number, providerMessageId: string) {
    await withContext(this.db, { tenantId, userId: null }, async (tx) => {
      await lockProviderId(tx, providerMessageId);
      await recordAttempt(tx, tenantId, messageId, attempt, 'late_accepted', null, providerMessageId);
      if (!(await keepProviderId(tx, messageId, providerMessageId))) return;
      const m = (await tx.query<{ conversation_id: string; sent_by_membership_id: string | null }>(
        // Also while still "submitting": the late answer can arrive before the timeout outcome is saved (review finding
        // S4-5); the timeout path then leaves "sent" alone, because it changes only a message still "submitting".
        `UPDATE messages SET status = 'sent', error_code = NULL WHERE id = $1 AND status IN ('submitting', 'uncertain')
         RETURNING conversation_id, sent_by_membership_id`, [messageId])).rows[0];
      await applyOrphanStatuses(tx, messageId, providerMessageId);
      if (m) await stopTimerOnReply(tx, tenantId, m.conversation_id, m.sent_by_membership_id, new Date());
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
    // If WhatsApp's id is already recorded (a late answer was saved first), acceptance is proven: "sent", not uncertain.
    await tx.query(`UPDATE messages SET status = CASE WHEN provider_message_id IS NOT NULL THEN 'sent' ELSE 'uncertain' END,
                           failure_kind = NULL, error_code = CASE WHEN provider_message_id IS NOT NULL THEN NULL ELSE $2 END
                    WHERE id = $1 AND status = 'submitting'`,
      [row.message_id, code.slice(0, 100)]);
    await this.closeJob(tx, row.job_id, 'done', code);
  }

  private async closeJob(tx: Tx, jobId: string, state: 'done' | 'dead', code: string) {
    await tx.query(`UPDATE send_jobs SET state = $2, lease_until = NULL, last_error = $3, updated_at = now() WHERE id = $1`,
      [jobId, state, code.slice(0, 200)]);
  }
}

/** Appends one attempt's evidence (send_attempts is append-only). attempt null = the attempt being recovered. */
async function recordAttempt(tx: Tx, tenantId: string, messageId: string, attempt: number | null, outcome: string, code: string | null, providerMessageId: string | null) {
  await tx.query(
    // clock_timestamp(), not now(): the time of the answer, not of the transaction start, so the log is in true order.
    `INSERT INTO send_attempts (tenant_id, message_id, attempt, outcome, code, provider_message_id, created_at)
     VALUES ($1, $2, coalesce($3, (SELECT greatest(attempts, 1) FROM messages WHERE id = $2)), $4, $5, $6, clock_timestamp())`,
    [tenantId, messageId, attempt, outcome, code?.slice(0, 100) ?? null, providerMessageId]);
}

/**
 * Records the provider's id on a message that has none yet. Refuses (returns false) if another message already
 * holds that id, which would mean the provider answered for a different message; that is logged, never merged.
 */
async function keepProviderId(tx: Tx, messageId: string, providerMessageId: string): Promise<boolean> {
  const holder = (await tx.query<{ id: string }>('SELECT id FROM messages WHERE provider_message_id = $1', [providerMessageId])).rows[0];
  if (holder && holder.id !== messageId) {
    console.error('provider id already belongs to another message; not reassigned', providerMessageId);
    return false;
  }
  await tx.query('UPDATE messages SET provider_message_id = $2 WHERE id = $1 AND provider_message_id IS NULL', [messageId, providerMessageId]);
  return true;
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
