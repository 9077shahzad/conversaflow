import { withContext, type Tx } from '@conversaflow/database';
import { z } from 'zod';
import type { Deps, TenantActor } from '../core/context';
import { AppError, Errors } from '../core/errors';
import { parse } from '../core/validate';
import { AuditService } from './audit.service';
import { queueConversationNotice } from './push';
import { consentKeyword, type ParsedEvent, type Provider } from './channels';
import { InboundProcessor, recordWebhook } from './inbound';
import { Sender } from './sender';
import { checkParamValue, renderTemplate } from './templates.service';
import { acceptsInbound, outboundTypeFor } from './media';
import { startTimerOnInbound } from './sla';
import { autoAssignNewConversation } from './auto-assign';
import { startAutomationRuns, stopAutomationRuns } from './automations';
import { conversationTags } from './inbox-tools';
import { isUuid } from './members.service';

/** Free-form replies are allowed only within this long of the customer's last message (Meta customer service window). */
export const SERVICE_WINDOW_HOURS = 24;
/** Manual retries allowed per original message, across the whole retry chain (database constraint, migration 0025). */
export const MANUAL_RETRY_LIMIT = 1;

const ChannelRequest = z.object({
  provider: z.enum(['sandbox', 'whatsapp_cloud']),
  providerNumberId: z.string().regex(/^[0-9A-Za-z_-]{3,64}$/, 'Use the provider number id (letters, digits, - or _)'),
  displayPhone: z.string().trim().min(3).max(32),
  label: z.string().trim().min(1).max(80),
  /** The business account (Meta's WABA id) the number belongs to. Sandbox numbers get their own account if omitted. */
  providerAccountId: z.string().regex(/^[0-9A-Za-z_-]{3,64}$/).optional(),
});
const TemplateSendRequest = z.object({
  templateId: z.string().uuid(),
  params: z.array(z.string().max(1024)).max(20),
  seenActivity: z.number().int().min(0),
  clientMessageId: z.string().uuid(),
  takeover: z.boolean().optional(),
});
const MarketingConsentRequest = z.object({
  granted: z.boolean(),
  /** How the customer agreed or withdrew, in the agent's words (e.g. "Customer asked for offers in chat on 21 Oct"). */
  evidence: z.string().trim().min(5).max(300),
});
const ListQuery = z.object({
  status: z.enum(['open', 'pending', 'resolved', 'active']).default('active'),
  assigned: z.enum(['me', 'unassigned', 'any']).default('any'),
  tag: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before: z.string().datetime({ offset: true }).optional(),
});
const AssignRequest = z.object({ membershipId: z.string().uuid().nullable(), expectedVersion: z.number().int().min(0) });
const StatusRequest = z.object({ status: z.enum(['resolved', 'open']), expectedVersion: z.number().int().min(0) }).strict();
const NoteRequest = z.object({ body: z.string().trim().min(1).max(4000) });
const PauseRequest = z.object({
  reason: z.string().trim().min(3).max(300),
  /** How long the pause lasts; null means until someone releases it. */
  minutes: z.number().int().min(5).max(7 * 24 * 60).nullable(),
});
const RetryRequest = z.object({
  seenActivity: z.number().int().min(0),
  clientMessageId: z.string().uuid(),
  /** Required for an uncertain message: the person confirms that a second copy may reach the customer. */
  confirmPossibleDuplicate: z.boolean().optional(),
});
const ReplyRequest = z.object({
  /** The reply text, or the caption when a file is attached (may then be empty). */
  text: z.string().trim().max(4096).default(''),
  /** A stored file of this company, scanned clean, sent as a WhatsApp media message. */
  fileId: z.string().uuid().optional(),
  /**
   * The conversation's activity counter when the agent last looked (from GET /conversations/:id). Every recorded
   * message bumps it, including a late customer message with an older timestamp; a mismatch refuses the reply.
   */
  seenActivity: z.number().int().min(0),
  /** Idempotency key chosen by the sender; a retried request returns the first result instead of sending again. */
  clientMessageId: z.string().uuid(),
  takeover: z.boolean().optional(),
});

type ConvRow = {
  id: string; contact_id: string; connection_id: string; status: string; assigned_membership_id: string | null;
  last_inbound_at: Date | null; last_message_id: string | null; version: number; activity_seq: string;
  paused_by_membership_id: string | null; paused_reason: string | null; paused_at: Date | null; paused_until: Date | null;
  sla_kind: string | null; sla_started_at: Date | null; sla_due_at: Date | null; first_response_at: Date | null;
};
const pauseActive = (c: ConvRow) => c.paused_at !== null && (c.paused_until === null || c.paused_until.getTime() > Date.now());

/**
 * Messaging slice 1 (CF-EXT-001/002/003): verified webhook intake, contacts, conversations, inbox, assignment,
 * internal notes and replies. Everything runs as cf_app inside one company's context, so row-level security applies.
 */
export class InboxService {
  private readonly sender: Sender;
  constructor(private readonly deps: Deps) {
    this.sender = new Sender(deps.db, deps.channels, {}, undefined, deps.storage);
  }

  // --- Channels ------------------------------------------------------------------------------------------------
  async listChannels(actor: TenantActor) {
    return withContext(this.deps.db, actor, async (tx) => (await tx.query(
      `SELECT id, provider, provider_number_id AS "providerNumberId", display_phone AS "displayPhone", label, status,
              created_at AS "createdAt" FROM channel_connections ORDER BY created_at`)).rows);
  }

  async connectChannel(actor: TenantActor, input: unknown) {
    const body = parse(ChannelRequest, input);
    if (body.provider === 'whatsapp_cloud') {
      throw Errors.conflict('provider_not_available',
        'Connecting a live WhatsApp number needs Meta onboarding, which has not been approved yet. Use the sandbox for testing.');
    }
    if (!this.deps.channels.sandbox) throw Errors.conflict('provider_not_available', 'The sandbox channel is turned off here.');
    return withContext(this.deps.db, actor, async (tx) => {
      try {
        const accountId = body.providerAccountId ?? `sbx-${body.providerNumberId}`;
        let account = (await tx.query<{ id: string }>(
          'SELECT id FROM provider_accounts WHERE provider = $1 AND account_id = $2', [body.provider, accountId])).rows[0];
        // Inserting an account another company holds fails on the unique key: same answer as a taken number.
        account ??= (await tx.query<{ id: string }>(
          'INSERT INTO provider_accounts (tenant_id, provider, account_id) VALUES ($1, $2, $3) RETURNING id',
          [actor.tenantId, body.provider, accountId])).rows[0]!;
        const { rows } = await tx.query(
          `INSERT INTO channel_connections (tenant_id, provider, provider_number_id, display_phone, label, created_by, account_ref)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING id, provider, provider_number_id AS "providerNumberId", display_phone AS "displayPhone", label, status`,
          [actor.tenantId, body.provider, body.providerNumberId, body.displayPhone, body.label, actor.userId, account.id]);
        await AuditService.record(tx, {
          tenantId: actor.tenantId, actorUserId: actor.userId, action: 'channel.connected', ip: actor.ip,
          targetType: 'channel_connection', targetId: rows[0].id, metadata: { provider: body.provider },
        });
        return rows[0];
      } catch (err) {
        // Deliberately the same answer whether this company or another already holds the number (FR-105).
        if ((err as { code?: string }).code === '23505') throw Errors.conflict('number_unavailable', 'This number is already connected.');
        throw err;
      }
    });
  }

