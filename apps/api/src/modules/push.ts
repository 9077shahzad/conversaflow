import { withContext, type Db, type Tx } from '@conversaflow/database';
import { z } from 'zod';
import type { TenantActor } from '../core/context';
import { Errors } from '../core/errors';
import { parse } from '../core/validate';
import { AuditService } from './audit.service';
import { isUuid } from './members.service';

/**
 * Notifications on agents' phones and computers (BRD v1.2 Wave 2, W2.5, CF-EXT-013; migration 0052).
 *
 * - A member turns notifications on in their browser; the browser's push subscription is saved for that member (at
 *   most 10 devices each). Turning off, signing out of the device or the push service saying the subscription is
 *   gone removes it.
 * - A notification is queued in the same transaction as the event (a customer message, a request on the customer
 *   page), so exactly once; at most one waits per device and conversation, so a burst of messages is one alert.
 * - Who hears about what: the person a conversation is assigned to (on by default); everyone who can reply and asked
 *   for unassigned conversations (off by default); customer requests for the conversation's person, or for those who
 *   hear about unassigned conversations.
 * - The text shown never contains message text, customer names or numbers (it can appear on a locked screen).
 * - Sending uses the Web Push standard with the company's VAPID keys. Without keys (local development, tests) a
 *   recording sender is used and notifications are labelled as not sent anywhere.
 */
export interface PushSubscriptionRow { id: string; endpoint: string; p256dh: string; auth: string }
export interface PushPayload { title: string; body: string; url: string; tag: string }
export type PushOutcome = 'sent' | 'gone' | 'retry';
export interface PushSender {
  readonly name: 'web_push' | 'recording';
  send(sub: PushSubscriptionRow, payload: PushPayload): Promise<PushOutcome>;
}

/** Records instead of sending (development and tests). */
export class RecordingPushSender implements PushSender {
  readonly name = 'recording' as const;
  readonly sent: Array<{ endpoint: string; payload: PushPayload }> = [];
  /** Endpoints the "push service" reports as gone, for tests. */
  readonly gone = new Set<string>();
  async send(sub: PushSubscriptionRow, payload: PushPayload): Promise<PushOutcome> {
    if (this.gone.has(sub.endpoint)) return 'gone';
    this.sent.push({ endpoint: sub.endpoint, payload });
    return 'sent';
  }
}

/** The Web Push standard (RFC 8030, 8291, 8292) through the `web-push` library. Not run against a live push service yet. */
export class WebPushSender implements PushSender {
  readonly name = 'web_push' as const;
  constructor(private readonly keys: { publicKey: string; privateKey: string; subject: string }) {}
  async send(sub: PushSubscriptionRow, payload: PushPayload): Promise<PushOutcome> {
    const webpush = await import('web-push');
    try {
      await webpush.default.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, JSON.stringify(payload), {
        TTL: 3600, urgency: 'high', timeout: 10_000,
        vapidDetails: { subject: this.keys.subject, publicKey: this.keys.publicKey, privateKey: this.keys.privateKey },
      });
      return 'sent';
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      return status === 404 || status === 410 ? 'gone' : 'retry';
    }
  }
}

/**
 * Push services browsers use. A subscription must point at one of them (on the standard https port, by name, never
 * an address), so the worker can never be made to call anything else (review of W2.5, H1). Development and tests
 * may also use hosts under example.test.
 */
const PUSH_HOSTS = ['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'push.services.mozilla.com', 'notify.windows.com', 'web.push.apple.com'];
export function isPushServiceUrl(raw: string, allowTestHosts: boolean): boolean {
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== 'https:' || (u.port && u.port !== '443') || u.username || u.password) return false;
  const h = u.hostname.toLowerCase();
  if (/^[0-9.]+$/.test(h) || h.includes(':') || h.startsWith('[')) return false;
  if (allowTestHosts && (h === 'example.test' || h.endsWith('.example.test'))) return true;
  return PUSH_HOSTS.some((p) => h === p || h.endsWith(`.${p}`));
}
const SubscribeInput = z.object({
  endpoint: z.string().url().max(1000),
  keys: z.object({ p256dh: z.string().min(40).max(200).regex(/^[A-Za-z0-9_-]+=*$/), auth: z.string().min(16).max(64).regex(/^[A-Za-z0-9_-]+=*$/) }),
}).strict();
const PrefsInput = z.object({ assigned: z.boolean(), unassigned: z.boolean(), customerRequests: z.boolean() }).strict();

