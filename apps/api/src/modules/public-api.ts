import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { lookup as lookupCb } from 'node:dns';
import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { decryptSecret, encryptSecret } from '../core/crypto';
import { withContext, type Db, type Tx } from '@conversaflow/database';
import { z } from 'zod';
import type { Deps, TenantActor } from '../core/context';
import { AppError, Errors } from '../core/errors';
import type { RateRule } from '../core/rate-limit';
import { parse } from '../core/validate';
import { AuditService } from './audit.service';
import { isUuid } from './members.service';
import { maskLinks } from './customer-links';

/**
 * Public API v1 and outgoing webhooks (BRD v1.2 Wave 2, W2.8, CF-EXT-016; migration 0056).
 *
 * API keys
 * - Created by a member with api.manage (two-step sign-in), for themselves. A key acts as that member, limited to its
 *   scopes: it can never do more than the member can do now, and stops when the member loses access, the key is
 *   revoked or it expires. The key is `cf_live_<prefix>_<secret>`; only the secret's SHA-256 is stored.
 * - Requests carry `Authorization: Bearer <key>`. No cookies and no browser session are involved, so the usual
 *   cross-site checks do not apply; the key is looked up again on every request.
 * - Limits: 600 requests a minute per key; 30 failed key lookups an hour per address.
 * - Every request is logged with method, route, status and duration (never bodies or keys).
 * - Lists use cursor pagination (`?limit=…&cursor=…`, `nextCursor` in the answer).
 * - A reply may name `seenActivity` (the conversation's activity counter it was written against) to be refused if
 *   the conversation moved on; without it, the reply is checked against the conversation as it is now.
 * - An Idempotency-Key belongs to one conversation: reusing it elsewhere is refused (409).
 * - Webhook subscriptions need the subscriber's own company-wide access to that data (inbox.read_all, and
 *   contacts.read for events naming a contact), and deliveries stop if the member who set one up loses it.
 * - Signing secrets are sealed with WEBHOOK_SECRETS_KEY (held outside the database).
 *
 * Outgoing webhooks
 * - https endpoints only; in production an endpoint must not resolve to a private, loopback or link-local address.
 * - Each delivery is a JSON POST with `ConversaFlow-Event`, `ConversaFlow-Event-Id` and `ConversaFlow-Signature:
 *   t=<unix seconds>,v1=<hex HMAC-SHA256 of "t.body">` (a second v1 during the 24 hours after a rotation).
 * - Retried with back-off (8 attempts over about a day); every attempt's status is recorded; a delivery can be
 *   sent again by hand with the same event id, so receivers can drop duplicates.
 */
export const API_SCOPES = ['conversations:read', 'messages:send', 'contacts:read', 'contacts:write', 'reports:read'] as const;
export type ApiScope = (typeof API_SCOPES)[number];
/** What each scope allows, as permissions the key's member must also hold. */
/** Kept when the member holds them, never required: an owner's key reads every conversation, as the owner does. */
const SCOPE_OPTIONAL: Partial<Record<ApiScope, string[]>> = { 'conversations:read': ['inbox.read_all'], 'messages:send': ['inbox.read_all'], 'contacts:read': ['inbox.read_all'] };
/** Events and the access their creator needs, since each carries data from across the company (review of W2.8). */
const EVENT_PERMISSIONS: Record<string, string[]> = {
  'message.received': ['inbox.read_all', 'contacts.read'], 'message.status': ['inbox.read_all'], 'conversation.resolved': ['inbox.read_all'],
  'customer_request.created': ['inbox.read_all', 'contacts.read'], 'promise.missed': ['inbox.read_all'],
};
const EVENT_PERMISSIONS_ALL = [...new Set(Object.values(EVENT_PERMISSIONS).flat())];
const SCOPE_PERMISSIONS: Record<ApiScope, string[]> = {
  'conversations:read': ['inbox.reply'],
  'messages:send': ['inbox.reply'],
  'contacts:read': ['contacts.read'],
  'contacts:write': ['contacts.write'],
  'reports:read': ['reports.read'],
};
export const WEBHOOK_EVENTS = ['message.received', 'message.status', 'conversation.resolved', 'customer_request.created', 'promise.missed'] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export const API_RATE: Record<string, RateRule> = {
  perKey: { name: 'api:key', limit: 600, windowSeconds: 60 },
  failPerIp: { name: 'api:fail', limit: 30, windowSeconds: 3600 },
  resend: { name: 'api:resend', limit: 60, windowSeconds: 3600 },
};

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest();
const KeyInput = z.object({ name: z.string().trim().min(2).max(80), scopes: z.array(z.enum(API_SCOPES)).min(1).max(5), expiresInDays: z.number().int().min(1).max(730).optional() }).strict();
const EndpointInput = z.object({ url: z.string().url().max(500), events: z.array(z.enum(WEBHOOK_EVENTS)).min(1).max(5), description: z.string().trim().max(200).optional() }).strict();
const EndpointUpdate = z.object({ events: z.array(z.enum(WEBHOOK_EVENTS)).min(1).max(5).optional(), enabled: z.boolean().optional(), description: z.string().trim().max(200).optional() }).strict();

