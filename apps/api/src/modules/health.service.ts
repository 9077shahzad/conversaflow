import { withContext } from '@conversaflow/database';
import type { Deps, TenantActor } from '../core/context';
import { Errors } from '../core/errors';
import { AuditService } from './audit.service';
import { isUuid } from './members.service';
import { applyStatus } from './sender';
import { InboundProcessor } from './inbound';

/**
 * Provider health and recovery (Wave 1). One company's view of its WhatsApp connection: are events arriving, is
 * anything stuck, what needs a person. Recovery actions are limited to ones that cannot message a customer twice:
 *
 *  - re-apply delivery statuses that arrived before their message was recorded (idempotent);
 *  - download a customer's media again after a download failure (no effect on the customer);
 *  - re-read template review status from the provider (POST /v1/templates/sync);
 *  - try again incoming events the worker gave up on (applying is idempotent and never sends anything).
 *
 * Messages that failed or are uncertain are listed with their conversation; retrying them happens there, through the
 * normal retry with all its checks, so this screen never sends anything itself.
 */
const MEDIA_ID_LIFETIME_DAYS = 7; // Meta: media ids from webhooks expire after 7 days (media page, read 21 Oct 2026)

export class HealthService {
  constructor(private readonly deps: Deps) {}

  /** Incoming events the worker gave up on are tried again from the start (audited). */
  retryIncoming(actor: TenantActor) {
    return InboundProcessor.retryFailed(this.deps.db, actor);
  }

