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

/** An approved template, sent by name and language with its positional parameters ({{1}}, {{2}} ...). */
export interface TemplateSendInput extends Omit<SendInput, 'body'> {
  templateName: string;
  language: string;
  params: string[];
}

/** A template submitted for review. Templates belong to the business account (Meta's WABA), not to a number. */
export interface TemplateSubmission {
  accountId: string;
  name: string;
  language: string;
  category: 'marketing' | 'utility' | 'authentication';
  headerText: string | null;
  bodyText: string;
  footerText: string | null;
  examples: string[];
}

export type MediaType = 'image' | 'audio' | 'video' | 'document' | 'sticker';

/** A stored, scanned file sent as a WhatsApp media message (with an optional caption). */
export interface MediaSendInput extends Omit<SendInput, 'body'> {
  mediaType: Exclude<MediaType, 'sticker'>;
  data: Buffer;
  contentType: string;
  filename: string;
  caption: string | null;
}

/** Downloads a customer's media by the provider's media id (Meta: GET /MEDIA_ID for a fresh URL, then GET the URL). */
export interface MediaFetchInput { providerNumberId: string; mediaId: string; signal?: AbortSignal }

export interface ProviderTemplate {
  providerTemplateId: string;
  name: string;
  language: string;
  status: TemplateStatus;
  category: 'marketing' | 'utility' | 'authentication';
  quality: 'unknown' | 'green' | 'yellow' | 'red';
  reason: string | null;
}
export type TemplateStatus = 'pending' | 'approved' | 'rejected' | 'paused' | 'disabled' | 'in_appeal' | 'archived' | 'deleted';

export interface ChannelAdapter {
  readonly provider: Provider;
  /** Sends a free-form text inside the customer service window. Throws ChannelSendError when it does not succeed. */
  sendText(input: SendInput): Promise<SendResult>;
  /** Sends an approved template (allowed outside the window). Same error contract as sendText. */
  sendTemplate(input: TemplateSendInput): Promise<SendResult>;
  /** Submits a template for review. Returns the provider's id; the decision arrives later by webhook. */
  submitTemplate(input: TemplateSubmission): Promise<{ providerTemplateId: string }>;
  /** Reads the account's templates as the provider currently sees them (recovery if a webhook was missed). */
  listTemplates(accountId: string): Promise<ProviderTemplate[]>;
  /**
   * Sends a media message. A real adapter uploads the file first (no customer-visible effect, safe to repeat) and then
   * sends; only the send step can be uncertain. Same error contract as sendText.
   */
  sendMedia(input: MediaSendInput): Promise<SendResult>;
  /** Downloads inbound media. Throws ChannelSendError: `rejected` (gone, e.g. expired) or `not_accepted` (try later). */
  fetchMedia(input: MediaFetchInput): Promise<{ data: Buffer; contentType: string }>;
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
  readonly sent: Array<{
    providerNumberId: string; to: string; body: string; providerMessageId: string; callbackData: string;
    template?: { name: string; language: string; params: string[] };
  }> = [];
  /** Templates "held by the provider", keyed by account id. Tests change their status to simulate review. */
  readonly templates = new Map<string, ProviderTemplate[]>();
  /** Customer media "held by the provider", keyed by media id. A missing id behaves like expired media. */
  readonly media = new Map<string, { data: Buffer; contentType: string }>();
  /** Scripted outcomes for media downloads ('ok', { reject }, { notAccepted }). */
  mediaScript: SandboxStep[] = [];
  /** Tests script the next outcomes; an empty script means success. */
  script: SandboxStep[] = [];
  /** Tests can fix the next provider message ids (to deliver a status before the send is recorded). */
  nextIds: string[] = [];

  async sendText(input: SendInput): Promise<SendResult> {
    return this.deliver(input, input.body);
  }

  async sendTemplate(input: TemplateSendInput): Promise<SendResult> {
    const known = [...this.templates.values()].flat().find((x) => x.name === input.templateName && x.language === input.language);
    if (known && known.status !== 'approved') throw new ChannelSendError('132015', 'Sandbox: template is not approved.', 'rejected');
    return this.deliver({ ...input, body: '' }, `[template ${input.templateName}] ${input.params.join(' | ')}`,
      { name: input.templateName, language: input.language, params: input.params });
  }

  async submitTemplate(input: TemplateSubmission): Promise<{ providerTemplateId: string }> {
    const step = this.script.shift() ?? 'ok';
    if (typeof step === 'object' && 'reject' in step) throw new ChannelSendError(step.reject, 'Sandbox provider refused the template.', 'rejected');
    if (typeof step === 'object' && ('notAccepted' in step || 'uncertain' in step || 'acceptedButLost' in step)) {
      throw new ChannelSendError('submit_unavailable', 'Sandbox provider is not available.', 'not_accepted');
    }
    const providerTemplateId = String(1_000_000_000 + Math.floor(Math.random() * 1_000_000_000));
    const list = this.templates.get(input.accountId) ?? [];
    list.push({ providerTemplateId, name: input.name, language: input.language, status: 'pending', category: input.category, quality: 'unknown', reason: null });
    this.templates.set(input.accountId, list);
    return { providerTemplateId };
  }