export interface ApiCaller { keyId: string; tenantId: string; scopes: Set<ApiScope>; actor: TenantActor }

// --- Keys (managed by a signed-in member) -------------------------------------------------------------------------

export class ApiKeysService {
  constructor(private readonly deps: Deps) {}

  async create(actor: TenantActor, input: unknown) {
    const body = parse(KeyInput, input);
    // A key can never be given more than its member may do.
    for (const s of body.scopes) for (const p of SCOPE_PERMISSIONS[s]) if (!actor.permissions.has(p)) throw Errors.forbidden(`You cannot give a key the "${s}" scope: you do not have that access yourself.`);
    const prefix = randomBytes(6).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, '0').slice(0, 8);
    const secret = randomBytes(32).toString('base64url');
    const token = `cf_live_${prefix}_${secret}`;
    return withContext(this.deps.db, actor, async (tx) => {
      const n = (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM api_keys WHERE revoked_at IS NULL')).rows[0]!.n;
      if (n >= 50) throw Errors.conflict('too_many_keys', 'A company can have up to 50 active API keys.');
      const row = (await tx.query<{ id: string; created_at: Date; expires_at: Date | null }>(
        `INSERT INTO api_keys (tenant_id, membership_id, name, prefix, secret_hash, scopes, created_by, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $8::int IS NULL THEN NULL ELSE now() + make_interval(days => $8::int) END) RETURNING id, created_at, expires_at`,
        [actor.tenantId, actor.membershipId, body.name, prefix, sha(token), [...new Set(body.scopes)], actor.userId, body.expiresInDays ?? null])).rows[0]!;
      await AuditService.record(tx, { tenantId: actor.tenantId, actorUserId: actor.userId, action: 'api_key.created', ip: actor.ip, targetType: 'api_key', targetId: row.id,
        metadata: { name: body.name, scopes: body.scopes, expiresAt: row.expires_at } });
      return { id: row.id, key: token, prefix, scopes: body.scopes, expiresAt: row.expires_at };
    });
  }

  list(actor: TenantActor) {
    return withContext(this.deps.db, actor, async (tx) => (await tx.query(
      `SELECT k.id, k.name, k.prefix, k.scopes, k.membership_id AS "membershipId", k.created_at AS "createdAt", k.expires_at AS "expiresAt",
              k.last_used_at AS "lastUsedAt", k.revoked_at AS "revokedAt",
              CASE WHEN k.revoked_at IS NOT NULL THEN 'revoked' WHEN k.expires_at IS NOT NULL AND k.expires_at <= now() THEN 'expired' ELSE 'active' END AS state,
              (SELECT count(*)::int FROM api_request_log l WHERE l.api_key_id = k.id AND l.created_at > now() - interval '24 hours') AS "requests24h"
       FROM api_keys k ORDER BY k.created_at DESC`)).rows);
  }

  async revoke(actor: TenantActor, id: string) {
    if (!isUuid(id)) throw Errors.notFound('API key');
    return withContext(this.deps.db, actor, async (tx) => {
      const r = await tx.query('UPDATE api_keys SET revoked_at = now(), revoked_by = $2 WHERE id = $1 AND revoked_at IS NULL RETURNING id', [id, actor.userId]);
      if (!r.rowCount) {
        if (!(await tx.query('SELECT 1 FROM api_keys WHERE id = $1', [id])).rowCount) throw Errors.notFound('API key');
        return { id, state: 'revoked' };
      }
      await AuditService.record(tx, { tenantId: actor.tenantId, actorUserId: actor.userId, action: 'api_key.revoked', ip: actor.ip, targetType: 'api_key', targetId: id, metadata: {} });
      return { id, state: 'revoked' };
    });
  }

  log(actor: TenantActor, id: string) {
    if (!isUuid(id)) throw Errors.notFound('API key');
    return withContext(this.deps.db, actor, async (tx) => (await tx.query(
      `SELECT method, route, status, duration_ms AS "durationMs", created_at AS "createdAt" FROM api_request_log WHERE api_key_id = $1 ORDER BY created_at DESC LIMIT 200`, [id])).rows);
  }
}

// --- Authentication of API requests ----------------------------------------------------------------------------

export class ApiAuth {
  constructor(private readonly deps: Deps) {}

  private async hasMfa(userId: string) {
    return withContext(this.deps.identityDb, { tenantId: null, userId }, async (tx) =>
      ((await tx.query('SELECT 1 FROM mfa_factors WHERE user_id = $1 AND confirmed_at IS NOT NULL', [userId])).rowCount ?? 0) > 0);
  }

