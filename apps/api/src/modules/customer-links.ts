import { createHash, randomBytes } from 'node:crypto';
import { withContext, type Tx } from '@conversaflow/database';
import { z } from 'zod';
import type { Deps, TenantActor } from '../core/context';
import { AppError, Errors } from '../core/errors';
import { RATE_RULES } from '../core/rate-limit';
import { parse } from '../core/validate';
import { AuditService } from './audit.service';
import { stopAutomationRuns } from './automations';
import { isUuid } from './members.service';
import { queueConversationNotice } from './push';
import { startTimerOnInbound } from './sla';

/**
 * Customer control centre, first version (BRD v1.2 Wave 2, W2.4, CF-EXT-020; migration 0051).
 *
 * A team member who can reply in a conversation creates a private link for that customer. The customer opens it and
 * can see where their conversations stand, choose a language, stop or restart messages, change marketing consent, ask
 * for a person or make a complaint. Nothing more: the page never shows message text, files, team members' names or
 * anything about other customers.
 *
 * - The token is 32 random bytes; only its SHA-256 is stored. It is carried in the address fragment (never sent to the
 *   server by the browser, so never logged) and sent by the page in the `X-Customer-Link` header.
 * - Every request looks the link up again (`customer_link_route`, reviewed and pinned), so revoking or expiry takes
 *   effect on the next request. Suspended or closed companies' links stop working too.
 * - Requests are limited per link and per address; failed lookups are limited per address.
 * - Consent changes take the customer's lock (the same one incoming messages take), so a STOP arriving at the same
 *   moment is applied in a definite order, and `opt_keyword_at` is moved on so an older delayed keyword cannot undo it.
 */
export const LINK_HEADER = 'x-customer-link';
const IssueInput = z.object({ days: z.number().int().min(1).max(30).default(7), locale: z.enum(['en', 'ar']).optional() });
const PrefsInput = z.object({ locale: z.enum(['en', 'ar']) });
const ConsentInput = z.object({ messages: z.enum(['stop', 'start']).optional(), marketing: z.boolean().optional() })
  .refine((v) => v.messages !== undefined || v.marketing !== undefined, 'Nothing to change.');
const RequestInput = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('talk_to_person'), text: z.string().trim().max(2000).optional() }),
  z.object({ kind: z.literal('complaint'), text: z.string().trim().min(1).max(2000) }),
]);

export const hashToken = (token: string) => createHash('sha256').update(token, 'utf8').digest();
const tokenShape = /^[A-Za-z0-9_-]{43}$/;

export interface LinkContext { linkId: string; tenantId: string; contactId: string; conversationId: string | null; expiresAt: Date; ip: string | null }

/** Rate-limit key for an address: IPv6 addresses by their /64 (one subscriber), IPv4 as they are. */
export function addressKey(ip: string | null): string {
  if (!ip) return 'unknown';
  const v = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  if (!v.includes(':')) return v;
  return v.split(':').slice(0, 4).join(':') + '::/64';
}

