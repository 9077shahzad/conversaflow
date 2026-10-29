import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { withContext, type Db, type Tx } from '@conversaflow/database';
import { z } from 'zod';
import type { Deps, TenantActor } from '../core/context';
import { AppError, Errors } from '../core/errors';
import { parse } from '../core/validate';
import { AuditService } from './audit.service';
import { isUuid } from './members.service';
import { StripePaymentProvider } from './stripe';

/**
 * Prepaid WhatsApp message credits (owner decision of 29 Oct 2026; migration 0061).
 *
 * Companies onboarded through the Solution Partner arrangement hold a prepaid balance with ConversaFlow; each paid
 * WhatsApp message is charged to it at Meta's rate (through the partner) plus a margin. Companies without a credit
 * account are untouched: they keep paying Meta directly and nothing here runs for them.
 *
 * How a message is charged
 * - When a paid message is about to be sent (a marketing or authentication template, or a utility template outside
 *   the customer's 24-hour window), its expected price is RESERVED from the available balance (balance - reserved),
 *   under the account's row lock, so two sends at once can never spend the same money. Without enough credit the
 *   message is not sent ("insufficient_credit"). Free messages (replies in the 24-hour window) reserve nothing.
 * - Meta reports in the delivery status whether a message is billable and its category. A billable delivered (or read)
 *   message is CHARGED once (unique per message, whatever the number of webhooks); anything else RELEASES the
 *   reservation. A message that fails releases it; a reservation never settled is released after the configured hours.
 * - Prices come from versioned rate cards (currency, market from the recipient's number, category, effective date) and
 *   the company's margin; the reservation keeps the card it was priced with.
 * Top-ups are credited only from a verified payment-provider event whose amount, currency, company and payment
 * reference all match; each event is applied once. Refunds come from unused balance only.
 */
export const BILLABLE_CATEGORIES = ['marketing', 'utility', 'authentication'] as const;
export type Pricing = { billable: boolean | null; category: string | null; type: string | null };
/**
 * Meta's pricing from 1 October 2026 (developers.facebook.com, WhatsApp pricing and non-template messages pages, read
 * 29 Oct 2026): service messages (free-form replies) are charged per message at the utility rate after 1,000 free
 * service messages per business number per month; utility templates are charged inside the customer service window
 * too. Messages in a free entry point window (after a click-to-WhatsApp ad) stay free, and Meta's status webhook says so
 * (billable false), which releases any hold. The month is taken as the calendar month in UTC (to confirm with Meta).
 */
export const SERVICE_FREE_PER_MONTH = 1000;
const MIN_TOPUP: Record<string, number> = { SAR: 5000, AED: 5000, USD: 1500 };
const MAX_TOPUP = 10_000_000; // 100,000.00 in a two-decimal currency
export const AUTO_TOPUP_CONSENT = 'I authorise ConversaFlow to charge the saved card the amount below whenever our available message credit falls under the threshold, up to the daily limit, until I turn this off.';

/** Pricing as stored in a status payload (orphaned statuses applied later). */
export function pricingFrom(v: unknown): Pricing | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  return { billable: typeof o.billable === 'boolean' ? o.billable : null, category: typeof o.category === 'string' ? o.category.slice(0, 40) : null,
    type: typeof o.type === 'string' ? o.type.slice(0, 40) : null };
}

const price = (cost: number, marginBp: number) => Number((BigInt(cost) * BigInt(10_000 + marginBp) * 2n + 10_000n) / 20_000n);

/** The market of a number: the longest calling-code prefix on the card, or 'other'. */
export function marketFor(prefixes: Array<{ prefix: string; market: string }>, waNumber: string): string {
  const digits = waNumber.replace(/\D/g, '');
  let best: { prefix: string; market: string } | null = null;
  for (const p of prefixes) if (digits.startsWith(p.prefix) && (!best || p.prefix.length > best.prefix.length)) best = p;
  return best?.market ?? 'other';
}

type Account = { tenant_id: string; currency: string; balance_minor: string; reserved_minor: string; margin_bp: number | null; low_threshold_minor: string; low_alerted_at: Date | null };
/**
 * Prepaid credit applies only to companies on the partner route. The database already refuses an active account for any
 * other company (migrations 0064, 0065); this is checked again here so a fault there can never charge a company that
 * pays Meta directly (review of 0064, H1).
 */
export const ON_PARTNER_ROUTE = `EXISTS (SELECT 1 FROM messaging_routes r WHERE r.tenant_id = credit_accounts.tenant_id AND r.route = 'partner_360dialog')`;
async function lockAccount(tx: Tx): Promise<Account | null> {
  return (await tx.query<Account>(`SELECT tenant_id, currency, balance_minor, reserved_minor, margin_bp, low_threshold_minor, low_alerted_at
                                   FROM credit_accounts WHERE status = 'active' AND ${ON_PARTNER_ROUTE} FOR UPDATE`)).rows[0] ?? null;
}
/**
 * The rate for a number and category. `at` picks the card in force at that moment (default now); `cardId` uses that
 * exact card. Lines fall back to the market 'other' of the same card.
 */
async function rateFor(tx: Tx, currency: string, waNumber: string, category: string, opts: { at?: Date; cardId?: string } = {}) {
  const card = opts.cardId
    ? { id: opts.cardId }
    : (await tx.query<{ id: string }>(
        `SELECT id FROM credit_rate_cards WHERE currency = $1 AND effective_from <= coalesce($2::timestamptz, now()) ORDER BY effective_from DESC LIMIT 1`,
        [currency, opts.at ?? null])).rows[0];
  if (!card) return null;
  const prefixes = (await tx.query<{ prefix: string; market: string }>('SELECT prefix, market FROM credit_rate_markets WHERE card_id = $1', [card.id])).rows;
  const market = marketFor(prefixes, waNumber);
  // Service messages are priced like utility messages (Meta, from 1 Oct 2026) unless the card has its own service lines.
  const line = (await tx.query<{ market: string; unit_cost_minor: string }>(
    `SELECT market, unit_cost_minor FROM credit_rate_lines
     WHERE card_id = $1 AND market IN ($3, 'other') AND (category = $2 OR ($2 = 'service' AND category = 'utility'))
     ORDER BY (market = $3) DESC, (category = $2) DESC LIMIT 1`, [card.id, category, market])).rows[0];
  if (!line) return null;
  return { cardId: card.id, market: line.market, cost: Number(line.unit_cost_minor) };
}
/** Meta's pricing categories mapped to ours ('authentication_international' → authentication, 'marketing_lite' → marketing). */
export function categoryOf(metaCategory: string | null): (typeof BILLABLE_CATEGORIES)[number] | 'service' | null {
  if (!metaCategory) return null;
  const c = metaCategory.toLowerCase();
  if (c === 'service' || c.startsWith('service')) return 'service';
  for (const b of BILLABLE_CATEGORIES) if (c === b || c.startsWith(`${b}_`)) return b;
  return null;
}
async function marginOf(tx: Tx, a: Account) {
  return a.margin_bp ?? (await tx.query<{ m: number }>('SELECT default_margin_bp AS m FROM credit_settings')).rows[0]!.m;
}

/** Low-balance and empty notices: once each time the balance falls under the threshold, re-armed by a top-up. */
async function checkLowBalance(tx: Tx, tenantId: string) {
  const a = (await tx.query<{ available: string; threshold: string; alerted: Date | null }>(
    `SELECT balance_minor - reserved_minor AS available, low_threshold_minor AS threshold, low_alerted_at AS alerted FROM credit_accounts`)).rows[0];
  if (!a) return;
  const available = Number(a.available);
  if (available < Number(a.threshold) && !a.alerted) {
    await tx.query('UPDATE credit_accounts SET low_alerted_at = now()');
    await tx.query(`INSERT INTO credit_notices (tenant_id, kind, data) VALUES ($1, $2, $3)`,
      [tenantId, available <= 0 ? 'empty' : 'low_balance', JSON.stringify({ availableMinor: available, thresholdMinor: Number(a.threshold) })]);
  } else if (available >= Number(a.threshold) && a.alerted) {
    await tx.query('UPDATE credit_accounts SET low_alerted_at = NULL');
  }
}

// --- Used by the sender and by delivery statuses ---------------------------------------------------------------

/**
 * Called by the sender in the transaction that marks a message as being sent. Nothing for companies without an
 * account, and nothing for messages expected to be free.
 */
