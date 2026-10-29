/**
 * Partner route (360dialog), per-company routing, Stripe in test mode, partner funding, versioned consent wording and
 * the remaining low findings (migration 0064). 360dialog and Stripe are local stand-ins (test/fakes.ts): nothing
 * leaves the machine and no money moves.
 */
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withContext } from '@conversaflow/database';
import { loadConfig } from '../src/core/config';
import { Dialog360Adapter, partnerKeySealer } from '../src/modules/dialog360';
import { Sender } from '../src/modules/sender';
import { CreditWorker, SERVICE_FREE_PER_MONTH, partnerFundingCheck, settleRefund } from '../src/modules/credits';
import { PlatformService } from '../src/modules/platform.service';
import { StripePaymentProvider, stripeSignature } from '../src/modules/stripe';
import { Fake360dialog, FakeStripe } from './fakes';
import { activateSubscription, enableMfa, newCompany, newStaff, newUser, startApp, type Client, type TestApp } from './helpers';

const TOKEN = 'partner-webhook-token-' + 'x'.repeat(30);
const STRIPE_KEY = 'sk_test_' + 'a'.repeat(24);
const STRIPE_WHSEC = 'whsec_' + 'b'.repeat(24);
let t: TestApp;
let d360: Fake360dialog;
let stripe: FakeStripe;
let staff: Client;
let owner: Client;
let tenant: string;
let direct: Client;
let directTenant: string;
let connection: string;
const NUMBER = `${Date.now()}`.slice(-9) + '01';
const ACCOUNT = `waba${randomUUID().slice(0, 8)}`;
const API_KEY = `d360key_${randomUUID()}`;
let seq = 0;
const saudi = () => `96656${String(Math.floor(Math.random() * 1e6) + ++seq).padStart(7, '0')}`;
const http = () => request(t.app.getHttpServer());
const app = <T>(fn: Parameters<typeof withContext<T>>[2], tid = tenant) => withContext<T>(t.deps.db, { tenantId: tid, userId: null }, fn);
const hook = (payload: unknown, token = TOKEN) => http().post('/v1/webhooks/dialog360').set('Content-Type', 'application/json').set('X-CF-Partner-Token', token).send(JSON.stringify(payload));
const inbound = (wa: string, text: string) => hook({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: NUMBER },
  contacts: [{ wa_id: wa, profile: { name: 'Partner Customer' } }],
  messages: [{ from: wa, id: `wamid.in.${randomUUID()}`, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }] } }] }] });
const statusHook = (wamid: string, status: string, pricing?: Record<string, unknown>) => hook({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: {
  metadata: { phone_number_id: NUMBER }, statuses: [{ id: wamid, status, timestamp: String(Math.floor(Date.now() / 1000)), recipient_id: '1', ...(pricing ? { pricing } : {}),
    ...(status === 'failed' ? { errors: [{ code: 131026 }] } : {}) }] } }] }] });
const stripeHook = (event: Record<string, unknown>, opts: { secret?: string; at?: number } = {}) => {
  const raw = JSON.stringify(event);
  const sig = stripeSignature(opts.secret ?? STRIPE_WHSEC, opts.at ?? Math.floor(Date.now() / 1000), raw);
  return http().post('/v1/webhooks/credits/stripe').set('Content-Type', 'application/json').set('Stripe-Signature', sig).send(raw);
};
const account = async () => (await owner.get('/v1/credits').expect(200)).body;
const conv = async (wa: string) => (await app(async (tx) => (await tx.query<{ id: string }>(
  `SELECT c.id FROM conversations c JOIN contact_identifiers ci ON ci.contact_id = c.contact_id WHERE ci.value = $1 ORDER BY c.created_at DESC LIMIT 1`, [wa])).rows[0]!)).id;
const msg = (id: string) => app(async (tx) => (await tx.query<{ status: string; error_code: string | null; provider_message_id: string | null }>(
  'SELECT status, error_code, provider_message_id FROM messages WHERE id = $1', [id])).rows[0]!);
const reservation = (id: string) => app(async (tx) => (await tx.query<{ state: string; price_minor: string; category: string }>(
  'SELECT state, price_minor, category FROM credit_reservations WHERE message_id = $1', [id])).rows[0] ?? null);