  async listTemplates(accountId: string): Promise<ProviderTemplate[]> {
    return (this.templates.get(accountId) ?? []).map((x) => ({ ...x }));
  }

  async sendMedia(input: MediaSendInput): Promise<SendResult> {
    return this.deliver({ ...input, body: '' }, `[${input.mediaType} ${input.filename} ${input.data.length} bytes]${input.caption ? ' ' + input.caption : ''}`);
  }

  async fetchMedia(input: MediaFetchInput): Promise<{ data: Buffer; contentType: string }> {
    const step = this.mediaScript.shift() ?? 'ok';
    if (typeof step === 'object' && 'reject' in step) throw new ChannelSendError(step.reject, 'Sandbox: media not available.', 'rejected');
    if (typeof step === 'object' && 'notAccepted' in step) throw new ChannelSendError(step.notAccepted, 'Sandbox: try again later.', 'not_accepted');
    const m = this.media.get(input.mediaId);
    if (!m) throw new ChannelSendError('media_not_found', 'Sandbox: media expired or unknown.', 'rejected');
    return { data: Buffer.from(m.data), contentType: m.contentType };
  }

  private async deliver(input: SendInput, body: string, template?: { name: string; language: string; params: string[] }): Promise<SendResult> {
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
    this.sent.push({ providerNumberId: input.providerNumberId, to: input.to, body, providerMessageId, callbackData: input.callbackData, ...(template ? { template } : {}) });
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
const MediaPart = z.object({
  id: z.string().min(1).max(200),
  mime_type: z.string().max(120).optional(),
  caption: z.string().max(1024).optional(),
  filename: z.string().max(255).optional(),
}).passthrough();
const MEDIA_TYPES: MediaType[] = ['image', 'audio', 'video', 'document', 'sticker'];
const StatusUpdate = z.object({
  id: z.string().min(1).max(200),
  status: z.enum(['sent', 'delivered', 'read', 'failed']),
  timestamp: epochSeconds,
  recipient_id: z.string().max(40).optional(),
  biz_opaque_callback_data: z.string().max(512).optional(),
  errors: z.array(z.object({ code: z.union([z.number(), z.string()]).optional(), title: z.string().optional() }).passthrough()).optional(),
  // Meta's pricing for this message (per-message pricing): whether it is billable and its category (message credits).
  pricing: z.object({ billable: z.boolean().optional(), category: z.string().max(40).optional(), type: z.string().max(40).optional() }).passthrough().optional(),
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
    time: z.number().int().optional(),
    changes: z.array(z.object({ field: z.string(), value: z.unknown() })).max(100),
  })).min(1).max(100),
});

const TemplateStatusValue = z.object({
  event: z.string().min(1).max(40),
  message_template_id: z.union([z.number(), z.string()]),
  message_template_name: z.string().max(512).optional(),
  message_template_language: z.string().max(20).optional(),
  reason: z.string().max(500).nullable().optional(),
}).passthrough();
const TemplateQualityValue = z.object({
  new_quality_score: z.string().max(20),
  message_template_id: z.union([z.number(), z.string()]),
}).passthrough();
const TemplateCategoryValue = z.object({
  new_category: z.string().max(40),
  previous_category: z.string().max(40).optional(),
  message_template_id: z.union([z.number(), z.string()]),
}).passthrough();

/**
 * Meta's template review events mapped to our states (Meta webhook reference message_template_status_update, read
 * 21 Oct 2026). Events that do not change whether the template may be sent (FLAGGED, LIMIT_EXCEEDED, LOCKED,
 * UNARCHIVED's follow-up) keep the current state and are shown as the last event.
 */
export const TEMPLATE_EVENT_STATUS: Record<string, TemplateStatus | null> = {
  APPROVED: 'approved', REINSTATED: 'approved', UNARCHIVED: null, PENDING: 'pending', REJECTED: 'rejected',
  IN_APPEAL: 'in_appeal', PAUSED: 'paused', DISABLED: 'disabled', ARCHIVED: 'archived', DELETED: 'deleted',
  PENDING_DELETION: 'deleted', FLAGGED: null, LIMIT_EXCEEDED: null, LOCKED: null,
};

export type TemplateChange =
  | { type: 'status'; event: string; reason: string | null }
  | { type: 'quality'; quality: 'unknown' | 'green' | 'yellow' | 'red' }
  | { type: 'category'; category: string; completed: boolean };

