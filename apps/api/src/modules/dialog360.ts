import { createHash, timingSafeEqual } from 'node:crypto';
import { decryptSecret, encryptSecret } from '../core/crypto';
import {
  ChannelSendError, type ChannelAdapter, type MediaFetchInput, type MediaSendInput, type ProviderTemplate, type SendInput, type SendResult,
  type TemplateSendInput, type TemplateStatus, type TemplateSubmission,
} from './channels';

/**
 * 360dialog (WhatsApp Solution Partner) adapter, for companies on the partner route (migration 0064).
 *
 * 360dialog hosts the WhatsApp Cloud API: requests use Meta's Cloud API body format, sent to 360dialog's address with
 * the number's own API key in the D360-API-KEY header (one key per number, issued by 360dialog at onboarding). Webhooks
 * arrive in Meta's format, so the existing parser applies; they are authenticated by a secret header we set when
 * registering the webhook (see webhookTokenOk).
 *
 * Status: written from 360dialog's published documentation (read 29 Oct 2026) and tested against a local stand-in
 * that implements the same endpoints. It has not yet been run against 360dialog itself (their sandbox or a live
 * number); that needs the owner's 360dialog account.
 *
 * Keys are stored sealed (AES-256-GCM); only this adapter, holding the sealing key, can read them.
 */
export const DIALOG360_DEFAULT_BASE = 'https://waba-v2.360dialog.io';

/** The sealing key for partner API keys, derived from the server secret so it is never the same key as other uses. */
export function partnerKeySealer(serverSecret: Buffer) {
  const key = createHash('sha256').update('cf-partner-channel-keys').update(serverSecret).digest();
  return { seal: (apiKey: string) => encryptSecret(key, apiKey), open: (sealed: string) => decryptSecret(key, sealed) };
}

/** Webhook authentication: the shared secret header must match exactly (constant-time comparison). */
export function webhookTokenOk(expected: string | undefined, given: string | undefined): boolean {
  if (!expected || !given) return false;
  const a = createHash('sha256').update(expected).digest();
  const b = createHash('sha256').update(given).digest();
  return timingSafeEqual(a, b) && expected.length === given.length;
}

const STATUS_MAP: Record<string, TemplateStatus> = {
  approved: 'approved', pending: 'pending', submitted: 'pending', rejected: 'rejected', paused: 'paused', disabled: 'disabled',
  in_appeal: 'in_appeal', archived: 'archived', deleted: 'deleted', pending_deletion: 'deleted',
};
const QUALITY_MAP: Record<string, ProviderTemplate['quality']> = { green: 'green', yellow: 'yellow', red: 'red', high: 'green', medium: 'yellow', low: 'red' };

export class Dialog360Adapter implements ChannelAdapter {
  readonly provider = 'dialog360' as const;
  private readonly sealer: ReturnType<typeof partnerKeySealer>;
  constructor(
    serverSecret: Buffer,
    private readonly baseUrl = DIALOG360_DEFAULT_BASE,
    private readonly fetcher: typeof fetch = fetch,
  ) { this.sealer = partnerKeySealer(serverSecret); }

  private key(sealed: string | null | undefined): string {
    if (!sealed) throw new ChannelSendError('partner_key_missing', 'This number has no 360dialog API key.', 'rejected');
    try { return this.sealer.open(sealed); } catch { throw new ChannelSendError('partner_key_unreadable', 'The stored 360dialog key cannot be read.', 'rejected'); }
  }