/** The customer's lock(s), in ascending order, as incoming messages and imports take them. */
async function lockCustomer(tx: Tx, l: LinkContext) {
  const phones = (await tx.query<{ value: string }>(
    `SELECT value FROM contact_identifiers WHERE contact_id = $1 AND kind = 'whatsapp' ORDER BY value`, [l.contactId])).rows;
  for (const p of phones) await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${l.tenantId}:wa:${p.value}`]);
}

/** Team side: create, list and revoke links (inbox.reply on a conversation the member can see). */
export class CustomerLinksService {
  constructor(private readonly deps: Deps) {}

  private async visibleConversation(tx: Tx, actor: TenantActor, id: string, lock = false) {
    if (!isUuid(id)) throw Errors.notFound('Conversation');
    const sql = `SELECT id, contact_id, status FROM conversations c WHERE c.id = $1
                 AND ($2::boolean OR c.assigned_membership_id IS NULL OR c.assigned_membership_id = $3::uuid)`;
    const c = (await tx.query<{ id: string; contact_id: string; status: string }>(lock ? sql + ' FOR UPDATE' : sql,
      [id, actor.permissions.has('inbox.read_all'), actor.membershipId])).rows[0];
    if (!c) throw Errors.notFound('Conversation');
    return c;
  }

  async issue(actor: TenantActor, conversationId: string, input: unknown) {
    const body = parse(IssueInput, input ?? {});
    return withContext(this.deps.db, actor, async (tx) => {
      const c = await this.visibleConversation(tx, actor, conversationId);
      await tx.query('SELECT 1 FROM contacts WHERE id = $1 FOR UPDATE', [c.contact_id]);
      const live = (await tx.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM customer_links WHERE contact_id = $1 AND revoked_at IS NULL AND expires_at > now()`, [c.contact_id])).rows[0]!.n;
      if (live >= 5) throw Errors.conflict('too_many_links', 'This customer already has 5 links in use. Revoke one first.');
      const token = randomBytes(32).toString('base64url');
      const row = (await tx.query<{ id: string; expires_at: Date }>(
        `INSERT INTO customer_links (tenant_id, contact_id, conversation_id, token_hash, created_by, expires_at)
         VALUES ($1, $2, $3, $4, $5, now() + make_interval(days => $6)) RETURNING id, expires_at`,
        [actor.tenantId, c.contact_id, c.id, hashToken(token), actor.userId, body.days])).rows[0]!;
      await tx.query(`INSERT INTO conversation_events (tenant_id, conversation_id, kind, actor_membership_id, data) VALUES ($1, $2, 'customer_link_issued', $3, $4)`,
        [actor.tenantId, c.id, actor.membershipId, JSON.stringify({ linkId: row.id, expiresAt: row.expires_at })]);
      await AuditService.record(tx, { tenantId: actor.tenantId, actorUserId: actor.userId, action: 'customer_link.issued', ip: actor.ip,
        targetType: 'customer_link', targetId: row.id, metadata: { contactId: c.contact_id, days: body.days } });
      const locale = body.locale ?? 'en';
      // Shown once. The token is in the fragment, so the browser never sends it in a request line or Referer.
      return { id: row.id, expiresAt: row.expires_at, url: `${this.deps.config.APP_ORIGIN}/${locale}/c#${token}` };
    });
  }

  list(actor: TenantActor, conversationId: string) {
    return withContext(this.deps.db, actor, async (tx) => {
      const c = await this.visibleConversation(tx, actor, conversationId);
      return (await tx.query(
        `SELECT id, created_at AS "createdAt", expires_at AS "expiresAt", revoked_at AS "revokedAt", revoke_reason AS "revokeReason",
                last_used_at AS "lastUsedAt", uses,
                CASE WHEN revoked_at IS NOT NULL THEN 'revoked' WHEN expires_at <= now() THEN 'expired' ELSE 'active' END AS state
         FROM customer_links WHERE contact_id = $1 ORDER BY created_at DESC LIMIT 20`, [c.contact_id])).rows;
    });
  }

  async revoke(actor: TenantActor, linkId: string) {
    if (!isUuid(linkId)) throw Errors.notFound('Link');
    return withContext(this.deps.db, actor, async (tx) => {
      const l = (await tx.query<{ id: string; conversation_id: string | null; contact_id: string; revoked_at: Date | null }>(
        'SELECT id, conversation_id, contact_id, revoked_at FROM customer_links WHERE id = $1 FOR UPDATE', [linkId])).rows[0];
      if (!l) throw Errors.notFound('Link');
      // Only through a conversation of this customer that the member can see.
      const seen = (await tx.query(`SELECT 1 FROM conversations c WHERE c.contact_id = $1
          AND ($2::boolean OR c.assigned_membership_id IS NULL OR c.assigned_membership_id = $3::uuid) LIMIT 1`,
        [l.contact_id, actor.permissions.has('inbox.read_all'), actor.membershipId])).rowCount;
      if (!seen) throw Errors.notFound('Link');
      if (l.revoked_at) return { id: l.id, state: 'revoked' };
      await tx.query(`UPDATE customer_links SET revoked_at = now(), revoked_by = $2, revoke_reason = 'revoked_by_team' WHERE id = $1`, [l.id, actor.userId]);
      if (l.conversation_id) {
        await tx.query(`INSERT INTO conversation_events (tenant_id, conversation_id, kind, actor_membership_id, data) VALUES ($1, $2, 'customer_link_revoked', $3, $4)`,
          [actor.tenantId, l.conversation_id, actor.membershipId, JSON.stringify({ linkId: l.id })]);
      }
      await AuditService.record(tx, { tenantId: actor.tenantId, actorUserId: actor.userId, action: 'customer_link.revoked', ip: actor.ip,
        targetType: 'customer_link', targetId: l.id, metadata: {} });
      return { id: l.id, state: 'revoked' };
    });
  }

  /** Every active link of the conversation's customer stops working at once. */
  async revokeAll(actor: TenantActor, conversationId: string) {
    return withContext(this.deps.db, actor, async (tx) => {
      const c = await this.visibleConversation(tx, actor, conversationId);
      const r = await tx.query(`UPDATE customer_links SET revoked_at = now(), revoked_by = $2, revoke_reason = 'all_revoked'
                                WHERE contact_id = $1 AND revoked_at IS NULL RETURNING id`, [c.contact_id, actor.userId]);
      if (r.rowCount) {
        await tx.query(`INSERT INTO conversation_events (tenant_id, conversation_id, kind, actor_membership_id, data) VALUES ($1, $2, 'customer_link_revoked', $3, $4)`,
          [actor.tenantId, c.id, actor.membershipId, JSON.stringify({ all: true, count: r.rowCount })]);
        await AuditService.record(tx, { tenantId: actor.tenantId, actorUserId: actor.userId, action: 'customer_link.revoked_all', ip: actor.ip,
          targetType: 'contact', targetId: c.contact_id, metadata: { count: r.rowCount } });
      }
      return { revoked: r.rowCount ?? 0 };
    });
  }

  /** Requests the customer made through a link, for the conversation view and the inbox. */
  requests(actor: TenantActor, conversationId: string) {
    return withContext(this.deps.db, actor, async (tx) => {
      const c = await this.visibleConversation(tx, actor, conversationId);
      return (await tx.query(
        `SELECT id, kind, body, created_at AS "createdAt", handled_at AS "handledAt" FROM customer_requests
         WHERE contact_id = $1 ORDER BY created_at DESC LIMIT 50`, [c.contact_id])).rows;
    });
  }

  async handle(actor: TenantActor, requestId: string) {
    if (!isUuid(requestId)) throw Errors.notFound('Request');
    return withContext(this.deps.db, actor, async (tx) => {
      const r = (await tx.query<{ id: string; contact_id: string; conversation_id: string | null; handled_at: Date | null }>(
        'SELECT id, contact_id, conversation_id, handled_at FROM customer_requests WHERE id = $1 FOR UPDATE', [requestId])).rows[0];
      if (!r) throw Errors.notFound('Request');
      const seen = (await tx.query(`SELECT 1 FROM conversations c WHERE c.contact_id = $1
          AND ($2::boolean OR c.assigned_membership_id IS NULL OR c.assigned_membership_id = $3::uuid) LIMIT 1`,
        [r.contact_id, actor.permissions.has('inbox.read_all'), actor.membershipId])).rowCount;
      if (!seen) throw Errors.notFound('Request');
      if (r.handled_at) throw Errors.conflict('already_handled', 'This request is already marked as handled.');
      await tx.query('UPDATE customer_requests SET handled_at = now(), handled_by = $2 WHERE id = $1', [r.id, actor.userId]);
      if (r.conversation_id) {
        await tx.query(`INSERT INTO conversation_events (tenant_id, conversation_id, kind, actor_membership_id, data) VALUES ($1, $2, 'customer_request_handled', $3, $4)`,
          [actor.tenantId, r.conversation_id, actor.membershipId, JSON.stringify({ requestId: r.id })]);
      }
      await AuditService.record(tx, { tenantId: actor.tenantId, actorUserId: actor.userId, action: 'customer_request.handled', ip: actor.ip,
        targetType: 'customer_request', targetId: r.id, metadata: {} });
      return { id: r.id, handled: true };
    });
  }
}