  // --- Webhook intake ---------------------------------------------------------------------------------------------
  /**
   * Records the events of one verified delivery (AX-3): each provider event is recorded once (unique key); a repeat
   * changes nothing. Events for unknown or disabled numbers are ignored (counted), never stored. The worker applies
   * recorded events; with INBOUND_APPLY=request (development and tests only) they are applied here, after recording,
   * through the same code.
   */
  async ingest(provider: Provider, payload: unknown) {
    const inline = this.deps.config.INBOUND_APPLY === 'request';
    const { counts, recorded } = await recordWebhook(this.deps.db, provider, payload, inline);
    if (!inline || recorded.length === 0) return counts;
    const applied = await new InboundProcessor(this.deps.db, {}, { inRequest: true }).process(recorded);
    return { ...counts, applied: applied.applied, stale: applied.stale, orphan: applied.orphan, unknownTemplate: applied.unknownTemplate,
      retrying: applied.retrying, failed: applied.failed, queued: applied.retrying };
  }

  // --- Inbox -------------------------------------------------------------------------------------------------------
  /**
   * Agents without inbox.read_all see conversations assigned to them and unassigned ones; nobody else's.
   * Used as `(<$a>::boolean OR c.assigned_membership_id IS NULL OR c.assigned_membership_id = <$b>::uuid)`.
   */
  private visibility(actor: TenantActor): [boolean, string] {
    return [actor.permissions.has('inbox.read_all'), actor.membershipId];
  }

  async list(actor: TenantActor, query: unknown) {
    const q = parse(ListQuery, query);
    if (!isUuid(actor.membershipId)) throw Errors.forbidden();
    return withContext(this.deps.db, actor, async (tx) => {
      const { rows } = await tx.query(
        `SELECT c.id, c.status, c.version, c.assigned_membership_id AS "assignedMembershipId",
                c.last_message_at AS "lastMessageAt", c.last_inbound_at AS "lastInboundAt",
                (c.last_inbound_at IS NOT NULL AND c.last_inbound_at > now() - make_interval(hours => $5)) AS "windowOpen",
                ct.id AS "contactId", ct.display_name AS "contactName", (ct.opted_out_at IS NOT NULL) AS "optedOut",
                m.body AS "lastMessagePreview", m.direction AS "lastMessageDirection",
                (c.paused_at IS NOT NULL AND (c.paused_until IS NULL OR c.paused_until > now())) AS "paused",
                c.sla_kind AS "slaKind", c.sla_due_at AS "slaDueAt",
                EXISTS (SELECT 1 FROM messages f WHERE f.conversation_id = c.id AND f.direction = 'out'
                          AND f.status IN ('failed', 'uncertain')
                          AND NOT EXISTS (SELECT 1 FROM messages r WHERE r.retry_of = f.id)) AS "needsAttention",
                coalesce((SELECT json_agg(json_build_object('id', t.id, 'name', t.name, 'color', t.color) ORDER BY lower(t.name))
                          FROM conversation_tags ctg JOIN tags t ON t.id = ctg.tag_id WHERE ctg.conversation_id = c.id), '[]'::json) AS "tags"
         FROM conversations c
         JOIN contacts ct ON ct.id = c.contact_id
         LEFT JOIN messages m ON m.id = c.last_message_id
         WHERE ($7::boolean OR c.assigned_membership_id IS NULL OR c.assigned_membership_id = $8::uuid)
           AND ($1 = 'active' AND c.status IN ('open', 'pending') OR c.status = $1)
           AND ($2 = 'any' OR ($2 = 'me' AND c.assigned_membership_id = $3::uuid) OR ($2 = 'unassigned' AND c.assigned_membership_id IS NULL))
           AND ($4::timestamptz IS NULL OR c.last_message_at < $4)
           AND ($9::uuid IS NULL OR EXISTS (SELECT 1 FROM conversation_tags ctg WHERE ctg.conversation_id = c.id AND ctg.tag_id = $9::uuid))
         ORDER BY c.last_message_at DESC NULLS LAST, c.id DESC
         LIMIT $6`,
        [q.status, q.assigned, actor.membershipId, q.before ?? null, SERVICE_WINDOW_HOURS, q.limit, ...this.visibility(actor), q.tag ?? null]);
      return { items: rows, nextBefore: rows.length === q.limit ? rows[rows.length - 1].lastMessageAt : null };
    });
  }

  private async loadVisible(tx: Tx, actor: TenantActor, id: string, lock = false): Promise<ConvRow> {
    if (!isUuid(id)) throw Errors.notFound('Conversation');
    const sql = `SELECT * FROM conversations c WHERE c.id = $1
                 AND ($2::boolean OR c.assigned_membership_id IS NULL OR c.assigned_membership_id = $3::uuid)`;
    const c = (await tx.query<ConvRow>(lock ? sql + ' FOR UPDATE' : sql, [id, ...this.visibility(actor)])).rows[0];
    if (!c) throw Errors.notFound('Conversation');
    return c;
  }