/** Service messages already handed to the provider on this number this calendar month (UTC), this one excluded. */
export async function serviceMessagesThisMonth(tx: Tx, connectionId: string, exceptMessageId: string | null): Promise<number> {
  return (await tx.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM messages m JOIN conversations c ON c.id = m.conversation_id
     WHERE c.connection_id = $1 AND m.direction = 'out' AND m.kind <> 'template' AND m.id IS DISTINCT FROM $2::uuid
       AND m.status IN ('submitting', 'sent', 'delivered', 'read', 'uncertain')
       AND m.created_at >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`, [connectionId, exceptMessageId])).rows[0]!.n;
}

/** Which price category a message would be charged in, if any. */
export function paidCategoryOf(kind: string, templateCategory: string | null): (typeof BILLABLE_CATEGORIES)[number] | 'service' | null {
  if (kind === 'template') return templateCategory && (BILLABLE_CATEGORIES as readonly string[]).includes(templateCategory) ? templateCategory as (typeof BILLABLE_CATEGORIES)[number] : null;
  return 'service';
}

/**
 * `mayBePaid` is the sender's decision, made once before it took any lock (review of 0064, M4): a free-form message it
 * judged free (within the number's monthly allowance) is not held, so no account lock is taken out of order. Several
 * sends at the same moment can therefore pass the 1,000th message together; Meta then charges a few replies we did not
 * hold for, and they are charged on delivery like any unreserved billable message (documented in design-and-tests.md).
 */
export async function reserveForSend(tx: Tx, a: { tenantId: string; messageId: string; kind: string; category: string | null; to: string; connectionId: string; mayBePaid: boolean }):
  Promise<'not_needed' | 'reserved' | 'insufficient_credit' | 'no_rate'> {
  const category = paidCategoryOf(a.kind, a.category);
  if (!category) return 'not_needed';
  if (category === 'service' && !a.mayBePaid) return 'not_needed';
  const acct = await lockAccount(tx);
  if (!acct) return 'not_needed';
  const existing = (await tx.query<{ state: string }>('SELECT state FROM credit_reservations WHERE message_id = $1', [a.messageId])).rows[0];
  if (existing && existing.state !== 'released') return 'reserved';
  const rate = await rateFor(tx, acct.currency, a.to, category);
  if (!rate) return 'no_rate';
  const margin = await marginOf(tx, acct);
  const amount = price(rate.cost, margin);
  if (Number(acct.balance_minor) - Number(acct.reserved_minor) < amount) {
    await checkLowBalance(tx, a.tenantId);
    return 'insufficient_credit';
  }
  if (existing) {
    // Sent again after its hold was given back (review M2): held again at today's price, under the same lock.
    await tx.query(`UPDATE credit_reservations SET state = 'held', settled_at = NULL, rate_card_id = $2, market = $3, category = $4, cost_minor = $5,
                      price_minor = $6, margin_bp = $7, created_at = now() WHERE message_id = $1 AND state = 'released'`,
      [a.messageId, rate.cardId, rate.market, category, rate.cost, amount, margin]);
  } else {
    await tx.query(`INSERT INTO credit_reservations (message_id, tenant_id, rate_card_id, market, category, cost_minor, price_minor, margin_bp)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [a.messageId, a.tenantId, rate.cardId, rate.market, category, rate.cost, amount, margin]);
  }
  if (amount > 0) {
    await tx.query(`INSERT INTO credit_entries (tenant_id, kind, amount_minor, reserved_delta, message_id, rate_card_id, market, category, cost_minor, margin_bp)
                    VALUES ($1, 'reserve', 0, $2, $3, $4, $5, $6, $7, $8)`, [a.tenantId, amount, a.messageId, rate.cardId, rate.market, category, rate.cost, margin]);
  }
  await checkLowBalance(tx, a.tenantId);
  return 'reserved';
}

/**
 * Takes the company's credit account lock, if it has an account. Every transaction that may write credit entries takes
 * it first, before any other row it locks (sender steps, incoming webhook groups, status re-application), so the lock
 * order is the same everywhere (review of 0061, M1). No-op for companies paying Meta directly.
 */
export async function lockCreditAccount(tx: Tx): Promise<void> {
  await tx.query(`SELECT 1 FROM credit_accounts WHERE status = 'active' FOR UPDATE`);
}

/** Gives back a held reservation (the message failed, was not sent, or turned out free). Safe to call repeatedly. */
export async function releaseReservation(tx: Tx, messageId: string, why: string) {
  // Nothing held (every free message): no lock taken at all (recheck N2).
  if (!(await tx.query(`SELECT 1 FROM credit_reservations WHERE message_id = $1 AND state = 'held'`, [messageId])).rowCount) return;
  if (!(await lockAccount(tx))) return;                                    // no open account: nothing to give back (L4)
  const r = (await tx.query<{ price_minor: string; tenant_id: string }>(
    `UPDATE credit_reservations SET state = 'released', settled_at = now() WHERE message_id = $1 AND state = 'held' RETURNING price_minor, tenant_id`, [messageId])).rows[0];
  if (!r) return;
  const tenantId = r.tenant_id;
  if (Number(r.price_minor) > 0) {
    await tx.query(`INSERT INTO credit_entries (tenant_id, kind, amount_minor, reserved_delta, message_id, note) VALUES ($1, 'release', 0, $2, $3, $4)`,
      [tenantId, -Number(r.price_minor), messageId, why.slice(0, 300)]);
  }
  await checkLowBalance(tx, tenantId);
}

/**
 * A delivery status with Meta's pricing. Billable and delivered (or read): charged once, also when the hold had already
 * been given back (a late delivery after the stale release or a failed status; review H1). Not billable: released.
 * A billable message nobody reserved for (for example a utility template Meta did charge) is still charged, so the
 * balance can go below zero; paid sends then stop until a top-up.
 */
export async function settleOnStatus(tx: Tx, tenantId: string, messageId: string, status: string, pricing: Pricing | null) {
  if (!(await tx.query('SELECT 1 FROM credit_accounts')).rowCount) return;
  if (status === 'failed') { await releaseReservation(tx, messageId, 'message_failed'); return; }
  if (!pricing || (status !== 'delivered' && status !== 'read' && status !== 'sent')) return;
  const mapped = categoryOf(pricing.category);
  if (pricing.billable === false || (pricing.type && pricing.type.startsWith('free'))) {
    await releaseReservation(tx, messageId, `free:${pricing.type ?? pricing.category ?? 'not_billable'}`);
    return;
  }
  if (pricing.billable !== true || status === 'sent') return;                  // Meta charges on delivery
  const acct = await lockAccount(tx);
  if (!acct) return;
  if ((await tx.query(`SELECT 1 FROM credit_entries WHERE message_id = $1 AND kind = 'charge'`, [messageId])).rowCount) return;
  const res = (await tx.query<{ rate_card_id: string; market: string; category: string; cost_minor: string; price_minor: string; margin_bp: number; state: string }>(
    'SELECT rate_card_id, market, category, cost_minor, price_minor, margin_bp, state FROM credit_reservations WHERE message_id = $1', [messageId])).rows[0];
  const kind = res ? null : (await tx.query<{ kind: string }>('SELECT kind FROM messages WHERE id = $1', [messageId])).rows[0]?.kind;
  const category = mapped ?? res?.category ?? (kind && kind !== 'template' ? 'service' : 'marketing');
  let charge: { cardId: string; market: string; cost: number; price: number; margin: number };
  if (res && res.category === category) {
    charge = { cardId: res.rate_card_id, market: res.market, cost: Number(res.cost_minor), price: Number(res.price_minor), margin: res.margin_bp };
  } else {
    // Another category than reserved, or never reserved: priced on the card it was reserved with, or the card in force
    // when the message was created (review M6), never today's card.
    const m = (await tx.query<{ wa: string | null; created_at: Date }>(
      `SELECT (SELECT value FROM contact_identifiers ci WHERE ci.contact_id = c.contact_id AND ci.kind = 'whatsapp' LIMIT 1) AS wa, m.created_at
       FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE m.id = $1`, [messageId])).rows[0];
    const rate = await rateFor(tx, acct.currency, m?.wa ?? '', category, res ? { cardId: res.rate_card_id } : { at: m?.created_at });
    if (!rate) { console.error('credits: no rate for a billable message', messageId, category); return; }
    const margin = res?.margin_bp ?? await marginOf(tx, acct);
    charge = { cardId: rate.cardId, market: rate.market, cost: rate.cost, price: price(rate.cost, margin), margin };
  }
  const held = res && res.state === 'held' ? Number(res.price_minor) : 0;
  await tx.query(`INSERT INTO credit_entries (tenant_id, kind, amount_minor, reserved_delta, message_id, rate_card_id, market, category, cost_minor, margin_bp)
                  VALUES ($1, 'charge', $2, $3, $4, $5, $6, $7, $8, $9)`,
    [tenantId, -charge.price, -held, messageId, charge.cardId, charge.market, category, charge.cost, charge.margin]);
  if (res) await tx.query(`UPDATE credit_reservations SET state = 'charged', settled_at = now() WHERE message_id = $1`, [messageId]);
  await checkLowBalance(tx, tenantId);
}