const TEXT = {
  en: { promise_due_soon: ['Promise due soon', 'A promise to a customer is due within the hour.'], promise_missed: ['Promise missed', 'A promise to a customer passed its deadline.'],
    new_message: ['New message', 'A customer wrote in a conversation.'], customer_request: ['Customer request', 'A customer asked for help on their page.'], test: ['Notifications are on', 'This is a test from ConversaFlow.'] },
  ar: { promise_due_soon: ['وعد يقترب موعده', 'موعد وعد لعميل خلال ساعة.'], promise_missed: ['وعد فات موعده', 'فات موعد وعد لعميل.'],
    new_message: ['رسالة جديدة', 'كتب عميل في محادثة.'], customer_request: ['طلب عميل', 'طلب عميل المساعدة من صفحته.'], test: ['الإشعارات مفعّلة', 'هذا إشعار تجريبي من ConversaFlow.'] },
} as const;

export class PushService {
  constructor(private readonly deps: { db: Db; config: { VAPID_PUBLIC_KEY?: string; NODE_ENV?: string }; rateLimiter?: { hit(rule: { name: string; limit: number; windowSeconds: number }, subject: string): Promise<void> } }, private readonly sender: PushSender) {}

  /** What the browser needs to subscribe, and whether notifications really go anywhere. */
  info() {
    return { publicKey: this.deps.config.VAPID_PUBLIC_KEY ?? null, delivery: this.sender.name };
  }

