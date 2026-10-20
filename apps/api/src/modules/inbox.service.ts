import { withContext, type Tx } from '@conversaflow/database';
import { z } from 'zod';
import type { Deps, TenantActor } from '../core/context';
import { AppError, Errors } from '../core/errors';
import { parse } from '../core/validate';
import { AuditService } from './audit.service';
import { consentKeyword, parseWebhook, type ParsedEvent, type Provider } from './channels';
import { applyStatus, Sender } from './sender';
import { isUuid } from './members.service';

/** Free-form replies are allowed only within this long of the customer's last message (Meta customer service window). */
export const SERVICE_WINDOW_HOURS = 24;

const ChannelRequest = z.object({
  provider: z.enum(['sandbox', 'whatsapp_cloud']),
  providerNumberId: z.string().regex(/^[0-9A-Za-z_-]{3,64}$/, 'Use the provider number id (letters, digits, - or _)'),
  displayPhone: z.string().trim().min(3).max(32),
  label: z.string().trim().min(1).max(80),
});
const ListQuery = z.object({
  status: z.enum(['open', 'pending', 'resolved', 'active']).default('active'),
  assigned: z.enum(['me', 'unassigned', 'any']).default('any'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before: z.string().datetime({ offset: true }).optional(),
});
const AssignRequest = z.object({ membershipId: z.string().uuid().nullable(), expectedVersion: z.number().int().min(0) });
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
  text: z.string().trim().min(1).max(4096),
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
};
const pauseActive = (c: ConvRow) => c.paused_at !== null && (c.paused_until === null || c.paused_until.getTime() > Date.now());

/**
 * Messaging slice 1 (CF-EXT-001/002/003): verified webhook intake, contacts, conversations, inbox, assignment,
 * internal notes and replies. Everything runs as cf_app inside one company's context, so row-level security applies.
 */