// --- Payment providers -----------------------------------------------------------------------------------------

export type PaymentEvent = { id: string; type: 'payment.succeeded' | 'payment.failed' | 'dispute.lost'; providerRef: string; amountMinor: number; currency: string;
  tenantId: string; topupId: string; reason?: string };
export interface PaymentProvider {
  readonly name: string;
  readonly testMode: boolean;
  createCheckout(input: { tenantId: string; topupId: string; amountMinor: number; currency: string; returnUrl: string }): Promise<{ providerRef: string; checkoutUrl: string }>;
  /** Merchant-initiated charge of a saved method (automatic top-up). Returns the provider's event for the outcome. */
  /**
   * Merchant-initiated charge of a saved method (automatic top-up). A provider that answers at once returns the signed
   * event for the outcome; one that reports later by webhook returns no event.
   */
  chargeSaved(input: { tenantId: string; topupId: string; methodRef: string; amountMinor: number; currency: string; idempotencyKey: string }): Promise<{ providerRef: string; event: { raw: string; signature: string } | null }>;
  /** 'pending': the provider accepted the refund but has not finished it (Stripe, some cards); asked again by refundStatus. */
  refund(input: { providerRef: string; amountMinor: number; idempotencyKey: string }): Promise<{ refundRef: string; status: 'succeeded' | 'failed' | 'pending' }>;
  /**
   * Looks a payment up directly with the provider (our own authenticated call, not a webhook), for recovery when its
   * notices never arrive. Null when the provider cannot say.
   */
  lookupPayment?(providerRef: string): Promise<{ status: 'succeeded' | 'failed' | 'pending'; amountMinor: number; currency: string; reason?: string } | null>;
  /** The current state of a refund the provider reported as pending (review of 0064, M6). */
  refundStatus?(refundRef: string): Promise<'succeeded' | 'failed' | 'pending'>;
  /** Verifies the signature and reads the event; null for events that need no action. May look things up with the provider. */
  verifyEvent(raw: string, signature: string | undefined): Promise<PaymentEvent | null>;
  /** The header that carries the signature. */
  readonly signatureHeader: string;
}

/**
 * The test provider: no money moves. Checkouts are completed by pressing "simulate" on the credits page (only where
 * this provider is configured, never in production). Events are signed exactly as a real provider's would be, so the
 * same verification and application code is exercised.
 */
export class TestPaymentProvider implements PaymentProvider {
  readonly name = 'test';
  readonly testMode = true;
  private readonly key: Buffer;
  constructor(secret: Buffer, private readonly appOrigin: string) { this.key = createHash('sha256').update('cf-credits-test-provider').update(secret).digest(); }
  sign(raw: string) { return createHmac('sha256', this.key).update(raw).digest('hex'); }
  event(e: Omit<PaymentEvent, 'id'> & { id?: string }) {
    const raw = JSON.stringify({ ...e, id: e.id ?? `evt_test_${randomUUID()}` });
    return { raw, signature: this.sign(raw) };
  }
  async createCheckout(i: { topupId: string }) {
    const ref = `pay_test_${i.topupId}`;
    return { providerRef: ref, checkoutUrl: `${this.appOrigin}/en/app/credits?testCheckout=${encodeURIComponent(ref)}` };
  }
  async chargeSaved(i: { tenantId: string; topupId: string; methodRef: string; amountMinor: number; currency: string }) {
    const ref = `pay_test_${i.topupId}`;
    const declined = i.methodRef.endsWith('0002');                            // the test card that always declines
    return { providerRef: ref, event: this.event({ type: declined ? 'payment.failed' : 'payment.succeeded', providerRef: ref, amountMinor: i.amountMinor,
      currency: i.currency, tenantId: i.tenantId, topupId: i.topupId, ...(declined ? { reason: 'card_declined' } : {}) }) };
  }
  /** Tests script refund outcomes: 'fail' (the provider refuses), 'throw' (no answer). Empty means success. */
  refundScript: Array<'ok' | 'fail' | 'throw'> = [];
  async refund(i: { idempotencyKey: string }) {
    const step = this.refundScript.shift() ?? 'ok';
    if (step === 'throw') throw new Error('test provider: no answer');
    return { refundRef: `re_test_${i.idempotencyKey}`, status: step === 'fail' ? 'failed' as const : 'succeeded' as const };
  }
  readonly signatureHeader = 'x-cf-payment-signature';
  async verifyEvent(raw: string, signature: string | undefined): Promise<PaymentEvent> {
    const want = Buffer.from(this.sign(raw), 'hex');
    const got = Buffer.from(signature ?? '', 'hex');
    if (got.length !== want.length || !timingSafeEqual(got, want)) throw new AppError(400, 'invalid_signature', 'The payment event signature is not valid.');
    return EventShape.parse(JSON.parse(raw));
  }
}
export function createPaymentProvider(kind: 'none' | 'test' | 'stripe', secret: Buffer, appOrigin: string,
  stripe?: { secretKey?: string; webhookSecret?: string; apiBase?: string }): PaymentProvider | null {
  if (kind === 'test') return new TestPaymentProvider(secret, appOrigin);
  if (kind === 'stripe' && stripe?.secretKey && stripe.webhookSecret) return new StripePaymentProvider(stripe.secretKey, stripe.webhookSecret, appOrigin, stripe.apiBase);
  return null;
}

const EventShape = z.object({
  id: z.string().min(1).max(200), type: z.enum(['payment.succeeded', 'payment.failed', 'dispute.lost']), providerRef: z.string().min(1).max(200),
  amountMinor: z.number().int().positive(), currency: z.string().regex(/^[A-Z]{3}$/), tenantId: z.string().uuid(), topupId: z.string().uuid(), reason: z.string().max(200).optional(),
});

/**
 * Applies a verified provider event to the company's top-up, once. Payment events must match the top-up's reference,
 * amount and currency exactly; a dispute may be for part of it. An event that does not match is not recorded, so the
 * provider's retry (once our reference is saved) is applied normally (review M4).
 */