  async subscribe(actor: TenantActor, input: unknown, userAgent: string | undefined) {
    const body = parse(SubscribeInput, input);
    if (!isPushServiceUrl(body.endpoint, this.deps.config.NODE_ENV !== 'production')) throw Errors.badRequest('This is not a browser push service address.');
    return withContext(this.deps.db, actor, async (tx) => {
      const n = (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM push_subscriptions WHERE membership_id = $1', [actor.membershipId])).rows[0]!.n;
      const existing = (await tx.query<{ id: string; membership_id: string }>('SELECT id, membership_id FROM push_subscriptions WHERE endpoint = $1', [body.endpoint])).rows[0];
      // A device signed in as someone else before: it now belongs to this member only.
      if (existing && existing.membership_id !== actor.membershipId) await tx.query('DELETE FROM push_subscriptions WHERE id = $1', [existing.id]);
      if (existing && existing.membership_id === actor.membershipId) {
        await tx.query('UPDATE push_subscriptions SET p256dh = $2, auth = $3, user_agent = $4, failures = 0 WHERE id = $1', [existing.id, body.keys.p256dh, body.keys.auth, userAgent?.slice(0, 300) ?? null]);
        await AuditService.record(tx, { tenantId: actor.tenantId, actorUserId: actor.userId, action: 'notifications.device_renewed', ip: actor.ip, targetType: 'push_subscription', targetId: existing.id, metadata: {} });
        return { id: existing.id };
      }
      if (n >= 10) throw Errors.conflict('too_many_devices', 'Notifications are on for 10 devices already. Turn them off on one first.');
      const id = (await tx.query<{ id: string }>(
        'INSERT INTO push_subscriptions (tenant_id, membership_id, endpoint, p256dh, auth, user_agent) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
        [actor.tenantId, actor.membershipId, body.endpoint, body.keys.p256dh, body.keys.auth, userAgent?.slice(0, 300) ?? null])).rows[0]!.id;
      await AuditService.record(tx, { tenantId: actor.tenantId, actorUserId: actor.userId, action: 'notifications.device_added', ip: actor.ip, targetType: 'push_subscription', targetId: id, metadata: {} });
      return { id };
    });
  }

  async unsubscribe(actor: TenantActor, id: string) {
    if (!isUuid(id)) throw Errors.notFound('Device');
    return withContext(this.deps.db, actor, async (tx) => {
      const r = await tx.query('DELETE FROM push_subscriptions WHERE id = $1 AND membership_id = $2', [id, actor.membershipId]);
      if (!r.rowCount) throw Errors.notFound('Device');
      await AuditService.record(tx, { tenantId: actor.tenantId, actorUserId: actor.userId, action: 'notifications.device_removed', ip: actor.ip, targetType: 'push_subscription', targetId: id, metadata: {} });
      return { removed: true };
    });
  }

  /** This device turned notifications off: removed by its push address (the member's own devices only). */
  async unsubscribeEndpoint(actor: TenantActor, input: unknown) {
    const body = parse(z.object({ endpoint: z.string().max(1000) }).strict(), input);
    return withContext(this.deps.db, actor, async (tx) => {
      const r = await tx.query<{ id: string }>('DELETE FROM push_subscriptions WHERE endpoint = $1 AND membership_id = $2 RETURNING id', [body.endpoint, actor.membershipId]);
      if (r.rowCount) await AuditService.record(tx, { tenantId: actor.tenantId, actorUserId: actor.userId, action: 'notifications.device_removed', ip: actor.ip, targetType: 'push_subscription', targetId: r.rows[0]!.id, metadata: {} });
      return { removed: (r.rowCount ?? 0) > 0 };
    });
  }

  devices(actor: TenantActor) {
    return withContext(this.deps.db, actor, async (tx) => (await tx.query(
      `SELECT id, endpoint, user_agent AS "userAgent", created_at AS "createdAt", last_success_at AS "lastSuccessAt"
       FROM push_subscriptions WHERE membership_id = $1 ORDER BY created_at`, [actor.membershipId])).rows);
  }

  preferences(actor: TenantActor) {
    return withContext(this.deps.db, actor, async (tx) => {
      const r = (await tx.query<{ assigned: boolean; unassigned: boolean; customer_requests: boolean }>(
        'SELECT assigned, unassigned, customer_requests FROM notification_preferences WHERE membership_id = $1', [actor.membershipId])).rows[0];
      return { assigned: r?.assigned ?? true, unassigned: r?.unassigned ?? false, customerRequests: r?.customer_requests ?? true };
    });
  }

  async setPreferences(actor: TenantActor, input: unknown) {
    const body = parse(PrefsInput, input);
    return withContext(this.deps.db, actor, async (tx) => {
      await tx.query(`INSERT INTO notification_preferences (tenant_id, membership_id, assigned, unassigned, customer_requests) VALUES ($1, $2, $3, $4, $5)
                      ON CONFLICT (tenant_id, membership_id) DO UPDATE SET assigned = $3, unassigned = $4, customer_requests = $5, updated_at = now()`,
        [actor.tenantId, actor.membershipId, body.assigned, body.unassigned, body.customerRequests]);
      return body;
    });
  }

  /** A test notification to the member's own devices. */
  async test(actor: TenantActor) {
    await this.deps.rateLimiter?.hit({ name: 'push:test', limit: 5, windowSeconds: 3600 }, actor.membershipId);
    return withContext(this.deps.db, actor, async (tx) => {
      const r = await tx.query(`INSERT INTO push_jobs (tenant_id, subscription_id, kind) SELECT tenant_id, id, 'test' FROM push_subscriptions WHERE membership_id = $1`, [actor.membershipId]);
      if (!r.rowCount) throw Errors.conflict('no_devices', 'Turn on notifications on this device first.');
      return { queued: r.rowCount };
    });
  }
}

/**
 * Queues notifications for a customer's message, in the transaction that records it. The conversation's person
 * hears about it (unless they turned that off); with nobody assigned, members who can reply and asked to hear about
 * unassigned conversations do.
 */
export async function queueConversationNotice(tx: Tx, tenantId: string, conversationId: string, kind: 'new_message' | 'customer_request') {
  const c = (await tx.query<{ assigned: string | null }>('SELECT assigned_membership_id AS assigned FROM conversations WHERE id = $1', [conversationId])).rows[0];
  if (!c) return;
  const want = kind === 'customer_request' ? 'customer_requests' : null;
  await tx.query(
    `INSERT INTO push_jobs (tenant_id, subscription_id, kind, conversation_id)
     SELECT $1, s.id, $3, $2 FROM push_subscriptions s
     JOIN memberships m ON m.id = s.membership_id AND m.status = 'active'
     LEFT JOIN notification_preferences p ON p.membership_id = s.membership_id
     WHERE (CASE WHEN $4::uuid IS NOT NULL THEN s.membership_id = $4::uuid AND coalesce(p.assigned, true)
                 ELSE coalesce(p.unassigned, false) END)
       AND ($5::text IS NULL OR coalesce(p.customer_requests, true))
       AND EXISTS (SELECT 1 FROM membership_roles mr JOIN role_permissions rp ON rp.role_id = mr.role_id
                   WHERE mr.membership_id = s.membership_id AND rp.permission_key = 'inbox.reply')
       -- One waiting alert per device and conversation: a burst of messages is one notification (also a unique index).
       AND NOT EXISTS (SELECT 1 FROM push_jobs j WHERE j.subscription_id = s.id AND j.conversation_id = $2 AND j.state IN ('pending', 'leased'))
     ON CONFLICT DO NOTHING`,
    [tenantId, conversationId, kind, c.assigned, want]);
}

export const PUSH_LIMITS = { maxAttempts: 5, leaseSeconds: 60, removeAfterFailures: 20 };

/** Worker: sends due notifications. A device the push service says is gone is removed. */
export class PushWorker {
  constructor(private readonly db: Db, private readonly sender: PushSender) {}