  async get(actor: TenantActor, id: string) {
    return withContext(this.deps.db, actor, async (tx) => {
      const c = await this.loadVisible(tx, actor, id);
      const contact = (await tx.query(
        `SELECT ct.id, ct.display_name AS "displayName", (ct.opted_out_at IS NOT NULL) AS "optedOut",
                ct.marketing_consent_at AS "marketingConsentAt",
                (SELECT value FROM contact_identifiers ci WHERE ci.contact_id = ct.id AND ci.kind = 'whatsapp' LIMIT 1) AS "whatsapp"
         FROM contacts ct WHERE ct.id = $1`, [c.contact_id])).rows[0];
      const messages = (await tx.query(
        `SELECT m.id, m.direction, m.kind, m.body, m.provider_type AS "providerType", m.status, m.error_code AS "errorCode",
                m.occurred_at AS "occurredAt", m.sent_by_membership_id AS "sentByMembershipId", (m.referral IS NOT NULL) AS "fromAd",
                (m.automation_run_id IS NOT NULL) AS "byAutomation", m.ai_interaction_id AS "aiInteractionId",
                (SELECT ai.simulated FROM ai_interactions ai WHERE ai.id = m.ai_interaction_id) AS "aiSimulated",
                m.failure_kind AS "failureKind", m.original_author_membership_id AS "originalAuthorMembershipId",
                m.template_id AS "templateId", m.pricing_category AS "pricingCategory",
                m.media_type AS "mediaType", m.media_status AS "mediaStatus", m.file_id AS "fileId", m.media_filename AS "mediaFilename",
                (SELECT f.scan_basis FROM files f WHERE f.id = m.file_id) AS "scanBasis",
                m.attempts, m.retry_of AS "retryOf", m.retry_number AS "retryNumber", r.id AS "retriedAs",
                (m.direction = 'out' AND m.status IN ('failed', 'uncertain') AND r.id IS NULL AND m.retry_number < $2) AS "retryable",
                t.status AS "templateStatus", t.category AS "templateCategory", m.campaign_id AS "campaignId",
                CASE WHEN m.direction = 'out' AND m.status IN ('failed', 'uncertain') THEN
                  (SELECT coalesce(json_agg(json_build_object('attempt', a.attempt, 'outcome', a.outcome, 'code', a.code, 'at', a.created_at)
                                            ORDER BY a.created_at), '[]'::json) FROM send_attempts a WHERE a.message_id = m.id)
                END AS "attemptLog"
         FROM messages m LEFT JOIN messages r ON r.retry_of = m.id LEFT JOIN message_templates t ON t.id = m.template_id
         WHERE m.conversation_id = $1 ORDER BY m.occurred_at, m.id`, [c.id, MANUAL_RETRY_LIMIT])).rows;
      // Why a failed or uncertain message cannot be retried by this person right now (null = it can). An ordinary reply
      // needs the 24-hour window; an approved template does not, but must still be approved (and, for marketing,
      // have recorded consent). The server applies the same checks again when the retry is requested and sent.
      const windowOpenNow = c.last_inbound_at !== null && Date.now() - c.last_inbound_at.getTime() < SERVICE_WINDOW_HOURS * 3600_000;
      const pausedForMe = pauseActive(c) && c.paused_by_membership_id !== actor.membershipId;
      for (const m of messages) {
        if (m.direction !== 'out' || (m.status !== 'failed' && m.status !== 'uncertain')) { m.retryBlock = null; continue; }
        m.retryBlock =
          m.retriedAs ? 'already_retried'
          : m.campaignId ? 'campaign_message'
          : m.retryNumber >= MANUAL_RETRY_LIMIT ? 'retry_limit_reached'
          : c.status === 'resolved' ? 'conversation_resolved'
          : contact.optedOut ? 'contact_opted_out'
          : pausedForMe ? 'replies_paused'
          : c.assigned_membership_id && c.assigned_membership_id !== actor.membershipId ? 'assigned_to_other'
          : m.kind === 'template' ? (m.templateStatus !== 'approved' ? 'template_not_approved'
            : m.templateCategory === 'marketing' && !contact.marketingConsentAt ? 'marketing_consent_required' : null)
          : !windowOpenNow ? 'template_required'
          : null;
      }
      const notes = (await tx.query(
        `SELECT id, body, author_membership_id AS "authorMembershipId", created_at AS "createdAt"
         FROM internal_notes WHERE conversation_id = $1 ORDER BY created_at, id`, [c.id])).rows;
      const events = (await tx.query(
        `SELECT id, kind, actor_membership_id AS "actorMembershipId", data, created_at AS "createdAt"
         FROM conversation_events WHERE conversation_id = $1 ORDER BY created_at, id`, [c.id])).rows;
      const windowOpen = c.last_inbound_at !== null && Date.now() - c.last_inbound_at.getTime() < SERVICE_WINDOW_HOURS * 3600_000;
      return {
        id: c.id, status: c.status, version: c.version, assignedMembershipId: c.assigned_membership_id,
        lastMessageId: c.last_message_id, activitySeq: Number(c.activity_seq), windowOpen, contact, messages, notes, events,
        sla: c.sla_kind ? { kind: c.sla_kind, startedAt: c.sla_started_at, dueAt: c.sla_due_at } : null,
        // 'sandbox' means every send, acceptance and status here is simulated; nothing reached WhatsApp.
        provider: (await tx.query<{ provider: string }>('SELECT provider FROM channel_connections WHERE id = $1', [c.connection_id])).rows[0]?.provider,
        firstResponseAt: c.first_response_at,
        tags: await conversationTags(tx, c.id),
        people: await this.names(tx, [c.assigned_membership_id, c.paused_by_membership_id,
          ...events.map((e) => (e.data as { membershipId?: string } | null)?.membershipId ?? null),
          ...messages.map((m) => m.sentByMembershipId), ...messages.map((m) => m.originalAuthorMembershipId), ...notes.map((n) => n.authorMembershipId), ...events.map((e) => e.actorMembershipId)]),
        pause: pauseActive(c)
          ? { active: true, reason: c.paused_reason, pausedByMembershipId: c.paused_by_membership_id, pausedAt: c.paused_at, until: c.paused_until }
          : { active: false },
      };
    });
  }

  /** Display names for the people who appear in a conversation (members of this company only, under RLS). */
  private async names(tx: Tx, ids: Array<string | null | undefined>): Promise<Record<string, string>> {
    const unique = [...new Set(ids.filter((x): x is string => !!x))];
    if (!unique.length) return {};
    const { rows } = await tx.query<{ id: string; name: string }>(
      'SELECT m.id, u.full_name AS name FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.id = ANY($1::uuid[])', [unique]);
    return Object.fromEntries(rows.map((r) => [r.id, r.name]));
  }

  async assign(actor: TenantActor, id: string, input: unknown) {
    const body = parse(AssignRequest, input);
    return withContext(this.deps.db, actor, async (tx) => {
      const c = await this.loadVisible(tx, actor, id);
      const canAssignOthers = actor.permissions.has('inbox.assign');
      const selfClaim = body.membershipId === actor.membershipId && c.assigned_membership_id === null;
      const selfRelease = body.membershipId === null && c.assigned_membership_id === actor.membershipId;
      if (!canAssignOthers && !selfClaim && !selfRelease) throw Errors.forbidden('You can only pick up unassigned conversations or hand back your own.');
      if (body.membershipId) {
        const ok = await tx.query(
          `SELECT 1 FROM memberships m JOIN membership_roles mr ON mr.membership_id = m.id
           JOIN role_permissions rp ON rp.role_id = mr.role_id AND rp.permission_key = 'inbox.reply'
           WHERE m.id = $1 AND m.status = 'active'`, [body.membershipId]);
        if (!ok.rowCount) throw Errors.badRequest('That person cannot reply to customers in this company.');
      }
      const upd = await tx.query(
        `UPDATE conversations SET assigned_membership_id = $2, version = version + 1 WHERE id = $1 AND version = $3 RETURNING version`,
        [c.id, body.membershipId, body.expectedVersion]);
      if (!upd.rowCount) {
        throw new AppError(409, 'conversation_changed', 'Someone else changed this conversation. Reload it and try again.',
          { version: c.version, assignedMembershipId: c.assigned_membership_id });
      }
      await tx.query(
        `INSERT INTO conversation_events (tenant_id, conversation_id, kind, actor_membership_id, data) VALUES ($1, $2, $3, $4, $5)`,
        [actor.tenantId, c.id, body.membershipId ? 'assigned' : 'unassigned', actor.membershipId,
          JSON.stringify({ from: c.assigned_membership_id, to: body.membershipId })]);
      // Assigned to a person: from now on that person handles it, and automations stop (FR-206; review of W2.1, L4).
      if (body.membershipId) await stopAutomationRuns(tx, c.id, 'person_assigned');
      await AuditService.record(tx, {
        tenantId: actor.tenantId, actorUserId: actor.userId, action: 'conversation.assigned', ip: actor.ip,
        targetType: 'conversation', targetId: c.id, metadata: { from: c.assigned_membership_id, to: body.membershipId },
      });
      return { id: c.id, version: upd.rows[0].version, assignedMembershipId: body.membershipId };
    });
  }