/** Customer side: everything goes through the link, looked up again on every request. */
export class CustomerPortalService {
  constructor(private readonly deps: Deps) {}

  /** Resolves the header to a live link, or refuses. Never says whether a link existed, expired or was revoked. */
  async open(token: string | undefined, ip: string | null): Promise<LinkContext> {
    const subject = addressKey(ip);
    await this.deps.rateLimiter.hit(RATE_RULES.customerLinkPerIp, subject);
    // Wrong links are limited per address; a right link is never refused because others behind the same address
    // (mobile networks share addresses) tried wrong ones. With 256-bit tokens guessing is not a practical threat.
    // (Review of W2.4, M4.)
    if (!token || !tokenShape.test(token)) {
      await this.deps.rateLimiter.hit(RATE_RULES.customerLinkFailPerIp, subject);
      throw Errors.invalidLink();
    }
    const hash = hashToken(token);
    const row = await withContext(this.deps.db, { tenantId: null, userId: null }, async (tx) =>
      (await tx.query<{ link_id: string; tenant_id: string; contact_id: string; conversation_id: string | null; expires_at: Date }>(
        'SELECT * FROM customer_link_route($1)', [hash])).rows[0]);
    if (!row) {
      await this.deps.rateLimiter.hit(RATE_RULES.customerLinkFailPerIp, subject);
      throw Errors.invalidLink();
    }
    await this.deps.rateLimiter.hit(RATE_RULES.customerLinkPerLink, row.link_id);
    const ok = await withContext(this.deps.db, { tenantId: row.tenant_id, userId: null }, async (tx) => {
      const t = (await tx.query<{ status: string }>('SELECT status FROM tenants WHERE id = $1', [row.tenant_id])).rows[0];
      if (!t || t.status === 'suspended' || t.status === 'closed') return false;
      const u = await tx.query('UPDATE customer_links SET last_used_at = now(), uses = uses + 1 WHERE id = $1 AND revoked_at IS NULL AND expires_at > now()', [row.link_id]);
      return (u.rowCount ?? 0) > 0;
    });
    if (!ok) throw Errors.invalidLink();
    return { linkId: row.link_id, tenantId: row.tenant_id, contactId: row.contact_id, conversationId: row.conversation_id, expiresAt: row.expires_at, ip };
  }