export async function applyPaymentEvent(db: Db, provider: string, e: PaymentEvent, testMode = true): Promise<string> {
  return withContext(db, { tenantId: e.tenantId, userId: null }, async (tx) => {
    if (!(await lockAccount(tx))) return 'no_account';
    const t = (await tx.query<{ id: string; amount_minor: string; currency: string; status: string; provider_ref: string | null; kind: string; reversed_minor: string }>(
      'SELECT id, amount_minor, currency, status, provider_ref, kind, reversed_minor FROM credit_topups WHERE id = $1 AND provider = $2 FOR UPDATE', [e.topupId, provider])).rows[0];
    if (!t) return 'unknown_topup';
    const amountOk = e.type === 'dispute.lost' ? e.amountMinor <= Number(t.amount_minor) : e.amountMinor === Number(t.amount_minor);
    // The provider's reference is saved after its call returns, so its webhook can arrive first (an automatic top-up
    // with Stripe). The event names our top-up, company, amount and currency, all checked; its reference is then adopted
    // (review of 0064, H2).
    if (t.provider_ref === null && amountOk && t.currency === e.currency && e.type !== 'dispute.lost') {
      await tx.query('UPDATE credit_topups SET provider_ref = $2 WHERE id = $1 AND provider_ref IS NULL', [t.id, e.providerRef]);
      t.provider_ref = e.providerRef;
    }
    if (t.provider_ref !== e.providerRef || !amountOk || t.currency !== e.currency) return 'mismatch';
    const seen = await tx.query(`INSERT INTO credit_payment_events (tenant_id, provider, event_id, type, provider_ref, amount_minor, currency, outcome)
                                 VALUES ($1, $2, $3, $4, $5, $6, $7, 'received') ON CONFLICT (provider, event_id) DO NOTHING RETURNING id`,
      [e.tenantId, provider, e.id, e.type, e.providerRef, e.amountMinor, e.currency]);
    if (!seen.rowCount) return 'duplicate';
    const outcome = async (o: string) => { await tx.query('UPDATE credit_payment_events SET outcome = $3 WHERE provider = $1 AND event_id = $2', [provider, e.id, o]); return o; };
    if (e.type === 'payment.succeeded') {
      if (t.status === 'succeeded') return outcome('already_applied');
      // A payment reported failed (or given up on) and then confirmed is credited: the money was taken (review M3).
      await tx.query(`UPDATE credit_topups SET status = 'succeeded', failure_reason = NULL, settled_at = now(),
                        receipt_no = 'CR-' || CASE WHEN $2 THEN 'TEST-' ELSE '' END || to_char(now(), 'YYYY') || '-'
                                     || lpad(nextval('credit_receipt_seq')::text, 6, '0') WHERE id = $1`, [t.id, testMode]);
      await tx.query(`INSERT INTO credit_entries (tenant_id, kind, amount_minor, topup_id, note) VALUES ($1, 'topup', $2, $3, $4)`,
        [e.tenantId, e.amountMinor, t.id, t.kind === 'auto' ? 'automatic top-up' : t.status !== 'pending' ? `confirmed after ${t.status}` : null]);
      await checkLowBalance(tx, e.tenantId);
      await AuditService.record(tx, { tenantId: e.tenantId, actorUserId: null, action: 'credits.topup_succeeded', ip: undefined, targetType: 'credit_topup', targetId: t.id,
        metadata: { amountMinor: e.amountMinor, currency: e.currency, provider, kind: t.kind, previousStatus: t.status } });
      return outcome('applied');
    }
    if (e.type === 'payment.failed') {
      if (t.status !== 'pending') return outcome(`not_pending:${t.status}`);
      await tx.query(`UPDATE credit_topups SET status = 'failed', failure_reason = $2, settled_at = now() WHERE id = $1`, [t.id, (e.reason ?? 'payment_failed').slice(0, 200)]);
      await tx.query(`INSERT INTO credit_notices (tenant_id, kind, data) VALUES ($1, $2, $3)`,
        [e.tenantId, t.kind === 'auto' ? 'auto_topup_failed' : 'topup_failed', JSON.stringify({ topupId: t.id, amountMinor: e.amountMinor, reason: e.reason ?? null })]);
      return outcome('failed_recorded');
    }
    // dispute.lost: the bank took (part of) the payment back. What was already refunded is not taken twice; the rest is
    // taken back even below zero (review M3).
    // Only refunds that went through count (a pending one may still be refused, recheck N3); earlier disputes of the
    // same payment are counted by amount, so a second partial dispute applies too (N4).
    if (t.status !== 'succeeded') return outcome('nothing_to_reverse');
    const refundedOk = Number((await tx.query<{ s: string }>(`SELECT coalesce(sum(amount_minor), 0) AS s FROM credit_refunds WHERE topup_id = $1 AND status = 'succeeded'`, [t.id])).rows[0]!.s);
    const take = Math.min(e.amountMinor, Number(t.amount_minor) - refundedOk - Number(t.reversed_minor));
    if (take <= 0) return outcome('nothing_to_reverse');
    await tx.query('UPDATE credit_topups SET reversed = true, reversed_minor = reversed_minor + $2 WHERE id = $1', [t.id, take]);
    await tx.query(`INSERT INTO credit_entries (tenant_id, kind, amount_minor, topup_id, note) VALUES ($1, 'reversal', $2, $3, $4)`,
      [e.tenantId, -take, t.id, (e.reason ?? 'dispute lost').slice(0, 300)]);
    await tx.query(`INSERT INTO credit_notices (tenant_id, kind, data) VALUES ($1, 'reversal', $2)`, [e.tenantId, JSON.stringify({ topupId: t.id, amountMinor: take })]);
    await checkLowBalance(tx, e.tenantId);
    await AuditService.record(tx, { tenantId: e.tenantId, actorUserId: null, action: 'credits.topup_reversed', ip: undefined, targetType: 'credit_topup', targetId: t.id,
      metadata: { disputedMinor: e.amountMinor, reversedMinor: take } });
    return outcome('reversed');
  });
}

/**
 * Asks the provider for a pending refund (idempotent by the refund's id) and settles it: a credit note, or the amount
 * given back. No answer: it stays pending for the worker to try again. Returns the refund's status.
 */
export async function settleRefund(db: Db, provider: PaymentProvider, tenantId: string, refundId: string): Promise<string> {
  const r = await withContext(db, { tenantId, userId: null }, async (tx) => (await tx.query<{ status: string; amount_minor: string; provider_ref: string; topup_id: string; refund_ref: string | null }>(
    `SELECT f.status, f.amount_minor, t.provider_ref, f.topup_id, f.provider_ref AS refund_ref FROM credit_refunds f JOIN credit_topups t ON t.id = f.topup_id WHERE f.id = $1`, [refundId])).rows[0]);
  if (!r || r.status !== 'pending') return r?.status ?? 'unknown';
  let answer: { refundRef: string; status: 'succeeded' | 'failed' | 'pending' };
  try {
    // Already accepted by the provider and still in progress: ask for its state rather than asking again (an idempotent
    // repeat would only replay the first answer).
    answer = r.refund_ref && provider.refundStatus
      ? { refundRef: r.refund_ref, status: await provider.refundStatus(r.refund_ref) }
      : await provider.refund({ providerRef: r.provider_ref, amountMinor: Number(r.amount_minor), idempotencyKey: refundId });
  } catch (err) {
    console.error('refund: no answer from the provider; the worker will try again', refundId, err instanceof Error ? err.message : err);
    // Counted; after 30 attempts the worker stops and a person is told (recheck N6). The money stays out of the balance:
    // whether it reached the customer must be checked with the provider.
    await withContext(db, { tenantId, userId: null }, async (tx) => {
      const n = (await tx.query<{ attempts: number }>(`UPDATE credit_refunds SET attempts = attempts + 1 WHERE id = $1 AND status = 'pending' RETURNING attempts`, [refundId])).rows[0]?.attempts;
      if (n === 30) {
        await tx.query(`INSERT INTO credit_notices (tenant_id, kind, data) VALUES ($1, 'refund_stuck', $2)`, [tenantId, JSON.stringify({ refundId, amountMinor: Number(r.amount_minor) })]);
        await AuditService.record(tx, { tenantId, actorUserId: null, action: 'credits.refund_stuck', ip: undefined, targetType: 'credit_refund', targetId: refundId, metadata: { attempts: n } });
      }
    });
    return 'pending';
  }
  return withContext(db, { tenantId, userId: null }, async (tx) => {
    await lockCreditAccount(tx);
    const still = (await tx.query(`SELECT 1 FROM credit_refunds WHERE id = $1 AND status = 'pending' FOR UPDATE`, [refundId])).rowCount;
    if (!still) return (await tx.query<{ status: string }>('SELECT status FROM credit_refunds WHERE id = $1', [refundId])).rows[0]!.status;
    if (answer.status === 'pending') {
      // Accepted, not finished: kept pending with the provider's reference; the worker asks again. The money stays out of
      // the balance until the provider confirms either way.
      // Counted only after three days, so the worker keeps asking for about three days and then tells a person
      // (refund_stuck), as for a refund that is never answered (recheck finding 5).
      const n = (await tx.query<{ attempts: number }>(`UPDATE credit_refunds SET provider_ref = $2,
          attempts = attempts + CASE WHEN created_at < now() - interval '3 days' THEN 1 ELSE 0 END WHERE id = $1 RETURNING attempts`, [refundId, answer.refundRef])).rows[0]!.attempts;
      if (n === 30) {
        await tx.query(`INSERT INTO credit_notices (tenant_id, kind, data) VALUES ($1, 'refund_stuck', $2)`, [tenantId, JSON.stringify({ refundId, amountMinor: Number(r.amount_minor) })]);
        await AuditService.record(tx, { tenantId, actorUserId: null, action: 'credits.refund_stuck', ip: undefined, targetType: 'credit_refund', targetId: refundId, metadata: { attempts: n, providerStatus: 'pending' } });
      }
      return 'pending';
    }
    if (answer.status === 'succeeded') {
      await tx.query(`UPDATE credit_refunds f SET status = 'succeeded', provider_ref = $2, settled_at = now(),
                        credit_note_no = 'CN-' || CASE WHEN $3 THEN 'TEST-' ELSE '' END
                                         || to_char(now(), 'YYYY') || '-' || lpad(nextval('credit_note_seq')::text, 6, '0') WHERE f.id = $1`, [refundId, answer.refundRef, provider.testMode]);
      await AuditService.record(tx, { tenantId, actorUserId: null, action: 'credits.refunded', ip: undefined, targetType: 'credit_refund', targetId: refundId, metadata: { amountMinor: Number(r.amount_minor) } });
      return 'succeeded';
    }
    await tx.query(`UPDATE credit_refunds SET status = 'failed', provider_ref = $2, settled_at = now() WHERE id = $1`, [refundId, answer.refundRef]);
    await tx.query('UPDATE credit_topups SET refunded_minor = refunded_minor - $2 WHERE id = $1', [r.topup_id, Number(r.amount_minor)]);
    await tx.query(`INSERT INTO credit_entries (tenant_id, kind, amount_minor, refund_id, note) VALUES ($1, 'refund_failed', $2, $3, 'the provider refused the refund')`,
      [tenantId, Number(r.amount_minor), refundId]);
    await tx.query(`INSERT INTO credit_notices (tenant_id, kind, data) VALUES ($1, 'refund_failed', $2)`, [tenantId, JSON.stringify({ refundId, amountMinor: Number(r.amount_minor) })]);
    await checkLowBalance(tx, tenantId);
    await AuditService.record(tx, { tenantId, actorUserId: null, action: 'credits.refund_failed', ip: undefined, targetType: 'credit_refund', targetId: refundId, metadata: { amountMinor: Number(r.amount_minor) } });
    return 'failed';
  });
}