  async overview(actor: TenantActor) {
    // The item lists name customers, so they follow the inbox's visibility rule (review of slice 3, finding 10): a role
    // without inbox.read_all sees only unassigned conversations and its own. Counts stay company-wide.
    const visible: [boolean, string | null] = [actor.permissions.has('inbox.read_all'), isUuid(actor.membershipId) ? actor.membershipId : null];
    return withContext(this.deps.db, actor, async (tx) => {
      const connections = (await tx.query(
        `SELECT ch.id, ch.label, ch.display_phone AS "displayPhone", ch.status, ch.provider,
                (SELECT max(w.received_at) FROM webhook_events w WHERE w.connection_id = ch.id) AS "lastEventAt",
                (SELECT count(*)::int FROM webhook_events w WHERE w.connection_id = ch.id AND w.received_at > now() - interval '24 hours') AS "events24h"
         FROM channel_connections ch ORDER BY ch.created_at`)).rows;
      const webhooks = (await tx.query<Record<string, number | string | null>>(
        `SELECT count(*) FILTER (WHERE received_at > now() - interval '24 hours')::int AS "received24h",
                count(*) FILTER (WHERE outcome = 'orphan_status')::int AS "waitingStatuses",
                min(received_at) FILTER (WHERE outcome = 'orphan_status') AS "oldestWaitingStatusAt",
                count(*) FILTER (WHERE outcome = 'unknown_template' AND received_at > now() - interval '7 days')::int AS "unknownTemplateEvents7d",
                count(*) FILTER (WHERE processed_at IS NULL AND failed_at IS NULL)::int AS "unprocessed",
                -- Overdue: past its next try by 2 minutes, or waiting more than 10 minutes since it arrived (an event put
                -- back again and again because its customer stays busy never uses an attempt; second recheck of AX-3).
                count(*) FILTER (WHERE processed_at IS NULL AND failed_at IS NULL
                                 AND (next_attempt_at < now() - interval '2 minutes' OR received_at < now() - interval '10 minutes'))::int AS "overdue",
                count(*) FILTER (WHERE processed_at IS NULL AND failed_at IS NULL AND attempts > 0)::int AS "retrying",
                min(received_at) FILTER (WHERE processed_at IS NULL AND failed_at IS NULL) AS "oldestWaitingAt",
                count(*) FILTER (WHERE failed_at IS NOT NULL)::int AS "failed"
         FROM webhook_events`)).rows[0]!;
      const sending = (await tx.query<Record<string, number>>(
        `SELECT count(*) FILTER (WHERE j.state = 'pending')::int AS "waiting",
                count(*) FILTER (WHERE j.state = 'pending' AND j.next_attempt_at < now() - interval '2 minutes')::int AS "overdue",
                count(*) FILTER (WHERE j.state = 'leased' AND j.lease_until < now())::int AS "stuck",
                count(*) FILTER (WHERE j.state = 'dead')::int AS "gaveUp"
         FROM send_jobs j`)).rows[0]!;
      const outcomes = (await tx.query<{ status: string; failure_kind: string | null; n: number }>(
        `SELECT m.status, m.failure_kind, count(*)::int AS n FROM messages m
         WHERE m.direction = 'out' AND m.status IN ('failed', 'uncertain') AND m.created_at > now() - interval '7 days'
           AND NOT EXISTS (SELECT 1 FROM messages r WHERE r.retry_of = m.id)
         GROUP BY 1, 2`)).rows;
      const media = (await tx.query<Record<string, number>>(
        `SELECT count(*) FILTER (WHERE m.media_status = 'pending')::int AS "pending",
                count(*) FILTER (WHERE m.media_status = 'pending' AND m.created_at < now() - interval '10 minutes')::int AS "overdue",
                count(*) FILTER (WHERE m.media_status = 'failed' AND m.created_at > now() - interval '7 days')::int AS "failed7d",
                count(*) FILTER (WHERE m.media_status = 'rejected' AND m.created_at > now() - interval '7 days')::int AS "blockedByScan7d"
         FROM messages m WHERE m.direction = 'in' AND m.kind = 'media'`)).rows[0]!;
      const templates = (await tx.query<Record<string, number>>(
        `SELECT count(*) FILTER (WHERE status = 'approved')::int AS "approved",
                count(*) FILTER (WHERE status = 'pending')::int AS "pending",
                count(*) FILTER (WHERE status = 'pending' AND created_at < now() - interval '24 hours')::int AS "pendingOver24h",
                count(*) FILTER (WHERE status IN ('paused', 'disabled'))::int AS "pausedOrDisabled",
                count(*) FILTER (WHERE status = 'rejected')::int AS "rejected",
                count(*) FILTER (WHERE quality = 'red' AND status = 'approved')::int AS "lowQuality"
         FROM message_templates`)).rows[0]!;
      const attention = (await tx.query(
        `SELECT m.id, m.conversation_id AS "conversationId", m.status, m.failure_kind AS "failureKind", m.error_code AS "errorCode",
                m.created_at AS "createdAt", ct.display_name AS "contactName",
                (m.retry_number < 1) AS "retryable"
         FROM messages m JOIN conversations c ON c.id = m.conversation_id JOIN contacts ct ON ct.id = c.contact_id
         WHERE m.direction = 'out' AND m.status IN ('failed', 'uncertain') AND m.created_at > now() - interval '7 days'
           AND NOT EXISTS (SELECT 1 FROM messages r WHERE r.retry_of = m.id)
           AND ($1::boolean OR c.assigned_membership_id IS NULL OR c.assigned_membership_id = $2::uuid)
         ORDER BY (m.status = 'uncertain') DESC, m.created_at DESC LIMIT 50`, visible)).rows;
      const mediaProblems = (await tx.query(
        `SELECT m.id, m.conversation_id AS "conversationId", m.media_type AS "mediaType", m.media_status AS "mediaStatus",
                j.last_error AS "lastError", m.created_at AS "createdAt",
                (m.media_status = 'failed' AND m.created_at > now() - make_interval(days => $1)) AS "canRetry"
         FROM messages m LEFT JOIN media_jobs j ON j.message_id = m.id JOIN conversations c ON c.id = m.conversation_id
         WHERE m.direction = 'in' AND m.kind = 'media' AND m.media_status IN ('failed', 'pending') AND m.created_at > now() - interval '7 days'
           AND ($2::boolean OR c.assigned_membership_id IS NULL OR c.assigned_membership_id = $3::uuid)
         ORDER BY m.created_at DESC LIMIT 50`, [MEDIA_ID_LIFETIME_DAYS, ...visible])).rows;

      const count = (status: string, kind: string | null) =>
        outcomes.filter((o) => o.status === status && (kind === null || o.failure_kind === kind)).reduce((a, o) => a + o.n, 0);
      const delivery = {
        uncertain7d: count('uncertain', null),
        failed7d: { blocked: count('failed', 'blocked'), rejected: count('failed', 'rejected'), exhausted: count('failed', 'exhausted'),
          providerReported: count('failed', 'provider_reported') },
      };

      // Plain reasons, most serious first. "degraded" means something is not working; "attention" means a person
      // should look at specific items.
      const problems: Array<{ code: string; level: 'degraded' | 'attention' }> = [];
      if (connections.length === 0) problems.push({ code: 'no_connection', level: 'degraded' });
      if (connections.some((c: { status: string }) => c.status !== 'active')) problems.push({ code: 'connection_disabled', level: 'degraded' });
      // Incoming events are applied by the worker (AX-3): a backlog means customers' messages are not yet in the inbox.
      if (Number(webhooks.overdue) > 0) problems.push({ code: 'incoming_delayed', level: 'degraded' });
      if (Number(webhooks.failed) > 0) problems.push({ code: 'incoming_failed', level: 'attention' });
      if (sending.overdue! > 0 || sending.stuck! > 0) problems.push({ code: 'sending_delayed', level: 'degraded' });
      if (media.overdue! > 0) problems.push({ code: 'media_delayed', level: 'degraded' });
      if (Number(webhooks.waitingStatuses) > 0 && webhooks.oldestWaitingStatusAt
          && Date.now() - new Date(webhooks.oldestWaitingStatusAt as string).getTime() > 10 * 60_000) {
        problems.push({ code: 'statuses_waiting', level: 'attention' });
      }
      if (delivery.uncertain7d > 0) problems.push({ code: 'uncertain_deliveries', level: 'attention' });
      if (delivery.failed7d.rejected + delivery.failed7d.exhausted + delivery.failed7d.providerReported > 0) problems.push({ code: 'failed_deliveries', level: 'attention' });
      if (templates.pausedOrDisabled! > 0 || templates.lowQuality! > 0) problems.push({ code: 'template_quality', level: 'attention' });
      if (templates.pendingOver24h! > 0) problems.push({ code: 'template_review_slow', level: 'attention' });
      if (media.failed7d! > 0) problems.push({ code: 'media_failed', level: 'attention' });
      const status = problems.some((p) => p.level === 'degraded') ? 'degraded' : problems.length ? 'attention' : 'healthy';

      return { status, problems, checkedAt: new Date().toISOString(), connections, webhooks, sending, delivery, media, templates, attention, mediaProblems };
    });
  }