  async resolve(authorization: string | undefined, ip: string | null): Promise<ApiCaller> {
    const subject = ip ?? 'unknown';
    await this.deps.rateLimiter.check(API_RATE.failPerIp!, subject);
    const m = /^Bearer (cf_live_[a-z0-9]{8}_[A-Za-z0-9_-]{43})$/.exec(authorization ?? '');
    const fail = async () => { await this.deps.rateLimiter.hit(API_RATE.failPerIp!, subject); return new AppError(401, 'invalid_api_key', 'The API key is missing, wrong, revoked or expired.'); };
    if (!m) throw await fail();
    const row = await withContext(this.deps.db, { tenantId: null, userId: null }, async (tx) =>
      (await tx.query<{ key_id: string; tenant_id: string; membership_id: string; scopes: ApiScope[] }>('SELECT * FROM api_key_route($1)', [sha(m[1]!)])).rows[0]);
    if (!row) throw await fail();
    await this.deps.rateLimiter.hit(API_RATE.perKey!, row.key_id);
    // The member the key acts for, with their permissions as they are now.
    const actor = await withContext(this.deps.db, { tenantId: row.tenant_id, userId: null }, async (tx) => {
      const t = (await tx.query<{ status: string }>('SELECT status FROM tenants WHERE id = $1', [row.tenant_id])).rows[0];
      if (!t || t.status === 'suspended' || t.status === 'closed') return null;
      // The member must be active in the company and their account active on the platform (review of W2.8).
      const r = (await tx.query<{ user_id: string; permissions: string[] | null; roles: string[] | null; requires_mfa: boolean }>(
        `SELECT m.user_id, tenant_requires_mfa() AS requires_mfa,
                array_agg(DISTINCT rp.permission_key) FILTER (WHERE rp.permission_key IS NOT NULL) AS permissions,
                array_agg(DISTINCT r.key) FILTER (WHERE r.key IS NOT NULL) AS roles
         FROM memberships m JOIN users u ON u.id = m.user_id AND u.status = 'active'
         LEFT JOIN membership_roles mr ON mr.membership_id = m.id LEFT JOIN roles r ON r.id = mr.role_id
         LEFT JOIN role_permissions rp ON rp.role_id = r.id WHERE m.id = $1 AND m.status = 'active' GROUP BY m.user_id`, [row.membership_id])).rows[0];
      if (!r) return null;
      // Where the company requires two-step sign-in (pilot), a key works only while its member still has it set up.
      if (r.requires_mfa && !(await this.hasMfa(r.user_id))) return null;
      await tx.query('UPDATE api_keys SET last_used_at = now() WHERE id = $1', [row.key_id]);
      // Only what both the member and the key's scopes allow.
      const allowed = new Set(row.scopes.flatMap((s) => [...(SCOPE_PERMISSIONS[s] ?? []), ...(SCOPE_OPTIONAL[s] ?? [])]));
      return { tenantId: row.tenant_id, userId: r.user_id, membershipId: row.membership_id, roles: r.roles ?? [],
        permissions: new Set((r.permissions ?? []).filter((p) => allowed.has(p))), requiresMfa: false, ip: ip ?? undefined, apiKeyId: row.key_id } as TenantActor;
    });
    if (!actor) throw await fail();
    return { keyId: row.key_id, tenantId: row.tenant_id, scopes: new Set(row.scopes), actor };
  }

  async logRequest(c: ApiCaller | null, method: string, route: string, status: number, started: number) {
    if (!c) return;
    await withContext(this.deps.db, { tenantId: c.tenantId, userId: null }, (tx) => tx.query(
      'INSERT INTO api_request_log (tenant_id, api_key_id, method, route, status, duration_ms) VALUES ($1, $2, $3, $4, $5, $6)',
      [c.tenantId, c.keyId, method, route.slice(0, 120), status, Math.max(0, Date.now() - started)])).catch(() => undefined);
  }
}

export function requireScope(c: ApiCaller, scope: ApiScope) {
  if (!c.scopes.has(scope)) throw new AppError(403, 'missing_scope', `This API key does not have the "${scope}" scope.`);
  for (const p of SCOPE_PERMISSIONS[scope]) if (!c.actor.permissions.has(p)) throw new AppError(403, 'forbidden', 'The member this key acts for no longer has this access.');
}

/** Opaque cursors: base64url of "<iso time>|<uuid>". */
export const cursor = {
  encode: (at: Date, id: string) => Buffer.from(`${at.toISOString()}|${id}`).toString('base64url'),
  decode: (c: string | undefined): { at: Date; id: string } | null => {
    if (!c) return null;
    const [at, id] = Buffer.from(c, 'base64url').toString('utf8').split('|');
    if (!at || !id || !isUuid(id) || Number.isNaN(Date.parse(at))) throw Errors.badRequest('The cursor is not valid.');
    return { at: new Date(at), id };
  },
};
const Page = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50), cursor: z.string().max(200).optional() });