  /**
   * Resolves or reopens a conversation (FR-201, FR-205). The person handling it, anyone for an unassigned one, or
   * someone with inbox.assign. Resolving stops the reply timer. A resolved conversation stays in history; the
   * customer's next message starts a new conversation, so reopening is refused if a newer one is already open.
   */
  async setStatus(actor: TenantActor, id: string, input: unknown) {
    const body = parse(StatusRequest, input);
    return withContext(this.deps.db, actor, async (tx) => {
      const c = await this.loadVisible(tx, actor, id);
      const mine = c.assigned_membership_id === null || c.assigned_membership_id === actor.membershipId;
      if (!mine && !actor.permissions.has('inbox.assign')) throw new AppError(409, 'assigned_to_other', 'Another person is handling this conversation.');
      const to = body.status;
      if ((to === 'resolved') === (c.status === 'resolved')) {
        throw Errors.conflict(to === 'resolved' ? 'already_resolved' : 'not_resolved', to === 'resolved' ? 'This conversation is already resolved.' : 'This conversation is not resolved.');
      }
      let upd;
      try {
        upd = await tx.query<{ version: number }>(
          `UPDATE conversations SET status = $2, resolved_at = CASE WHEN $2 = 'resolved' THEN now() END,
                  sla_kind = CASE WHEN $2 = 'resolved' THEN NULL ELSE sla_kind END,
                  sla_started_at = CASE WHEN $2 = 'resolved' THEN NULL ELSE sla_started_at END,
                  sla_due_at = CASE WHEN $2 = 'resolved' THEN NULL ELSE sla_due_at END,
                  activity_seq = activity_seq + 1, version = version + 1
           WHERE id = $1 AND version = $3 RETURNING version`, [c.id, to, body.expectedVersion]);
      } catch (err) {
        if ((err as { code?: string }).code === '23505') throw Errors.conflict('newer_conversation_open', 'The customer has a newer open conversation. Continue there.');
        throw err;
      }
      if (!upd.rowCount) throw new AppError(409, 'conversation_changed', 'Someone else changed this conversation. Reload it and try again.', { version: c.version });
      await tx.query(
        `INSERT INTO conversation_events (tenant_id, conversation_id, kind, actor_membership_id, data) VALUES ($1, $2, 'status_changed', $3, $4)`,
        [actor.tenantId, c.id, actor.membershipId, JSON.stringify({ from: c.status, to })]);
      if (to === 'resolved') await stopAutomationRuns(tx, c.id, 'conversation_resolved');
      return { id: c.id, status: to, version: upd.rows[0]!.version };
    });
  }

  /** Internal notes are stored for the team only. Nothing here can reach a channel adapter. */
  async addNote(actor: TenantActor, id: string, input: unknown) {
    const body = parse(NoteRequest, input);
    return withContext(this.deps.db, actor, async (tx) => {
      const c = await this.loadVisible(tx, actor, id);
      const { rows } = await tx.query(
        `INSERT INTO internal_notes (tenant_id, conversation_id, author_membership_id, body) VALUES ($1, $2, $3, $4)
         RETURNING id, body, author_membership_id AS "authorMembershipId", created_at AS "createdAt"`,
        [actor.tenantId, c.id, actor.membershipId, body.body]);
      return rows[0];
    });
  }

  /** Checks shared by replies and retries. Throws the reason a person may not send in this conversation now. */
  private async checkCanSend(tx: Tx, actor: TenantActor, c: ConvRow, seenActivity: number, takeover = false, requireWindow = true) {
    const ctx = (await tx.query<{ opted_out_at: Date | null; wa: string | null; channel_status: string }>(
      `SELECT ct.opted_out_at, ch.status AS channel_status,
              (SELECT value FROM contact_identifiers ci WHERE ci.contact_id = ct.id AND ci.kind = 'whatsapp' LIMIT 1) AS wa
       FROM contacts ct, channel_connections ch WHERE ct.id = $1 AND ch.id = $2`, [c.contact_id, c.connection_id])).rows[0]!;
    if (c.status === 'resolved') throw Errors.conflict('conversation_resolved', 'This conversation is resolved.');
    if (ctx.channel_status !== 'active') throw Errors.conflict('channel_disabled', 'This channel is turned off.');
    if (pauseActive(c) && c.paused_by_membership_id !== actor.membershipId) {
      throw new AppError(409, 'replies_paused', 'A supervisor has paused replies on this conversation.',
        { reason: c.paused_reason, pausedByMembershipId: c.paused_by_membership_id, until: c.paused_until });
    }
    let assigned = c.assigned_membership_id;
    if (assigned && assigned !== actor.membershipId) {
      if (!takeover) throw new AppError(409, 'assigned_to_other', 'Another person is handling this conversation.', { assignedMembershipId: assigned });
      if (!actor.permissions.has('inbox.assign')) throw Errors.forbidden('Only a supervisor can take over a conversation.');
      await tx.query(
        `INSERT INTO conversation_events (tenant_id, conversation_id, kind, actor_membership_id, data) VALUES ($1, $2, 'takeover', $3, $4)`,
        [actor.tenantId, c.id, actor.membershipId, JSON.stringify({ from: assigned })]);
      await AuditService.record(tx, {
        tenantId: actor.tenantId, actorUserId: actor.userId, action: 'conversation.takeover', ip: actor.ip,
        targetType: 'conversation', targetId: c.id, metadata: { from: assigned },
      });
      assigned = null;
    }
    if (Number(c.activity_seq) !== seenActivity) {
      throw new AppError(409, 'conversation_changed', 'New messages arrived or were sent. Read them before replying.',
        { activitySeq: Number(c.activity_seq) });
    }
    if (ctx.opted_out_at) throw Errors.conflict('contact_opted_out', 'This customer has opted out of messages.');
    if (requireWindow && (c.last_inbound_at === null || Date.now() - c.last_inbound_at.getTime() >= SERVICE_WINDOW_HOURS * 3600_000)) {
      throw Errors.conflict('template_required',
        'More than 24 hours have passed since the customer last wrote. Only an approved template can be sent now.');
    }
    if (!ctx.wa) throw Errors.conflict('no_whatsapp_identifier', 'This contact has no verified WhatsApp number.');
    if (assigned === null) {
      await tx.query(
        `INSERT INTO conversation_events (tenant_id, conversation_id, kind, actor_membership_id, data) VALUES ($1, $2, 'assigned', $3, $4)`,
        [actor.tenantId, c.id, actor.membershipId, JSON.stringify({ from: c.assigned_membership_id, to: actor.membershipId, by: 'reply' })]);
    }
  }

