import { createHmac, timingSafeEqual } from 'node:crypto';
import { AppError } from '../core/errors';
import type { PaymentEvent, PaymentProvider } from './credits';

/**
 * Stripe as the payment provider for message-credit top-ups, TEST MODE ONLY (owner instruction of 29 Oct 2026:
 * production payments stay off). Configuration accepts only Stripe test keys (sk_test_ / rk_test_), and production
 * refuses any credits provider.
 *
 * - Top-up: a Checkout Session for the amount, with our company and top-up ids in its metadata; credit is added only on
 *   Stripe's signed `checkout.session.completed` (paid) or `checkout.session.async_payment_succeeded` event.
 * - Failure: `checkout.session.async_payment_failed` and `checkout.session.expired`.
 * - Automatic top-up: an off-session PaymentIntent on the saved card; its outcome arrives by webhook.
 * - Refund: the Refunds API on the session's PaymentIntent, with our refund id as the idempotency key.
 * - Chargeback: `charge.dispute.closed` with status `lost`; the session is found through its PaymentIntent.
 * - Webhook signature: Stripe's scheme (HMAC-SHA256 of "timestamp.body" with the endpoint secret, 5-minute tolerance).
 *
 * Written from Stripe's API reference; tested against a local stand-in of the same endpoints. Not yet run against
 * Stripe's own test mode (needs the owner's Stripe account and test keys).
 */
const TOLERANCE_SECONDS = 300;

export function stripeSignature(secret: string, timestamp: number, raw: string): string {
  return `t=${timestamp},v1=${createHmac('sha256', secret).update(`${timestamp}.${raw}`).digest('hex')}`;
}

export class StripePaymentProvider implements PaymentProvider {
  readonly name = 'stripe';
  readonly testMode = true;
  readonly signatureHeader = 'stripe-signature';
  constructor(
    private readonly secretKey: string,
    private readonly webhookSecret: string,
    private readonly appOrigin: string,
    private readonly apiBase = 'https://api.stripe.com',
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => number = () => Date.now(),
  ) {
    if (!/^(sk|rk)_test_/.test(secretKey)) throw new Error('Stripe: only test-mode keys are accepted.');
  }