  private ctx(l: LinkContext) { return { tenantId: l.tenantId, userId: null }; }

  /**
   * Inside each action's own transaction: the link is still live, and stays so until the action commits (revoking
   * takes the row for update, so the two are ordered). Review of W2.4, M2.
   */
  private async live(tx: Tx, l: LinkContext) {
    const ok = (await tx.query('SELECT 1 FROM customer_links WHERE id = $1 AND revoked_at IS NULL AND expires_at > now() FOR SHARE', [l.linkId])).rowCount;
    if (!ok) throw Errors.invalidLink();
  }

  async view(l: LinkContext) {
    return withContext(this.deps.db, this.ctx(l), async (tx) => {
      const company = (await tx.query<{ name: string; locale: string }>('SELECT legal_name AS name, locale FROM tenants WHERE id = $1', [l.tenantId])).rows[0]!;
      const contact = (await tx.query<{ name: string | null; locale: string | null; opted_out_at: Date | null; marketing_consent_at: Date | null }>(
        'SELECT display_name AS name, locale, opted_out_at, marketing_consent_at FROM contacts WHERE id = $1', [l.contactId])).rows[0];
      if (!contact) throw Errors.invalidLink();
      const conversations = (await tx.query(
        `SELECT c.id, c.status, c.created_at AS "startedAt", c.last_message_at AS "lastActivityAt", c.resolved_at AS "resolvedAt",
                (c.assigned_membership_id IS NOT NULL) AS "withPerson"
         FROM conversations c WHERE c.contact_id = $1 ORDER BY c.created_at DESC LIMIT 10`, [l.contactId])).rows;
      const requests = (await tx.query(
        `SELECT id, kind, created_at AS "createdAt", handled_at AS "handledAt" FROM customer_requests
         WHERE contact_id = $1 ORDER BY created_at DESC LIMIT 20`, [l.contactId])).rows;
      return {
        company: { name: company.name },
        // First name only, and only what the company itself saved.
        customer: { firstName: contact.name ? contact.name.trim().split(/\s+/)[0] : null, locale: contact.locale ?? company.locale },
        consent: { messages: contact.opted_out_at ? 'stopped' : 'allowed', marketing: !!contact.marketing_consent_at && !contact.opted_out_at },
        conversations, requests, linkExpiresAt: l.expiresAt,
      };
    });
  }