// --- The company's own screens and actions ---------------------------------------------------------------------

const TopUpInput = z.object({ amountMinor: z.number().int().positive().max(MAX_TOPUP) }).strict();
const SettingsInput = z.object({ lowThresholdMinor: z.number().int().min(0).max(MAX_TOPUP) }).strict();
const AutoInput = z.discriminatedUnion('enabled', [
  z.object({ enabled: z.literal(false) }).strict(),
  z.object({ enabled: z.literal(true), thresholdMinor: z.number().int().min(0).max(MAX_TOPUP), amountMinor: z.number().int().positive().max(MAX_TOPUP),
    dailyLimitMinor: z.number().int().positive().max(MAX_TOPUP * 5), methodId: z.string().uuid(),
    consentVersion: z.number().int().min(1), consentLocale: z.enum(['en', 'ar']), consentText: z.string() }).strict(),
]);
const RefundInput = z.object({ topupId: z.string().uuid(), amountMinor: z.number().int().positive(), reason: z.string().trim().min(3).max(300) }).strict();

export class CreditsService {
  constructor(private readonly deps: Deps, private readonly provider: PaymentProvider | null) {}

  async account(actor: TenantActor) {
    return withContext(this.deps.db, actor, async (tx) => {
      const route = (await tx.query<{ route: string }>('SELECT route FROM messaging_routes')).rows[0]?.route ?? 'meta_direct';
      const a = (await tx.query<Account & { auto_enabled: boolean; auto_threshold_minor: string | null; auto_amount_minor: string | null; auto_daily_limit_minor: string | null;
        auto_method_id: string | null; opened_at: Date; auto_consent_version: number | null; auto_consent_locale: string | null }>(
        `SELECT * FROM credit_accounts WHERE status = 'active'`)).rows[0];
      if (!a) return { mode: 'meta_direct' as const, route, provider: null };
      // Automatic top-up wording: only versions approved after legal review can be accepted (owner instruction 6).
      const consent = (await tx.query<{ version: number; locale: string; text: string }>(
        `SELECT DISTINCT ON (locale) version, locale, text FROM credit_consent_texts WHERE status = 'approved' ORDER BY locale, version DESC`)).rows;
      const margin = await marginOf(tx, a);
      const methods = (await tx.query('SELECT id, label, created_at AS "createdAt" FROM credit_payment_methods WHERE removed_at IS NULL ORDER BY created_at')).rows;
      const notices = (await tx.query(`SELECT id, kind, data, created_at AS "createdAt", read_at AS "readAt" FROM credit_notices ORDER BY created_at DESC LIMIT 20`)).rows;
      return {
        mode: 'prepaid' as const, route, provider: this.provider ? { name: this.provider.name, testMode: this.provider.testMode } : null,
        currency: a.currency, balanceMinor: Number(a.balance_minor), reservedMinor: Number(a.reserved_minor), availableMinor: Number(a.balance_minor) - Number(a.reserved_minor),
        lowThresholdMinor: Number(a.low_threshold_minor), marginBp: margin, openedAt: a.opened_at,
        auto: { enabled: a.auto_enabled, thresholdMinor: a.auto_threshold_minor === null ? null : Number(a.auto_threshold_minor), amountMinor: a.auto_amount_minor === null ? null : Number(a.auto_amount_minor),
          dailyLimitMinor: a.auto_daily_limit_minor === null ? null : Number(a.auto_daily_limit_minor), methodId: a.auto_method_id,
          acceptedVersion: a.auto_consent_version, acceptedLocale: a.auto_consent_locale,
          available: consent.length > 0, wording: Object.fromEntries(consent.map((c) => [c.locale, { version: c.version, text: c.text }])) },
        methods, notices, minTopUpMinor: MIN_TOPUP[a.currency] ?? 1000,
      };
    });
  }

  entries(actor: TenantActor, q: { before?: string; limit?: string }) {
    const limit = Math.min(Math.max(Number(q.limit ?? 50) || 50, 1), 200);
    return withContext(this.deps.db, actor, async (tx) => (await tx.query(
      `SELECT id, kind, amount_minor::int AS "amountMinor", reserved_delta::int AS "reservedDelta", balance_after::int AS "balanceAfter", message_id AS "messageId",
              topup_id AS "topupId", refund_id AS "refundId", market, category, note, created_at AS "createdAt"
       FROM credit_entries WHERE ($1::timestamptz IS NULL OR created_at < $1) ORDER BY created_at DESC, id DESC LIMIT $2`,
      [q.before && !Number.isNaN(Date.parse(q.before)) ? q.before : null, limit])).rows);
  }

  topups(actor: TenantActor) {
    return withContext(this.deps.db, actor, async (tx) => (await tx.query(
      `SELECT id, amount_minor::int AS "amountMinor", currency, kind, status, failure_reason AS "failureReason", refunded_minor::int AS "refundedMinor", reversed,
              receipt_no AS "receiptNo", created_at AS "createdAt", settled_at AS "settledAt", provider
       FROM credit_topups ORDER BY created_at DESC LIMIT 100`)).rows);
  }