  private async api(method: 'GET' | 'POST', path: string, form?: Record<string, string | number>, idempotencyKey?: string) {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.secretKey}` };
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    let body: string | undefined;
    if (form) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(Object.entries(form).map(([k, v]): [string, string] => [k, String(v)])).toString();
    }
    const res = await this.fetcher(`${this.apiBase}${path}`, { method, headers, body });
    const json = await res.json().catch(() => ({})) as Record<string, unknown>;
    if (!res.ok) {
      const err = (json.error ?? {}) as { code?: string; message?: string; type?: string };
      throw new AppError(502, 'payment_provider_error', `Stripe refused the request: ${err.code ?? err.type ?? res.status}`, { status: res.status });
    }
    return json;
  }

  async createCheckout(i: { tenantId: string; topupId: string; amountMinor: number; currency: string; returnUrl: string }) {
    const s = await this.api('POST', '/v1/checkout/sessions', {
      mode: 'payment',
      'line_items[0][quantity]': 1,
      'line_items[0][price_data][currency]': i.currency.toLowerCase(),
      'line_items[0][price_data][unit_amount]': i.amountMinor,
      'line_items[0][price_data][product_data][name]': 'ConversaFlow prepaid message credit',
      client_reference_id: i.topupId,
      'metadata[tenantId]': i.tenantId, 'metadata[topupId]': i.topupId, 'metadata[kind]': 'manual',
      'payment_intent_data[metadata][tenantId]': i.tenantId, 'payment_intent_data[metadata][topupId]': i.topupId,
      'payment_intent_data[metadata][kind]': 'manual',
      success_url: `${i.returnUrl}?topup=${i.topupId}`, cancel_url: `${i.returnUrl}?topup=${i.topupId}&cancelled=1`,
    }, `checkout-${i.topupId}`);
    return { providerRef: String(s.id), checkoutUrl: String(s.url) };
  }

  /** methodRef is "customerId:paymentMethodId" saved from a card-saving checkout. The outcome arrives by webhook. */
  async chargeSaved(i: { tenantId: string; topupId: string; methodRef: string; amountMinor: number; currency: string; idempotencyKey: string }) {
    const [customer, method] = i.methodRef.split(':');
    if (!customer || !method) throw new AppError(409, 'payment_method_invalid', 'The saved card reference is not a Stripe customer and card.');
    const pi = await this.api('POST', '/v1/payment_intents', {
      amount: i.amountMinor, currency: i.currency.toLowerCase(), customer, payment_method: method, off_session: 'true', confirm: 'true',
      'metadata[tenantId]': i.tenantId, 'metadata[topupId]': i.topupId, 'metadata[kind]': 'auto',
    }, i.idempotencyKey);
    return { providerRef: String(pi.id), event: null };
  }

  async refund(i: { providerRef: string; amountMinor: number; idempotencyKey: string }) {
    // A checkout top-up is referenced by its session; the refund goes to the session's payment.
    let paymentIntent = i.providerRef;
    if (i.providerRef.startsWith('cs_')) {
      const s = await this.api('GET', `/v1/checkout/sessions/${encodeURIComponent(i.providerRef)}`);
      paymentIntent = String(s.payment_intent ?? '');
      if (!paymentIntent) throw new AppError(409, 'not_refundable', 'Stripe has no payment for this top-up.');
    }
    const r = await this.api('POST', '/v1/refunds', { payment_intent: paymentIntent, amount: i.amountMinor, 'metadata[refundId]': i.idempotencyKey }, `refund-${i.idempotencyKey}`);
    // 'pending' refunds complete without further action in the large majority of cases; 'failed' or 'canceled' did not.
    const status = r.status === 'failed' || r.status === 'canceled' ? 'failed' as const : 'succeeded' as const;
    return { refundRef: String(r.id), status };
  }

  async verifyEvent(raw: string, signature: string | undefined): Promise<PaymentEvent | null> {
    this.checkSignature(raw, signature);
    const ev = JSON.parse(raw) as { id: string; type: string; data: { object: Record<string, unknown> } };
    const o = ev.data?.object ?? {};
    const meta = (o.metadata ?? {}) as Record<string, string>;
    const base = (type: PaymentEvent['type'], providerRef: string, amount: number, currency: string, m: Record<string, string>, reason?: string): PaymentEvent | null =>
      m.tenantId && m.topupId ? { id: ev.id, type, providerRef, amountMinor: amount, currency: currency.toUpperCase(), tenantId: m.tenantId, topupId: m.topupId, ...(reason ? { reason } : {}) } : null;
    switch (ev.type) {
      case 'checkout.session.completed':
        if (o.mode !== 'payment' || o.payment_status !== 'paid') return null;   // asynchronous methods confirm later
        return base('payment.succeeded', String(o.id), Number(o.amount_total), String(o.currency), meta);
      case 'checkout.session.async_payment_succeeded':
        return base('payment.succeeded', String(o.id), Number(o.amount_total), String(o.currency), meta);
      case 'checkout.session.async_payment_failed':
        return base('payment.failed', String(o.id), Number(o.amount_total), String(o.currency), meta, 'payment_failed');
      case 'checkout.session.expired':
        return base('payment.failed', String(o.id), Number(o.amount_total), String(o.currency), meta, 'checkout_expired');
      case 'payment_intent.succeeded':
        return meta.kind === 'auto' ? base('payment.succeeded', String(o.id), Number(o.amount), String(o.currency), meta) : null;
      case 'payment_intent.payment_failed': {
        const reason = String(((o.last_payment_error ?? {}) as { code?: string }).code ?? 'payment_failed');
        return meta.kind === 'auto' ? base('payment.failed', String(o.id), Number(o.amount), String(o.currency), meta, reason) : null;
      }
      case 'charge.dispute.closed': {
        if (o.status !== 'lost') return null;
        const pi = String(o.payment_intent ?? '');
        if (!pi) return null;
        // Our top-up is referenced by the checkout session (manual) or the payment intent (automatic).
        const sessions = await this.api('GET', `/v1/checkout/sessions?payment_intent=${encodeURIComponent(pi)}&limit=1`);
        const s = ((sessions.data ?? []) as Array<Record<string, unknown>>)[0];
        if (s) return base('dispute.lost', String(s.id), Number(o.amount), String(o.currency), (s.metadata ?? {}) as Record<string, string>, String(o.reason ?? 'dispute lost'));
        const intent = await this.api('GET', `/v1/payment_intents/${encodeURIComponent(pi)}`);
        return base('dispute.lost', pi, Number(o.amount), String(o.currency), (intent.metadata ?? {}) as Record<string, string>, String(o.reason ?? 'dispute lost'));
      }
      default:
        return null;
    }
  }

  private checkSignature(raw: string, header: string | undefined) {
    const parts = Object.fromEntries((header ?? '').split(',').map((p) => p.trim().split('=') as [string, string]).filter((p) => p.length === 2));
    const t = Number(parts.t);
    const bad = () => new AppError(400, 'invalid_signature', 'The payment event signature is not valid.');
    if (!Number.isInteger(t) || !parts.v1 || !/^[0-9a-f]{64}$/.test(parts.v1)) throw bad();
    if (Math.abs(this.now() / 1000 - t) > TOLERANCE_SECONDS) throw bad();
    const want = createHmac('sha256', this.webhookSecret).update(`${t}.${raw}`).digest();
    const got = Buffer.from(parts.v1, 'hex');
    if (got.length !== want.length || !timingSafeEqual(got, want)) throw bad();
  }
}