  async setPreferences(l: LinkContext, input: unknown) {
    const body = parse(PrefsInput, input);
    return withContext(this.deps.db, this.ctx(l), async (tx) => {
      await this.live(tx, l);
      await tx.query('UPDATE contacts SET locale = $2, updated_at = now() WHERE id = $1', [l.contactId, body.locale]);
      if (l.conversationId) {
        await tx.query(`INSERT INTO conversation_events (tenant_id, conversation_id, kind, data) VALUES ($1, $2, 'customer_preferences', $3)`,
          [l.tenantId, l.conversationId, JSON.stringify({ locale: body.locale, linkId: l.linkId })]);
      }
      await AuditService.record(tx, { tenantId: l.tenantId, actorUserId: null, action: 'contact.preferences_changed', ip: l.ip ?? undefined,
        targetType: 'contact', targetId: l.contactId, metadata: { via: 'customer_link', linkId: l.linkId, locale: body.locale } });
      return { locale: body.locale };
    });
  }

  async setConsent(l: LinkContext, input: unknown) {
    const body = parse(ConsentInput, input);
    return withContext(this.deps.db, this.ctx(l), async (tx) => {
      await this.live(tx, l);
      await lockCustomer(tx, l);
      const cur = (await tx.query<{ opted_out_at: Date | null; marketing_consent_at: Date | null }>(
        'SELECT opted_out_at, marketing_consent_at FROM contacts WHERE id = $1 FOR UPDATE', [l.contactId])).rows[0];
      if (!cur) throw Errors.invalidLink();
      let optedOut = cur.opted_out_at !== null;
      let marketing = cur.marketing_consent_at !== null;
      const evidence = `customer_link:${l.linkId}`;
      const event = async (kind: string) => {
        await tx.query(`INSERT INTO consent_events (tenant_id, contact_id, kind, channel, source, evidence) VALUES ($1, $2, $3, 'whatsapp', 'customer_link', $4)`,
          [l.tenantId, l.contactId, kind, evidence]);
        await AuditService.record(tx, { tenantId: l.tenantId, actorUserId: null, ip: l.ip ?? undefined, targetType: 'contact', targetId: l.contactId,
          action: { opt_out: 'contact.opted_out', opt_in: 'contact.opted_in', marketing_opt_in: 'contact.marketing_opt_in', marketing_opt_out: 'contact.marketing_opt_out' }[kind]!,
          metadata: { source: 'customer_link', linkId: l.linkId } });
      };
      if (body.messages) {
        // Moves the keyword clock on: an older STOP or START still in the queue cannot undo the customer's choice.
        // Whole seconds, as WhatsApp dates messages: a STOP sent in the same second as the page choice still applies
        // (keywords apply when not older; review of W2.4, M1).
        await tx.query(`UPDATE contacts SET opt_keyword_at = greatest(coalesce(opt_keyword_at, date_trunc('second', now())), date_trunc('second', now())) WHERE id = $1`, [l.contactId]);
      }
      if (body.messages === 'stop' && !optedOut) {
        await tx.query('UPDATE contacts SET opted_out_at = now(), marketing_consent_at = NULL, updated_at = now() WHERE id = $1', [l.contactId]);
        await event('opt_out'); optedOut = true; marketing = false;
        if (l.conversationId) {
          await tx.query(`INSERT INTO conversation_events (tenant_id, conversation_id, kind, data) VALUES ($1, $2, 'opted_out', $3)`,
            [l.tenantId, l.conversationId, JSON.stringify({ evidence })]);
        }
      } else if (body.messages === 'start' && optedOut) {
        await tx.query('UPDATE contacts SET opted_out_at = NULL, updated_at = now() WHERE id = $1', [l.contactId]);
        await event('opt_in'); optedOut = false;
        if (l.conversationId) {
          await tx.query(`INSERT INTO conversation_events (tenant_id, conversation_id, kind, data) VALUES ($1, $2, 'opted_in', $3)`,
            [l.tenantId, l.conversationId, JSON.stringify({ evidence })]);
        }
      }
      if (body.marketing !== undefined && body.marketing !== marketing) {
        if (body.marketing && optedOut) throw new AppError(409, 'messages_stopped', 'Messages are stopped. Allow messages first, then marketing.');
        await tx.query('UPDATE contacts SET marketing_consent_at = CASE WHEN $2 THEN now() END, updated_at = now() WHERE id = $1', [l.contactId, body.marketing]);
        await event(body.marketing ? 'marketing_opt_in' : 'marketing_opt_out'); marketing = body.marketing;
      }
      return { messages: optedOut ? 'stopped' : 'allowed', marketing };
    });
  }