  /** Re-applies delivery statuses that arrived before their message was recorded. Safe to repeat. */
  async reapplyStatuses(actor: TenantActor) {
    return withContext(this.deps.db, actor, async (tx) => {
      const waiting = (await tx.query<{ id: string; wamid: string; status: string; code: string | null; ref: string | null }>(
        `SELECT id, payload->>'id' AS wamid, payload->>'status' AS status, payload#>>'{errors,0,code}' AS code,
                payload->>'biz_opaque_callback_data' AS ref
         FROM webhook_events WHERE kind = 'status' AND outcome = 'orphan_status' ORDER BY received_at LIMIT 500`)).rows;
      const result = { applied: 0, stillWaiting: 0, stale: 0 };
      for (const w of waiting) {
        const outcome = await applyStatus(tx, w.wamid, w.status, w.code, w.ref);
        if (outcome === 'orphan_status') { result.stillWaiting++; continue; }
        await tx.query('UPDATE webhook_events SET outcome = $2, processed_at = now() WHERE id = $1', [w.id, outcome]);
        if (outcome === 'applied') result.applied++; else result.stale++;
      }
      await AuditService.record(tx, {
        tenantId: actor.tenantId, actorUserId: actor.userId, action: 'channel.recovery.statuses_reapplied', ip: actor.ip, metadata: result,
      });
      return result;
    });
  }

  /** Downloads a customer's media again after a failed download, while the provider still holds it. */
  async retryMedia(actor: TenantActor, messageId: string) {
    if (!isUuid(messageId)) throw Errors.notFound('Message');
    return withContext(this.deps.db, actor, async (tx) => {
      const m = (await tx.query<{ media_status: string | null; direction: string; created_at: Date }>(
        'SELECT media_status, direction, created_at FROM messages WHERE id = $1 FOR UPDATE', [messageId])).rows[0];
      if (!m || m.direction !== 'in' || !m.media_status) throw Errors.notFound('Message');
      if (m.media_status !== 'failed') throw Errors.conflict('not_retryable', 'Only a failed download can be tried again.');
      if (Date.now() - m.created_at.getTime() > MEDIA_ID_LIFETIME_DAYS * 86_400_000) {
        throw Errors.conflict('media_expired', 'WhatsApp keeps customer media for 7 days; this file can no longer be downloaded. Ask the customer to send it again.');
      }
      await tx.query(`UPDATE messages SET media_status = 'pending' WHERE id = $1`, [messageId]);
      await tx.query(
        `INSERT INTO media_jobs (tenant_id, message_id) VALUES ($1, $2)
         ON CONFLICT (tenant_id, message_id) DO UPDATE SET state = 'pending', attempts = 0, next_attempt_at = now(), lease_until = NULL,
                                                           last_error = NULL, updated_at = now()`, [actor.tenantId, messageId]);
      await AuditService.record(tx, {
        tenantId: actor.tenantId, actorUserId: actor.userId, action: 'channel.recovery.media_retried', ip: actor.ip,
        targetType: 'message', targetId: messageId,
      });
      return { mediaStatus: 'pending' };
    });
  }
}
