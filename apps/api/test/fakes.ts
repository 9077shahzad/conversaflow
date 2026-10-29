/**
 * Local stand-ins for 360dialog and Stripe, for tests and the payment-to-message demonstration. They implement the
 * endpoints our adapters call (as documented by each provider), check the credentials sent, record every request and
 * can be scripted to fail. Nothing here contacts the real services.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';

export interface Recorded { method: string; path: string; headers: Record<string, string | string[] | undefined>; body: string }
type Step = 'ok' | { status: number; error?: { code?: number | string; message?: string } } | 'drop';

async function read(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}
function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}
async function listen(server: Server): Promise<string> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** 360dialog's WhatsApp API (waba-v2): messages, media, templates; one API key per number. */
export class Fake360dialog {
  readonly requests: Recorded[] = [];
  /** API keys that are valid, and the number each belongs to. */
  readonly keys = new Map<string, string>();
  /** Scripted outcomes for POST /messages (first in, first out); empty means success. */
  script: Step[] = [];
  readonly media = new Map<string, { data: Buffer; mime: string }>();
  readonly templates: Array<Record<string, unknown>> = [];
  private seq = 0;
  private server = createServer((req, res) => void this.handle(req, res));
  url = '';

  async start() { this.url = await listen(this.server); return this; }
  async stop() { await new Promise<void>((r) => this.server.close(() => r())); }
  sent() { return this.requests.filter((r) => r.method === 'POST' && r.path === '/messages').map((r) => ({ ...r, json: JSON.parse(r.body) as Record<string, unknown> })); }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const body = await read(req);
    const url = new URL(req.url ?? '/', 'http://x');
    this.requests.push({ method: req.method ?? 'GET', path: url.pathname, headers: req.headers, body });
    const key = req.headers['d360-api-key'];
    if (typeof key !== 'string' || !this.keys.has(key)) return json(res, 401, { error: { code: 0, message: 'Invalid API key' } });
    if (req.method === 'POST' && url.pathname === '/messages') {
      const step = this.script.shift() ?? 'ok';
      if (step === 'drop') { req.socket.destroy(); return; }
      if (typeof step === 'object') return json(res, step.status, { error: step.error ?? { code: step.status, message: 'scripted' } });
      return json(res, 200, { messaging_product: 'whatsapp', contacts: [{ wa_id: (JSON.parse(body) as { to: string }).to }], messages: [{ id: `wamid.d360.${++this.seq}.${randomUUID().slice(0, 8)}` }] });
    }
    if (req.method === 'POST' && url.pathname === '/media') return json(res, 200, { id: `media-${++this.seq}` });
    if (req.method === 'POST' && url.pathname === '/v1/configs/templates') {
      const t = JSON.parse(body) as Record<string, unknown>;
      const id = String(++this.seq + 5_000_000);
      this.templates.push({ ...t, id, status: 'submitted', quality_score: { score: 'UNKNOWN' } });
      return json(res, 200, { id, status: 'submitted', category: t.category });
    }
    if (req.method === 'GET' && url.pathname === '/v1/configs/templates') return json(res, 200, { count: this.templates.length, waba_templates: this.templates });
    if (req.method === 'GET' && url.pathname.startsWith('/whatsapp_business/attachments')) {
      const m = this.media.get(url.searchParams.get('mid') ?? '');
      if (!m) return json(res, 404, { error: { message: 'not found' } });
      res.writeHead(200, { 'content-type': m.mime }).end(m.data);
      return;
    }
    if (req.method === 'GET' && /^\/[A-Za-z0-9_.-]+$/.test(url.pathname)) {
      const id = url.pathname.slice(1);
      const m = this.media.get(id);
      if (!m) return json(res, 404, { error: { message: 'media not found' } });
      return json(res, 200, { url: `https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=${id}`, mime_type: m.mime, id });
    }
    return json(res, 404, { error: { message: 'unknown endpoint' } });
  }
}