  async request(l: LinkContext, input: unknown) {
    const body = parse(RequestInput, input);
    return withContext(this.deps.db, this.ctx(l), async (tx) => {
      await this.live(tx, l);
      // The customer's lock first (as incoming messages take it), so no new conversation opens while this one reopens,
      // and two requests at once cannot both pass the limit (review of W2.4, L1).
      await lockCustomer(tx, l);
      const open = (await tx.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM customer_requests WHERE contact_id = $1 AND handled_at IS NULL`, [l.contactId])).rows[0]!.n;
      if (open >= 5) throw Errors.conflict('too_many_requests', 'You already have 5 requests waiting. The team will reply soon.');
      // The customer's open conversation if there is one, otherwise the newest.
      const conv = (await tx.query<{ id: string; status: string }>(
        `SELECT id, status FROM conversations WHERE contact_id = $1 ORDER BY (status <> 'resolved') DESC, created_at DESC LIMIT 1 FOR UPDATE`,
        [l.contactId])).rows[0] ?? null;
      const row = (await tx.query<{ id: string; created_at: Date }>(
        `INSERT INTO customer_requests (tenant_id, contact_id, link_id, conversation_id, kind, body) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, created_at`,
        [l.tenantId, l.contactId, l.linkId, conv?.id ?? null, body.kind, body.text || null])).rows[0]!;
      if (conv) {
        // Brings it to the team's attention: a resolved conversation is reopened unless the customer already has an
        // open one, and automations stop because a person is now needed.
        if (conv.status === 'resolved') {
          // Open conversations sort first, so a resolved one here means the customer has none open: reopening it
          // cannot clash with the one-open-conversation rule.
          await tx.query(`UPDATE conversations SET status = 'open', resolved_at = NULL, activity_seq = activity_seq + 1, version = version + 1 WHERE id = $1`, [conv.id]);
          await tx.query(`INSERT INTO conversation_events (tenant_id, conversation_id, kind, data) VALUES ($1, $2, 'status_changed', $3)`,
            [l.tenantId, conv.id, JSON.stringify({ from: 'resolved', to: 'open', by: 'customer_page' })]);
          await startTimerOnInbound(tx, conv.id, new Date());
        } else {
          await tx.query('UPDATE conversations SET activity_seq = activity_seq + 1, version = version + 1 WHERE id = $1', [conv.id]);
        }
        await tx.query(`INSERT INTO conversation_events (tenant_id, conversation_id, kind, data) VALUES ($1, $2, 'customer_request', $3)`,
          [l.tenantId, conv.id, JSON.stringify({ requestId: row.id, kind: body.kind })]);
        if (body.kind === 'talk_to_person' || body.kind === 'complaint') await stopAutomationRuns(tx, conv.id, 'person_requested');
        await queueConversationNotice(tx, l.tenantId, conv.id, 'customer_request');
      }
      await AuditService.record(tx, { tenantId: l.tenantId, actorUserId: null, action: 'customer_request.created', ip: l.ip ?? undefined,
        targetType: 'customer_request', targetId: row.id, metadata: { kind: body.kind, linkId: l.linkId } });
      return { id: row.id, kind: body.kind, createdAt: row.created_at };
    });
  }
}

/** Masks customer page tokens in message text shown back to people, the AI or the API (review of W2.4, M3). */
export function maskLinks(text: string | null): string | null {
  return text === null ? null : text.replace(/(\/c#)[A-Za-z0-9_-]{43}/g, '$1••••••');
}