  /** Starts a top-up: a pending record and the provider's checkout. Nothing is credited until the provider confirms. */
  async startTopUp(actor: TenantActor, input: unknown) {
    const body = parse(TopUpInput, input);
    if (!this.provider) throw Errors.conflict('payments_unavailable', 'Online payments are not connected yet.');
    const t = await withContext(this.deps.db, actor, async (tx) => {
      // Locked, so a route change cannot close the account between this check and the pending top-up (recheck finding 1).
      const a = await lockAccount(tx);
      if (!a) throw Errors.conflict('no_credit_account', 'This company pays Meta directly; it has no message-credit balance.');
      if (body.amountMinor < (MIN_TOPUP[a.currency] ?? 1000)) throw Errors.badRequest('The amount is below the minimum top-up.');
      const pending = (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM credit_topups WHERE status = 'pending' AND created_at > now() - interval '1 hour'`)).rows[0]!.n;
      if (pending >= 5) throw Errors.conflict('too_many_pending', 'Finish or cancel the top-ups already started.');
      const id = (await tx.query<{ id: string }>(`INSERT INTO credit_topups (tenant_id, amount_minor, currency, kind, provider, created_by) VALUES ($1, $2, $3, 'manual', $4, $5) RETURNING id`,
        [actor.tenantId, body.amountMinor, a.currency, this.provider!.name, actor.userId])).rows[0]!.id;
      await AuditService.record(tx, { tenantId: actor.tenantId, actorUserId: actor.userId, action: 'credits.topup_started', ip: actor.ip, targetType: 'credit_topup', targetId: id,
        metadata: { amountMinor: body.amountMinor, currency: a.currency, provider: this.provider!.name } });
      return { id, currency: a.currency };
    });
    const c = await this.provider.createCheckout({ tenantId: actor.tenantId, topupId: t.id, amountMinor: body.amountMinor, currency: t.currency,
      returnUrl: `${this.deps.config.APP_ORIGIN}/en/app/credits` });
    await withContext(this.deps.db, actor, (tx) => tx.query('UPDATE credit_topups SET provider_ref = $2 WHERE id = $1 AND provider_ref IS NULL', [t.id, c.providerRef]));
    return { id: t.id, checkoutUrl: c.checkoutUrl, testMode: this.provider.testMode };
  }

  /** Test mode only: completes a test checkout as the provider would, through the same signed-event path. */
  async simulateCheckout(actor: TenantActor, topupId: string, outcome: 'succeeded' | 'failed') {
    if (!(this.provider instanceof TestPaymentProvider) || this.deps.config.NODE_ENV === 'production') throw Errors.notFound('Test checkout');
    if (!isUuid(topupId)) throw Errors.notFound('Top-up');
    const t = await withContext(this.deps.db, actor, async (tx) => (await tx.query<{ amount_minor: string; currency: string; provider_ref: string | null }>(
      `SELECT amount_minor, currency, provider_ref FROM credit_topups WHERE id = $1 AND status = 'pending'`, [topupId])).rows[0]);
    if (!t || !t.provider_ref) throw Errors.notFound('Top-up');
    const ev = this.provider.event({ type: outcome === 'succeeded' ? 'payment.succeeded' : 'payment.failed', providerRef: t.provider_ref, amountMinor: Number(t.amount_minor),
      currency: t.currency, tenantId: actor.tenantId, topupId, ...(outcome === 'failed' ? { reason: 'card_declined' } : {}) });
    return { outcome: await this.handleEvent(this.provider.name, ev.raw, ev.signature) };
  }

  signatureHeaderFor(providerName: string): string {
    return this.provider && this.provider.name === providerName ? this.provider.signatureHeader : 'x-cf-payment-signature';
  }

  /** The provider's webhook: signature verified, then applied once. */
  async handleEvent(providerName: string, raw: string, signature: string | undefined) {
    if (!this.provider || this.provider.name !== providerName) throw Errors.notFound('Payment provider');
    let e: PaymentEvent | null;
    try { e = await this.provider.verifyEvent(raw, signature); } catch (err) {
      if (err instanceof AppError) throw err;
      throw new AppError(400, 'invalid_event', 'The payment event could not be read.');
    }
    if (!e) return 'ignored';
    const outcome = await applyPaymentEvent(this.deps.db, this.provider.name, e, this.provider.testMode);
    // An event that cannot be applied will not become right if sent again (the reference is adopted when it arrives first,
    // review of 0064 H2). It is kept and raises a platform alert: the money may have been taken and a person refunds it
    // (recheck of 0065, finding 2).
    if (outcome === 'mismatch' || outcome === 'unknown_topup' || outcome === 'no_account') {
      await withContext(this.deps.db, { tenantId: null, userId: null }, (tx) => tx.query('SELECT credit_record_unmatched($1, $2, $3, $4, $5, $6, $7, $8, $9)',
        [this.provider!.name, e.id, e.type, outcome, e.tenantId, e.topupId, e.providerRef, e.amountMinor, e.currency]));
      console.error('credits: payment event not applied; recorded for a person to check', this.provider.name, e.id, outcome);
      return `unmatched:${outcome}`;
    }
    return outcome;
  }

  /** Test mode only: a saved test card for automatic top-up (…4242 succeeds, …0002 is always declined). */
  async addTestMethod(actor: TenantActor, input: unknown) {
    const body = parse(z.object({ last4: z.enum(['4242', '0002']) }).strict(), input);
    if (!(this.provider instanceof TestPaymentProvider) || this.deps.config.NODE_ENV === 'production') throw Errors.notFound('Test card');
    return withContext(this.deps.db, actor, async (tx) => {
      if (!(await tx.query(`SELECT 1 FROM credit_accounts`)).rowCount) throw Errors.conflict('no_credit_account', 'This company has no message-credit balance.');
      const id = (await tx.query<{ id: string }>(`INSERT INTO credit_payment_methods (tenant_id, provider, provider_ref, label, created_by) VALUES ($1, 'test', $2, $3, $4) RETURNING id`,
        [actor.tenantId, `pm_test_${body.last4}`, `Test card •••• ${body.last4}`, actor.userId])).rows[0]!.id;
      await AuditService.record(tx, { tenantId: actor.tenantId, actorUserId: actor.userId, action: 'credits.method_added', ip: actor.ip, targetType: 'credit_payment_method', targetId: id, metadata: { test: true } });
      return { id };
    });
  }

  async saveSettings(actor: TenantActor, input: unknown) {
    const body = parse(SettingsInput, input);
    return withContext(this.deps.db, actor, async (tx) => {
      if (!(await lockAccount(tx))) throw Errors.conflict('no_credit_account', 'This company has no message-credit balance.');
      await tx.query('UPDATE credit_accounts SET low_threshold_minor = $1, low_alerted_at = NULL', [body.lowThresholdMinor]);
      await checkLowBalance(tx, actor.tenantId);
      await AuditService.record(tx, { tenantId: actor.tenantId, actorUserId: actor.userId, action: 'credits.settings_changed', ip: actor.ip, targetType: 'tenant', targetId: actor.tenantId, metadata: body });
      return { ok: true };
    });
  }

  /** Automatic top-up: only with the exact consent wording, a saved method and limits; turning it off needs nothing. */
  async setAuto(actor: TenantActor, input: unknown) {
    const body = parse(AutoInput, input);
    return withContext(this.deps.db, actor, async (tx) => {
      const a = await lockAccount(tx);
      if (!a) throw Errors.conflict('no_credit_account', 'This company has no message-credit balance.');
      if (!body.enabled) {
        await tx.query(`UPDATE credit_accounts SET auto_enabled = false`);
      } else {
        const wording = (await tx.query<{ text: string; status: string }>('SELECT text, status FROM credit_consent_texts WHERE version = $1 AND locale = $2',
          [body.consentVersion, body.consentLocale])).rows[0];
        if (!wording || wording.status !== 'approved') {
          throw Errors.conflict('consent_not_approved', 'Automatic top-up is not available yet: its wording is awaiting legal review.');
        }
        if (body.consentText !== wording.text) throw Errors.badRequest('Agree to the automatic top-up wording exactly as shown.');
        if (body.amountMinor < (MIN_TOPUP[a.currency] ?? 1000)) throw Errors.badRequest('The amount is below the minimum top-up.');
        if (body.dailyLimitMinor < body.amountMinor) throw Errors.badRequest('The daily limit must be at least one top-up.');
        const m = (await tx.query(`SELECT 1 FROM credit_payment_methods WHERE id = $1 AND removed_at IS NULL`, [body.methodId])).rowCount;
        if (!m) throw Errors.badRequest('Choose a saved card.');
        await tx.query(`UPDATE credit_accounts SET auto_enabled = true, auto_threshold_minor = $1, auto_amount_minor = $2, auto_daily_limit_minor = $3, auto_method_id = $4,
                          auto_consent_at = now(), auto_consent_by = $5, auto_consent_text = $6, auto_consent_version = $7, auto_consent_locale = $8`,
          [body.thresholdMinor, body.amountMinor, body.dailyLimitMinor, body.methodId, actor.userId, body.consentText, body.consentVersion, body.consentLocale]);
      }
      await AuditService.record(tx, { tenantId: actor.tenantId, actorUserId: actor.userId, action: body.enabled ? 'credits.auto_topup_enabled' : 'credits.auto_topup_disabled', ip: actor.ip,
        targetType: 'tenant', targetId: actor.tenantId, metadata: body.enabled ? { thresholdMinor: body.thresholdMinor, amountMinor: body.amountMinor, dailyLimitMinor: body.dailyLimitMinor,
          consentVersion: body.consentVersion, consentLocale: body.consentLocale } : {} });
      return { enabled: body.enabled };
    });
  }

  /**
   * A refund of unused credit from one successful top-up, in two steps (review H2). Step 1, under the account lock: the
   * amount is taken out of the balance and the refund recorded as pending. Step 2, with no lock held: the provider is
   * asked, with the refund's id as its idempotency key. Step 3: settled (credit note) or, if the provider refused, the
   * amount is given back. A refund left pending (no answer, a crash) is settled by the worker with the same key.
   * Only cash credit can be refunded: credit given as an adjustment is not paid out (review L3).
   */
  async refund(actor: TenantActor, input: unknown) {
    const body = parse(RefundInput, input);
    const provider = this.provider;
    if (!provider) throw Errors.conflict('payments_unavailable', 'Online payments are not connected yet.');
    const id = await withContext(this.deps.db, actor, async (tx) => {
      const a = await lockAccount(tx);
      if (!a) throw Errors.conflict('no_credit_account', 'This company has no message-credit balance.');
      const t = (await tx.query<{ amount_minor: string; refunded_minor: string; status: string; reversed: boolean; provider: string }>(
        'SELECT amount_minor, refunded_minor, status, reversed, provider FROM credit_topups WHERE id = $1 FOR UPDATE', [body.topupId])).rows[0];
      if (!t || t.status !== 'succeeded' || t.reversed) throw Errors.conflict('not_refundable', 'Only a completed top-up can be refunded.');
      if (t.provider !== provider.name) throw Errors.conflict('not_refundable', 'This top-up was paid through another provider.');
      if (body.amountMinor > Number(t.amount_minor) - Number(t.refunded_minor)) throw Errors.badRequest('More than the unrefunded part of this top-up.');
      const cash = Number((await tx.query<{ c: string }>(
        `SELECT coalesce(sum(amount_minor) FILTER (WHERE kind IN ('topup', 'refund', 'refund_failed', 'reversal', 'charge')), 0) AS c FROM credit_entries`)).rows[0]!.c);
      if (body.amountMinor > Math.min(Number(a.balance_minor) - Number(a.reserved_minor), cash)) throw Errors.conflict('balance_in_use', 'Only unused credit can be refunded.');
      const refundId = (await tx.query<{ id: string }>(`INSERT INTO credit_refunds (tenant_id, topup_id, amount_minor, reason, requested_by) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [actor.tenantId, body.topupId, body.amountMinor, body.reason, actor.userId])).rows[0]!.id;
      await tx.query('UPDATE credit_topups SET refunded_minor = refunded_minor + $2 WHERE id = $1', [body.topupId, body.amountMinor]);
      await tx.query(`INSERT INTO credit_entries (tenant_id, kind, amount_minor, refund_id, note, created_by) VALUES ($1, 'refund', $2, $3, $4, $5)`,
        [actor.tenantId, -body.amountMinor, refundId, body.reason, actor.userId]);
      await checkLowBalance(tx, actor.tenantId);
      await AuditService.record(tx, { tenantId: actor.tenantId, actorUserId: actor.userId, action: 'credits.refund_requested', ip: actor.ip, targetType: 'credit_refund', targetId: refundId,
        metadata: { topupId: body.topupId, amountMinor: body.amountMinor, reason: body.reason } });
      return refundId;
    });
    return { id, status: await settleRefund(this.deps.db, provider, actor.tenantId, id) };
  }

  /** A receipt (top-up) or credit note (refund), with what a printed document needs. */
  async document(actor: TenantActor, id: string) {
    if (!isUuid(id)) throw Errors.notFound('Receipt');
    return withContext(this.deps.db, actor, async (tx) => {
      const company = (await tx.query<{ legal_name: string; country: string }>('SELECT legal_name, country FROM tenants WHERE id = $1', [actor.tenantId])).rows[0]!;
      const t = (await tx.query(`SELECT 'receipt' AS type, receipt_no AS number, amount_minor::int AS "amountMinor", currency, settled_at AS "date", kind, provider
                                  FROM credit_topups WHERE id = $1 AND status = 'succeeded'`, [id])).rows[0];
      const r = t ? null : (await tx.query(`SELECT 'credit_note' AS type, f.credit_note_no AS number, f.amount_minor::int AS "amountMinor", t.currency, f.settled_at AS "date",
                                                f.reason, t.receipt_no AS "forReceipt"
                                         FROM credit_refunds f JOIN credit_topups t ON t.id = f.topup_id WHERE f.id = $1 AND f.status = 'succeeded'`, [id])).rows[0];
      const doc = t ?? r;
      if (!doc) throw Errors.notFound('Receipt');
      const testMode = String((doc as { number?: string }).number ?? '').includes('-TEST-');
      return { ...doc, testMode, company: company.legal_name, issuer: 'MERONATIC SOLUTIONS GROUP, LLC',
        description: testMode ? 'TEST MODE: no money was taken. Not a receipt.' : 'Prepaid WhatsApp message credit (not a tax invoice; tax treatment pending legal review)' };
    });
  }

  /** The month's statement: opening and closing balance and the totals in between. */
  /** The month's statement, in the company's own time zone (review L7), balances read in ledger order (review M5). */
  async statement(actor: TenantActor, month: string) {
    const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
    if (!m) throw Errors.badRequest('Month as YYYY-MM.');
    return withContext(this.deps.db, actor, async (tx) => {
      const a = (await tx.query<{ currency: string }>('SELECT currency FROM credit_accounts')).rows[0];
      if (!a) throw Errors.conflict('no_credit_account', 'This company has no message-credit balance.');
      const tz = (await tx.query<{ timezone: string }>('SELECT timezone FROM tenants WHERE id = $1', [actor.tenantId])).rows[0]!.timezone;
      const r = (await tx.query<{ opening: string | null; closing: string | null; topups: string; charges: string; charge_count: number; refunds: string; reversals: string; adjustments: string }>(
        `WITH b AS (SELECT ($1::date)::timestamp AT TIME ZONE $2 AS s, ($1::date + interval '1 month')::timestamp AT TIME ZONE $2 AS e)
         SELECT (SELECT balance_after FROM credit_entries, b WHERE created_at < b.s ORDER BY seq DESC LIMIT 1) AS opening,
                (SELECT balance_after FROM credit_entries, b WHERE created_at < b.e ORDER BY seq DESC LIMIT 1) AS closing,
                coalesce(sum(amount_minor) FILTER (WHERE kind = 'topup'), 0) AS topups,
                coalesce(-sum(amount_minor) FILTER (WHERE kind = 'charge'), 0) AS charges, count(*) FILTER (WHERE kind = 'charge')::int AS charge_count,
                coalesce(-sum(amount_minor) FILTER (WHERE kind IN ('refund', 'refund_failed')), 0) AS refunds,
                coalesce(-sum(amount_minor) FILTER (WHERE kind = 'reversal'), 0) AS reversals,
                coalesce(sum(amount_minor) FILTER (WHERE kind = 'adjustment'), 0) AS adjustments
         FROM credit_entries, b WHERE created_at >= b.s AND created_at < b.e`, [`${month}-01`, tz])).rows[0]!;
      return { month, currency: a.currency, timezone: tz, openingMinor: Number(r.opening ?? 0), closingMinor: Number(r.closing ?? r.opening ?? 0),
        topupsMinor: Number(r.topups), chargesMinor: Number(r.charges), chargedMessages: r.charge_count, refundsMinor: Number(r.refunds),
        reversalsMinor: Number(r.reversals), adjustmentsMinor: Number(r.adjustments) };
    });
  }

  /** Removes a saved card; automatic top-up using it is turned off (review L9). */
  async removeMethod(actor: TenantActor, id: string) {
    if (!isUuid(id)) throw Errors.notFound('Card');
    return withContext(this.deps.db, actor, async (tx) => {
      await lockCreditAccount(tx);
      const r = await tx.query('UPDATE credit_payment_methods SET removed_at = now() WHERE id = $1 AND removed_at IS NULL', [id]);
      if (!r.rowCount) throw Errors.notFound('Card');
      await tx.query('UPDATE credit_accounts SET auto_enabled = false WHERE auto_method_id = $1 AND auto_enabled', [id]);
      await AuditService.record(tx, { tenantId: actor.tenantId, actorUserId: actor.userId, action: 'credits.method_removed', ip: actor.ip, targetType: 'credit_payment_method', targetId: id, metadata: {} });
      return { ok: true };
    });
  }

  markNoticesRead(actor: TenantActor) {
    return withContext(this.deps.db, actor, async (tx) => { await tx.query('UPDATE credit_notices SET read_at = now() WHERE read_at IS NULL'); return { ok: true }; });
  }

  /** For screens that send templates: whether this company is on prepaid credit and how much is available. */
  static async availability(tx: Tx) {
    const a = (await tx.query<{ available: string }>(`SELECT balance_minor - reserved_minor AS available FROM credit_accounts WHERE status = 'active'`)).rows[0];
    return a ? Number(a.available) : null;
  }
}