  /** A file may be sent only if it is this company's, scanned clean, and of a type and size WhatsApp accepts. */
  private async attachable(tx: Tx, actor: TenantActor, fileId: string) {
    if (!actor.permissions.has('files.read')) throw Errors.forbidden('You cannot send files.');
    const f = (await tx.query<{ id: string; status: string; content_type: string; size_bytes: string; original_name: string }>(
      'SELECT id, status, content_type, size_bytes, original_name FROM files WHERE id = $1', [fileId])).rows[0];
    if (!f || f.status !== 'available') throw Errors.notFound('File');
    const type = outboundTypeFor(f.content_type, Number(f.size_bytes));
    if (!type) throw Errors.badRequest('WhatsApp does not accept this type or size of file.');
    return { type, fileId: f.id, mime: f.content_type, filename: f.original_name };
  }

  /** Records a queued outbound message and its send job, and moves the conversation forward. */
  private async enqueue(tx: Tx, actor: TenantActor, c: ConvRow, text: string, clientMessageId: string, retryOf: string | null,
    template?: { id: string; params: string[]; category: string }, media?: { type: string; fileId: string; mime: string; filename: string }) {
    const msg = (await tx.query<{ id: string; occurred_at: Date }>(
      `INSERT INTO messages (tenant_id, conversation_id, direction, kind, body, client_message_id, sent_by_membership_id, occurred_at, status,
                             retry_of, template_id, template_params, pricing_category, media_type, media_status, file_id, media_mime, media_filename)
       VALUES ($1, $2, 'out', $7, $3, $4, $5, clock_timestamp(), 'queued', $6, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING id, occurred_at`,
      [actor.tenantId, c.id, text || null, clientMessageId, actor.membershipId, retryOf, template ? 'template' : media ? 'media' : 'text',
        template?.id ?? null, template ? JSON.stringify(template.params) : null, template?.category ?? 'service',
        media?.type ?? null, media ? 'available' : null, media?.fileId ?? null, media?.mime ?? null, media?.filename ?? null])).rows[0]!;
    const job = (await tx.query<{ id: string }>(
      'INSERT INTO send_jobs (tenant_id, message_id) VALUES ($1, $2) RETURNING id', [actor.tenantId, msg.id])).rows[0]!;
    // A person on the team wrote: automations stop in this conversation (FR-206).
    await stopAutomationRuns(tx, c.id, 'person_replied');
    await tx.query(
      `UPDATE conversations SET assigned_membership_id = $2, last_message_id = $3, last_message_at = $4,
              activity_seq = activity_seq + 1, version = version + 1 WHERE id = $1`,
      [c.id, actor.membershipId, msg.id, msg.occurred_at]);
    return { messageId: msg.id, jobId: job.id };
  }

  /** Sends straight away when possible; if this fails or the process stops, the worker finishes the job. */
  private async sendNow(actor: TenantActor, jobId: string) {
    try {
      if (await this.sender.leaseNow(actor.tenantId, jobId)) await this.sender.processJob(actor.tenantId, jobId);
    } catch (err) {
      console.error('immediate send failed; the worker will continue', err instanceof Error ? err.message : err);
    }
  }

  async reply(actor: TenantActor, id: string, input: unknown) {
    const body = parse(ReplyRequest, input);
    type Prepared = { existing: string } | { existing?: undefined; messageId: string; jobId: string };
    const prepared = await withContext<Prepared>(this.deps.db, actor, async (tx) => {
      // A retry of a request we already accepted returns that message, whatever has changed since.
      const again = await tx.query(`SELECT id FROM messages WHERE client_message_id = $1 AND sent_by_membership_id = $2`,
        [body.clientMessageId, actor.membershipId]);
      if (again.rows[0]) return { existing: again.rows[0].id as string };
      const c = await this.loadVisible(tx, actor, id, true);
      if (!body.fileId && !body.text) throw Errors.badRequest('Write a reply or attach a file.');
      const media = body.fileId ? await this.attachable(tx, actor, body.fileId) : undefined;
      await this.checkCanSend(tx, actor, c, body.seenActivity, body.takeover);
      return this.enqueue(tx, actor, c, body.text, body.clientMessageId, null, undefined, media);
    });
    if (prepared.existing !== undefined) return this.message(actor, prepared.existing);
    await this.sendNow(actor, prepared.jobId);
    return this.message(actor, prepared.messageId);
  }