  async dispatchDue(limit = 100): Promise<number> {
    const due = await withContext(this.db, { tenantId: null, userId: null }, async (tx) =>
      (await tx.query<{ job_id: string; tenant_id: string }>('SELECT * FROM push_claim($1, $2)', [limit, PUSH_LIMITS.leaseSeconds])).rows);
    for (const d of due) await this.one(d.tenant_id, d.job_id).catch((err) => console.error('push job error', d.job_id, err instanceof Error ? err.message : err));
    return due.length;
  }

  private async one(tenantId: string, jobId: string) {
    const ctx = { tenantId, userId: null };
    const job = await withContext(this.db, ctx, async (tx) => (await tx.query<{ kind: 'new_message' | 'customer_request' | 'test' | 'promise_due_soon' | 'promise_missed'; conversation_id: string | null; attempts: number;
      sub_id: string; endpoint: string; p256dh: string; auth: string; locale: string; allowed: boolean }>(
      `SELECT j.kind, j.conversation_id, j.attempts, s.id AS sub_id, s.endpoint, s.p256dh, s.auth, t.locale,
              (m.status = 'active' AND EXISTS (SELECT 1 FROM membership_roles mr JOIN role_permissions rp ON rp.role_id = mr.role_id
                                               WHERE mr.membership_id = m.id AND rp.permission_key = 'inbox.reply')) AS allowed
       FROM push_jobs j JOIN push_subscriptions s ON s.id = j.subscription_id JOIN tenants t ON t.id = j.tenant_id
       JOIN memberships m ON m.id = s.membership_id
       WHERE j.id = $1 AND j.state = 'leased'`, [jobId])).rows[0]);
    if (!job) return;
    // A member suspended or no longer able to reply since the alert was queued is not told (review of W2.5, M1);
    // an alert whose lease ran out too often is given up.
    if (!job.allowed || job.attempts >= PUSH_LIMITS.maxAttempts) {
      await withContext(this.db, ctx, (tx) => tx.query(`UPDATE push_jobs SET state = 'failed', lease_until = NULL, last_error = $2, updated_at = now() WHERE id = $1`,
        [jobId, job.allowed ? 'too_many_attempts' : 'member_not_allowed']));
      return;
    }
    const lang = job.locale === 'ar' ? 'ar' : 'en';
    const [title, body] = TEXT[lang][job.kind];
    const url = job.conversation_id ? `/${lang}/app/inbox?c=${job.conversation_id}` : `/${lang}/app/inbox`;
    const outcome = await this.sender.send({ id: job.sub_id, endpoint: job.endpoint, p256dh: job.p256dh, auth: job.auth },
      { title, body, url, tag: job.conversation_id ?? 'conversaflow' });
    await withContext(this.db, ctx, async (tx) => {
      if (outcome === 'sent') {
        await tx.query(`UPDATE push_jobs SET state = 'sent', lease_until = NULL, attempts = attempts + 1, updated_at = now() WHERE id = $1`, [jobId]);
        await tx.query('UPDATE push_subscriptions SET last_success_at = now(), failures = 0 WHERE id = $1', [job.sub_id]);
      } else if (outcome === 'gone') {
        await tx.query('DELETE FROM push_subscriptions WHERE id = $1', [job.sub_id]);   // its jobs go with it
      } else {
        const last = job.attempts + 1 >= PUSH_LIMITS.maxAttempts;
        await tx.query(`UPDATE push_jobs SET state = $2, attempts = attempts + 1, lease_until = NULL, last_error = 'push_service_error',
                          next_attempt_at = now() + make_interval(secs => 30 * (attempts + 1)), updated_at = now() WHERE id = $1`, [jobId, last ? 'failed' : 'pending']);
        const f = (await tx.query<{ failures: number }>('UPDATE push_subscriptions SET failures = failures + 1 WHERE id = $1 RETURNING failures', [job.sub_id])).rows[0];
        // A device failing again and again is removed (it can be turned on again).
        if (f && f.failures >= PUSH_LIMITS.removeAfterFailures) await tx.query('DELETE FROM push_subscriptions WHERE id = $1', [job.sub_id]);
      }
    });
  }
}