/** Read endpoints of the public API. Writes go through the same services as the app (all their checks). */
export class PublicApiReads {
  constructor(private readonly deps: Deps) {}

  conversations(c: ApiCaller, query: unknown) {
    const q = parse(Page.extend({ status: z.enum(['open', 'pending', 'resolved', 'all']).default('all') }).strict(), query ?? {});
    const after = cursor.decode(q.cursor);
    return withContext(this.deps.db, c.actor, async (tx) => {
      const rows = (await tx.query<{ id: string; status: string; contact_id: string; assigned_membership_id: string | null; created_at: Date; last_message_at: Date | null }>(
        `SELECT c.id, c.status, c.contact_id, c.assigned_membership_id, c.created_at, c.last_message_at FROM conversations c
         WHERE ($1 = 'all' OR c.status = $1)
           AND ($2::boolean OR c.assigned_membership_id IS NULL OR c.assigned_membership_id = $3::uuid)
           AND ($4::timestamptz IS NULL OR (c.created_at, c.id) < ($4::timestamptz, $5::uuid))
         ORDER BY c.created_at DESC, c.id DESC LIMIT $6`,
        [q.status, c.actor.permissions.has('inbox.read_all'), c.actor.membershipId, after?.at ?? null, after?.id ?? null, q.limit + 1])).rows;
      const page = rows.slice(0, q.limit);
      return {
        data: page.map((r) => ({ id: r.id, status: r.status, contactId: r.contact_id, assignedMemberId: r.assigned_membership_id, createdAt: r.created_at, lastMessageAt: r.last_message_at })),
        nextCursor: rows.length > q.limit ? cursor.encode(page.at(-1)!.created_at, page.at(-1)!.id) : null,
      };
    });
  }

  messages(c: ApiCaller, conversationId: string, query: unknown) {
    const q = parse(Page.strict(), query ?? {});
    if (!isUuid(conversationId)) throw Errors.notFound('Conversation');
    const after = cursor.decode(q.cursor);
    return withContext(this.deps.db, c.actor, async (tx) => {
      const ok = (await tx.query(`SELECT 1 FROM conversations c WHERE c.id = $1 AND ($2::boolean OR c.assigned_membership_id IS NULL OR c.assigned_membership_id = $3::uuid)`,
        [conversationId, c.actor.permissions.has('inbox.read_all'), c.actor.membershipId])).rowCount;
      if (!ok) throw Errors.notFound('Conversation');
      const rows = (await tx.query<{ id: string; direction: string; kind: string; body: string | null; status: string; occurred_at: Date; via_api: boolean; by_automation: boolean }>(
        `SELECT m.id, m.direction, m.kind, m.body, m.status, m.occurred_at, (m.api_key_id IS NOT NULL) AS via_api, (m.automation_run_id IS NOT NULL) AS by_automation FROM messages m
         WHERE m.conversation_id = $1 AND ($2::timestamptz IS NULL OR (m.occurred_at, m.id) < ($2::timestamptz, $3::uuid))
         ORDER BY m.occurred_at DESC, m.id DESC LIMIT $4`, [conversationId, after?.at ?? null, after?.id ?? null, q.limit + 1])).rows;
      const page = rows.slice(0, q.limit);
      return {
        data: page.map((m) => ({ id: m.id, direction: m.direction, kind: m.kind, text: maskLinks(m.body), status: m.status, at: m.occurred_at, viaApi: m.via_api, byAutomation: m.by_automation })),
        nextCursor: rows.length > q.limit ? cursor.encode(page.at(-1)!.occurred_at, page.at(-1)!.id) : null,
      };
    });
  }

  contacts(c: ApiCaller, query: unknown) {
    const q = parse(Page.strict(), query ?? {});
    const after = cursor.decode(q.cursor);
    return withContext(this.deps.db, c.actor, async (tx) => {
      const rows = (await tx.query<{ id: string; name: string | null; locale: string | null; whatsapp: string | null; opted_out: boolean; marketing: boolean; created_at: Date }>(
        `SELECT ct.id, ct.display_name AS name, ct.locale, (SELECT value FROM contact_identifiers ci WHERE ci.contact_id = ct.id AND ci.kind = 'whatsapp' LIMIT 1) AS whatsapp,
                (ct.opted_out_at IS NOT NULL) AS opted_out, (ct.marketing_consent_at IS NOT NULL) AS marketing, ct.created_at
         FROM contacts ct WHERE ($1::timestamptz IS NULL OR (ct.created_at, ct.id) < ($1::timestamptz, $2::uuid))
         ORDER BY ct.created_at DESC, ct.id DESC LIMIT $3`, [after?.at ?? null, after?.id ?? null, q.limit + 1])).rows;
      const page = rows.slice(0, q.limit);
      return {
        data: page.map((r) => ({ id: r.id, name: r.name, locale: r.locale, whatsapp: r.whatsapp, optedOut: r.opted_out, marketingConsent: r.marketing, createdAt: r.created_at })),
        nextCursor: rows.length > q.limit ? cursor.encode(page.at(-1)!.created_at, page.at(-1)!.id) : null,
      };
    });
  }
}