export class InboxService {
  private readonly sender: Sender;
  constructor(private readonly deps: Deps) {
    this.sender = new Sender(deps.db, deps.channels);
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
        const { rows } = await tx.query(
          `INSERT INTO channel_connections (tenant_id, provider, provider_number_id, display_phone, label, created_by)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id, provider, provider_number_id AS "providerNumberId", display_phone AS "displayPhone", label, status`,
          [actor.tenantId, body.provider, body.providerNumberId, body.displayPhone, body.label, actor.userId]);
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
   * Stores and applies the events of one verified delivery. Safe to repeat: each provider event is recorded once
   * (unique key), a second delivery is counted as a duplicate and changes nothing. Events for unknown or disabled
   * numbers are ignored (counted), never stored.
   */
  async ingest(provider: Provider, payload: unknown) {
    const { events, skipped } = parseWebhook(payload);
    const counts = { applied: 0, duplicate: 0, stale: 0, orphan: 0, unrouted: 0, skipped };
    const byNumber = new Map<string, ParsedEvent[]>();
    for (const e of events) byNumber.set(e.providerNumberId, [...(byNumber.get(e.providerNumberId) ?? []), e]);

    for (const [number, list] of byNumber) {
      const route = await withContext(this.deps.db, { tenantId: null, userId: null }, async (tx) =>
        (await tx.query<{ tenant_id: string; connection_id: string }>('SELECT * FROM channel_route($1, $2)', [provider, number])).rows[0]);
      if (!route) { counts.unrouted += list.length; continue; }
      // Oldest first, so a delivery that bundles several events applies them in the provider's order.
      list.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
      await withContext(this.deps.db, { tenantId: route.tenant_id, userId: null }, async (tx) => {
        for (const e of list) {
          const ins = await tx.query<{ id: string }>(
            `INSERT INTO webhook_events (tenant_id, connection_id, event_key, kind, payload) VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (tenant_id, connection_id, event_key) DO NOTHING RETURNING id`,
            [route.tenant_id, route.connection_id, e.key, e.kind, JSON.stringify(e.raw)]);
          if (!ins.rows[0]) { counts.duplicate++; continue; }
          const outcome = e.kind === 'message'
            ? await this.applyInbound(tx, route.tenant_id, route.connection_id, e)
            : await applyStatus(tx, e.providerMessageId, e.status, e.errorCode, e.callbackData);
          await tx.query('UPDATE webhook_events SET processed_at = now(), outcome = $2 WHERE id = $1', [ins.rows[0].id, outcome]);
          if (outcome === 'applied') counts.applied++;
          else if (outcome === 'stale_status') counts.stale++;
          else counts.orphan++;
        }
      });
    }
    return counts;
  }

  private async applyInbound(tx: Tx, tenantId: string, connectionId: string, e: Extract<ParsedEvent, { kind: 'message' }>) {
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
    const msg = await tx.query<{ id: string }>(
      `INSERT INTO messages (tenant_id, conversation_id, direction, kind, body, provider_type, provider_message_id, occurred_at, status, referral)
       VALUES ($1, $2, 'in', $3, $4, $5, $6, $7, 'received', $8)
       ON CONFLICT (tenant_id, provider_message_id) DO NOTHING RETURNING id`,
      [tenantId, conv.id, e.type === 'text' ? 'text' : 'unsupported', e.body, e.type === 'text' ? null : e.type,
        e.providerMessageId, e.occurredAt, e.referral ? JSON.stringify(e.referral) : null]);
    const messageId = msg.rows[0]?.id;
    if (!messageId) return 'applied' as const; // already recorded under another event key; nothing more to do
    // A delayed message updates the thread position only if it is the newest; the service window uses the latest.
    await tx.query(
      `UPDATE conversations SET
         last_inbound_at = greatest(coalesce(last_inbound_at, $2), $2),
         last_message_id = CASE WHEN last_message_at IS NULL OR $2 >= last_message_at THEN $3 ELSE last_message_id END,
         last_message_at = greatest(coalesce(last_message_at, $2), $2),
         status = CASE WHEN status = 'pending' THEN 'open' ELSE status END,
         activity_seq = activity_seq + 1,
         version = version + 1
       WHERE id = $1`, [conv.id, e.occurredAt, messageId]);

    const consent = consentKeyword(e.body);
    if (consent) {
      const optedOut = (await tx.query<{ opted_out_at: Date | null }>('SELECT opted_out_at FROM contacts WHERE id = $1', [contactId])).rows[0]!.opted_out_at;
      if ((consent === 'opt_out') !== (optedOut !== null)) {
        await tx.query(`UPDATE contacts SET opted_out_at = CASE WHEN $2 THEN now() END, updated_at = now() WHERE id = $1`,
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
    return 'applied' as const;
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
                EXISTS (SELECT 1 FROM messages f WHERE f.conversation_id = c.id AND f.direction = 'out'
                          AND f.status IN ('failed', 'uncertain')
                          AND NOT EXISTS (SELECT 1 FROM messages r WHERE r.retry_of = f.id)) AS "needsAttention"
         FROM conversations c
         JOIN contacts ct ON ct.id = c.contact_id
         LEFT JOIN messages m ON m.id = c.last_message_id
         WHERE ($7::boolean OR c.assigned_membership_id IS NULL OR c.assigned_membership_id = $8::uuid)
           AND ($1 = 'active' AND c.status IN ('open', 'pending') OR c.status = $1)
           AND ($2 = 'any' OR ($2 = 'me' AND c.assigned_membership_id = $3::uuid) OR ($2 = 'unassigned' AND c.assigned_membership_id IS NULL))
           AND ($4::timestamptz IS NULL OR c.last_message_at < $4)
         ORDER BY c.last_message_at DESC NULLS LAST, c.id DESC
         LIMIT $6`,
        [q.status, q.assigned, actor.membershipId, q.before ?? null, SERVICE_WINDOW_HOURS, q.limit, ...this.visibility(actor)]);
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
                (SELECT value FROM contact_identifiers ci WHERE ci.contact_id = ct.id AND ci.kind = 'whatsapp' LIMIT 1) AS "whatsapp"
         FROM contacts ct WHERE ct.id = $1`, [c.contact_id])).rows[0];
      const messages = (await tx.query(
        `SELECT m.id, m.direction, m.kind, m.body, m.provider_type AS "providerType", m.status, m.error_code AS "errorCode",
                m.occurred_at AS "occurredAt", m.sent_by_membership_id AS "sentByMembershipId", (m.referral IS NOT NULL) AS "fromAd",
                m.attempts, m.retry_of AS "retryOf", r.id AS "retriedAs"
         FROM messages m LEFT JOIN messages r ON r.retry_of = m.id
         WHERE m.conversation_id = $1 ORDER BY m.occurred_at, m.id`, [c.id])).rows;
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
        people: await this.names(tx, [c.assigned_membership_id, c.paused_by_membership_id,
          ...messages.map((m) => m.sentByMembershipId), ...notes.map((n) => n.authorMembershipId), ...events.map((e) => e.actorMembershipId)]),
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
      await AuditService.record(tx, {
        tenantId: actor.tenantId, actorUserId: actor.userId, action: 'conversation.assigned', ip: actor.ip,
        targetType: 'conversation', targetId: c.id, metadata: { from: c.assigned_membership_id, to: body.membershipId },
      });
      return { id: c.id, version: upd.rows[0].version, assignedMembershipId: body.membershipId };
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
  private async checkCanSend(tx: Tx, actor: TenantActor, c: ConvRow, seenActivity: number, takeover = false) {
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
    if (c.last_inbound_at === null || Date.now() - c.last_inbound_at.getTime() >= SERVICE_WINDOW_HOURS * 3600_000) {
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

  /** Records a queued outbound message and its send job, and moves the conversation forward. */
  private async enqueue(tx: Tx, actor: TenantActor, c: ConvRow, text: string, clientMessageId: string, retryOf: string | null) {
    const msg = (await tx.query<{ id: string; occurred_at: Date }>(
      `INSERT INTO messages (tenant_id, conversation_id, direction, kind, body, client_message_id, sent_by_membership_id, occurred_at, status, retry_of)
       VALUES ($1, $2, 'out', 'text', $3, $4, $5, clock_timestamp(), 'queued', $6) RETURNING id, occurred_at`,
      [actor.tenantId, c.id, text, clientMessageId, actor.membershipId, retryOf])).rows[0]!;
    const job = (await tx.query<{ id: string }>(
      'INSERT INTO send_jobs (tenant_id, message_id) VALUES ($1, $2) RETURNING id', [actor.tenantId, msg.id])).rows[0]!;
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
      await this.checkCanSend(tx, actor, c, body.seenActivity, body.takeover);
      return this.enqueue(tx, actor, c, body.text, body.clientMessageId, null);
    });
    if (prepared.existing !== undefined) return this.message(actor, prepared.existing);
    await this.sendNow(actor, prepared.jobId);
    return this.message(actor, prepared.messageId);
  }

  /**
   * A person retries a failed or uncertain message. The retry is a new message linked to the original (which keeps its
   * honest status). An uncertain message may already have reached the customer, so the person must confirm.
   */
  async retry(actor: TenantActor, messageId: string, input: unknown) {
    const body = parse(RetryRequest, input);
    if (!isUuid(messageId)) throw Errors.notFound('Message');
    type Prepared = { existing: string } | { existing?: undefined; messageId: string; jobId: string };
    const prepared = await withContext<Prepared>(this.deps.db, actor, async (tx) => {
      const again = await tx.query(`SELECT id FROM messages WHERE client_message_id = $1 AND sent_by_membership_id = $2`,
        [body.clientMessageId, actor.membershipId]);
      if (again.rows[0]) return { existing: again.rows[0].id as string };
      const orig = (await tx.query<{ id: string; conversation_id: string; status: string; body: string | null; direction: string; error_code: string | null }>(
        'SELECT id, conversation_id, status, body, direction, error_code FROM messages WHERE id = $1', [messageId])).rows[0];
      if (!orig || orig.direction !== 'out') throw Errors.notFound('Message');
      const c = await this.loadVisible(tx, actor, orig.conversation_id, true);
      if (orig.status !== 'failed' && orig.status !== 'uncertain') {
        throw Errors.conflict('not_retryable', 'Only a failed or uncertain message can be retried.');
      }
      if (orig.status === 'uncertain' && !body.confirmPossibleDuplicate) {
        throw new AppError(409, 'confirmation_required',
          'We do not know whether this message reached the customer. Retrying may send it twice. Confirm to retry.');
      }
      if (await tx.query('SELECT 1 FROM messages WHERE retry_of = $1', [orig.id]).then((r) => r.rowCount)) {
        throw Errors.conflict('already_retried', 'This message has already been retried.');
      }
      await this.checkCanSend(tx, actor, c, body.seenActivity);
      const queued = await this.enqueue(tx, actor, c, orig.body ?? '', body.clientMessageId, orig.id);
      await tx.query(
        `INSERT INTO conversation_events (tenant_id, conversation_id, kind, actor_membership_id, data) VALUES ($1, $2, 'retried', $3, $4)`,
        [actor.tenantId, c.id, actor.membershipId, JSON.stringify({ original: orig.id, retry: queued.messageId, originalStatus: orig.status })]);
      await AuditService.record(tx, {
        tenantId: actor.tenantId, actorUserId: actor.userId, action: 'message.retried', ip: actor.ip, targetType: 'message', targetId: orig.id,
        metadata: { retry: queued.messageId, originalStatus: orig.status, errorCode: orig.error_code, confirmedPossibleDuplicate: !!body.confirmPossibleDuplicate },
      });
      return queued;
    }).catch((err) => {
      if ((err as { code?: string }).code === '23505') throw Errors.conflict('already_retried', 'This message has already been retried.');
      throw err;
    });
    if (prepared.existing !== undefined) return this.message(actor, prepared.existing);
    await this.sendNow(actor, prepared.jobId);
    return this.message(actor, prepared.messageId);
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
      `SELECT id, conversation_id AS "conversationId", direction, body, status, error_code AS "errorCode", occurred_at AS "occurredAt",
              attempts, retry_of AS "retryOf"
       FROM messages WHERE id = $1`, [id])).rows[0]);
  }
}