export type ParsedEvent =
  | { kind: 'template'; accountId: string; key: string; providerTemplateId: string; change: TemplateChange; occurredAt: Date; raw: unknown }
  | { kind: 'message'; providerNumberId: string; key: string; from: string; profileName: string | null; providerMessageId: string;
      occurredAt: Date; type: string; body: string | null; referral: Record<string, unknown> | null; raw: unknown;
      media: { type: MediaType; id: string; mime: string | null; filename: string | null } | null }
  | { kind: 'status'; providerNumberId: string; key: string; providerMessageId: string; status: 'sent' | 'delivered' | 'read' | 'failed';
      occurredAt: Date; errorCode: string | null; callbackData: string | null; raw: unknown;
      pricing: { billable: boolean | null; category: string | null; type: string | null } | null };

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
      if (change.field === 'message_template_status_update' || change.field === 'message_template_quality_update' || change.field === 'template_category_update') {
        const t = parseTemplateChange(change.field, change.value, entry.id, entry.time, receivedAt);
        if (t) events.push(t); else skipped++;
        continue;
      }
      if (change.field !== 'messages') { skipped++; continue; }
      const v = ChangeValue.safeParse(change.value);
      if (!v.success) { skipped++; continue; }
      const number = v.data.metadata.phone_number_id;
      const names = new Map((v.data.contacts ?? []).map((c) => [c.wa_id, c.profile?.name ?? null]));
      for (const m of v.data.messages ?? []) {
        const mediaType = MEDIA_TYPES.find((t) => t === m.type);
        const part = mediaType ? MediaPart.safeParse((m as Record<string, unknown>)[mediaType]) : null;
        const media = mediaType && part?.success
          ? { type: mediaType, id: part.data.id, mime: part.data.mime_type ?? null, filename: part.data.filename ?? null }
          : null;
        events.push({
          kind: 'message', providerNumberId: number, key: `msg:${m.id}`, from: m.from, profileName: names.get(m.from) ?? null,
          providerMessageId: m.id, occurredAt: providerTime(m.timestamp, receivedAt), type: m.type,
          body: m.type === 'text' ? (m.text?.body ?? '') : media && part?.success ? (part.data.caption ?? null) : null,
          referral: m.referral ?? null, raw: m, media,
        });
      }
      for (const s of v.data.statuses ?? []) {
        const code = s.errors?.[0]?.code;
        events.push({
          kind: 'status', providerNumberId: number, key: `st:${s.id}:${s.status}`, providerMessageId: s.id, status: s.status,
          occurredAt: providerTime(s.timestamp, receivedAt), errorCode: code === undefined ? null : String(code),
          callbackData: s.biz_opaque_callback_data ?? null, raw: s,
          pricing: s.pricing ? { billable: s.pricing.billable ?? null, category: s.pricing.category ?? null, type: s.pricing.type ?? null } : null,
        });
      }
    }
  }
  return { events, skipped };
}

function parseTemplateChange(field: string, value: unknown, accountId: string | undefined, time: number | undefined, receivedAt: number): ParsedEvent | null {
  if (!accountId || !/^[0-9A-Za-z_-]{3,64}$/.test(accountId)) return null;
  const occurredAt = new Date(Math.min((time ?? receivedAt / 1000) * 1000, receivedAt));
  const stamp = time ?? Math.floor(receivedAt / 1000);
  if (field === 'message_template_status_update') {
    const v = TemplateStatusValue.safeParse(value);
    if (!v.success) return null;
    const id = String(v.data.message_template_id);
    return { kind: 'template', accountId, key: `tpl:${id}:status:${v.data.event}:${stamp}`, providerTemplateId: id, occurredAt, raw: v.data,
      change: { type: 'status', event: v.data.event.toUpperCase(), reason: v.data.reason ?? null } };
  }
  if (field === 'message_template_quality_update') {
    const v = TemplateQualityValue.safeParse(value);
    if (!v.success) return null;
    const q = v.data.new_quality_score.toLowerCase();
    const quality = (['green', 'yellow', 'red'].includes(q) ? q : 'unknown') as 'unknown' | 'green' | 'yellow' | 'red';
    const id = String(v.data.message_template_id);
    return { kind: 'template', accountId, key: `tpl:${id}:quality:${quality}:${stamp}`, providerTemplateId: id, occurredAt, raw: v.data,
      change: { type: 'quality', quality } };
  }
  const v = TemplateCategoryValue.safeParse(value);
  if (!v.success) return null;
  const id = String(v.data.message_template_id);
  return { kind: 'template', accountId, key: `tpl:${id}:category:${v.data.new_category}:${v.data.previous_category === undefined ? 'announced' : 'completed'}:${stamp}`, providerTemplateId: id, occurredAt, raw: v.data,
    change: { type: 'category', category: v.data.new_category.toLowerCase(), completed: v.data.previous_category !== undefined } };
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