// --- Outgoing webhooks ----------------------------------------------------------------------------------------

/**
 * Addresses an endpoint may not reach in production: private, loopback, link-local, shared, benchmarking,
 * documentation, multicast and reserved ranges, and IPv6 forms that carry an IPv4 address (mapped, compatible,
 * NAT64, 6to4), which are checked as that IPv4 address (review of W2.8).
 */
const BLOCKED = (() => {
  const b = new BlockList();
  for (const [net, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
    ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3]] as const) b.addSubnet(net, bits, 'ipv4');
  for (const [net, bits] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8], ['2001:db8::', 32], ['100::', 64], ['2001::', 23]] as const) b.addSubnet(net, bits, 'ipv6');
  return b;
})();
function embeddedIpv4(v6: string): string | null {
  // Expand to eight groups.
  const [head, tail] = v6.toLowerCase().split('::') as [string, string | undefined];
  const h = head ? head.split(':') : []; const t = tail !== undefined && tail !== '' ? tail.split(':') : [];
  const last = (t.length ? t : h).at(-1) ?? '';
  const dotted = isIP(last) === 4 ? last : null;
  const groups = [...h, ...(tail !== undefined ? Array(8 - h.length - t.length - (dotted ? 1 : 0)).fill('0') : []), ...t];
  if (dotted) { groups.pop(); const [a, b2, c, d] = dotted.split('.').map(Number) as [number, number, number, number]; groups.push(((a << 8) | b2).toString(16), ((c << 8) | d).toString(16)); }
  const g = groups.map((x) => parseInt(x || '0', 16));
  if (g.length !== 8 || g.some((x) => Number.isNaN(x))) return null;
  const v4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  const zero = (n: number) => g.slice(0, n).every((x) => x === 0);
  if (zero(5) && g[5] === 0xffff) return v4(g[6]!, g[7]!);                         // ::ffff:a.b.c.d
  if (zero(6) && (g[6] !== 0 || g[7]! > 1)) return v4(g[6]!, g[7]!);                // ::a.b.c.d (compatible)
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return v4(g[6]!, g[7]!);   // 64:ff9b::/96
  if (g[0] === 0x2002) return v4(g[1]!, g[2]!);                                   // 6to4
  return null;
}
export function isPrivateAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return BLOCKED.check(ip, 'ipv4');
  if (kind !== 6) return true;
  const inner = embeddedIpv4(ip);
  if (inner) return isPrivateAddress(inner);
  return BLOCKED.check(ip, 'ipv6');
}
/** Ports an endpoint may use in production. */
const ALLOWED_PORTS = new Set(['', '443', '8443']);

export async function checkEndpointUrl(url: string, allowPrivate: boolean) {
  const u = new URL(url);
  if (u.protocol !== 'https:') throw Errors.badRequest('Webhook addresses must use https.');
  if (u.username || u.password) throw Errors.badRequest('Webhook addresses cannot contain a user name or password.');
  if (allowPrivate) return;
  if (!ALLOWED_PORTS.has(u.port)) throw Errors.badRequest('Webhook addresses must use port 443 or 8443.');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (addrs.length === 0) throw Errors.badRequest('This address could not be found.');
  if (addrs.some(isPrivateAddress)) throw Errors.badRequest('Webhook addresses must be on the public internet.');
}

/**
 * The real sender: https only, no redirects followed, and the address is checked again at the moment of connecting
 * (the name is resolved once and that checked address is used), so a name that changes after the first check
 * cannot point the request inside the network (review of W2.8).
 */
export function httpsFetcher(allowPrivate: boolean): Fetcher {
  return (url, init) => new Promise((resolve, reject) => {
    const req = httpsRequest(url, {
      method: init.method, headers: { ...init.headers, 'content-length': String(Buffer.byteLength(init.body)) }, signal: init.signal,
      lookup: (hostname, options, cb) => lookupCb(hostname, { ...options, all: false }, (err, address, family) => {
        if (err) return cb(err, '', 0);
        if (!allowPrivate && isPrivateAddress(String(address))) return cb(Object.assign(new Error('address_not_allowed'), { code: 'EADDRNOTALLOWED' }), '', 0);
        cb(null, String(address), family as number);
      }),
    }, (res) => { res.resume(); res.on('end', () => resolve({ status: res.statusCode ?? 0 })); res.on('error', reject); });
    req.on('error', reject);
    req.end(init.body);
  });
}

