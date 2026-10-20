import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

/**
 * Channel adapters (CF-EXT-001, BRD §14 "capability-based channel interfaces").
 *
 * Webhook payloads use the shape of Meta's WhatsApp Cloud API webhooks (object, entry[].changes[].value with
 * metadata, contacts, messages, statuses), so the real Cloud API adapter reuses the same parser. The sandbox adapter
 * is a local test double: it never opens a network connection and is refused in production (config.ts).
 */
export type Provider = 'sandbox' | 'whatsapp_cloud';

export interface SendResult { providerMessageId: string }

export interface ChannelAdapter {
  readonly provider: Provider;
  /** Sends a free-form text inside the customer service window. Throws ChannelSendError on a provider refusal. */
  sendText(input: { providerNumberId: string; to: string; body: string; clientMessageId: string }): Promise<SendResult>;
}

export class ChannelSendError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

/** Local double: records what would have been sent. Tests read `sent`; nothing leaves the process. */
export class SandboxAdapter implements ChannelAdapter {
  readonly provider = 'sandbox' as const;
  readonly sent: Array<{ providerNumberId: string; to: string; body: string; providerMessageId: string }> = [];
  /** Tests can make the next sends fail with a provider-style error code. */
  failNext: string[] = [];
  /** Tests can fix the next provider message ids (to deliver a status before the send is recorded). */
  nextIds: string[] = [];

  async sendText(input: { providerNumberId: string; to: string; body: string; clientMessageId: string }): Promise<SendResult> {
    const fail = this.failNext.shift();
    if (fail) throw new ChannelSendError(fail, 'Sandbox provider refused the message.');
    const providerMessageId = this.nextIds.shift() ?? `wamid.sandbox.${randomUUID()}`;
    this.sent.push({ providerNumberId: input.providerNumberId, to: input.to, body: input.body, providerMessageId });
    return { providerMessageId };
  }
}

/** Meta signs webhook bodies with HMAC-SHA256 of the raw body and the app secret: `X-Hub-Signature-256: sha256=<hex>`. */
export function signBody(secret: string, rawBody: Buffer | string): string {
  return 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');
}

export function verifySignature(secret: string, rawBody: Buffer | undefined, header: string | undefined): boolean {
  if (!rawBody || !header || !/^sha256=[0-9a-f]{64}$/.test(header)) return false;
  const expected = Buffer.from(signBody(secret, rawBody));
  const given = Buffer.from(header);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

// --- Parsing --------------------------------------------------------------------------------------------------
const epochSeconds = z.string().regex(/^\d{1,12}$/);
const InboundMessage = z.object({
  from: z.string().regex(/^[0-9]{6,20}$/),
  id: z.string().min(1).max(200),
  timestamp: epochSeconds,
  type: z.string().min(1).max(40),
  text: z.object({ body: z.string().max(4096) }).optional(),
  referral: z.record(z.unknown()).optional(),
}).passthrough();
const StatusUpdate = z.object({
  id: z.string().min(1).max(200),
  status: z.enum(['sent', 'delivered', 'read', 'failed']),
  timestamp: epochSeconds,
  recipient_id: z.string().max(40).optional(),
  errors: z.array(z.object({ code: z.union([z.number(), z.string()]).optional(), title: z.string().optional() }).passthrough()).optional(),
}).passthrough();
const ChangeValue = z.object({
  metadata: z.object({ phone_number_id: z.string().min(1).max(64), display_phone_number: z.string().max(32).optional() }),
  contacts: z.array(z.object({ wa_id: z.string(), profile: z.object({ name: z.string().max(200) }).partial().optional() }).passthrough()).optional(),
  messages: z.array(InboundMessage).optional(),
  statuses: z.array(StatusUpdate).optional(),
}).passthrough();
export const WebhookPayload = z.object({
  object: z.literal('whatsapp_business_account'),
  entry: z.array(z.object({
    id: z.string().optional(),
    changes: z.array(z.object({ field: z.string(), value: z.unknown() })).max(100),
  })).min(1).max(100),
});

export type ParsedEvent =
  | { kind: 'message'; providerNumberId: string; key: string; from: string; profileName: string | null; providerMessageId: string;
      occurredAt: Date; type: string; body: string | null; referral: Record<string, unknown> | null; raw: unknown }
  | { kind: 'status'; providerNumberId: string; key: string; providerMessageId: string; status: 'sent' | 'delivered' | 'read' | 'failed';
      occurredAt: Date; errorCode: string | null; raw: unknown };

/** Splits one verified delivery into individual events. Malformed parts are skipped and counted, not fatal. */
export function parseWebhook(payload: unknown): { events: ParsedEvent[]; skipped: number } {
  const top = WebhookPayload.safeParse(payload);
  if (!top.success) return { events: [], skipped: 1 };
  const events: ParsedEvent[] = [];
  let skipped = 0;
  for (const entry of top.data.entry) {
    for (const change of entry.changes) {
      if (change.field !== 'messages') { skipped++; continue; }
      const v = ChangeValue.safeParse(change.value);
      if (!v.success) { skipped++; continue; }
      const number = v.data.metadata.phone_number_id;
      const names = new Map((v.data.contacts ?? []).map((c) => [c.wa_id, c.profile?.name ?? null]));
      for (const m of v.data.messages ?? []) {
        events.push({
          kind: 'message', providerNumberId: number, key: `msg:${m.id}`, from: m.from, profileName: names.get(m.from) ?? null,
          providerMessageId: m.id, occurredAt: new Date(Number(m.timestamp) * 1000), type: m.type,
          body: m.type === 'text' ? (m.text?.body ?? '') : null, referral: m.referral ?? null, raw: m,
        });
      }
      for (const s of v.data.statuses ?? []) {
        const code = s.errors?.[0]?.code;
        events.push({
          kind: 'status', providerNumberId: number, key: `st:${s.id}:${s.status}`, providerMessageId: s.id, status: s.status,
          occurredAt: new Date(Number(s.timestamp) * 1000), errorCode: code === undefined ? null : String(code), raw: s,
        });
      }
    }
  }
  return { events, skipped };
}

/** Delivery states only move forward; `failed` is final. A late "sent" never overwrites "read". */
export const STATUS_RANK: Record<string, number> = { queued: 0, sent: 1, delivered: 2, read: 3, failed: 4 };

/**
 * Opt-out and opt-in keywords (FR-108). Exact whole-message matches only, so ordinary sentences containing these words
 * never change consent. English and Arabic.
 */
const OPT_OUT = new Set(['stop', 'unsubscribe', 'stop all', 'إيقاف', 'ايقاف', 'إلغاء الاشتراك', 'الغاء الاشتراك', 'توقف']);
const OPT_IN = new Set(['start', 'subscribe', 'ابدأ', 'ابدا', 'اشتراك']);
export function consentKeyword(body: string | null): 'opt_out' | 'opt_in' | null {
  if (!body) return null;
  const t = body.trim().toLowerCase().replace(/\s+/g, ' ');
  if (OPT_OUT.has(t)) return 'opt_out';
  if (OPT_IN.has(t)) return 'opt_in';
  return null;
}