/** Stripe's API in test mode: Checkout Sessions, PaymentIntents, Refunds. */
export class FakeStripe {
  readonly requests: Recorded[] = [];
  readonly sessions = new Map<string, Record<string, unknown>>();
  refundScript: Array<'succeeded' | 'failed' | 'pending'> = [];
  /** Refunds by id; a test may move a pending one on (Stripe finishing it later). */
  readonly refunds = new Map<string, Record<string, unknown>>();
  /** Payment intents created for automatic top-ups; a test moves their status on. */
  readonly intents = new Map<string, Record<string, unknown>>();
  private seq = 0;
  private server = createServer((req, res) => void this.handle(req, res));
  url = '';
  constructor(private readonly secretKey: string) {}

  async start() { this.url = await listen(this.server); return this; }
  async stop() { await new Promise<void>((r) => this.server.close(() => r())); }
  /** As if the customer paid at checkout: the session gets its payment. */
  pay(sessionId: string) {
    const s = this.sessions.get(sessionId)!;
    s.payment_intent = `pi_test_${++this.seq}`;
    s.payment_status = 'paid';
    s.status = 'complete';
    return s;
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const body = await read(req);
    const url = new URL(req.url ?? '/', 'http://x');
    this.requests.push({ method: req.method ?? 'GET', path: url.pathname + url.search, headers: req.headers, body });
    if (req.headers.authorization !== `Bearer ${this.secretKey}`) return json(res, 401, { error: { type: 'invalid_request_error', code: 'api_key_invalid' } });
    const form = Object.fromEntries(new URLSearchParams(body));
    if (req.method === 'POST' && url.pathname === '/v1/checkout/sessions') {
      const id = `cs_test_${++this.seq}${randomUUID().replace(/-/g, '').slice(0, 10)}`;
      const meta = { tenantId: form['metadata[tenantId]'], topupId: form['metadata[topupId]'], kind: form['metadata[kind]'] };
      const s = { id, object: 'checkout.session', mode: form.mode, url: `https://checkout.stripe.test/c/pay/${id}`, amount_total: Number(form['line_items[0][price_data][unit_amount]']),
        currency: form['line_items[0][price_data][currency]'], metadata: meta, payment_intent: null, payment_status: 'unpaid', status: 'open' };
      this.sessions.set(id, s);
      return json(res, 200, s);
    }
    if (req.method === 'GET' && url.pathname.startsWith('/v1/checkout/sessions/')) {
      const s = this.sessions.get(decodeURIComponent(url.pathname.split('/').pop()!));
      return s ? json(res, 200, s) : json(res, 404, { error: { type: 'invalid_request_error', code: 'resource_missing' } });
    }
    if (req.method === 'GET' && url.pathname === '/v1/checkout/sessions') {
      const pi = url.searchParams.get('payment_intent');
      return json(res, 200, { object: 'list', data: [...this.sessions.values()].filter((s) => s.payment_intent === pi) });
    }
    if (req.method === 'POST' && url.pathname === '/v1/refunds') {
      const status = this.refundScript.shift() ?? 'succeeded';
      const r = { id: `re_test_${++this.seq}`, object: 'refund', status, amount: Number(form.amount), payment_intent: form.payment_intent };
      this.refunds.set(r.id, r);
      return json(res, 200, r);
    }
    if (req.method === 'GET' && url.pathname.startsWith('/v1/refunds/')) {
      const r = this.refunds.get(decodeURIComponent(url.pathname.split('/').pop()!));
      return r ? json(res, 200, r) : json(res, 404, { error: { type: 'invalid_request_error', code: 'resource_missing' } });
    }
    if (req.method === 'POST' && url.pathname === '/v1/payment_intents') {
      const pi = { id: `pi_test_auto_${++this.seq}`, object: 'payment_intent', status: 'processing', amount: Number(form.amount), currency: form.currency,
        metadata: { tenantId: form['metadata[tenantId]'], topupId: form['metadata[topupId]'], kind: form['metadata[kind]'] } };
      this.intents.set(pi.id, pi);
      return json(res, 200, pi);
    }
    if (req.method === 'GET' && url.pathname.startsWith('/v1/payment_intents/')) {
      const pi = this.intents.get(decodeURIComponent(url.pathname.split('/').pop()!));
      return pi ? json(res, 200, pi) : json(res, 404, { error: { type: 'invalid_request_error', code: 'resource_missing' } });
    }
    return json(res, 404, { error: { type: 'invalid_request_error', code: 'unknown' } });
  }
}