/** Owner-role insert for set-up (the route table is readable to it only with row security relaxed, as for the table itself). */
const asOwnerQ = async (table: string, sql: string, params: unknown[]) => {
  await t.ownerDb.query(`ALTER TABLE ${table} NO FORCE ROW LEVEL SECURITY`);
  await t.ownerDb.query('ALTER TABLE messaging_routes NO FORCE ROW LEVEL SECURITY');
  try { return await t.ownerDb.query(sql, params); } finally {
    await t.ownerDb.query(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
    await t.ownerDb.query('ALTER TABLE messaging_routes FORCE ROW LEVEL SECURITY');
  }
};
async function reply(convId: string, text: string) {
  const c = (await owner.get(`/v1/conversations/${convId}`).expect(200)).body;
  return (await owner.post(`/v1/conversations/${convId}/reply`, { text, seenActivity: c.activitySeq, clientMessageId: randomUUID() }).expect(201)).body.id as string;
}

beforeAll(async () => {
  d360 = await new Fake360dialog().start();
  d360.keys.set(API_KEY, NUMBER);
  stripe = await new FakeStripe(STRIPE_KEY).start();
  t = await startApp({ DIALOG360_WEBHOOK_TOKEN: TOKEN, DIALOG360_BASE_URL: d360.url, CREDITS_PROVIDER: 'stripe', STRIPE_SECRET_KEY: STRIPE_KEY,
    STRIPE_WEBHOOK_SECRET: STRIPE_WHSEC, STRIPE_API_BASE: stripe.url });
  staff = await newStaff(t, 'pt-staff', 'platform_owner');
  owner = await newUser(t, 'pt-owner');
  tenant = await newCompany(owner, 'pt', 'business');
  await activateSubscription(t, tenant);
  await enableMfa(owner);
  direct = await newUser(t, 'pt-direct');
  directTenant = await newCompany(direct, 'ptdirect', 'business');
  await activateSubscription(t, directTenant);
  await enableMfa(direct);
});
afterAll(async () => { await t?.close(); await d360?.stop(); await stripe?.stop(); });

describe('one messaging and billing route per company', () => {
  it('existing companies stay on the direct route: no credit account, no partner number', async () => {
    expect((await direct.get('/v1/credits').expect(200)).body).toMatchObject({ mode: 'meta_direct', route: 'meta_direct' });
    expect((await staff.post(`/v1/platform/tenants/${directTenant}/credits/account`, { currency: 'SAR' })).status).toBe(409);
    expect((await staff.post(`/v1/platform/tenants/${directTenant}/partner-channels`, { providerNumberId: `${NUMBER}9`, displayPhone: '+966500000001', label: 'x',
      accountId: `${ACCOUNT}x`, apiKey: 'some-key-123' })).status).toBe(409);
    await owner.put(`/v1/platform/tenants/${tenant}/messaging-route`, { route: 'partner_360dialog', note: 'not staff' }).expect(403);
  });

  it('a company is put on the partner route, its number connected with a sealed key, and its credit opened', async () => {
    await staff.put(`/v1/platform/tenants/${tenant}/messaging-route`, { route: 'partner_360dialog', note: 'Pilot on the partner route' }).expect(200);
    connection = (await staff.post(`/v1/platform/tenants/${tenant}/partner-channels`, { providerNumberId: NUMBER, displayPhone: '+966500000077', label: 'Partner',
      accountId: ACCOUNT, apiKey: API_KEY }).expect(201)).body.id;
    const sealed = (await app(async (tx) => (await tx.query<{ sealed_key: string }>('SELECT sealed_key FROM partner_channel_keys WHERE connection_id = $1', [connection])).rows[0]!)).sealed_key;
    expect(sealed.startsWith('v1.')).toBe(true);
    expect(sealed).not.toContain(API_KEY);
    expect(partnerKeySealer(t.deps.keys.webhookSecrets).open(sealed)).toBe(API_KEY);
    await staff.post(`/v1/platform/tenants/${tenant}/credits/account`, { currency: 'SAR', lowThresholdMinor: 1000 }).expect(201);
    await staff.post('/v1/platform/credits/rate-cards', { currency: 'SAR', effectiveFrom: new Date(Date.now() + 500).toISOString(), source: 'Test fixture (not Meta prices)',
      markets: [{ prefix: '966', market: 'saudi_arabia' }],
      lines: [{ market: 'saudi_arabia', category: 'marketing', unitCostMinor: 25 }, { market: 'saudi_arabia', category: 'utility', unitCostMinor: 5 },
        { market: 'saudi_arabia', category: 'authentication', unitCostMinor: 5 }, { market: 'other', category: 'marketing', unitCostMinor: 50 },
        { market: 'other', category: 'utility', unitCostMinor: 10 }, { market: 'other', category: 'authentication', unitCostMinor: 10 }] }).expect(201);
    await new Promise((r) => setTimeout(r, 600));
    expect(await account()).toMatchObject({ mode: 'prepaid', route: 'partner_360dialog', provider: { name: 'stripe', testMode: true } });
  });

  it('the database refuses mixed routing: the same number twice, a direct number on the partner route, a partner number on the direct route', async () => {
    // Another partner company cannot take the same number.
    const other = await newUser(t, 'pt-other');
    const otherTenant = await newCompany(other, 'ptother', 'business');
    await staff.put(`/v1/platform/tenants/${otherTenant}/messaging-route`, { route: 'partner_360dialog', note: 'Second partner company' }).expect(200);
    expect((await staff.post(`/v1/platform/tenants/${otherTenant}/partner-channels`, { providerNumberId: NUMBER, displayPhone: '+966500000078', label: 'Dup',
      accountId: `${ACCOUNT}2`, apiKey: 'another-key-123' })).status).toBe(409);
    // A direct (Meta) connection on the partner route, or a partner connection on the direct route, is refused by the database.
    await expect(asOwnerQ('channel_connections', `INSERT INTO channel_connections (tenant_id, provider, provider_number_id, display_phone, label, ownership_verified_at, ownership_method)
      VALUES ($1, 'whatsapp_cloud', $2, '+1', 'x', now(), 'embedded_signup_v4')`, [tenant, `${NUMBER}7`])).rejects.toThrow(/messaging route/);
    await expect(asOwnerQ('channel_connections', `INSERT INTO channel_connections (tenant_id, provider, provider_number_id, display_phone, label, ownership_verified_at, ownership_method)
      VALUES ($1, 'dialog360', $2, '+1', 'x', now(), 'partner_embedded_signup')`, [directTenant, `${NUMBER}8`])).rejects.toThrow(/messaging route/);
    // The same number live on both routes: refused.
    const acct = (await asOwnerQ('provider_accounts', `INSERT INTO provider_accounts (tenant_id, provider, account_id) VALUES ($1, 'whatsapp_cloud', $2) RETURNING id`,
      [directTenant, `waba-direct-${seq}`])).rows[0].id;
    await expect(asOwnerQ('channel_connections', `INSERT INTO channel_connections (tenant_id, provider, provider_number_id, display_phone, label, ownership_verified_at, ownership_method, account_ref)
      VALUES ($1, 'whatsapp_cloud', $2, '+1000', 'x', now(), 'embedded_signup_v4', $3)`, [directTenant, NUMBER, acct])).rejects.toThrow(/one_live_route|duplicate/);
    // Switching back while the partner number is live, or while credit remains: refused.
    expect((await staff.put(`/v1/platform/tenants/${tenant}/messaging-route`, { route: 'meta_direct', note: 'Try to switch back' })).status).toBe(409);
  });
});

describe('sending and receiving through 360dialog (stand-in)', () => {
  let wa: string;
  it('webhooks need the secret header; inbound messages arrive in Meta format', async () => {
    wa = saudi();
    await inbound(wa, 'Hello').set('X-CF-Partner-Token', 'wrong').expect(401);
    await hook({ object: 'whatsapp_business_account', entry: [] }, 'nope').expect(401);
    await inbound(wa, 'Hello').expect(200);
    expect(await conv(wa)).toBeTruthy();
  });

  it('a reply goes to 360dialog with the number\'s key, Cloud API body and our callback reference; free within the monthly allowance', async () => {
    await topUp(10000);
    const id = await reply(await conv(wa), 'Thanks for your message');
    expect((await msg(id)).status).toBe('sent');
    const last = d360.sent().at(-1)!;
    expect(last.headers['d360-api-key']).toBe(API_KEY);
    expect(last.json).toMatchObject({ messaging_product: 'whatsapp', to: wa, type: 'text', text: { body: 'Thanks for your message' }, biz_opaque_callback_data: id });
    expect(await reservation(id)).toBeNull();
    // Meta reports it free (inside the 1,000 a month): nothing charged.
    await statusHook((await msg(id)).provider_message_id!, 'delivered', { billable: false, pricing_model: 'PMP', type: 'free_customer_service', category: 'service' }).expect(200);
    expect(await account()).toMatchObject({ reservedMinor: 0, balanceMinor: 10000 });
  });

  it('beyond the free monthly allowance a reply holds the utility price and is charged when Meta bills it', async () => {
    const c = await conv(wa);
    await app(async (tx) => {
      await tx.query(`INSERT INTO messages (tenant_id, conversation_id, direction, kind, body, client_message_id, occurred_at, status)
                      SELECT $1, $2, 'out', 'text', 'earlier', gen_random_uuid(), now(), 'delivered' FROM generate_series(1, $3)`, [tenant, c, SERVICE_FREE_PER_MONTH]);
    });
    const id = await reply(c, 'Your technician is on the way');
    expect(await reservation(id)).toMatchObject({ state: 'held', price_minor: '6', category: 'service' });
    await statusHook((await msg(id)).provider_message_id!, 'delivered', { billable: true, pricing_model: 'PMP', type: 'regular', category: 'service' }).expect(200);
    expect(await reservation(id)).toMatchObject({ state: 'charged' });
    expect((await account()).balanceMinor).toBe(10000 - 6);
    await app((tx) => tx.query(`DELETE FROM messages WHERE conversation_id = $1 AND body = 'earlier'`, [c]).catch(() => undefined));
  });

  it('templates are submitted through 360dialog and sent with their parameters; failures are classified for safe retry', async () => {
    const tpl = (await owner.post('/v1/templates', { name: 'partner_offer', language: 'en', category: 'marketing', bodyText: 'Hi {{1}}, our offer is open.', examples: ['Sara'] }).expect(201)).body;
    expect(d360.templates.at(-1)).toMatchObject({ name: 'partner_offer', category: 'MARKETING', language: 'en' });
    await hook({ object: 'whatsapp_business_account', entry: [{ id: ACCOUNT, time: Math.floor(Date.now() / 1000), changes: [{ field: 'message_template_status_update',
      value: { event: 'APPROVED', message_template_id: Number(tpl.providerTemplateId), message_template_name: 'partner_offer', message_template_language: 'en', reason: null } }] }] }).expect(200);
    const c = await conv(wa);
    await app(async (tx) => {
      await tx.query(`UPDATE conversations SET last_inbound_at = now() - interval '30 hours' WHERE id = $1`, [c]);
      await tx.query('UPDATE contacts SET marketing_consent_at = now() WHERE id = (SELECT contact_id FROM conversations WHERE id = $1)', [c]);
    });
    const send = async () => {
      const cv = (await owner.get(`/v1/conversations/${c}`).expect(200)).body;
      return (await owner.post(`/v1/conversations/${c}/template`, { templateId: tpl.id, params: ['Sara'], seenActivity: cv.activitySeq, clientMessageId: randomUUID() }).expect(201)).body.id as string;
    };
    const ok = await send();
    expect(d360.sent().at(-1)!.json).toMatchObject({ type: 'template', template: { name: 'partner_offer', language: { code: 'en' }, components: [{ type: 'body', parameters: [{ type: 'text', text: 'Sara' }] }] } });
    expect(await reservation(ok)).toMatchObject({ state: 'held', price_minor: '30' });
    // Rejected (400): failed, hold given back. Busy (503): kept for retry. No answer after sending: uncertain, never resent.
    d360.script.push({ status: 400, error: { code: 131026, message: 'Recipient not on WhatsApp' } });
    const rejected = await send();
    expect(await msg(rejected)).toMatchObject({ status: 'failed', error_code: 'd360_400_131026' });
    expect(await reservation(rejected)).toMatchObject({ state: 'released' });
    d360.script.push({ status: 503 });
    const busy = await send();
    expect((await msg(busy)).status).toBe('queued');
    expect(await reservation(busy)).toMatchObject({ state: 'held' });
    d360.script.push('drop');
    await app((tx) => tx.query(`UPDATE send_jobs SET next_attempt_at = now() WHERE message_id = $1`, [busy]));
    await new Sender(t.deps.db, t.deps.channels).dispatchDue(10);
    expect((await msg(busy)).status).toBe('uncertain');
    // Delayed and repeated delivery reports for the accepted one: charged once.
    const wamid = (await msg(ok)).provider_message_id!;
    for (let i = 0; i < 3; i++) await statusHook(wamid, 'delivered', { billable: true, pricing_model: 'PMP', type: 'regular', category: 'marketing' }).expect(200);
    expect((await app(async (tx) => (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM credit_entries WHERE message_id = $1 AND kind = 'charge'`, [ok])).rows[0]!.n))).toBe(1);
  });

  it('media: uploaded then sent by id; customer media fetched through 360dialog\'s address with the key', async () => {
    const adapter = t.deps.channels.dialog360 as Dialog360Adapter;
    const sealed = partnerKeySealer(t.deps.keys.webhookSecrets).seal(API_KEY);
    const r = await adapter.sendMedia({ providerNumberId: NUMBER, to: '966500000001', callbackData: randomUUID(), credential: sealed, mediaType: 'document',
      data: Buffer.from('%PDF-1.4 test'), contentType: 'application/pdf', filename: 'quote.pdf', caption: 'Your quote' });
    expect(r.providerMessageId).toMatch(/^wamid\.d360\./);
    expect(d360.requests.some((x) => x.path === '/media' && x.headers['content-type']?.toString().startsWith('multipart/form-data'))).toBe(true);
    expect(d360.sent().at(-1)!.json).toMatchObject({ type: 'document', document: { filename: 'quote.pdf', caption: 'Your quote' } });
    d360.media.set('m123', { data: Buffer.from('JPEGDATA'), mime: 'image/jpeg' });
    const got = await adapter.fetchMedia({ providerNumberId: NUMBER, mediaId: 'm123', credential: sealed });
    expect(got).toMatchObject({ contentType: 'image/jpeg' });
    expect(got.data.toString()).toBe('JPEGDATA');
    await expect(adapter.fetchMedia({ providerNumberId: NUMBER, mediaId: 'gone', credential: sealed })).rejects.toMatchObject({ code: 'media_not_found', kind: 'rejected' });
    await expect(adapter.sendText({ providerNumberId: NUMBER, to: '1', body: 'x', callbackData: 'y', credential: null })).rejects.toMatchObject({ code: 'partner_key_missing' });
  });
});

let topups = 0;
/** A Stripe test-mode top-up end to end: checkout created, customer pays, signed webhook credits the balance. */
async function topUp(amountMinor: number) {
  const r = (await owner.post('/v1/credits/topups', { amountMinor }).expect(201)).body;
  const session = [...stripe.sessions.values()].at(-1)!;
  stripe.pay(String(session.id));
  await stripeHook({ id: `evt_${++topups}_${randomUUID().slice(0, 6)}`, type: 'checkout.session.completed', data: { object: stripe.sessions.get(String(session.id)) } }).expect(200);
  return { topupId: r.id as string, sessionId: String(session.id) };
}

describe('Stripe in test mode (stand-in)', () => {
  it('a top-up creates a Checkout Session with our references; only Stripe\'s signed, matching event adds credit, once', async () => {
    const before = (await account()).balanceMinor;
    const r = (await owner.post('/v1/credits/topups', { amountMinor: 6000 }).expect(201)).body;
    expect(r.checkoutUrl).toMatch(/^https:\/\/checkout\.stripe\.test\//);
    const req = stripe.requests.filter((x) => x.path === '/v1/checkout/sessions').at(-1)!;
    expect(req.headers['idempotency-key']).toBe(`checkout-${r.id}`);
    const form = Object.fromEntries(new URLSearchParams(req.body));
    expect(form).toMatchObject({ mode: 'payment', 'line_items[0][price_data][currency]': 'sar', 'line_items[0][price_data][unit_amount]': '6000', 'metadata[topupId]': r.id, 'metadata[tenantId]': tenant });
    const session = [...stripe.sessions.values()].at(-1)!;
    stripe.pay(String(session.id));
    const event = { id: `evt_pay_${randomUUID().slice(0, 6)}`, type: 'checkout.session.completed', data: { object: session } };
    await stripeHook(event, { secret: 'whsec_wrongwrongwrong' }).expect(400);
    await stripeHook(event, { at: Math.floor(Date.now() / 1000) - 3600 }).expect(400);           // too old: replay refused
    expect((await stripeHook(event).expect(200)).body.outcome).toBe('applied');
    expect((await stripeHook(event).expect(200)).body.outcome).toBe('duplicate');
    expect((await stripeHook({ id: 'evt_other', type: 'customer.created', data: { object: {} } }).expect(200)).body.outcome).toBe('ignored');
    expect((await account()).balanceMinor).toBe(before + 6000);
    const top = (await owner.get('/v1/credits/topups').expect(200)).body.find((x: { id: string }) => x.id === r.id);
    expect(top.receiptNo).toMatch(/^CR-TEST-\d{4}-\d{6}$/);   // Stripe in test mode: documents are marked TEST
  });

  it('an expired checkout is a failed payment; a refund goes to the session\'s payment with our idempotency key; a lost dispute takes the credit back', async () => {
    const r = (await owner.post('/v1/credits/topups', { amountMinor: 5000 }).expect(201)).body;
    const s = [...stripe.sessions.values()].at(-1)!;
    expect((await stripeHook({ id: `evt_exp_${randomUUID().slice(0, 6)}`, type: 'checkout.session.expired', data: { object: s } }).expect(200)).body.outcome).toBe('failed_recorded');
    void r;
    const { topupId, sessionId } = await topUp(8000);
    const refund = (await owner.post('/v1/credits/refunds', { topupId, amountMinor: 1500, reason: 'Unused credit' }).expect(201)).body;
    expect(refund.status).toBe('succeeded');
    const rq = stripe.requests.filter((x) => x.path === '/v1/refunds').at(-1)!;
    expect(rq.headers['idempotency-key']).toBe(`refund-${refund.id}`);
    expect(Object.fromEntries(new URLSearchParams(rq.body))).toMatchObject({ payment_intent: stripe.sessions.get(sessionId)!.payment_intent, amount: '1500' });
    stripe.refundScript.push('failed');
    expect((await owner.post('/v1/credits/refunds', { topupId, amountMinor: 1000, reason: 'Refused at Stripe' }).expect(201)).body.status).toBe('failed');
    const before = (await account()).balanceMinor;
    const pi = String(stripe.sessions.get(sessionId)!.payment_intent);
    expect((await stripeHook({ id: `evt_dsp_${randomUUID().slice(0, 6)}`, type: 'charge.dispute.closed',
      data: { object: { id: 'dp_1', status: 'lost', payment_intent: pi, amount: 8000, currency: 'sar', reason: 'fraudulent' } } }).expect(200)).body.outcome).toBe('reversed');
    expect((await account()).balanceMinor).toBe(before - (8000 - 1500));     // the refunded part is not taken twice
  });

  it('only Stripe test keys are accepted, and production refuses any credits provider', () => {
    const base = { ...process.env, CREDITS_PROVIDER: 'stripe', STRIPE_WEBHOOK_SECRET: STRIPE_WHSEC };
    expect(() => loadConfig({ ...base, STRIPE_SECRET_KEY: 'sk_live_' + 'a'.repeat(24) })).toThrow(/TEST key/);
    const prod = { ...base, STRIPE_SECRET_KEY: STRIPE_KEY, NODE_ENV: 'production', SCANNER: 'clamd', SCANNER_REQUIRE_OFFICIAL_SIGNATURES: 'true', CHANNEL_SANDBOX_ENABLED: 'false',
      SMTP_URL: 'smtp://example.test', INBOUND_APPLY: 'worker' };
    expect(() => loadConfig(prod)).toThrow(/not approved yet/);
    expect(() => loadConfig({ ...prod, CREDITS_PROVIDER: 'none', DIALOG360_WEBHOOK_TOKEN: TOKEN })).toThrow(/partner route is not approved/);
  });
});

describe('partner funding is tracked apart from customer payments, with alerts', () => {
  it('the monitor computes cost per day, cover and the buffer, and raises and clears alerts', async () => {
    await staff.put('/v1/platform/partner/funding/settings', { lowBalanceMinor: 50000, minDaysCover: 14, topupLeadDays: 5, safetyBp: 5000 }).expect(200);
    await staff.post('/v1/platform/partner/funding', { what: 'entry', kind: 'funding', amountMinor: 100000, currency: 'USD', reference: `WIRE-${randomUUID().slice(0, 6)}` }).expect(201);
    await staff.post('/v1/platform/partner/funding', { what: 'balance', amountMinor: 1000, currency: 'USD' }).expect(201);
    let f = await partnerFundingCheck(t.deps.db);
    expect(f!.dailyCostMinor).toBeGreaterThanOrEqual(0);
    expect(f!.openAlerts).toEqual(expect.arrayContaining(['partner_balance_low', 'partner_below_buffer']));
    expect(f!.customerLiabilityMinor).toBeGreaterThan(0);                      // customers' unspent prepaid credit, in USD
    await staff.post('/v1/platform/partner/funding', { what: 'balance', amountMinor: 10_000_000, currency: 'USD' }).expect(201);
    f = await partnerFundingCheck(t.deps.db);
    expect(f!.openAlerts).not.toContain('partner_balance_low');
    expect(f!.openAlerts).not.toContain('partner_below_buffer');
    const o = (await staff.get('/v1/platform/partner/funding').expect(200)).body;
    expect(o.fundedMinor).toBeGreaterThanOrEqual(100000);
    expect(o.monitor).toMatchObject({ partner: '360dialog', currency: 'USD' });
    await owner.get('/v1/platform/partner/funding').expect(403);
  });
});

describe('automatic top-up wording, versioned (Arabic and English)', () => {
  it('nothing can be accepted until approved; the Arabic version is stored word for word with its version; retiring it turns automatic top-up off', async () => {
    const wording = (await staff.get('/v1/platform/credits/consent-wording').expect(200)).body as Array<{ version: number; locale: string; text: string; status: string }>;
    const ar = wording.find((w) => w.locale === 'ar' && w.version === 1)!;
    expect(ar.text).toMatch(/أفوّض ConversaFlow/);
    await app((tx) => tx.query(`INSERT INTO credit_payment_methods (tenant_id, provider, provider_ref, label) VALUES ($1, 'stripe', 'cus_1:pm_1', 'Visa •••• 4242')`, [tenant]));
    const methodId = (await account()).methods[0].id;
    const on = { enabled: true, thresholdMinor: 1000, amountMinor: 5000, dailyLimitMinor: 10000, methodId, consentVersion: 1, consentLocale: 'ar', consentText: ar.text };
    if (ar.status !== 'approved') {
      expect((await owner.put('/v1/credits/auto-topup', on).expect(409)).body.error.code).toBe('consent_not_approved');
      expect((await account()).auto.available).toBe(false);
      await staff.put('/v1/platform/credits/consent-wording/1/ar', { status: 'approved' }).expect(409);    // needs the legal reference
      await staff.put('/v1/platform/credits/consent-wording/1/ar', { status: 'approved', legalReference: 'Counsel memo (test)' }).expect(200);
    }
    await owner.put('/v1/credits/auto-topup', { ...on, consentText: ar.text + ' ' }).expect(400);
    await owner.put('/v1/credits/auto-topup', on).expect(200);
    const row = await app(async (tx) => (await tx.query<{ v: number; l: string; text: string }>('SELECT auto_consent_version AS v, auto_consent_locale AS l, auto_consent_text AS text FROM credit_accounts')).rows[0]!);
    expect(row).toEqual({ v: 1, l: 'ar', text: ar.text });
    await expect(t.ownerDb.query(`UPDATE credit_consent_texts SET text = 'changed' WHERE version = 1 AND locale = 'ar'`)).rejects.toThrow(/never changes/);
    const added = (await staff.post('/v1/platform/credits/consent-wording', { locale: 'ar', text: ar.text + ' (نسخة 2)' }).expect(201)).body;
    expect(added).toMatchObject({ version: 2, status: 'awaiting_legal_review' });
    await staff.put('/v1/platform/credits/consent-wording/1/ar', { status: 'retired' }).expect(200);
    expect((await account()).auto.enabled).toBe(false);
  });
});

describe('the database ties records together (review L6, L8)', () => {
  it('the application role cannot write a top-up entry without a paid top-up, or any adjustment', async () => {
    await expect(app((tx) => tx.query(`INSERT INTO credit_entries (tenant_id, kind, amount_minor, topup_id) VALUES ($1, 'topup', 99999, gen_random_uuid())`, [tenant])))
      .rejects.toThrow(/matching paid top-up/);
    await expect(app((tx) => tx.query(`INSERT INTO credit_entries (tenant_id, kind, amount_minor, note, created_by) VALUES ($1, 'adjustment', 99999, 'x', gen_random_uuid())`, [tenant])))
      .rejects.toThrow(/platform staff only/);
  });
  it('the partner\'s monthly figure must be in the company\'s credit currency', async () => {
    const month = new Date().toISOString().slice(0, 7);
    expect((await staff.put(`/v1/platform/tenants/${tenant}/credits/partner-cost`, { month, currency: 'USD', costMinor: 100, reference: 'INV-1' })).status).toBe(409);
    await staff.put(`/v1/platform/tenants/${tenant}/credits/partner-cost`, { month, currency: 'SAR', costMinor: 100, reference: 'INV-1' }).expect(200);
  });
});

describe('fixes from the review of 0064 (migration 0065)', () => {
  let other: Client;
  let otherTenant: string;
  const appOther = <T>(fn: Parameters<typeof withContext<T>>[2]) => app<T>(fn, otherTenant);
  beforeAll(async () => {
    other = await newUser(t, 'pt-rev');
    otherTenant = await newCompany(other, 'ptrev', 'business');
    await activateSubscription(t, otherTenant);
    await enableMfa(other);
  });

  it('H1, M2: a closed account cannot be made active on the direct route; a switch back waits for pending payments; a closed account can be reopened', async () => {
    await staff.put(`/v1/platform/tenants/${otherTenant}/messaging-route`, { route: 'partner_360dialog', note: 'Review test company' }).expect(200);
    await staff.post(`/v1/platform/tenants/${otherTenant}/credits/account`, { currency: 'SAR' }).expect(201);
    // A top-up in progress: the company cannot be moved back to the direct route until it finishes.
    await other.post('/v1/credits/topups', { amountMinor: 5000 }).expect(201);
    const sw = await staff.put(`/v1/platform/tenants/${otherTenant}/messaging-route`, { route: 'meta_direct', note: 'Back to direct' });
    expect([sw.status, sw.body.error?.message]).toEqual([409, expect.stringMatching(/in progress/)]);
    const session = [...stripe.sessions.values()].at(-1)!;
    await stripeHook({ id: `evt_rev_${randomUUID().slice(0, 6)}`, type: 'checkout.session.expired', data: { object: session } }).expect(200);
    await staff.put(`/v1/platform/tenants/${otherTenant}/messaging-route`, { route: 'meta_direct', note: 'Back to direct' }).expect(200);
    expect((await other.get('/v1/credits').expect(200)).body).toMatchObject({ route: 'meta_direct' });
    // The database refuses reactivating the closed account while the company pays Meta directly (the 0061 gap, H1).
    await expect(asOwnerQ('credit_accounts', `UPDATE credit_accounts SET status = 'active' WHERE tenant_id = $1`, [otherTenant])).rejects.toThrow(/partner route/);
    expect((await staff.post(`/v1/platform/tenants/${otherTenant}/credits/account`, { currency: 'SAR' })).status).toBe(409);
    // Back on the partner route, the same account is reopened (it could not be before), keeping its currency.
    await staff.put(`/v1/platform/tenants/${otherTenant}/messaging-route`, { route: 'partner_360dialog', note: 'Partner again' }).expect(200);
    expect((await staff.post(`/v1/platform/tenants/${otherTenant}/credits/account`, { currency: 'USD' })).status).toBe(409);
    await staff.post(`/v1/platform/tenants/${otherTenant}/credits/account`, { currency: 'SAR' }).expect(201);
    expect((await other.get('/v1/credits').expect(200)).body).toMatchObject({ mode: 'prepaid', route: 'partner_360dialog' });
    expect((await staff.post(`/v1/platform/tenants/${otherTenant}/credits/account`, { currency: 'SAR' })).status).toBe(409);
  });

  it('H2: an automatic top-up whose webhook arrives before our reference is saved is credited; an event we cannot apply is answered with an error so Stripe retries', async () => {
    const topupId = (await appOther(async (tx) => (await tx.query<{ id: string }>(
      `INSERT INTO credit_topups (tenant_id, amount_minor, currency, kind, provider) VALUES ($1, 4000, 'SAR', 'auto', 'stripe') RETURNING id`, [otherTenant])).rows[0]!)).id;
    const before = (await other.get('/v1/credits').expect(200)).body.balanceMinor;
    const pi = { id: `pi_test_early_${randomUUID().slice(0, 6)}`, object: 'payment_intent', amount: 4000, currency: 'sar', metadata: { tenantId: otherTenant, topupId, kind: 'auto' } };
    expect((await stripeHook({ id: `evt_early_${randomUUID().slice(0, 6)}`, type: 'payment_intent.succeeded', data: { object: pi } }).expect(200)).body.outcome).toBe('applied');
    expect((await other.get('/v1/credits').expect(200)).body.balanceMinor).toBe(before + 4000);
    expect((await appOther(async (tx) => (await tx.query<{ provider_ref: string }>('SELECT provider_ref FROM credit_topups WHERE id = $1', [topupId])).rows[0]!)).provider_ref).toBe(pi.id);
    // A top-up we do not know: not applied; kept with an alert for a person, since sending it again cannot help.
    const badId = `evt_bad_${randomUUID().slice(0, 6)}`;
    expect((await stripeHook({ id: badId, type: 'payment_intent.succeeded', data: { object: { ...pi, metadata: { ...pi.metadata, topupId: randomUUID() } } } }).expect(200)).body.outcome)
      .toBe('unmatched:unknown_topup');
    const unmatched = (await staff.get('/v1/platform/credits/unmatched-events').expect(200)).body as Array<{ eventId: string; reason: string; amountMinor: number }>;
    expect(unmatched.find((u) => u.eventId === badId)).toMatchObject({ reason: 'unknown_topup', amountMinor: 4000 });
    await other.get('/v1/platform/credits/unmatched-events').expect(403);
  });

  it('M6: a refund Stripe reports as pending stays pending, then is settled by asking Stripe for its state (not by refunding again)', async () => {
    const { topupId } = await topUp(7000);
    stripe.refundScript.push('pending');
    const before = (await account()).balanceMinor;
    const r = (await owner.post('/v1/credits/refunds', { topupId, amountMinor: 2000, reason: 'Unused credit' }).expect(201)).body;
    expect(r.status).toBe('pending');
    expect((await account()).balanceMinor).toBe(before - 2000);                 // taken out of the balance while it is in progress
    const ref = (await app(async (tx) => (await tx.query<{ provider_ref: string }>('SELECT provider_ref FROM credit_refunds WHERE id = $1', [r.id])).rows[0]!)).provider_ref;
    expect(ref).toMatch(/^re_test_/);
    const provider = new StripePaymentProvider(STRIPE_KEY, STRIPE_WHSEC, 'http://localhost', stripe.url);
    const posts = () => stripe.requests.filter((x) => x.method === 'POST' && x.path === '/v1/refunds').length;
    const n = posts();
    expect(await settleRefund(t.deps.db, provider, tenant, r.id)).toBe('pending');      // Stripe still processing
    stripe.refunds.get(ref)!.status = 'succeeded';
    expect(await settleRefund(t.deps.db, provider, tenant, r.id)).toBe('succeeded');
    expect(posts()).toBe(n);
    expect(stripe.requests.some((x) => x.method === 'GET' && x.path === `/v1/refunds/${ref}`)).toBe(true);
    expect((await account()).balanceMinor).toBe(before - 2000);
    // A refund Stripe keeps pending for more than three days is counted, and a person is told once the count runs out.
    stripe.refundScript.push('pending');
    const r2 = (await owner.post('/v1/credits/refunds', { topupId, amountMinor: 1000, reason: 'Unused credit' }).expect(201)).body;
    await t.ownerDb.query(`ALTER TABLE credit_refunds NO FORCE ROW LEVEL SECURITY`);
    try { await t.ownerDb.query(`UPDATE credit_refunds SET created_at = now() - interval '4 days', attempts = 29 WHERE id = $1`, [r2.id]); }
    finally { await t.ownerDb.query(`ALTER TABLE credit_refunds FORCE ROW LEVEL SECURITY`); }
    expect(await settleRefund(t.deps.db, provider, tenant, r2.id)).toBe('pending');
    expect((await app(async (tx) => (await tx.query(`SELECT 1 FROM credit_notices WHERE kind = 'refund_stuck' AND data->>'refundId' = $1`, [r2.id])).rowCount))).toBe(1);
  });

  it('Stripe: any one of several signatures is enough (secret being rolled); live events are refused', async () => {
    const raw = JSON.stringify({ id: `evt_roll_${randomUUID().slice(0, 6)}`, type: 'customer.created', data: { object: {} } });
    const at = Math.floor(Date.now() / 1000);
    const good = stripeSignature(STRIPE_WHSEC, at, raw).split('v1=')[1];
    const wrong = stripeSignature('whsec_old_old_old_old', at, raw).split('v1=')[1];
    await http().post('/v1/webhooks/credits/stripe').set('Content-Type', 'application/json').set('Stripe-Signature', `t=${at},v1=${wrong},v1=${good}`).send(raw).expect(200);
    await http().post('/v1/webhooks/credits/stripe').set('Content-Type', 'application/json').set('Stripe-Signature', `t=${at},v1=${wrong}`).send(raw).expect(400);
    const live = await stripeHook({ id: `evt_live_${randomUUID().slice(0, 6)}`, type: 'customer.created', livemode: true, data: { object: {} } });
    expect([live.status, live.body.error.code]).toEqual([400, 'live_event_refused']);
  });

  it('partner funding: not readable from a company\'s context; figures only in the partner\'s currency', async () => {
    await expect(app((tx) => tx.query(`SELECT * FROM partner_funding_check('360dialog')`))).rejects.toThrow(/company context/);
    expect((await staff.post('/v1/platform/partner/funding', { what: 'balance', amountMinor: 1000, currency: 'SAR' })).status).toBe(409);
  });

  it('M3: in production no company can be moved to the partner route and no credit account opened', async () => {
    const prod = new PlatformService(t.deps.platformDb, undefined, t.deps.db, false);
    const fake = { token: 'not-used', userId: randomUUID(), role: 'platform_owner' } as unknown as Parameters<PlatformService['setRoute']>[0];
    await expect(prod.setRoute(fake, otherTenant, { route: 'partner_360dialog', note: 'Should be refused' })).rejects.toThrow(/not approved/);
    await expect(prod.creditOpenAccount(fake, otherTenant, { currency: 'SAR' })).rejects.toThrow(/not approved/);
  });
});

describe('payment recovery: early, repeated, out-of-order and lost Stripe events give exactly one credit (owner point 2)', () => {
  const provider = () => new StripePaymentProvider(STRIPE_KEY, STRIPE_WHSEC, 'http://localhost', stripe.url);
  /** Moves a top-up back in time; `recheck` also lets ten minutes pass since its last lookup. */
  const age = async (topupId: string, minutes: number, recheck = false) => {
    await t.ownerDb.query('ALTER TABLE credit_topups NO FORCE ROW LEVEL SECURITY');
    try { await t.ownerDb.query(`UPDATE credit_topups SET created_at = now() - make_interval(mins => $2),
        checked_at = CASE WHEN $3 AND checked_at <> 'infinity' THEN NULL ELSE checked_at END WHERE id = $1`, [topupId, minutes, recheck]); }
    finally { await t.ownerDb.query('ALTER TABLE credit_topups FORCE ROW LEVEL SECURITY'); }
  };
  const entries = (topupId: string, tid = tenant) => app(async (tx) => (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM credit_entries WHERE topup_id = $1 AND kind = 'topup'`, [topupId])).rows[0]!.n, tid);
  const evt = (type: string, object: unknown) => ({ id: `evt_${type}_${randomUUID().slice(0, 8)}`, type, data: { object } });

  it('early (before our reference is saved), repeated, a second notice for the same payment, and a late "expired": one credit', async () => {
    const before = (await account()).balanceMinor;
    const r = (await owner.post('/v1/credits/topups', { amountMinor: 5500 }).expect(201)).body;
    const session = [...stripe.sessions.values()].at(-1)!;
    await app((tx) => tx.query('UPDATE credit_topups SET provider_ref = NULL WHERE id = $1', [r.id]));   // as if the webhook won the race
    stripe.pay(String(session.id));
    const completed = evt('checkout.session.completed', session);
    expect((await stripeHook(completed).expect(200)).body.outcome).toBe('applied');
    expect((await stripeHook(completed).expect(200)).body.outcome).toBe('duplicate');                 // Stripe's retry of the same event
    expect((await stripeHook(evt('checkout.session.async_payment_succeeded', session)).expect(200)).body.outcome).toBe('already_applied');
    expect((await stripeHook(evt('checkout.session.expired', { ...session, status: 'expired' })).expect(200)).body.outcome).toBe('not_pending:succeeded');
    await age(r.id, 30);
    expect(await new CreditWorker(t.deps.db, provider()).recoverTopUps()).toBe(0);                       // nothing left to recover
    expect(await entries(r.id)).toBe(1);
    expect((await account()).balanceMinor).toBe(before + 5500);
  });

  it('every webhook lost: the worker looks the payment up with Stripe and credits it once; the late webhook then changes nothing', async () => {
    const before = (await account()).balanceMinor;
    const r = (await owner.post('/v1/credits/topups', { amountMinor: 6500 }).expect(201)).body;
    const session = [...stripe.sessions.values()].at(-1)!;
    stripe.pay(String(session.id));                                                                  // paid, but no webhook arrives
    const worker = new CreditWorker(t.deps.db, provider());
    expect(await worker.recoverTopUps()).toBe(0);                                                    // too recent: Stripe is still retrying
    await age(r.id, 30);
    expect(await worker.recoverTopUps()).toBe(1);
    expect(await worker.recoverTopUps()).toBe(0);                                                    // looked at once per ten minutes at most
    expect((await stripeHook(evt('checkout.session.completed', session)).expect(200)).body.outcome).toBe('already_applied');
    expect(await entries(r.id)).toBe(1);
    expect((await account()).balanceMinor).toBe(before + 6500);
    const top = (await owner.get('/v1/credits/topups').expect(200)).body.find((x: { id: string }) => x.id === r.id);
    expect(top).toMatchObject({ status: 'succeeded', receiptNo: expect.stringMatching(/^CR-TEST-/) });
  });

  it('an automatic top-up closed as unconfirmed and paid later is still credited once, by lookup', async () => {
    await app((tx) => tx.query(`INSERT INTO credit_payment_methods (tenant_id, provider, provider_ref, label) VALUES ($1, 'stripe', 'cus_9:pm_9', 'Visa •••• 4242')`, [tenant]));
    const id = (await app(async (tx) => (await tx.query<{ id: string }>(
      `INSERT INTO credit_topups (tenant_id, amount_minor, currency, kind, provider) VALUES ($1, 5200, 'SAR', 'auto', 'stripe') RETURNING id`, [tenant])).rows[0]!)).id;
    const charged = await provider().chargeSaved({ tenantId: tenant, topupId: id, methodRef: 'cus_9:pm_9', amountMinor: 5200, currency: 'SAR', idempotencyKey: id });
    await app((tx) => tx.query('UPDATE credit_topups SET provider_ref = $2 WHERE id = $1', [id, charged.providerRef]));
    await age(id, 20);
    const worker = new CreditWorker(t.deps.db, provider());
    expect(await worker.recoverTopUps()).toBe(0);                                                    // Stripe still processing
    expect(await worker.closeStuckAutoTopUps()).toBe(1);                                             // closed as unconfirmed, with a notice
    const before = (await account()).balanceMinor;
    stripe.intents.get(charged.providerRef)!.status = 'succeeded';
    await age(id, 30, true);
    expect(await worker.recoverTopUps()).toBe(1);
    expect(await entries(id)).toBe(1);
    expect((await account()).balanceMinor).toBe(before + 5200);
  });

  it('a payment that can never be applied is kept with an alert after retries stop, and a platform owner closes it with what was done', async () => {
    const id = randomUUID();
    const pi = { id: `pi_test_orphan_${randomUUID().slice(0, 6)}`, object: 'payment_intent', amount: 3100, currency: 'sar', metadata: { tenantId: tenant, topupId: id, kind: 'auto' } };
    const e = evt('payment_intent.succeeded', pi);
    expect((await stripeHook(e).expect(200)).body.outcome).toBe('unmatched:unknown_topup');
    expect((await stripeHook(e).expect(200)).body.outcome).toBe('unmatched:unknown_topup');          // repeated: still one record
    const open = ((await staff.get('/v1/platform/credits/unmatched-events').expect(200)).body as Array<{ id: string; eventId: string }>).filter((u) => u.eventId === e.id);
    expect(open).toHaveLength(1);
    const alerts = await t.ownerDb.query(`SELECT 1 FROM platform_alerts WHERE kind = 'payment_unmatched' AND subject = 'stripe' AND resolved_at IS NULL`);
    expect(alerts.rowCount).toBe(1);
    expect(await new CreditWorker(t.deps.db, provider()).refreshAlerts()).toContain('payment_unmatched:stripe');
    // A failure for a top-up that cannot be found took no money: logged, no alert, nothing for a person.
    expect((await stripeHook(evt('payment_intent.payment_failed', { ...pi, id: `pi_test_orphan2_${randomUUID().slice(0, 6)}` })).expect(200)).body.outcome).toBe('no_money_taken:unknown_topup');
    await staff.put(`/v1/platform/credits/unmatched-events/${open[0]!.id}`, { action: 'closed', resolution: 'x' }).expect(400);
    // No top-up of ours: only "closed" is possible.
    expect((await staff.put(`/v1/platform/credits/unmatched-events/${open[0]!.id}`, { action: 'credit', resolution: 'Try to credit it' })).status).toBe(409);
    for (const u of (await staff.get('/v1/platform/credits/unmatched-events').expect(200)).body as Array<{ id: string }>) {
      await staff.put(`/v1/platform/credits/unmatched-events/${u.id}`, { action: 'closed', resolution: 'Refunded in the Stripe dashboard (test)' }).expect(200);
    }
    expect((await staff.get('/v1/platform/credits/unmatched-events').expect(200)).body).toEqual([]);
    expect(await new CreditWorker(t.deps.db, provider()).refreshAlerts()).not.toContain('payment_unmatched:stripe');
    expect((await t.ownerDb.query(`SELECT 1 FROM platform_alerts WHERE kind = 'payment_unmatched' AND subject = 'stripe' AND resolved_at IS NULL`)).rowCount).toBe(0);
  });

  it('the charge answer for an automatic top-up is lost: found at Stripe by our top-up id and credited once', async () => {
    const before = (await account()).balanceMinor;
    const id = (await app(async (tx) => (await tx.query<{ id: string }>(
      `INSERT INTO credit_topups (tenant_id, amount_minor, currency, kind, provider) VALUES ($1, 5300, 'SAR', 'auto', 'stripe') RETURNING id`, [tenant])).rows[0]!)).id;
    stripe.dropNextIntentAnswer = true;
    await expect(provider().chargeSaved({ tenantId: tenant, topupId: id, methodRef: 'cus_9:pm_9', amountMinor: 5300, currency: 'SAR', idempotencyKey: id })).rejects.toThrow();
    const pi = [...stripe.intents.values()].find((x) => (x.metadata as Record<string, string>).topupId === id)!;
    pi.status = 'succeeded';                                                                           // charged at Stripe; we never heard
    await age(id, 20);
    const worker = new CreditWorker(t.deps.db, provider());
    expect(await worker.closeStuckAutoTopUps()).toBeGreaterThanOrEqual(1);                            // closed as unconfirmed first
    await age(id, 30);
    expect(await worker.recoverTopUps()).toBe(1);
    expect((await app(async (tx) => (await tx.query<{ provider_ref: string; status: string }>('SELECT provider_ref, status FROM credit_topups WHERE id = $1', [id])).rows[0]!)))
      .toEqual({ provider_ref: pi.id, status: 'succeeded' });
    expect(await entries(id)).toBe(1);
    expect((await account()).balanceMinor).toBe(before + 5300);
  });

  it('a lookup says failed, then the real payment succeeds: credited once; a lookup and a webhook at the same moment: credited once', async () => {
    const before = (await account()).balanceMinor;
    const r = (await owner.post('/v1/credits/topups', { amountMinor: 5700 }).expect(201)).body;
    const session = [...stripe.sessions.values()].at(-1)!;
    session.status = 'expired';
    await age(r.id, 30);
    const worker = new CreditWorker(t.deps.db, provider());
    expect(await worker.recoverTopUps()).toBe(1);                                                    // recorded as failed
    stripe.pay(String(session.id));                                                                  // then paid after all (asynchronous method)
    expect((await stripeHook(evt('checkout.session.async_payment_succeeded', session)).expect(200)).body.outcome).toBe('applied');
    expect(await entries(r.id)).toBe(1);
    // Racing: a paid top-up looked up while its webhook arrives.
    const r2 = (await owner.post('/v1/credits/topups', { amountMinor: 5900 }).expect(201)).body;
    const s2 = [...stripe.sessions.values()].at(-1)!;
    stripe.pay(String(s2.id));
    await age(r2.id, 30);
    const [, hook] = await Promise.all([worker.recoverTopUps(), stripeHook(evt('checkout.session.completed', s2))]);
    expect(hook.status).toBe(200);
    expect(await entries(r2.id)).toBe(1);
    expect((await account()).balanceMinor).toBe(before + 5700 + 5900);
  });

  it('a payment arriving for a closed account is held for a person: nothing credits it until they decide credit or refunded', async () => {
    const u = await newUser(t, 'pt-rec');
    const tid = await newCompany(u, 'ptrec', 'business');
    await activateSubscription(t, tid);
    await enableMfa(u);
    await staff.put(`/v1/platform/tenants/${tid}/messaging-route`, { route: 'partner_360dialog', note: 'Recovery test company' }).expect(200);
    await staff.post(`/v1/platform/tenants/${tid}/credits/account`, { currency: 'SAR' }).expect(201);
    const r1 = (await u.post('/v1/credits/topups', { amountMinor: 6100 }).expect(201)).body;
    const s1 = [...stripe.sessions.values()].at(-1)!;
    const r2 = (await u.post('/v1/credits/topups', { amountMinor: 6200 }).expect(201)).body;
    const s2 = [...stripe.sessions.values()].at(-1)!;
    await age(r1.id, 3 * 24 * 60);
    await age(r2.id, 3 * 24 * 60);                                                                   // abandoned checkouts no longer block a switch
    await staff.put(`/v1/platform/tenants/${tid}/messaging-route`, { route: 'meta_direct', note: 'Back to direct' }).expect(200);
    stripe.pay(String(s1.id));
    stripe.pay(String(s2.id));
    const e1 = evt('checkout.session.completed', s1);
    const e2 = evt('checkout.session.completed', s2);
    expect((await stripeHook(e1).expect(200)).body.outcome).toBe('unmatched:no_account');
    expect((await stripeHook(e2).expect(200)).body.outcome).toBe('unmatched:no_account');
    const kept = (await staff.get('/v1/platform/credits/unmatched-events').expect(200)).body as Array<{ id: string; eventId: string }>;
    const k1 = kept.find((x) => x.eventId === e1.id)!;
    const k2 = kept.find((x) => x.eventId === e2.id)!;
    // The account is reopened, but the held payments are not credited by a lookup or a retried webhook.
    await staff.put(`/v1/platform/tenants/${tid}/messaging-route`, { route: 'partner_360dialog', note: 'Partner again' }).expect(200);
    await staff.post(`/v1/platform/tenants/${tid}/credits/account`, { currency: 'SAR' }).expect(201);
    const worker = new CreditWorker(t.deps.db, provider());
    expect(await worker.recoverTopUps()).toBe(0);
    expect((await stripeHook(evt('checkout.session.async_payment_succeeded', s1)).expect(200)).body.outcome).toBe('held_for_review');
    expect((await u.get('/v1/credits').expect(200)).body.balanceMinor).toBe(0);
    expect((await staff.put(`/v1/platform/credits/unmatched-events/${k1.id}`, { action: 'closed', resolution: 'Close without deciding' })).status).toBe(409);
    // Decision 1, taken late (40 days on): credit it. The hold is lifted and the next lookup credits it once, whatever its age.
    await age(r1.id, 40 * 24 * 60);
    await staff.put(`/v1/platform/credits/unmatched-events/${k1.id}`, { action: 'credit', resolution: 'Genuine payment; account reopened' }).expect(200);
    expect(await worker.recoverTopUps()).toBe(1);
    expect(await entries(r1.id, tid)).toBe(1);
    // Meanwhile the bank takes back the second payment (dispute lost): it can never be credited, only closed.
    const pi2 = String(stripe.sessions.get(String(s2.id))!.payment_intent);
    expect((await stripeHook(evt('charge.dispute.closed', { id: 'dp_held', status: 'lost', payment_intent: pi2, amount: 6200, currency: 'sar', reason: 'fraudulent' }))
      .expect(200)).body.outcome).toBe('unmatched:dispute_uncredited');
    const dsp = ((await staff.get('/v1/platform/credits/unmatched-events').expect(200)).body as Array<{ id: string; reason: string; topupRef: string }>)
      .find((x) => x.reason === 'dispute_uncredited' && x.topupRef === r2.id)!;
    const refused = await staff.put(`/v1/platform/credits/unmatched-events/${dsp.id}`, { action: 'credit', resolution: 'Try to credit a disputed payment' });
    expect([refused.status, refused.body.error.message]).toEqual([409, expect.stringMatching(/disputed/)]);
    // Decision 2: refunded (here, taken back by the bank). The top-up is closed, and a later success never credits it.
    await staff.put(`/v1/platform/credits/unmatched-events/${k2.id}`, { action: 'refunded', resolution: 'Refunded in the Stripe dashboard (test)' }).expect(200);
    expect((await stripeHook(evt('checkout.session.async_payment_succeeded', s2)).expect(200)).body.outcome).toBe('refunded_by_hand');
    expect(await worker.recoverTopUps()).toBe(0);
    expect(await entries(r2.id, tid)).toBe(0);
    expect((await u.get('/v1/credits').expect(200)).body.balanceMinor).toBe(6100);
    const left = (await staff.get('/v1/platform/credits/unmatched-events').expect(200)).body as Array<{ eventId: string }>;
    expect(left.some((x) => x.eventId === e1.id || x.eventId === e2.id)).toBe(false);
  });
});