// --- Partner funding monitor (owner instruction 4) -----------------------------------------------------------------

/**
 * The partner's prepaid balance against what it must cover: Meta's cost per day of what prepaid companies send (the
 * higher of the 7- and 30-day averages), days of cover left, the buffer required (cover until a new top-up lands, with
 * a safety margin) and customers' unspent prepaid credit. Raises or clears platform alerts. Amounts are in the
 * partner's currency, minor units.
 */
export async function partnerFundingCheck(db: Db, partner = '360dialog') {
  const r = (await withContext(db, { tenantId: null, userId: null }, async (tx) =>
    (await tx.query<Record<string, unknown>>('SELECT * FROM partner_funding_check($1)', [partner])).rows[0]));
  if (!r) return null;
  const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return { partner: String(r.partner), currency: String(r.currency), balanceMinor: n(r.balance_minor), balanceObservedAt: r.balance_observed_at as Date | null,
    dailyCostMinor: n(r.daily_cost_minor), daysCover: n(r.days_cover), requiredBufferMinor: n(r.required_buffer_minor),
    customerLiabilityMinor: n(r.customer_liability_minor), openAlerts: (r.open_alerts as string[]) ?? [] };
}

// --- Worker: stale reservations and automatic top-ups ------------------------------------------------------------

export class CreditWorker {
  constructor(private readonly db: Db, private readonly provider: PaymentProvider | null) {}

  async releaseStale(limit = 200): Promise<number> {
    const due = await withContext(this.db, { tenantId: null, userId: null }, async (tx) =>
      (await tx.query<{ message_id: string; tenant_id: string }>('SELECT * FROM credit_reservations_stale($1)', [limit])).rows);
    let n = 0;
    for (const d of due) {
      try {
        const released = await withContext(this.db, { tenantId: d.tenant_id, userId: null }, async (tx) => {
          await lockCreditAccount(tx);
          // A message still waiting to be sent (held by a campaign limit, say) keeps its hold (review M2).
          const m = (await tx.query<{ status: string }>('SELECT status FROM messages WHERE id = $1', [d.message_id])).rows[0];
          if (m && (m.status === 'queued' || m.status === 'submitting')) return false;
          await releaseReservation(tx, d.message_id, 'not_billed_in_time');
          return true;
        });
        if (released) n++;
      } catch (err) { console.error('credit release failed', d.message_id, err instanceof Error ? err.message : err); }
    }
    return n;
  }