  /**
   * One request. Failures are classified for the sender: no response at all after the request may have left = uncertain
   * (never retried automatically); 429 and 5xx = not accepted (safe to retry); other 4xx = rejected.
   */
  private async call(path: string, sealed: string | null | undefined, init: { method?: string; json?: unknown; body?: FormData; headers?: Record<string, string>; signal?: AbortSignal }) {
    const headers: Record<string, string> = { 'D360-API-KEY': this.key(sealed), ...(init.headers ?? {}) };
    if (init.json !== undefined) headers['Content-Type'] = 'application/json';
    let res: Response;
    try {
      res = await this.fetcher(`${this.baseUrl}${path}`, { method: init.method ?? 'GET', headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body, signal: init.signal });
    } catch (err) {
      const sent = init.method === 'POST' && path === '/messages';
      throw new ChannelSendError(init.signal?.aborted ? 'provider_timeout' : 'partner_unreachable',
        `No answer from 360dialog: ${err instanceof Error ? err.message : 'network error'}`, sent ? 'uncertain' : 'not_accepted');
    }
    const text = await res.text();
    let body: unknown = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = null; }
    if (res.ok) return body as Record<string, unknown>;
    const err = (body as { error?: { code?: number | string; message?: string } } | null)?.error;
    const code = `d360_${res.status}${err?.code !== undefined ? `_${err.code}` : ''}`;
    const kind = res.status === 429 || res.status >= 500 ? 'not_accepted' : 'rejected';
    throw new ChannelSendError(code, `360dialog refused the request (${res.status}${err?.message ? `: ${err.message.slice(0, 200)}` : ''}).`, kind);
  }

  private async send(input: Omit<SendInput, 'body'>, message: Record<string, unknown>): Promise<SendResult> {
    const body = await this.call('/messages', input.credential, {
      method: 'POST', signal: input.signal,
      json: { messaging_product: 'whatsapp', recipient_type: 'individual', to: input.to, biz_opaque_callback_data: input.callbackData, ...message },
    });
    const id = (body as { messages?: Array<{ id?: string }> }).messages?.[0]?.id;
    // Accepted but without an id: it may be sent, and nothing can match it later except our callback reference.
    if (!id) throw new ChannelSendError('partner_no_message_id', '360dialog accepted the message without an id.', 'uncertain');
    return { providerMessageId: id };
  }

  sendText(input: SendInput): Promise<SendResult> {
    return this.send(input, { type: 'text', text: { preview_url: false, body: input.body } });
  }

  sendTemplate(input: TemplateSendInput): Promise<SendResult> {
    return this.send(input, {
      type: 'template',
      template: {
        name: input.templateName, language: { policy: 'deterministic', code: input.language },
        ...(input.params.length ? { components: [{ type: 'body', parameters: input.params.map((t) => ({ type: 'text', text: t })) }] } : {}),
      },
    });
  }

  /** Uploads the file (no customer-visible effect, safe to repeat), then sends it by media id. */
  async sendMedia(input: MediaSendInput): Promise<SendResult> {
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('file', new Blob([new Uint8Array(input.data)], { type: input.contentType }), input.filename);
    const up = await this.call('/media', input.credential, { method: 'POST', body: form, signal: input.signal });
    const mediaId = (up as { id?: string }).id;
    if (!mediaId) throw new ChannelSendError('partner_upload_failed', '360dialog did not return a media id.', 'not_accepted');
    const media: Record<string, unknown> = { id: mediaId };
    if (input.caption && input.mediaType !== 'audio') media.caption = input.caption;
    if (input.mediaType === 'document') media.filename = input.filename;
    return this.send(input, { type: input.mediaType, [input.mediaType]: media });
  }

  /**
   * Customer media: the media's URL is fetched through 360dialog (their documentation: replace Meta's lookaside host
   * with 360dialog's address and send the API key).
   */
  async fetchMedia(input: MediaFetchInput): Promise<{ data: Buffer; contentType: string }> {
    let meta: Record<string, unknown>;
    try {
      meta = await this.call(`/${encodeURIComponent(input.mediaId)}`, input.credential, { signal: input.signal });
    } catch (err) {
      if (err instanceof ChannelSendError && err.code.startsWith('d360_404')) throw new ChannelSendError('media_not_found', 'Media expired or unknown.', 'rejected');
      throw err;
    }
    const url = (meta as { url?: string }).url;
    if (!url) throw new ChannelSendError('media_not_found', 'Media expired or unknown.', 'rejected');
    const u = new URL(url);
    const path = `${u.pathname}${u.search}`;
    let res: Response;
    try {
      res = await this.fetcher(`${this.baseUrl}${path}`, { headers: { 'D360-API-KEY': this.key(input.credential) }, signal: input.signal });
    } catch {
      throw new ChannelSendError('partner_unreachable', 'No answer from 360dialog.', 'not_accepted');
    }
    if (res.status === 404) throw new ChannelSendError('media_not_found', 'Media expired or unknown.', 'rejected');
    if (!res.ok) throw new ChannelSendError(`d360_${res.status}`, 'Media download failed.', res.status >= 500 || res.status === 429 ? 'not_accepted' : 'rejected');
    return { data: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get('content-type') ?? (meta as { mime_type?: string }).mime_type ?? 'application/octet-stream' };
  }

  async submitTemplate(input: TemplateSubmission): Promise<{ providerTemplateId: string }> {
    const components: Array<Record<string, unknown>> = [];
    if (input.headerText) components.push({ type: 'HEADER', format: 'TEXT', text: input.headerText });
    components.push({ type: 'BODY', text: input.bodyText, ...(input.examples.length ? { example: { body_text: [input.examples] } } : {}) });
    if (input.footerText) components.push({ type: 'FOOTER', text: input.footerText });
    const r = await this.call('/v1/configs/templates', input.credential, {
      method: 'POST', json: { name: input.name, category: input.category.toUpperCase(), language: input.language, components },
    });
    const id = (r as { id?: string | number }).id;
    if (id === undefined) throw new ChannelSendError('partner_no_template_id', '360dialog did not return a template id.', 'not_accepted');
    return { providerTemplateId: String(id) };
  }

  async listTemplates(_accountId: string, credential?: string | null): Promise<ProviderTemplate[]> {
    const r = await this.call('/v1/configs/templates?limit=1000', credential, {});
    const list = ((r as { waba_templates?: unknown[] }).waba_templates ?? []) as Array<Record<string, unknown>>;
    return list.map((t) => ({
      providerTemplateId: String(t.id ?? t.external_id ?? ''),
      name: String(t.name ?? ''),
      language: String(t.language ?? ''),
      status: STATUS_MAP[String(t.status ?? '').toLowerCase()] ?? 'pending',
      category: (['marketing', 'utility', 'authentication'].includes(String(t.category ?? '').toLowerCase())
        ? String(t.category).toLowerCase() : 'utility') as ProviderTemplate['category'],
      quality: QUALITY_MAP[String((t.quality_score as { score?: string } | undefined)?.score ?? '').toLowerCase()] ?? 'unknown',
      reason: typeof t.rejected_reason === 'string' && t.rejected_reason !== 'NONE' ? t.rejected_reason : null,
    }));
  }
}