  /**
   * A person retries a failed or uncertain message (owner decisions of 20 and 21 Oct 2026).
   *
   * - Anyone who may reply to the conversation right now may retry, including a colleague's message. The usual reply
   *   checks apply now (assignment, pause, opt-out, window, channel) and again when the retry is actually sent.
   * - The retry is a new message linked to the original, which keeps its honest status. The database records the
   *   original author and the person retrying, and limits retries to MANUAL_RETRY_LIMIT per original message across
   *   the whole chain, so a retry copy cannot be retried again to get round the limit.
   * - A confirmed failure (`failed`) can be retried directly. An `uncertain` message may already have reached the
   *   customer, so the person must confirm that a second copy is acceptable.
   */
  async retry(actor: TenantActor, messageId: string, input: unknown) {
    const body = parse(RetryRequest, input);
    if (!isUuid(messageId)) throw Errors.notFound('Message');
    type Prepared = { existing: string } | { existing?: undefined; messageId: string; jobId: string };
    const prepared = await withContext<Prepared>(this.deps.db, actor, async (tx) => {
      const again = await tx.query(`SELECT id FROM messages WHERE client_message_id = $1 AND sent_by_membership_id = $2`,
        [body.clientMessageId, actor.membershipId]);
      if (again.rows[0]) return { existing: again.rows[0].id as string };
      const orig = (await tx.query<{
        id: string; conversation_id: string; status: string; body: string | null; direction: string; error_code: string | null;
        failure_kind: string | null; retry_number: number; original_author_membership_id: string | null;
        kind: string; template_id: string | null; template_params: string[] | null; pricing_category: string | null; file_id: string | null;
        campaign_id: string | null;
      }>(
        `SELECT id, conversation_id, status, body, direction, error_code, failure_kind, retry_number, original_author_membership_id,
                kind, template_id, template_params, pricing_category, file_id, campaign_id
         FROM messages WHERE id = $1`, [messageId])).rows[0];
      if (!orig || orig.direction !== 'out') throw Errors.notFound('Message');
      // A campaign message is never retried one by one: a retry would be an ordinary message and would skip the
      // campaign's own checks (suppression list, cancellation, frequency and daily limits). Review finding S4-1.
      if (orig.campaign_id) {
        throw Errors.conflict('campaign_message', 'Campaign messages are not retried individually. Start a new campaign if needed.');
      }
      const c = await this.loadVisible(tx, actor, orig.conversation_id, true);
      if (orig.status !== 'failed' && orig.status !== 'uncertain') {
        throw Errors.conflict('not_retryable', 'Only a failed or uncertain message can be retried.');
      }
      if (orig.retry_number >= MANUAL_RETRY_LIMIT) {
        throw Errors.conflict('retry_limit_reached', 'This message has already been retried as often as allowed. Write a new reply instead.');
      }
      if (await tx.query('SELECT 1 FROM messages WHERE retry_of = $1', [orig.id]).then((r) => r.rowCount)) {
        throw Errors.conflict('already_retried', 'This message has already been retried.');
      }
      if (orig.status === 'uncertain' && !body.confirmPossibleDuplicate) {
        throw new AppError(409, 'confirmation_required',
          'We do not know whether this message reached the customer. Retrying may send it twice. Confirm to retry.');
      }
      // A template may be retried outside the window (it will be checked again: still approved, consent).
      await this.checkCanSend(tx, actor, c, body.seenActivity, false, orig.kind !== 'template');
      const media = orig.kind === 'media' && orig.file_id ? await this.attachable(tx, actor, orig.file_id) : undefined;
      const queued = await this.enqueue(tx, actor, c, orig.body ?? '', body.clientMessageId, orig.id,
        orig.kind === 'template' ? { id: orig.template_id!, params: orig.template_params ?? [], category: orig.pricing_category ?? 'utility' } : undefined,
        media);
      const record = {
        original: orig.id, retry: queued.messageId, originalStatus: orig.status, failureKind: orig.failure_kind,
        errorCode: orig.error_code, originalAuthorMembershipId: orig.original_author_membership_id,
        retriedByMembershipId: actor.membershipId, confirmedPossibleDuplicate: orig.status === 'uncertain',
      };
      await tx.query(
        `INSERT INTO conversation_events (tenant_id, conversation_id, kind, actor_membership_id, data) VALUES ($1, $2, 'retried', $3, $4)`,
        [actor.tenantId, c.id, actor.membershipId, JSON.stringify(record)]);
      await AuditService.record(tx, {
        tenantId: actor.tenantId, actorUserId: actor.userId, action: 'message.retried', ip: actor.ip, targetType: 'message', targetId: orig.id,
        metadata: record,
      });
      return queued;
    }).catch((err) => {
      const code = (err as { code?: string }).code;
      // Two people retrying at once, or a retry past the chain limit, are stopped by database constraints.
      if (code === '23505') throw Errors.conflict('already_retried', 'This message has already been retried.');
      // Only the chain-length constraint means the limit; anything else (e.g. the message changed state at the same
      // moment) is reported as not retryable (review of slice 3, finding 8).
      if (code === '23514' && (err as { constraint?: string }).constraint === 'messages_retry_number_check') {
        throw Errors.conflict('retry_limit_reached', 'This message has already been retried as often as allowed. Write a new reply instead.');
      }
      if (code === '23514') throw Errors.conflict('not_retryable', 'This message can no longer be retried. Reload the conversation.');
      throw err;
    });
    if (prepared.existing !== undefined) return this.message(actor, prepared.existing);
    await this.sendNow(actor, prepared.jobId);
    return this.message(actor, prepared.messageId);
  }

  /**
   * Sends an approved template (the only way to write after the 24-hour window has closed). The usual checks apply
   * (assignment, pause, opt-out, channel) and, for marketing templates, recorded marketing consent. Everything is
   * checked again at send time, including that the template is still approved.
   */
  async sendTemplate(actor: TenantActor, id: string, input: unknown) {
    const body = parse(TemplateSendRequest, input);
    type Prepared = { existing: string } | { existing?: undefined; messageId: string; jobId: string };
    const prepared = await withContext<Prepared>(this.deps.db, actor, async (tx) => {
      const again = await tx.query(`SELECT id FROM messages WHERE client_message_id = $1 AND sent_by_membership_id = $2`,
        [body.clientMessageId, actor.membershipId]);
      if (again.rows[0]) return { existing: again.rows[0].id as string };
      const c = await this.loadVisible(tx, actor, id, true);
      const tpl = (await tx.query<{ id: string; status: string; category: string; param_count: number; account_ref: string;
        header_text: string | null; body_text: string; footer_text: string | null }>(
        `SELECT t.id, t.status, t.category, t.param_count, t.account_ref, t.header_text, t.body_text, t.footer_text
         FROM message_templates t WHERE t.id = $1`, [body.templateId])).rows[0];
      if (!tpl) throw Errors.notFound('Template');
      const conn = (await tx.query<{ account_ref: string }>('SELECT account_ref FROM channel_connections WHERE id = $1', [c.connection_id])).rows[0]!;
      if (tpl.account_ref !== conn.account_ref) throw Errors.badRequest('This template belongs to a different WhatsApp business account.');
      if (tpl.status !== 'approved') throw Errors.conflict('template_not_approved', 'This template is not approved for sending.');
      if (body.params.length !== tpl.param_count || !body.params.every(checkParamValue)) {
        throw Errors.badRequest(`Fill in all ${tpl.param_count} values, each on one line.`);
      }
      if (tpl.category === 'marketing') {
        const consent = (await tx.query<{ marketing_consent_at: Date | null }>('SELECT marketing_consent_at FROM contacts WHERE id = $1', [c.contact_id])).rows[0]!;
        if (!consent.marketing_consent_at) {
          throw Errors.conflict('marketing_consent_required', 'This customer has not agreed to receive marketing messages.');
        }
      }
      await this.checkCanSend(tx, actor, c, body.seenActivity, body.takeover, false);
      return this.enqueue(tx, actor, c, renderTemplate(tpl, body.params), body.clientMessageId, null,
        { id: tpl.id, params: body.params, category: tpl.category });
    });
    if (prepared.existing !== undefined) return this.message(actor, prepared.existing);
    await this.sendNow(actor, prepared.jobId);
    return this.message(actor, prepared.messageId);
  }