  /** Automatic top-ups for companies that turned them on: one at a time, within the daily limit. */
  async autoTopUps(limit = 100): Promise<number> {
    if (!this.provider) return 0;
    const due = await withContext(this.db, { tenantId: null, userId: null }, async (tx) =>
      (await tx.query<{ tenant_id: string }>('SELECT * FROM credit_auto_topup_due($1)', [limit])).rows);
    let n = 0;
    for (const d of due) {
      try {
        const t = await withContext(this.db, { tenantId: d.tenant_id, userId: null }, async (tx) => {
          const a = (await tx.query<{ currency: string; available: string; auto_enabled: boolean; auto_threshold_minor: string; auto_amount_minor: string; auto_daily_limit_minor: string; ref: string | null }>(
            `SELECT a.currency, a.balance_minor - a.reserved_minor AS available, a.auto_enabled, a.auto_threshold_minor, a.auto_amount_minor, a.auto_daily_limit_minor,
                    (SELECT provider_ref FROM credit_payment_methods m WHERE m.id = a.auto_method_id AND m.removed_at IS NULL) AS ref
             FROM credit_accounts a WHERE a.status = 'active' FOR UPDATE`)).rows[0];
          if (!a || !a.auto_enabled || !a.ref || Number(a.available) >= Number(a.auto_threshold_minor)) return null;
          if ((await tx.query(`SELECT 1 FROM credit_topups WHERE kind = 'auto' AND status = 'pending'`)).rowCount) return null;
          const today = (await tx.query<{ s: string }>(`SELECT coalesce(sum(amount_minor), 0) AS s FROM credit_topups WHERE kind = 'auto' AND status IN ('pending', 'succeeded')
                                                        AND created_at > now() - interval '24 hours'`)).rows[0]!.s;
          if (Number(today) + Number(a.auto_amount_minor) > Number(a.auto_daily_limit_minor)) return null;
          // The last automatic attempt failed: wait for a person (no retry loop on a declined card).
          const lastFailed = (await tx.query(`SELECT 1 FROM credit_topups WHERE kind = 'auto' AND status IN ('failed', 'cancelled') AND created_at > now() - interval '24 hours'`)).rowCount;
          if (lastFailed) return null;
          const id = (await tx.query<{ id: string }>(`INSERT INTO credit_topups (tenant_id, amount_minor, currency, kind, provider) VALUES ($1, $2, $3, 'auto', $4) RETURNING id`,
            [d.tenant_id, Number(a.auto_amount_minor), a.currency, this.provider!.name])).rows[0]!.id;
          return { id, amount: Number(a.auto_amount_minor), currency: a.currency, ref: a.ref };
        });
        if (!t) continue;
        const r = await this.provider.chargeSaved({ tenantId: d.tenant_id, topupId: t.id, methodRef: t.ref, amountMinor: t.amount, currency: t.currency, idempotencyKey: t.id });
        await withContext(this.db, { tenantId: d.tenant_id, userId: null }, (tx) => tx.query('UPDATE credit_topups SET provider_ref = $2 WHERE id = $1 AND provider_ref IS NULL', [t.id, r.providerRef]));
        if (r.event) {
          const e = await this.provider.verifyEvent(r.event.raw, r.event.signature);
          if (e) await applyPaymentEvent(this.db, this.provider.name, e, this.provider.testMode);
        }
        n++;
      } catch (err) { console.error('automatic top-up failed', d.tenant_id, err instanceof Error ? err.message : err); }
    }
    return n;
  }

  /** Refunds left pending (no answer from the provider, or a crash between the steps): asked again, same key. */
  async settlePendingRefunds(limit = 100): Promise<number> {
    if (!this.provider) return 0;
    const due = await withContext(this.db, { tenantId: null, userId: null }, async (tx) =>
      (await tx.query<{ refund_id: string; tenant_id: string }>('SELECT * FROM credit_refunds_pending($1)', [limit])).rows);
    let n = 0;
    for (const d of due) {
      try { if ((await settleRefund(this.db, this.provider, d.tenant_id, d.refund_id)) !== 'pending') n++; }
      catch (err) { console.error('refund settle failed', d.refund_id, err instanceof Error ? err.message : err); }
    }
    return n;
  }

  /**
   * Automatic top-ups never confirmed (a crash after recording, a lost answer) are closed as not confirmed, with a
   * notice, so automatic top-up is not blocked for good (review M4). A confirmation arriving later still credits it.
   */
  /**
   * Recovery when every webhook for a payment was lost and the provider has stopped retrying (owner instruction of
   * 29 Oct, point 2): pending top-ups are looked up with the provider at most every ten minutes and the answer is applied
   * through the same path as a webhook, so a payment is still credited exactly once whatever arrives later.
   */
  async recoverTopUps(limit = 100): Promise<number> {
    const provider = this.provider;
    if (!provider?.lookupPayment) return 0;
    const due = await withContext(this.db, { tenantId: null, userId: null }, async (tx) =>
      (await tx.query<{ topup_id: string; tenant_id: string }>('SELECT * FROM credit_topups_to_check($1, $2)', [provider.name, limit])).rows);
    let n = 0;
    for (const d of due) {
      try {
        const t = await withContext(this.db, { tenantId: d.tenant_id, userId: null }, async (tx) => (await tx.query<{ provider_ref: string; amount_minor: string; currency: string }>(
          `UPDATE credit_topups SET checked_at = now() WHERE id = $1 RETURNING provider_ref, amount_minor, currency`, [d.topup_id])).rows[0]);
        if (!t) continue;
        const found = await provider.lookupPayment(t.provider_ref);
        if (!found || found.status === 'pending') continue;
        const e: PaymentEvent = { id: `lookup:${t.provider_ref}:${found.status}`, type: found.status === 'succeeded' ? 'payment.succeeded' : 'payment.failed',
          providerRef: t.provider_ref, amountMinor: found.amountMinor, currency: found.currency, tenantId: d.tenant_id, topupId: d.topup_id,
          ...(found.reason ? { reason: found.reason } : {}) };
        const outcome = await applyPaymentEvent(this.db, provider.name, e, provider.testMode);
        if (outcome === 'mismatch' || outcome === 'unknown_topup' || outcome === 'no_account') {
          await withContext(this.db, { tenantId: null, userId: null }, (tx) => tx.query('SELECT credit_record_unmatched($1, $2, $3, $4, $5, $6, $7, $8, $9)',
            [provider.name, e.id, e.type, outcome, e.tenantId, e.topupId, e.providerRef, e.amountMinor, e.currency]));
          // Nothing more a lookup can do: stop looking; the alert brings it to a person.
          await withContext(this.db, { tenantId: d.tenant_id, userId: null }, (tx) => tx.query(`UPDATE credit_topups SET checked_at = 'infinity' WHERE id = $1`, [d.topup_id]));
        } else if (outcome === 'applied' || outcome === 'failed_recorded') n++;
      } catch (err) { console.error('top-up recovery failed', d.topup_id, err instanceof Error ? err.message : err); }
    }
    return n;
  }

  async closeStuckAutoTopUps(limit = 100): Promise<number> {
    const due = await withContext(this.db, { tenantId: null, userId: null }, async (tx) =>
      (await tx.query<{ topup_id: string; tenant_id: string }>('SELECT * FROM credit_auto_topups_stuck($1)', [limit])).rows);
    let n = 0;
    for (const d of due) {
      try {
        n += await withContext(this.db, { tenantId: d.tenant_id, userId: null }, async (tx) => {
          await lockCreditAccount(tx);
          const t = (await tx.query<{ amount_minor: string }>(`UPDATE credit_topups SET status = 'cancelled', failure_reason = 'not_confirmed', settled_at = now()
                                                               WHERE id = $1 AND status = 'pending' RETURNING amount_minor`, [d.topup_id])).rows[0];
          if (!t) return 0;
          await tx.query(`INSERT INTO credit_notices (tenant_id, kind, data) VALUES ($1, 'auto_topup_failed', $2)`,
            [d.tenant_id, JSON.stringify({ topupId: d.topup_id, amountMinor: Number(t.amount_minor), reason: 'not_confirmed' })]);
          return 1;
        });
      } catch (err) { console.error('stuck top-up close failed', d.topup_id, err instanceof Error ? err.message : err); }
    }
    return n;
  }
}