export function sign(secret: string, timestamp: number, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

export class WebhookEndpointsService {
  constructor(private readonly deps: Deps) {}
  private allowPrivate() { return this.deps.config.NODE_ENV !== 'production' && this.deps.config.WEBHOOKS_ALLOW_PRIVATE === true; }

  private seal(secret: string) { return encryptSecret(this.deps.keys.webhookSecrets, secret); }
  /** Each event carries company-wide data, so its subscriber must be able to see that data in the app. */
  private checkEvents(actor: TenantActor, events: readonly string[]) {
    for (const e of events) for (const p of EVENT_PERMISSIONS[e] ?? []) {
      if (!actor.permissions.has(p)) throw Errors.forbidden(`You cannot subscribe to "${e}": it carries data you cannot see yourself.`);
    }
  }

  async create(actor: TenantActor, input: unknown) {
    const body = parse(EndpointInput, input);
    this.checkEvents(actor, body.events);
    await checkEndpointUrl(body.url, this.allowPrivate());
    const secret = `whsec_${randomBytes(32).toString('base64url')}`;
    return withContext(this.deps.db, actor, async (tx) => {
      const n = (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM webhook_endpoints')).rows[0]!.n;
      if (n >= 20) throw Errors.conflict('too_many_endpoints', 'A company can have up to 20 webhook endpoints.');
      const id = (await tx.query<{ id: string }>(
        'INSERT INTO webhook_endpoints (tenant_id, url, events, secret_sealed, description, created_by, created_by_membership) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id',
        [actor.tenantId, body.url, [...new Set(body.events)], this.seal(secret), body.description ?? null, actor.userId, actor.membershipId])).rows[0]!.id;
      await AuditService.record(tx, { tenantId: actor.tenantId, actorUserId: actor.userId, action: 'webhook.created', ip: actor.ip, targetType: 'webhook_endpoint', targetId: id, metadata: { url: body.url, events: body.events } });
      return { id, secret };
    });
  }

  list(actor: TenantActor) {
    return withContext(this.deps.db, actor, async (tx) => (await tx.query(
      `SELECT e.id, e.url, e.events, e.enabled, e.description, e.created_at AS "createdAt", e.failures, (e.previous_until > now()) AS "rotating",
              (SELECT count(*)::int FROM webhook_deliveries d WHERE d.endpoint_id = e.id AND d.state = 'failed') AS "failedDeliveries"
       FROM webhook_endpoints e ORDER BY e.created_at`)).rows);
  }

  async update(actor: TenantActor, id: string, input: unknown) {
    const body = parse(EndpointUpdate, input);
    if (!isUuid(id)) throw Errors.notFound('Webhook');
    if (body.events) this.checkEvents(actor, body.events);
    return withContext(this.deps.db, actor, async (tx) => {
      if (body.enabled) {
        const e = (await tx.query<{ sealed: boolean }>('SELECT secret_sealed IS NOT NULL AS sealed FROM webhook_endpoints WHERE id = $1', [id])).rows[0];
        if (e && !e.sealed) throw Errors.conflict('needs_new_secret', 'Give this endpoint a new signing secret before switching it on.');
      }
      const r = await tx.query(`UPDATE webhook_endpoints SET events = coalesce($2, events), enabled = coalesce($3, enabled), description = coalesce($4, description),
                                  failures = CASE WHEN $3 THEN 0 ELSE failures END WHERE id = $1`,
        [id, body.events ? [...new Set(body.events)] : null, body.enabled ?? null, body.description ?? null]);
      if (!r.rowCount) throw Errors.notFound('Webhook');
      await AuditService.record(tx, { tenantId: actor.tenantId, actorUserId: actor.userId, action: 'webhook.updated', ip: actor.ip, targetType: 'webhook_endpoint', targetId: id, metadata: body });
      return { id };
    });
  }

  /** A new signing secret; the previous one stays valid (signed alongside) for 24 hours. */
  async rotate(actor: TenantActor, id: string) {
    if (!isUuid(id)) throw Errors.notFound('Webhook');
    const secret = `whsec_${randomBytes(32).toString('base64url')}`;
    return withContext(this.deps.db, actor, async (tx) => {
      const r = await tx.query(`UPDATE webhook_endpoints SET previous_secret_sealed = secret_sealed,
                                  previous_until = CASE WHEN secret_sealed IS NULL THEN NULL ELSE now() + interval '24 hours' END, secret_sealed = $2 WHERE id = $1`, [id, this.seal(secret)]);
      if (!r.rowCount) throw Errors.notFound('Webhook');
      await AuditService.record(tx, { tenantId: actor.tenantId, actorUserId: actor.userId, action: 'webhook.secret_rotated', ip: actor.ip, targetType: 'webhook_endpoint', targetId: id, metadata: {} });
      return { id, secret };
    });
  }

  async remove(actor: TenantActor, id: string) {
    if (!isUuid(id)) throw Errors.notFound('Webhook');
    return withContext(this.deps.db, actor, async (tx) => {
      const r = await tx.query('DELETE FROM webhook_endpoints WHERE id = $1', [id]);
      if (!r.rowCount) throw Errors.notFound('Webhook');
      await AuditService.record(tx, { tenantId: actor.tenantId, actorUserId: actor.userId, action: 'webhook.deleted', ip: actor.ip, targetType: 'webhook_endpoint', targetId: id, metadata: {} });
      return { deleted: true };
    });
  }

  deliveries(actor: TenantActor, id: string) {
    if (!isUuid(id)) throw Errors.notFound('Webhook');
    return withContext(this.deps.db, actor, async (tx) => (await tx.query(
      `SELECT id, event, event_id AS "eventId", state, attempts, last_status AS "lastStatus", last_error AS "lastError", delivered_at AS "deliveredAt",
              next_attempt_at AS "nextAttemptAt", resend_of AS "resendOf", created_at AS "createdAt"
       FROM webhook_deliveries WHERE endpoint_id = $1 ORDER BY created_at DESC LIMIT 100`, [id])).rows);
  }

  /** Sends a delivery again (same event and event id), whatever happened to it before. */
  async resend(actor: TenantActor, deliveryId: string) {
    if (!isUuid(deliveryId)) throw Errors.notFound('Delivery');
    await this.deps.rateLimiter.hit(API_RATE.resend!, actor.tenantId);
    return withContext(this.deps.db, actor, async (tx) => {
      const d = (await tx.query<{ endpoint_id: string; event: string; event_id: string; payload: unknown }>(
        'SELECT endpoint_id, event, event_id, payload FROM webhook_deliveries WHERE id = $1', [deliveryId])).rows[0];
      if (!d) throw Errors.notFound('Delivery');
      const id = (await tx.query<{ id: string }>(
        'INSERT INTO webhook_deliveries (tenant_id, endpoint_id, event, event_id, payload, resend_of) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
        [actor.tenantId, d.endpoint_id, d.event, d.event_id, JSON.stringify(d.payload), deliveryId])).rows[0]!.id;
      await AuditService.record(tx, { tenantId: actor.tenantId, actorUserId: actor.userId, action: 'webhook.resent', ip: actor.ip, targetType: 'webhook_delivery', targetId: id, metadata: { of: deliveryId } });
      return { id };
    });
  }
}

/**
 * Queues an event for every enabled endpoint that asked for it, in the caller's transaction (so exactly once with
 * the change that caused it). The payload says what happened and points at the records; it carries message text
 * only for message.received, because the company's own systems receive it.
 */
export async function emitEvent(tx: Tx, tenantId: string, event: WebhookEvent, data: Record<string, unknown>) {
  const eventId = randomUUID();
  const payload = { id: eventId, type: event, createdAt: new Date().toISOString(), data };
  await tx.query(
    `INSERT INTO webhook_deliveries (tenant_id, endpoint_id, event, event_id, payload)
     SELECT $1, e.id, $2, $3, $4 FROM webhook_endpoints e WHERE e.enabled AND $2 = ANY(e.events)`,
    [tenantId, event, eventId, JSON.stringify(payload)]);
}

/** A claimed batch is small enough to finish inside its lease even if every request times out. */
export const WEBHOOK_LIMITS = { maxAttempts: 8, timeoutMs: 10_000, leaseSeconds: 150, batch: 10, disableAfterFailures: 50 };
export type Fetcher = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ status: number }>;

/** Worker: delivers due webhooks. Endpoints failing 50 times in a row are switched off (and say so). */
export class WebhookWorker {
  private readonly fetcher: Fetcher;
  private readonly allowPrivate: boolean;
  constructor(private readonly db: Db, private readonly secretsKey: Buffer, opts: { fetcher?: Fetcher; allowPrivate?: boolean } = {}) {
    this.allowPrivate = opts.allowPrivate ?? false;
    this.fetcher = opts.fetcher ?? httpsFetcher(this.allowPrivate);
  }

  async dispatchDue(limit = WEBHOOK_LIMITS.batch): Promise<number> {
    const due = await withContext(this.db, { tenantId: null, userId: null }, async (tx) =>
      (await tx.query<{ delivery_id: string; tenant_id: string }>('SELECT * FROM webhook_claim($1, $2)', [limit, WEBHOOK_LIMITS.leaseSeconds])).rows);
    for (const d of due) await this.one(d.tenant_id, d.delivery_id).catch((err) => console.error('webhook delivery error', d.delivery_id, err instanceof Error ? err.message : err));
    return due.length;
  }

  private async one(tenantId: string, id: string) {
    const ctx = { tenantId, userId: null };
    const d = await withContext(this.db, ctx, async (tx) => (await tx.query<{ event: string; event_id: string; payload: unknown; attempts: number; url: string; secret: string | null;
      previous_secret: string | null; previous_valid: boolean; enabled: boolean; endpoint_id: string; lease: string; creator_ok: boolean }>(
      `SELECT d.event, d.event_id, d.payload, d.attempts, d.lease_until::text AS lease, e.url, e.secret_sealed AS secret, e.previous_secret_sealed AS previous_secret,
              (e.previous_until > now()) AS previous_valid, e.enabled, e.id AS endpoint_id,
              -- The member who set the endpoint up must still be active with the access the event needs.
              EXISTS (SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id AND u.status = 'active'
                      WHERE m.id = e.created_by_membership AND m.status = 'active'
                        AND NOT EXISTS (SELECT 1 FROM unnest($2::text[]) need(p) WHERE NOT EXISTS (
                          SELECT 1 FROM membership_roles mr JOIN role_permissions rp ON rp.role_id = mr.role_id WHERE mr.membership_id = m.id AND rp.permission_key = need.p))) AS creator_ok
       FROM webhook_deliveries d JOIN webhook_endpoints e ON e.id = d.endpoint_id WHERE d.id = $1 AND d.state = 'leased'`,
      [id, EVENT_PERMISSIONS_ALL])).rows[0]);
    if (!d) return;
    let status = 0; let error: string | null = null;
    if (d.attempts >= WEBHOOK_LIMITS.maxAttempts) error = 'gave_up';
    else if (!d.enabled || !d.secret) error = 'endpoint_disabled';
    else if (!d.creator_ok) error = 'creator_lost_access';
    else {
      try { await checkEndpointUrl(d.url, this.allowPrivate); } catch { error = 'address_not_allowed'; }
    }
    if (!error) {
      const body = JSON.stringify(d.payload);
      const ts = Math.floor(Date.now() / 1000);
      const sigs = [`v1=${sign(decryptSecret(this.secretsKey, d.secret!), ts, body)}`];
      if (d.previous_secret && d.previous_valid) sigs.push(`v1=${sign(decryptSecret(this.secretsKey, d.previous_secret), ts, body)}`);
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), WEBHOOK_LIMITS.timeoutMs);
      try {
        status = (await this.fetcher(d.url, { method: 'POST', signal: abort.signal, body, headers: {
          'content-type': 'application/json', 'user-agent': 'ConversaFlow-Webhooks/1', 'conversaflow-event': d.event, 'conversaflow-event-id': d.event_id,
          'conversaflow-signature': `t=${ts},${sigs.join(',')}`,
        } })).status;
        if (status < 200 || status >= 300) error = `http_${status}`;
      } catch (err) {
        const e = err as Error & { code?: string };
        error = e.name === 'AbortError' ? 'timeout' : e.code === 'EADDRNOTALLOWED' ? 'address_not_allowed' : 'connection_failed';
      } finally { clearTimeout(timer); }
    }
    await withContext(this.db, ctx, async (tx) => {
      // Only the holder of this lease records the result (another worker may have reclaimed an expired one).
      if (!error) {
        const r = await tx.query(`UPDATE webhook_deliveries SET state = 'delivered', attempts = attempts + 1, last_status = $2, last_error = NULL, delivered_at = now(), lease_until = NULL, updated_at = now()
                                  WHERE id = $1 AND state = 'leased' AND lease_until = $3::timestamptz`, [id, status, d.lease]);
        if (!r.rowCount) return;
        await tx.query('UPDATE webhook_endpoints SET failures = 0 WHERE id = $1', [d.endpoint_id]);
        return;
      }
      const final = ['endpoint_disabled', 'creator_lost_access', 'gave_up'].includes(error);
      const last = d.attempts + 1 >= WEBHOOK_LIMITS.maxAttempts || final;
      // 30 s, 2 min, 8 min, 32 min, ~2 h, ~8.5 h, then capped at 12 h.
      const r = await tx.query(`UPDATE webhook_deliveries SET state = $2, attempts = attempts + CASE WHEN $5 THEN 0 ELSE 1 END, last_status = $3, last_error = $4, lease_until = NULL, updated_at = now(),
                        next_attempt_at = now() + make_interval(secs => least(30 * power(4, attempts), 43200)) WHERE id = $1 AND state = 'leased' AND lease_until = $6::timestamptz`,
        [id, last ? 'failed' : 'pending', status || null, error, error === 'gave_up', d.lease]);
      if (!r.rowCount || final) return;
      const f = (await tx.query<{ failures: number }>('UPDATE webhook_endpoints SET failures = failures + 1 WHERE id = $1 RETURNING failures', [d.endpoint_id])).rows[0];
      if (f && f.failures === WEBHOOK_LIMITS.disableAfterFailures) {
        await tx.query('UPDATE webhook_endpoints SET enabled = false WHERE id = $1', [d.endpoint_id]);
        await AuditService.record(tx, { tenantId, actorUserId: null, action: 'webhook.auto_disabled', ip: undefined, targetType: 'webhook_endpoint', targetId: d.endpoint_id,
          metadata: { failures: f.failures } });
      }
    });
  }
}