  /** Records that a customer agreed to, or withdrew from, marketing messages, with the agent's evidence. */
  async setMarketingConsent(actor: TenantActor, contactId: string, input: unknown) {
    const body = parse(MarketingConsentRequest, input);
    if (!isUuid(contactId)) throw Errors.notFound('Contact');
    return withContext(this.deps.db, actor, async (tx) => {
      const ct = (await tx.query<{ opted_out_at: Date | null }>('SELECT opted_out_at FROM contacts WHERE id = $1 FOR UPDATE', [contactId])).rows[0];
      if (!ct) throw Errors.notFound('Contact');
      if (body.granted && ct.opted_out_at) {
        throw Errors.conflict('contact_opted_out', 'This customer has opted out of all messages. They must send START first.');
      }
      await tx.query(`UPDATE contacts SET marketing_consent_at = CASE WHEN $2 THEN now() END, updated_at = now() WHERE id = $1`, [contactId, body.granted]);
      await tx.query(
        `INSERT INTO consent_events (tenant_id, contact_id, kind, channel, source, evidence, recorded_by) VALUES ($1, $2, $3, 'whatsapp', 'agent_recorded', $4, $5)`,
        [actor.tenantId, contactId, body.granted ? 'marketing_opt_in' : 'marketing_opt_out', body.evidence, actor.userId]);
      await AuditService.record(tx, {
        tenantId: actor.tenantId, actorUserId: actor.userId, action: body.granted ? 'contact.marketing_opt_in' : 'contact.marketing_opt_out',
        ip: actor.ip, targetType: 'contact', targetId: contactId, metadata: { source: 'agent_recorded' },
      });
      return { marketingConsent: body.granted };
    });
  }

  /** "Pause replies / supervisor handling" (owner decision 20 Oct 2026): blocks everyone else's replies until released or expired. */
  async pause(actor: TenantActor, id: string, input: unknown) {
    const body = parse(PauseRequest, input);
    return withContext(this.deps.db, actor, async (tx) => {
      const c = await this.loadVisible(tx, actor, id, true);
      if (pauseActive(c) && c.paused_by_membership_id !== actor.membershipId) {
        throw new AppError(409, 'already_paused', 'Another supervisor has already paused replies here.',
          { reason: c.paused_reason, pausedByMembershipId: c.paused_by_membership_id, until: c.paused_until });
      }
      const upd = (await tx.query<{ paused_at: Date; paused_until: Date | null }>(
        `UPDATE conversations SET paused_by_membership_id = $2, paused_reason = $3, paused_at = now(),
                paused_until = CASE WHEN $4::int IS NULL THEN NULL ELSE now() + make_interval(mins => $4::int) END,
                version = version + 1
         WHERE id = $1 RETURNING paused_at, paused_until`, [c.id, actor.membershipId, body.reason, body.minutes])).rows[0]!;
      await tx.query(
        `INSERT INTO conversation_events (tenant_id, conversation_id, kind, actor_membership_id, data) VALUES ($1, $2, 'paused', $3, $4)`,
        [actor.tenantId, c.id, actor.membershipId, JSON.stringify({ reason: body.reason, until: upd.paused_until })]);
      await stopAutomationRuns(tx, c.id, 'replies_paused');
      await AuditService.record(tx, {
        tenantId: actor.tenantId, actorUserId: actor.userId, action: 'conversation.replies_paused', ip: actor.ip,
        targetType: 'conversation', targetId: c.id, metadata: { reason: body.reason, minutes: body.minutes },
      });
      return { active: true, reason: body.reason, pausedByMembershipId: actor.membershipId, pausedAt: upd.paused_at, until: upd.paused_until };
    });
  }

  async release(actor: TenantActor, id: string) {
    return withContext(this.deps.db, actor, async (tx) => {
      const c = await this.loadVisible(tx, actor, id, true);
      if (!pauseActive(c)) throw Errors.conflict('not_paused', 'Replies are not paused here.');
      if (c.paused_by_membership_id !== actor.membershipId && !actor.permissions.has('inbox.pause')) {
        throw Errors.forbidden('Only a supervisor can release a pause.');
      }
      await tx.query(
        `UPDATE conversations SET paused_by_membership_id = NULL, paused_reason = NULL, paused_at = NULL, paused_until = NULL,
                version = version + 1 WHERE id = $1`, [c.id]);
      await tx.query(
        `INSERT INTO conversation_events (tenant_id, conversation_id, kind, actor_membership_id, data) VALUES ($1, $2, 'resumed', $3, $4)`,
        [actor.tenantId, c.id, actor.membershipId, JSON.stringify({ pausedBy: c.paused_by_membership_id })]);
      await AuditService.record(tx, {
        tenantId: actor.tenantId, actorUserId: actor.userId, action: 'conversation.replies_resumed', ip: actor.ip,
        targetType: 'conversation', targetId: c.id, metadata: { pausedBy: c.paused_by_membership_id },
      });
      return { active: false };
    });
  }

  private async message(actor: TenantActor, id: string) {
    return withContext(this.deps.db, actor, async (tx) => (await tx.query(
      `SELECT id, conversation_id AS "conversationId", direction, body, status, error_code AS "errorCode", failure_kind AS "failureKind",
              occurred_at AS "occurredAt", attempts, retry_of AS "retryOf", retry_number AS "retryNumber",
              sent_by_membership_id AS "sentByMembershipId", original_author_membership_id AS "originalAuthorMembershipId"
       FROM messages WHERE id = $1`, [id])).rows[0]);
  }
}

