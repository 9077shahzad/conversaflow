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

export interface SendInput {
  providerNumberId: string;
  to: string;
  body: string;
  /**
   * Our message id, sent as Meta's `biz_opaque_callback_data`. Meta echoes it in status webhooks, so a send whose
   * outcome we did not learn (timeout, crash) can still be matched to its delivery status without re-sending it.
   */
  callbackData: string;
  /** Aborted when the sender gives up waiting (SEND_LIMITS.providerTimeoutMs); a real adapter must cancel the request. */
  signal?: AbortSignal;
}

export interface ChannelAdapter {
  readonly provider: Provider;
  /** Sends a free-form text inside the customer service window. Throws ChannelSendError when it does not succeed. */
  sendText(input: SendInput): Promise<SendResult>;
}

/**
 * How a send failed decides what may happen next:
 * - `rejected`: the provider definitely refused this message (e.g. invalid recipient). Never retried automatically.
 * - `not_accepted`: the provider definitely did not accept it, for a passing reason (e.g. rate limit). Safe to retry.
 * - `uncertain`: we cannot know whether it was accepted (timeout, connection lost after sending). Never retried
 *   automatically, because a retry could deliver it twice; a person decides.
 */
export type SendFailureKind = 'rejected' | 'not_accepted' | 'uncertain';

export class ChannelSendError extends Error {
  constructor(readonly code: string, message: string, readonly kind: SendFailureKind = 'rejected') { super(message); }
}

export type SandboxStep =
  | 'ok'
  | { reject: string }
  | { notAccepted: string }
  | { uncertain: string }
  /** The provider accepts the message, but the reply is lost on the way back (so we only know "uncertain"). */
  | { acceptedButLost: string }
  /** The provider takes this long to answer (to test the sender's timeout). */
  | { slowMs: number };

/** Local double: records what would have been sent. Tests read `sent`; nothing leaves the process. */
export class SandboxAdapter implements ChannelAdapter {
  readonly provider = 'sandbox' as const;
  readonly sent: Array<{ providerNumberId: string; to: string; body: string; providerMessageId: string; callbackData: string }> = [];
  /** Tests script the next outcomes; an empty script means success. */
  script: SandboxStep[] = [];
  /** Tests can fix the next provider message ids (to deliver a status before the send is recorded). */
  nextIds: string[] = [];

  async sendText(input: SendInput): Promise<SendResult> {
    const step = this.script.shift() ?? 'ok';
    if (typeof step === 'object' && 'slowMs' in step) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, step.slowMs);
        input.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')); });
      });
    }
    if (typeof step === 'object' && 'reject' in step) throw new ChannelSendError(step.reject, 'Sandbox provider refused the message.', 'rejected');
    if (typeof step === 'object' && 'notAccepted' in step) throw new ChannelSendError(step.notAccepted, 'Sandbox provider is busy; message not accepted.', 'not_accepted');
    if (typeof step === 'object' && 'uncertain' in step) throw new ChannelSendError(step.uncertain, 'No answer from the sandbox provider.', 'uncertain');
    const providerMessageId = this.nextIds.shift() ?? `wamid.sandbox.${randomUUID()}`;
    this.sent.push({ providerNumberId: input.providerNumberId, to: input.to, body: input.body, providerMessageId, callbackData: input.callbackData });
    if (typeof step === 'object' && 'acceptedButLost' in step) throw new ChannelSendError(step.acceptedButLost, 'The answer from the sandbox provider was lost.', 'uncertain');
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
  biz_opaque_callback_data: z.string().max(512).optional(),
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
      occurredAt: Date; errorCode: string | null; callbackData: string | null; raw: unknown };

/**
 * Provider timestamps are capped at the time we receive them, so a timestamp in the future can never keep the
 * 24-hour customer service window open or reorder a thread ahead of real messages.
 */
function providerTime(epoch: string, receivedAt: number): Date {
  return new Date(Math.min(Number(epoch) * 1000, receivedAt));
}

/** Splits one verified delivery into individual events. Malformed parts are skipped and counted, not fatal. */
export function parseWebhook(payload: unknown, receivedAt = Date.now()): { events: ParsedEvent[]; skipped: number } {
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
          providerMessageId: m.id, occurredAt: providerTime(m.timestamp, receivedAt), type: m.type,
          body: m.type === 'text' ? (m.text?.body ?? '') : null, referral: m.referral ?? null, raw: m,
        });
      }
      for (const s of v.data.statuses ?? []) {
        const code = s.errors?.[0]?.code;
        events.push({
          kind: 'status', providerNumberId: number, key: `st:${s.id}:${s.status}`, providerMessageId: s.id, status: s.status,
          occurredAt: providerTime(s.timestamp, receivedAt), errorCode: code === undefined ? null : String(code),
          callbackData: s.biz_opaque_callback_data ?? null, raw: s,
        });
      }
    }
  }
  return { events, skipped };
}

/** Delivery states only move forward; `failed` is final. A late "sent" never overwrites "read". */
export const STATUS_RANK: Record<string, number> = { queued: 0, submitting: 0, uncertain: 0, sent: 1, delivered: 2, read: 3, failed: 4 };

/**
 * Opt-out and opt-in commands (FR-108; owner decision 20 Oct 2026). A message counts only when, after removing
 * punctuation, emojis and symbols, it is exactly one of these commands. "STOP 🛑", "Stop!!" and "إيقاف 🙏" count;
 * "please stop the technician" does not. Arabic is compared after removing diacritics and tatweel and unifying the
 * forms of alef and yaa. A standalone "إلغاء" (cancel) is deliberately NOT an opt-out: customers use it to cancel
 * bookings.
 */
const OPT_OUT = ['stop', 'stop all', 'unsubscribe', 'إيقاف', 'أوقف', 'توقف', 'إلغاء الاشتراك', 'الغاء الاشتراك', 'وقف الرسائل'];
const OPT_IN = ['start', 'subscribe', 'ابدأ', 'اشتراك', 'تفعيل الرسائل'];

export function normaliseCommand(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/\p{Cf}/gu, '')                                   // invisible format marks: RLM/LRM/ALM, embeddings, ZWNJ, BOM (review S1)
    .toLowerCase()
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '')          // Arabic diacritics and tatweel
    .replace(/[\u0622\u0623\u0625\u0671]/g, '\u0627')     // آ أ إ ٱ → ا
    .replace(/\u0649/g, '\u064A')                           // ى → ي
    .replace(/\p{Extended_Pictographic}|\p{Emoji_Modifier}|\u200d|\ufe0f|\u20e3/gu, ' ')
    .replace(/[\p{P}\p{S}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
const OPT_OUT_SET = new Set(OPT_OUT.map(normaliseCommand));
const OPT_IN_SET = new Set(OPT_IN.map(normaliseCommand));

export function consentKeyword(body: string | null): 'opt_out' | 'opt_in' | null {
  if (!body || body.length > 60) return null;
  // Zero-width space and non-joiner are sometimes used as a word gap ("stop\u200Ball") and sometimes inside a word to
  // hide it ("ST\u200COP"). Both readings are tried; each must still match a whole command exactly (review S1 note).
  const candidates = [normaliseCommand(body), normaliseCommand(body.replace(/[\u200b\u200c]/g, ' '))];
  if (candidates.some((t) => OPT_OUT_SET.has(t))) return 'opt_out';
  if (candidates.some((t) => OPT_IN_SET.has(t))) return 'opt_in';
  return null;
}