/** Applies one recorded incoming message (called by the inbound processor with the customer's lock held). */
export async function applyInboundMessage(tx: Tx, tenantId: string, connectionId: string, e: Extract<ParsedEvent, { kind: 'message' }>, assignmentLocked = false) {
  // Serialise work for one customer, so two deliveries for a new number cannot create two contacts.
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${tenantId}:wa:${e.from}`]);
  let contactId = (await tx.query<{ contact_id: string }>(
    `SELECT contact_id FROM contact_identifiers WHERE kind = 'whatsapp' AND value = $1`, [e.from])).rows[0]?.contact_id;
  if (!contactId) {
    contactId = (await tx.query<{ id: string }>(
      'INSERT INTO contacts (tenant_id, display_name) VALUES ($1, $2) RETURNING id', [tenantId, e.profileName])).rows[0]!.id;
    await tx.query(`INSERT INTO contact_identifiers (tenant_id, contact_id, kind, value) VALUES ($1, $2, 'whatsapp', $3)`,
      [tenantId, contactId, e.from]);
  }
  let conv = (await tx.query<ConvRow>(
    `SELECT * FROM conversations WHERE contact_id = $1 AND connection_id = $2 AND status <> 'resolved' FOR UPDATE`,
    [contactId, connectionId])).rows[0];
  if (!conv) {
    conv = (await tx.query<ConvRow>(
      'INSERT INTO conversations (tenant_id, contact_id, connection_id) VALUES ($1, $2, $3) RETURNING *',
      [tenantId, contactId, connectionId])).rows[0]!;
  }
  // The customer's first message in this conversation (new, or started by a campaign): read before it is updated.
  const firstInbound = conv.last_inbound_at === null && conv.assigned_membership_id === null;
  // Media is recorded now and downloaded, checked for malware and stored by a background job.
  const media = e.media;
  const mediaStatus = media ? (acceptsInbound(media.type, media.mime) ? 'pending' : 'unsupported') : null;
  const kind = e.type === 'text' ? 'text' : media ? 'media' : 'unsupported';
  const msg = await tx.query<{ id: string }>(
    `INSERT INTO messages (tenant_id, conversation_id, direction, kind, body, provider_type, provider_message_id, occurred_at, status, referral,
                           media_type, media_status, provider_media_id, media_mime, media_filename)
     VALUES ($1, $2, 'in', $3, $4, $5, $6, $7, 'received', $8, $9, $10, $11, $12, $13)
     ON CONFLICT (tenant_id, provider_message_id) DO NOTHING RETURNING id`,
    [tenantId, conv.id, kind, e.body, e.type === 'text' ? null : e.type,
      e.providerMessageId, e.occurredAt, e.referral ? JSON.stringify(e.referral) : null,
      media?.type ?? null, mediaStatus, media?.id ?? null, media?.mime?.slice(0, 120) ?? null, media?.filename?.slice(0, 255) ?? null]);
  const messageId = msg.rows[0]?.id;
  if (!messageId) return 'applied' as const; // already recorded under another event key; nothing more to do
  // Click-to-WhatsApp: the conversation is credited to the first ad (or post) tapped within it (W1.9). Later taps in
  // the same conversation do not change it.
  if (e.referral) {
    // "New customer": no earlier conversation with the company and no earlier message in this one (the same rule as
    // the backfill; an imported contact who never wrote counts as new). Recheck W1.
    const isNew = (await tx.query<{ n: boolean }>(
      `SELECT NOT EXISTS (SELECT 1 FROM conversations p WHERE p.contact_id = $1 AND p.id <> $2 AND p.created_at <= (SELECT created_at FROM conversations WHERE id = $2))
              AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = $2 AND m.id <> $3 AND m.occurred_at < $4) AS n`,
      [contactId, conv.id, messageId, e.occurredAt])).rows[0]!.n;
    await recordAttribution(tx, tenantId, conv.id, contactId, messageId, e.referral, e.occurredAt, isNew);
  }
  // A customer's first message in a conversation nobody has: give it to the next team member if automatic assignment is on.
  // Only if the assignment lock was taken at the start: switching assignment on in the middle of a delivery must not
  // take that lock after a customer lock (review L3). The next first message is assigned as usual.
  if (firstInbound && assignmentLocked) await autoAssignNewConversation(tx, tenantId, conv.id, new Date());
  if (mediaStatus === 'pending') await tx.query('INSERT INTO media_jobs (tenant_id, message_id) VALUES ($1, $2)', [tenantId, messageId]);
  await startTimerOnInbound(tx, conv.id, e.occurredAt);
  // A delayed message updates the thread position only if it is the newest; the service window uses the latest.
  await tx.query(
    `UPDATE conversations SET
       last_inbound_at = greatest(coalesce(last_inbound_at, $2), $2),
       first_inbound_at = least(coalesce(first_inbound_at, $2), $2),
       last_message_id = CASE WHEN last_message_at IS NULL OR $2 >= last_message_at THEN $3 ELSE last_message_id END,
       last_message_at = greatest(coalesce(last_message_at, $2), $2),
       status = CASE WHEN status = 'pending' THEN 'open' ELSE status END,
       activity_seq = activity_seq + 1,
       version = version + 1
     WHERE id = $1`, [conv.id, e.occurredAt, messageId]);

  const consent = consentKeyword(e.body);
  if (consent) {
    const cur = (await tx.query<{ opted_out_at: Date | null; opt_keyword_at: Date | null }>(
      'SELECT opted_out_at, opt_keyword_at FROM contacts WHERE id = $1', [contactId])).rows[0]!;
    const optedOut = cur.opted_out_at;
    // Applied in the order the customer sent them: an older STOP or START (a retried or delayed event) changes nothing
    // once a newer keyword has been applied (review of AX-3, M1).
    // WhatsApp timestamps are in whole seconds: keywords sent within the same second apply in the order received.
    const newer = cur.opt_keyword_at === null || e.occurredAt.getTime() >= cur.opt_keyword_at.getTime();
    if (newer) await tx.query('UPDATE contacts SET opt_keyword_at = $2 WHERE id = $1', [contactId, e.occurredAt]);
    if (newer && (consent === 'opt_out') !== (optedOut !== null)) {
      // An opt-out also withdraws any marketing consent; opting back in does not restore it.
      await tx.query(
        `UPDATE contacts SET opted_out_at = CASE WHEN $2 THEN now() END,
                marketing_consent_at = CASE WHEN $2 THEN NULL ELSE marketing_consent_at END, updated_at = now() WHERE id = $1`,
        [contactId, consent === 'opt_out']);
      await tx.query(
        `INSERT INTO consent_events (tenant_id, contact_id, kind, channel, source, evidence) VALUES ($1, $2, $3, 'whatsapp', 'inbound_keyword', $4)`,
        [tenantId, contactId, consent, e.providerMessageId]);
      await tx.query(
        `INSERT INTO conversation_events (tenant_id, conversation_id, kind, data) VALUES ($1, $2, $3, $4)`,
        [tenantId, conv.id, consent === 'opt_out' ? 'opted_out' : 'opted_in', JSON.stringify({ evidence: e.providerMessageId })]);
      await AuditService.record(tx, {
        tenantId, actorUserId: null, action: consent === 'opt_out' ? 'contact.opted_out' : 'contact.opted_in',
        targetType: 'contact', targetId: contactId, metadata: { source: 'inbound_keyword', channel: 'whatsapp' },
      });
    }
  }
  // Notifications on the team's devices (W2.5): queued in this transaction, so exactly once.
  if (!consent) await queueConversationNotice(tx, tenantId, conv.id, 'new_message');
  // Automations: started in this transaction, so exactly once per message. STOP and START never start one.
  if (!consent) {
    await startAutomationRuns(tx, tenantId, { conversationId: conv.id, contactId, messageId, body: e.body, firstInbound: conv.last_inbound_at === null });
  }
  return 'applied' as const;
}

const str = (v: unknown, max: number) => (typeof v === 'string' && v.length > 0 ? v.slice(0, max) : null);
async function recordAttribution(tx: Tx, tenantId: string, conversationId: string, contactId: string, messageId: string,
  referral: Record<string, unknown>, at: Date, newContact: boolean) {
  const type = referral.source_type === 'ad' || referral.source_type === 'post' ? referral.source_type : 'unknown';
  await tx.query(
    `INSERT INTO conversation_attributions (conversation_id, tenant_id, contact_id, message_id, source_type, source_id, source_url, headline, ctwa_clid, new_contact, first_message_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT (conversation_id) DO NOTHING`,
    [conversationId, tenantId, contactId, messageId, type, str(referral.source_id, 100), str(referral.source_url, 500),
      str(referral.headline, 300), str(referral.ctwa_clid, 300), newContact, at]);
}
