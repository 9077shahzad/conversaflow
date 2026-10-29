/**
 * Prepaid WhatsApp message credits (owner decision of 29 Oct 2026, migration 0061). Test mode only: the payment
 * provider is the labelled test provider (no money moves) and WhatsApp is the sandbox (nothing leaves the machine).
 */
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withContext } from '@conversaflow/database';
import { loadConfig } from '../src/core/config';
import { signBody, type SandboxAdapter } from '../src/modules/channels';
import { AUTO_TOPUP_CONSENT, CreditWorker, CreditsService, TestPaymentProvider, categoryOf, marketFor, settleRefund } from '../src/modules/credits';
import { Sender } from '../src/modules/sender';
import { CampaignRunner } from '../src/modules/campaigns';
import { activateSubscription, addMember, enableMfa, newCompany, newStaff, newUser, startApp, type Client, type TestApp } from './helpers';

let t: TestApp;
let sandbox: SandboxAdapter;
let owner: Client;
let agent: Client;
let staff: Client;
let otherOwner: Client;
let tenant: string;
let otherTenant: string;
let ownerMembership: string;
let provider: TestPaymentProvider;
/** The provider instance the app itself uses (its refund outcomes can be scripted). */
let provider_: TestPaymentProvider;
let marketing: { id: string; providerTemplateId: string };
let utility: { id: string; providerTemplateId: string };
const NUMBER = `pn${randomUUID().slice(0, 8)}`;
const ACCOUNT = `waba${randomUUID().slice(0, 8)}`;
let seq = 0;
const base = Math.floor(Math.random() * 5_000_000);
const saudi = () => `96655${String(base + ++seq).padStart(7, '0')}`;
const uae = () => `97155${String(base + ++seq).padStart(7, '0')}`;
const elsewhere = () => `4477${String(base + ++seq).padStart(7, '0')}`;
const app = <T>(fn: Parameters<typeof withContext<T>>[2], tid = tenant) => withContext<T>(t.deps.db, { tenantId: tid, userId: null }, fn);
const http = () => request(t.app.getHttpServer());
const post = (raw: string) => http().post('/v1/webhooks/sandbox').set('Content-Type', 'application/json').set('X-Hub-Signature-256', signBody(t.deps.keys.sandboxWebhook, raw)).send(raw);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const send = () => new Sender(t.deps.db, t.deps.channels).dispatchDue(100);

async function approve(tpl: { providerTemplateId: string }, name: string) {
  const remote = (sandbox.templates.get(ACCOUNT) ?? []).find((x) => x.providerTemplateId === tpl.providerTemplateId);
  if (remote) remote.status = 'approved';
  await post(JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: ACCOUNT, time: Math.floor(Date.now() / 1000), changes: [{
    field: 'message_template_status_update', value: { event: 'APPROVED', message_template_id: Number(tpl.providerTemplateId), message_template_name: name,
      message_template_language: 'en', reason: null } }] }] })).expect(200);
}
/** A customer who wrote to us, with marketing consent; `windowOpen` false closes their 24-hour window. */
async function customer(wa: string, windowOpen = false) {
  await post(JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: NUMBER },
    contacts: [{ wa_id: wa, profile: { name: 'Credit Customer' } }],
    messages: [{ from: wa, id: `wamid.in.${randomUUID()}`, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'Hello' } }] } }] }] })).expect(200);
  return app(async (tx) => {
    const c = (await tx.query<{ id: string; contact_id: string }>(
      `SELECT c.id, c.contact_id FROM conversations c JOIN contact_identifiers ci ON ci.contact_id = c.contact_id WHERE ci.value = $1 ORDER BY c.created_at DESC LIMIT 1`, [wa])).rows[0]!;
    await tx.query('UPDATE contacts SET marketing_consent_at = now() WHERE id = $1', [c.contact_id]);
    if (!windowOpen) await tx.query(`UPDATE conversations SET last_inbound_at = now() - interval '30 hours' WHERE id = $1`, [c.id]);
    return c.id;
  });
}
async function queueTemplate(convId: string, tpl: { id: string }, expectStatus = 201) {
  const conv = (await owner.get(`/v1/conversations/${convId}`).expect(200)).body;
  const r = await owner.post(`/v1/conversations/${convId}/template`, { templateId: tpl.id, params: ['Sara'], seenActivity: conv.activitySeq, clientMessageId: randomUUID() }).expect(expectStatus);
  return r.body.id as string;
}
const msg = (id: string) => app(async (tx) => (await tx.query<{ status: string; error_code: string | null; provider_message_id: string | null }>(
  'SELECT status, error_code, provider_message_id FROM messages WHERE id = $1', [id])).rows[0]!);
const reservation = (id: string) => app(async (tx) => (await tx.query<{ state: string; price_minor: string; market: string; rate_card_id: string }>(
  'SELECT state, price_minor, market, rate_card_id FROM credit_reservations WHERE message_id = $1', [id])).rows[0] ?? null);
const account = async () => (await owner.get('/v1/credits').expect(200)).body as { balanceMinor: number; reservedMinor: number; availableMinor: number; notices: Array<{ kind: string }> };
/** Meta's status webhook with its pricing object (per-message pricing). */
function status(providerMessageId: string, s: 'sent' | 'delivered' | 'read' | 'failed', pricing?: { billable: boolean; category: string; type?: string }) {
  return post(JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: NUMBER },
    statuses: [{ id: providerMessageId, status: s, timestamp: String(Math.floor(Date.now() / 1000)), recipient_id: '1',
      ...(pricing ? { pricing: { pricing_model: 'PMP', type: 'regular', ...pricing } } : {}),
      ...(s === 'failed' ? { errors: [{ code: 131026, title: 'Undeliverable' }] } : {}) }] } }] }] }));
}
const charges = (id: string) => app(async (tx) => (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM credit_entries WHERE message_id = $1 AND kind = 'charge'`, [id])).rows[0]!.n);
/** Platform adjustment so that the available balance becomes exactly `target`. */
async function setAvailable(target: number) {
  const a = await account();
  if (a.availableMinor !== target) await staff.post(`/v1/platform/tenants/${tenant}/credits/adjustments`, { amountMinor: target - a.availableMinor, note: 'Test: set available balance' }).expect(201);
}
async function topUp(amountMinor: number, c: Client = owner) {
  const r = (await c.post('/v1/credits/topups', { amountMinor }).expect(201)).body;
  await c.post(`/v1/credits/test/topups/${r.id}/complete`, { outcome: 'succeeded' }).expect(200);
  return r.id as string;
}
const RATES = (from: Date, saudiMarketing = 25) => ({
  currency: 'SAR', effectiveFrom: from.toISOString(), source: 'Test fixture (not Meta prices)',
  markets: [{ prefix: '966', market: 'saudi_arabia' }, { prefix: '971', market: 'uae' }],
  lines: [
    { market: 'saudi_arabia', category: 'marketing', unitCostMinor: saudiMarketing }, { market: 'saudi_arabia', category: 'utility', unitCostMinor: 5 },
    { market: 'saudi_arabia', category: 'authentication', unitCostMinor: 5 },
    { market: 'uae', category: 'marketing', unitCostMinor: 40 }, { market: 'uae', category: 'utility', unitCostMinor: 10 },
    { market: 'other', category: 'marketing', unitCostMinor: 50 }, { market: 'other', category: 'utility', unitCostMinor: 10 },
    { market: 'other', category: 'authentication', unitCostMinor: 10 },
  ],
});

beforeAll(async () => {
  t = await startApp();
  sandbox = t.deps.channels.sandbox as SandboxAdapter;
  provider = new TestPaymentProvider(t.deps.keys.webhookSecrets, t.deps.config.APP_ORIGIN);
  provider_ = (t.app.get(CreditsService) as unknown as { provider: TestPaymentProvider }).provider;
  owner = await newUser(t, 'cr-owner');
  tenant = await newCompany(owner, 'cr', 'business');
  await activateSubscription(t, tenant);
  await enableMfa(owner);
  ownerMembership = (await owner.get('/v1/me/access').expect(200)).body.membershipId;
  agent = await addMember(t, owner, 'cr-agent', 'agent');
  await owner.post('/v1/channels', { provider: 'sandbox', providerNumberId: NUMBER, displayPhone: '+966500000077', label: 'Credits', providerAccountId: ACCOUNT }).expect(201);
  marketing = (await owner.post('/v1/templates', { name: 'credit_offer', language: 'en', category: 'marketing', bodyText: 'Hi {{1}}, our AC service offer is open.', examples: ['Sara'] }).expect(201)).body;
  utility = (await owner.post('/v1/templates', { name: 'credit_visit', language: 'en', category: 'utility', bodyText: 'Hi {{1}}, your visit is confirmed.', examples: ['Sara'] }).expect(201)).body;
  await approve(marketing, 'credit_offer');
  await approve(utility, 'credit_visit');
  staff = await newStaff(t, 'cr-staff', 'platform_owner');
  otherOwner = await newUser(t, 'cr-other');
  otherTenant = await newCompany(otherOwner, 'crother', 'business');
  await activateSubscription(t, otherTenant);
  await enableMfa(otherOwner);
});
afterAll(() => t?.close());
let wordingApproved = false;
/** A platform owner records the legal approval of wording version 1 (both languages), once. */
async function approveWording() {
  if (wordingApproved) return;
  for (const locale of ['en', 'ar']) {
    await staff.put(`/v1/platform/credits/consent-wording/1/${locale}`, { status: 'approved', legalReference: 'Test: counsel memo' }).expect(200);
  }
  wordingApproved = true;
}

describe('companies that pay Meta directly are unchanged', () => {
  it('no credit account: templates send as before, nothing is reserved or charged', async () => {
    expect((await owner.get('/v1/credits').expect(200)).body).toMatchObject({ mode: 'meta_direct' });
    const id = await queueTemplate(await customer(saudi()), marketing);
    await send();
    const m = await msg(id);
    expect(m.status).toBe('sent');
    await status(m.provider_message_id!, 'delivered', { billable: true, category: 'marketing' }).expect(200);
    expect(await reservation(id)).toBeNull();
    expect(await charges(id)).toBe(0);
    await owner.post('/v1/credits/topups', { amountMinor: 10000 }).expect(409);
  });
});

describe('platform set-up: accounts, versioned rates, margins', () => {
  it('only a platform owner opens accounts and publishes rates; bad rate cards are refused', async () => {
    await owner.post(`/v1/platform/tenants/${tenant}/credits/account`, { currency: 'SAR' }).expect(403);
    const support = await newStaff(t, 'cr-support', 'support_agent');
    await support.post(`/v1/platform/tenants/${tenant}/credits/account`, { currency: 'SAR' }).expect(403);
    // Prepaid credit only on the partner route; the company is put on it first (owner instruction 3).
    expect((await staff.post(`/v1/platform/tenants/${tenant}/credits/account`, { currency: 'SAR', lowThresholdMinor: 2000 })).status).toBe(409);
    await staff.put(`/v1/platform/tenants/${tenant}/messaging-route`, { route: 'partner_360dialog', note: 'Test: partner route' }).expect(200);
    await staff.post(`/v1/platform/tenants/${tenant}/credits/account`, { currency: 'SAR', lowThresholdMinor: 2000 }).expect(201);
    await staff.post(`/v1/platform/tenants/${tenant}/credits/account`, { currency: 'SAR' }).expect(409);
    await staff.post('/v1/platform/credits/rate-cards', RATES(new Date(Date.now() - 60_000))).expect(409);
    const noOther = RATES(new Date(Date.now() + 60_000));
    noOther.lines = noOther.lines.filter((l) => l.market !== 'other');
    await staff.post('/v1/platform/credits/rate-cards', noOther).expect(409);
    const incomplete = RATES(new Date(Date.now() + 60_000));
    incomplete.lines = incomplete.lines.filter((l) => !(l.market === 'other' && l.category === 'utility'));
    await staff.post('/v1/platform/credits/rate-cards', incomplete).expect(409);
    await staff.post('/v1/platform/credits/rate-cards', RATES(new Date(Date.now() + 800))).expect(201);
    await staff.put('/v1/platform/credits/margin', { tenantId: null, marginBp: 2000 }).expect(200);
    await sleep(900);
    expect(await account()).toMatchObject({ mode: 'prepaid', currency: 'SAR', balanceMinor: 0, marginBp: 2000, provider: { name: 'test', testMode: true } });
  });

  it('rate cards and the ledger cannot be edited, and balances move only through the ledger', async () => {
    await expect(app((tx) => tx.query('UPDATE credit_accounts SET balance_minor = 100000'))).rejects.toThrow(/only through the credit ledger/);
    await expect(app((tx) => tx.query("SELECT set_config('cf.credit_entry', 'x', true); UPDATE credit_accounts SET balance_minor = 100000"))).rejects.toThrow();
    await expect(t.ownerDb.query('UPDATE credit_rate_lines SET unit_cost_minor = 1')).rejects.toThrow(/never change/);
    await expect(app((tx) => tx.query("UPDATE credit_entries SET note = 'x'"))).rejects.toThrow(/permission denied/);
  });

  it('markets come from the longest calling-code prefix', () => {
    const p = [{ prefix: '9', market: 'nine' }, { prefix: '966', market: 'saudi_arabia' }, { prefix: '9665', market: 'saudi_mobile' }];
    expect(marketFor(p, '966551234567')).toBe('saudi_mobile');
    expect(marketFor(p, '966111234567')).toBe('saudi_arabia');
    expect(marketFor(p, '+44 7700 900000')).toBe('other');
    expect(categoryOf('authentication_international')).toBe('authentication');
    expect(categoryOf('marketing_lite')).toBe('marketing');
    expect(categoryOf('SERVICE')).toBe('service');
    expect(categoryOf('something_new')).toBeNull();
  });
});

describe('top-ups, receipts and payment events', () => {
  it('nothing is credited until the provider confirms; the receipt follows; repeats and forgeries change nothing', async () => {
    await owner.post('/v1/credits/topups', { amountMinor: 100 }).expect(400);
    await agent.post('/v1/credits/topups', { amountMinor: 10000 }).expect(403);
    await agent.get('/v1/credits').expect(403);
    const start = (await owner.post('/v1/credits/topups', { amountMinor: 10000 }).expect(201)).body;
    expect(start).toMatchObject({ testMode: true });
    expect(start.checkoutUrl).toContain('testCheckout=');
    expect((await account()).balanceMinor).toBe(0);
    // A forged event (wrong signature) and one for another amount are refused.
    const ref = `pay_test_${start.id}`;
    const forged = provider.event({ type: 'payment.succeeded', providerRef: ref, amountMinor: 10000, currency: 'SAR', tenantId: tenant, topupId: start.id });
    await http().post('/v1/webhooks/credits/test').set('Content-Type', 'application/json').set('X-CF-Payment-Signature', '00'.repeat(32)).send(forged.raw).expect(400);
    const wrongAmount = provider.event({ type: 'payment.succeeded', providerRef: ref, amountMinor: 99999, currency: 'SAR', tenantId: tenant, topupId: start.id });
    expect((await http().post('/v1/webhooks/credits/test').set('Content-Type', 'application/json').set('X-CF-Payment-Signature', wrongAmount.signature).send(wrongAmount.raw).expect(200)).body.outcome).toBe('unmatched:mismatch');
    await http().post('/v1/webhooks/credits/stripe').set('Content-Type', 'application/json').send('{}').expect(404);
    // The real event, delivered three times: credited once.
    const ok = provider.event({ type: 'payment.succeeded', providerRef: ref, amountMinor: 10000, currency: 'SAR', tenantId: tenant, topupId: start.id });
    const outcomes = [];
    for (let i = 0; i < 3; i++) outcomes.push((await http().post('/v1/webhooks/credits/test').set('Content-Type', 'application/json').set('X-CF-Payment-Signature', ok.signature).send(ok.raw).expect(200)).body.outcome);
    expect(outcomes).toEqual(['applied', 'duplicate', 'duplicate']);
    // A different event for the same top-up is not applied twice either.
    const again = provider.event({ type: 'payment.succeeded', providerRef: ref, amountMinor: 10000, currency: 'SAR', tenantId: tenant, topupId: start.id });
    expect((await http().post('/v1/webhooks/credits/test').set('Content-Type', 'application/json').set('X-CF-Payment-Signature', again.signature).send(again.raw).expect(200)).body.outcome).toBe('already_applied');
    expect((await account()).balanceMinor).toBe(10000);
    const top = (await owner.get('/v1/credits/topups').expect(200)).body.find((x: { id: string }) => x.id === start.id);
    expect(top).toMatchObject({ status: 'succeeded', amountMinor: 10000 });
    expect(top.receiptNo).toMatch(/^CR-TEST-\d{4}-\d{6}$/);
    const doc = (await owner.get(`/v1/credits/documents/${start.id}`).expect(200)).body;
    expect(doc).toMatchObject({ type: 'receipt', number: top.receiptNo, amountMinor: 10000, currency: 'SAR', testMode: true });
    expect(doc.description).toMatch(/TEST MODE/);
    await otherOwner.get(`/v1/credits/documents/${start.id}`).expect(404);
  });

  it('a failed payment credits nothing and leaves a notice', async () => {
    const before = (await account()).balanceMinor;
    const start = (await owner.post('/v1/credits/topups', { amountMinor: 6000 }).expect(201)).body;
    expect((await owner.post(`/v1/credits/test/topups/${start.id}/complete`, { outcome: 'failed' }).expect(200)).body.outcome).toBe('failed_recorded');
    await owner.post(`/v1/credits/test/topups/${start.id}/complete`, { outcome: 'succeeded' }).expect(404);
    const a = await account();
    expect(a.balanceMinor).toBe(before);
    expect(a.notices.some((n) => n.kind === 'topup_failed')).toBe(true);
  });
});

describe('charging paid messages', () => {
  it('a paid template reserves its price, is charged once on billable delivery, however many statuses arrive', async () => {
    await setAvailable(10000);
    const id = await queueTemplate(await customer(saudi()), marketing);
    await send();
    expect(await reservation(id)).toMatchObject({ state: 'held', price_minor: '30', market: 'saudi_arabia' });  // 25 + 20%
    expect(await account()).toMatchObject({ balanceMinor: 10000, reservedMinor: 30, availableMinor: 9970 });
    const wamid = (await msg(id)).provider_message_id!;
    await status(wamid, 'sent', { billable: true, category: 'marketing' }).expect(200);
    expect(await charges(id)).toBe(0);
    await status(wamid, 'delivered', { billable: true, category: 'marketing' }).expect(200);
    await status(wamid, 'read', { billable: true, category: 'marketing' }).expect(200);
    await status(wamid, 'delivered', { billable: true, category: 'marketing' }).expect(200);   // out of order, repeated
    expect(await charges(id)).toBe(1);
    expect(await reservation(id)).toMatchObject({ state: 'charged' });
    expect(await account()).toMatchObject({ balanceMinor: 9970, reservedMinor: 0 });
  });

  it('Meta pricing from 1 Oct 2026: replies within the free monthly allowance hold nothing; utility templates in the window are paid; anything Meta marks not billable is released', async () => {
    await setAvailable(5000);
    const open = await customer(saudi(), true);
    const util = await queueTemplate(open, utility);
    const conv = (await owner.get(`/v1/conversations/${open}`).expect(200)).body;
    const reply = (await owner.post(`/v1/conversations/${open}/reply`, { text: 'Thanks, see you soon', seenActivity: conv.activitySeq, clientMessageId: randomUUID() }).expect(201)).body.id;
    await send();
    expect(await reservation(reply)).toBeNull();
    expect(await reservation(util)).toMatchObject({ state: 'held', price_minor: '6' });   // utility is paid in the window too
    await status((await msg(util)).provider_message_id!, 'failed').expect(200);
    expect((await account()).reservedMinor).toBe(0);
    // A paid-looking send that Meta then reports as free is released, never charged.
    const id = await queueTemplate(await customer(saudi()), marketing);
    await send();
    expect(await reservation(id)).toMatchObject({ state: 'held' });
    await status((await msg(id)).provider_message_id!, 'delivered', { billable: false, category: 'marketing', type: 'free_customer_service' }).expect(200);
    expect(await reservation(id)).toMatchObject({ state: 'released' });
    expect(await charges(id)).toBe(0);
    expect(await account()).toMatchObject({ balanceMinor: 5000, reservedMinor: 0 });
    // A utility template outside the window is paid.
    const paidUtil = await queueTemplate(await customer(saudi()), utility);
    await send();
    expect(await reservation(paidUtil)).toMatchObject({ state: 'held', price_minor: '6' });
    await status((await msg(paidUtil)).provider_message_id!, 'failed').expect(200);
  });

  it('a message that fails, or that the provider refuses, gives its credit back', async () => {
    await setAvailable(5000);
    const a = await queueTemplate(await customer(saudi()), marketing);
    await send();
    await status((await msg(a)).provider_message_id!, 'failed').expect(200);
    expect(await reservation(a)).toMatchObject({ state: 'released' });
    sandbox.script.push({ reject: 'invalid_recipient' });
    const b = await queueTemplate(await customer(saudi()), marketing);
    await send();
    expect((await msg(b)).status).toBe('failed');
    expect(await reservation(b)).toMatchObject({ state: 'released' });
    expect(await account()).toMatchObject({ availableMinor: 5000, reservedMinor: 0 });
  });

  it('without enough credit the message is not sent, and the company is told once', async () => {
    await setAvailable(29);
    const before = sandbox.sent.length;
    const id = await queueTemplate(await customer(saudi()), marketing);
    await send();
    expect(await msg(id)).toMatchObject({ status: 'failed', error_code: 'insufficient_credit' });
    expect(sandbox.sent.length).toBe(before);
    const id2 = await queueTemplate(await customer(saudi()), marketing);
    await send();
    expect((await msg(id2)).error_code).toBe('insufficient_credit');
    const lows = async () => (await account()).notices.filter((n) => n.kind === 'low_balance' || n.kind === 'empty').length;
    const count = await lows();
    expect(count).toBeGreaterThanOrEqual(1);
    // A top-up above the threshold re-arms the notice; falling below again tells them again, once.
    await topUp(5000);
    await setAvailable(10);
    await queueTemplate(await customer(saudi()), marketing);
    await queueTemplate(await customer(saudi()), marketing);
    await send();
    expect(await lows()).toBe(count + 1);
  });

  it('sends at the same moment never spend more than the balance', async () => {
    await setAvailable(90);  // room for exactly three at 30
    // Eight messages queued at once (as a campaign would), then four senders working at the same time.
    const ids: string[] = [];
    for (let i = 0; i < 8; i++) {
      const c = await customer(saudi());
      ids.push(await app(async (tx) => {
        const m = (await tx.query<{ id: string }>(
          `INSERT INTO messages (tenant_id, conversation_id, direction, kind, body, client_message_id, sent_by_membership_id, occurred_at, status, template_id, template_params)
           VALUES ($1, $2, 'out', 'template', 'x', $3, $4, clock_timestamp(), 'queued', $5, '["Sara"]') RETURNING id`, [tenant, c, randomUUID(), ownerMembership, marketing.id])).rows[0]!;
        await tx.query('INSERT INTO send_jobs (tenant_id, message_id) VALUES ($1, $2)', [tenant, m.id]);
        return m.id;
      }));
    }
    await Promise.all([send(), send(), send(), send()]);
    const states = await Promise.all(ids.map(async (id) => ({ m: await msg(id), r: await reservation(id) })));
    expect(states.filter((s) => s.r?.state === 'held')).toHaveLength(3);
    expect(states.filter((s) => s.m.error_code === 'insufficient_credit')).toHaveLength(5);
    const a = await account();
    expect(a.reservedMinor).toBe(90);
    expect(a.availableMinor).toBe(0);
    // The ledger and the account agree.
    const sums = await app(async (tx) => (await tx.query<{ b: string; r: string }>('SELECT sum(amount_minor) AS b, sum(reserved_delta) AS r FROM credit_entries')).rows[0]!);
    expect(Number(sums.b)).toBe(a.balanceMinor);
    expect(Number(sums.r)).toBe(a.reservedMinor);
    for (const s of states) if (s.r?.state === 'held') await status(s.m.provider_message_id!, 'failed').expect(200);
  });

  it('prices follow the market, the company margin and the rate card in force when the message was priced', async () => {
    await setAvailable(5000);
    const u = await queueTemplate(await customer(uae()), marketing);
    const o = await queueTemplate(await customer(elsewhere()), marketing);
    await send();
    expect(await reservation(u)).toMatchObject({ market: 'uae', price_minor: '48' });
    expect(await reservation(o)).toMatchObject({ market: 'other', price_minor: '60' });
    await staff.put('/v1/platform/credits/margin', { tenantId: tenant, marginBp: 0 }).expect(200);
    const zero = await queueTemplate(await customer(saudi()), marketing);
    await send();
    expect(await reservation(zero)).toMatchObject({ price_minor: '25' });
    await staff.put('/v1/platform/credits/margin', { tenantId: tenant, marginBp: null }).expect(200);
    // A new card from a later moment: messages priced before keep the old price at delivery.
    const held = await queueTemplate(await customer(saudi()), marketing);
    await send();
    expect(await reservation(held)).toMatchObject({ price_minor: '30' });
    await staff.post('/v1/platform/credits/rate-cards', RATES(new Date(Date.now() + 700), 50)).expect(201);
    await sleep(800);
    const after = await queueTemplate(await customer(saudi()), marketing);
    await send();
    expect(await reservation(after)).toMatchObject({ price_minor: '60' });
    const before = (await account()).balanceMinor;
    await status((await msg(held)).provider_message_id!, 'delivered', { billable: true, category: 'marketing' }).expect(200);
    expect((await account()).balanceMinor).toBe(before - 30);
    for (const id of [u, o, zero, after]) await status((await msg(id)).provider_message_id!, 'failed').expect(200);
  });

  it('reservations never billed are given back by the worker after the configured time', async () => {
    await setAvailable(5000);
    const id = await queueTemplate(await customer(saudi()), marketing);
    await send();
    await t.ownerDb.query('ALTER TABLE credit_reservations NO FORCE ROW LEVEL SECURITY');
    try { await t.ownerDb.query(`UPDATE credit_reservations SET created_at = now() - interval '80 hours' WHERE message_id = $1`, [id]); }
    finally { await t.ownerDb.query('ALTER TABLE credit_reservations FORCE ROW LEVEL SECURITY'); }
    await new CreditWorker(t.deps.db, null).releaseStale(500);
    expect(await reservation(id)).toMatchObject({ state: 'released' });
    expect((await account()).reservedMinor).toBe(0);
  });
});

describe('refunds, reversals and adjustments', () => {
  it('only unused credit from a completed top-up is refunded, with a credit note', async () => {
    await setAvailable(0);
    const id = await topUp(8000);
    await owner.post('/v1/credits/refunds', { topupId: id, amountMinor: 9000, reason: 'Too much' }).expect(400);
    await setAvailable(3000);
    await owner.post('/v1/credits/refunds', { topupId: id, amountMinor: 5000, reason: 'Unused credit' }).expect(409);
    const r = (await owner.post('/v1/credits/refunds', { topupId: id, amountMinor: 2000, reason: 'Unused credit' }).expect(201)).body;
    expect(r.status).toBe('succeeded');
    expect((await account()).availableMinor).toBe(1000);
    const doc = (await owner.get(`/v1/credits/documents/${r.id}`).expect(200)).body;
    expect(doc).toMatchObject({ type: 'credit_note', amountMinor: 2000 });
    expect(doc.number).toMatch(/^CN-TEST-\d{4}-\d{6}$/);
    await setAvailable(10000);
    await owner.post('/v1/credits/refunds', { topupId: id, amountMinor: 6001, reason: 'Unused credit' }).expect(400);  // 8000 - 2000 left
    await agent.post('/v1/credits/refunds', { topupId: id, amountMinor: 100, reason: 'x y z' }).expect(403);
  });

  it('a payment taken back by the bank removes its credit, even below zero, and paid sends stop', async () => {
    await setAvailable(0);
    const id = await topUp(5000);
    await setAvailable(1000);   // 4000 already spent
    const ev = provider.event({ type: 'dispute.lost', providerRef: `pay_test_${id}`, amountMinor: 5000, currency: 'SAR', tenantId: tenant, topupId: id, reason: 'fraudulent' });
    const hit = () => http().post('/v1/webhooks/credits/test').set('Content-Type', 'application/json').set('X-CF-Payment-Signature', ev.signature).send(ev.raw).expect(200);
    expect((await hit()).body.outcome).toBe('reversed');
    expect((await hit()).body.outcome).toBe('duplicate');
    expect((await account()).balanceMinor).toBe(-4000);
    const m = await queueTemplate(await customer(saudi()), marketing);
    await send();
    expect((await msg(m)).error_code).toBe('insufficient_credit');
    expect((await account()).notices.some((n) => n.kind === 'reversal')).toBe(true);
  });

  it('adjustments need a reason and appear in the company audit trail', async () => {
    await staff.post(`/v1/platform/tenants/${tenant}/credits/adjustments`, { amountMinor: 500, note: 'x' }).expect(400);
    await staff.post(`/v1/platform/tenants/${tenant}/credits/adjustments`, { amountMinor: 0, note: 'Goodwill credit' }).expect(400);
    await staff.post(`/v1/platform/tenants/${otherTenant}/credits/adjustments`, { amountMinor: 500, note: 'No account here' }).expect(409);
    const before = (await account()).balanceMinor;
    await staff.post(`/v1/platform/tenants/${tenant}/credits/adjustments`, { amountMinor: 500, note: 'Goodwill credit' }).expect(201);
    expect((await account()).balanceMinor).toBe(before + 500);
    const audit = (await owner.get('/v1/audit-events?limit=50').expect(200)).body;
    expect(JSON.stringify(audit)).toContain('credits.adjusted');
  });
});

describe('automatic top-up is opt-in', () => {
  it('stays off until turned on with the exact wording, a saved card and limits; then tops up once within the daily limit', async () => {
    const worker = new CreditWorker(t.deps.db, provider);
    await setAvailable(100);
    await worker.autoTopUps(500);
    expect((await account()).availableMinor).toBe(100);
    const card = (await owner.post('/v1/credits/test/methods', { last4: '4242' }).expect(201)).body;
    const on = { enabled: true, thresholdMinor: 1000, amountMinor: 5000, dailyLimitMinor: 10000, methodId: card.id, consentText: AUTO_TOPUP_CONSENT, consentVersion: 1, consentLocale: 'en' };
    // The wording is awaiting legal review: automatic top-up cannot be turned on (owner instruction 6).
    expect((await owner.put('/v1/credits/auto-topup', on).expect(409)).body.error.code).toBe('consent_not_approved');
    await approveWording();
    await owner.put('/v1/credits/auto-topup', { ...on, consentText: 'ok' }).expect(400);
    await owner.put('/v1/credits/auto-topup', { ...on, methodId: randomUUID() }).expect(400);
    await owner.put('/v1/credits/auto-topup', { ...on, dailyLimitMinor: 4000 }).expect(400);
    await otherOwner.put('/v1/credits/auto-topup', on).expect(409);
    await owner.put('/v1/credits/auto-topup', on).expect(200);
    await worker.autoTopUps(500);
    expect((await account()).availableMinor).toBe(5100);
    await worker.autoTopUps(500);                       // above the threshold now: nothing
    expect((await account()).availableMinor).toBe(5100);
    await setAvailable(100);
    await worker.autoTopUps(500);                       // a second within 24 hours reaches the 10000 limit exactly
    expect((await account()).availableMinor).toBe(5100);
    await setAvailable(100);
    await worker.autoTopUps(500);                       // a third would pass the daily limit
    expect((await account()).availableMinor).toBe(100);
    const autos = (await owner.get('/v1/credits/topups').expect(200)).body.filter((x: { kind: string }) => x.kind === 'auto');
    expect(autos).toHaveLength(2);
    expect(autos.every((x: { status: string; receiptNo: string }) => x.status === 'succeeded' && /^CR-/.test(x.receiptNo))).toBe(true);
    await owner.put('/v1/credits/auto-topup', { enabled: false }).expect(200);
  });

  it('a declined card is not retried in a loop; the company is told', async () => {
    const c = await newUser(t, 'cr-auto');
    const tid = await newCompany(c, 'crauto', 'business');
    await activateSubscription(t, tid);
    await enableMfa(c);
    await staff.put(`/v1/platform/tenants/${tid}/messaging-route`, { route: 'partner_360dialog', note: 'Test: partner route' }).expect(200);
    await staff.post(`/v1/platform/tenants/${tid}/credits/account`, { currency: 'SAR' }).expect(201);
    const card = (await c.post('/v1/credits/test/methods', { last4: '0002' }).expect(201)).body;
    await c.put('/v1/credits/auto-topup', { enabled: true, thresholdMinor: 1000, amountMinor: 5000, dailyLimitMinor: 20000, methodId: card.id, consentText: AUTO_TOPUP_CONSENT, consentVersion: 1, consentLocale: 'en' }).expect(200);
    const worker = new CreditWorker(t.deps.db, provider);
    await worker.autoTopUps(500);
    await worker.autoTopUps(500);
    const tops = (await c.get('/v1/credits/topups').expect(200)).body;
    expect(tops).toHaveLength(1);
    expect(tops[0]).toMatchObject({ kind: 'auto', status: 'failed', failureReason: 'card_declined' });
    expect((await c.get('/v1/credits').expect(200)).body.notices.some((n: { kind: string }) => n.kind === 'auto_topup_failed')).toBe(true);
  });
});

describe('review fixes (0062)', () => {
  it('a billable delivery after the hold was given back is still charged once, without failing the webhook (H1)', async () => {
    await setAvailable(5000);
    const id = await queueTemplate(await customer(saudi()), marketing);
    await send();
    const wamid = (await msg(id)).provider_message_id!;
    await status(wamid, 'failed').expect(200);
    expect(await reservation(id)).toMatchObject({ state: 'released' });
    // Meta then reports it delivered and billable, bundled with a customer message in the same delivery.
    const wa = saudi();
    const raw = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: NUMBER },
      contacts: [{ wa_id: wa, profile: { name: 'Bundled' } }],
      messages: [{ from: wa, id: `wamid.in.${randomUUID()}`, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'Hi' } }],
      statuses: [{ id: wamid, status: 'delivered', timestamp: String(Math.floor(Date.now() / 1000)), recipient_id: '1', pricing: { billable: true, category: 'marketing', pricing_model: 'PMP', type: 'regular' } }] } }] }] });
    await post(raw).expect(200);
    expect(await charges(id)).toBe(1);
    const failed = await app(async (tx) => (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM webhook_events WHERE failed_at IS NOT NULL AND received_at > now() - interval '1 minute'`)).rows[0]!.n);
    expect(failed).toBe(0);
    expect(await app(async (tx) => (await tx.query('SELECT 1 FROM contact_identifiers WHERE value = $1', [wa])).rowCount)).toBe(1);
    expect(await account()).toMatchObject({ availableMinor: 5000 - 60, reservedMinor: 0 });
  });

  it('refunds: the provider refusing gives the amount back; no answer leaves it pending until the worker settles it (H2)', async () => {
    await setAvailable(0);
    const top = await topUp(8000);
    provider_.refundScript.push('fail');
    const refused = (await owner.post('/v1/credits/refunds', { topupId: top, amountMinor: 1000, reason: 'Refused test' }).expect(201)).body;
    expect(refused.status).toBe('failed');
    expect((await account()).availableMinor).toBe(8000);
    expect((await owner.get('/v1/credits/topups').expect(200)).body.find((x: { id: string }) => x.id === top).refundedMinor).toBe(0);
    provider_.refundScript.push('throw');
    const pending = (await owner.post('/v1/credits/refunds', { topupId: top, amountMinor: 2000, reason: 'No answer test' }).expect(201)).body;
    expect(pending.status).toBe('pending');
    expect((await account()).availableMinor).toBe(6000);                       // taken out while waiting: cannot be spent twice
    await t.ownerDb.query('ALTER TABLE credit_refunds NO FORCE ROW LEVEL SECURITY');
    try { await t.ownerDb.query(`UPDATE credit_refunds SET created_at = now() - interval '10 minutes' WHERE id = $1`, [pending.id]); }
    finally { await t.ownerDb.query('ALTER TABLE credit_refunds FORCE ROW LEVEL SECURITY'); }
    await new CreditWorker(t.deps.db, provider_).settlePendingRefunds(500);
    const doc = (await owner.get(`/v1/credits/documents/${pending.id}`).expect(200)).body;
    expect(doc).toMatchObject({ type: 'credit_note', amountMinor: 2000 });
    expect((await account()).availableMinor).toBe(6000);
  });

  it('partial disputes, refunds before a dispute, and payments confirmed after failing (M3)', async () => {
    await setAvailable(0);
    const top = await topUp(6000);
    await owner.post('/v1/credits/refunds', { topupId: top, amountMinor: 2000, reason: 'Partly unused' }).expect(201);
    const before = (await account()).balanceMinor;
    const ev = provider_.event({ type: 'dispute.lost', providerRef: `pay_test_${top}`, amountMinor: 6000, currency: 'SAR', tenantId: tenant, topupId: top });
    expect((await http().post('/v1/webhooks/credits/test').set('Content-Type', 'application/json').set('X-CF-Payment-Signature', ev.signature).send(ev.raw).expect(200)).body.outcome).toBe('reversed');
    expect((await account()).balanceMinor).toBe(before - 4000);                // the refunded 2000 is not taken twice
    // A partial dispute of another top-up takes only that part.
    const top2 = await topUp(5000);
    const b2 = (await account()).balanceMinor;
    const part = provider_.event({ type: 'dispute.lost', providerRef: `pay_test_${top2}`, amountMinor: 1500, currency: 'SAR', tenantId: tenant, topupId: top2 });
    expect((await http().post('/v1/webhooks/credits/test').set('Content-Type', 'application/json').set('X-CF-Payment-Signature', part.signature).send(part.raw).expect(200)).body.outcome).toBe('reversed');
    expect((await account()).balanceMinor).toBe(b2 - 1500);
    // A second partial dispute of the same payment applies too (recheck N4), never more than the payment.
    const part2 = provider_.event({ type: 'dispute.lost', providerRef: `pay_test_${top2}`, amountMinor: 5000, currency: 'SAR', tenantId: tenant, topupId: top2 });
    expect((await http().post('/v1/webhooks/credits/test').set('Content-Type', 'application/json').set('X-CF-Payment-Signature', part2.signature).send(part2.raw).expect(200)).body.outcome).toBe('reversed');
    expect((await account()).balanceMinor).toBe(b2 - 5000);
    // A refund still pending when the bank takes the payment back does not shield part of it (recheck N3).
    const top3 = await topUp(6000);
    const b4 = (await account()).balanceMinor;
    provider_.refundScript.push('throw');
    const pend = (await owner.post('/v1/credits/refunds', { topupId: top3, amountMinor: 2000, reason: 'Pending during dispute' }).expect(201)).body;
    expect(pend.status).toBe('pending');
    const d3 = provider_.event({ type: 'dispute.lost', providerRef: `pay_test_${top3}`, amountMinor: 6000, currency: 'SAR', tenantId: tenant, topupId: top3 });
    await http().post('/v1/webhooks/credits/test').set('Content-Type', 'application/json').set('X-CF-Payment-Signature', d3.signature).send(d3.raw).expect(200);
    provider_.refundScript.push('fail');
    expect(await settleRefund(t.deps.db, provider_, tenant, pend.id)).toBe('failed');
    expect((await account()).balanceMinor).toBe(b4 - 6000);
    // Reported failed, then confirmed: credited once.
    const start = (await owner.post('/v1/credits/topups', { amountMinor: 5000 }).expect(201)).body;
    await owner.post(`/v1/credits/test/topups/${start.id}/complete`, { outcome: 'failed' }).expect(200);
    const b3 = (await account()).balanceMinor;
    const late = provider_.event({ type: 'payment.succeeded', providerRef: `pay_test_${start.id}`, amountMinor: 5000, currency: 'SAR', tenantId: tenant, topupId: start.id });
    expect((await http().post('/v1/webhooks/credits/test').set('Content-Type', 'application/json').set('X-CF-Payment-Signature', late.signature).send(late.raw).expect(200)).body.outcome).toBe('applied');
    expect((await account()).balanceMinor).toBe(b3 + 5000);
  });

  it('a refund the provider never answers stops being retried after 30 attempts and a person is told (recheck N6)', async () => {
    await setAvailable(0);
    const top = await topUp(5000);
    provider_.refundScript.push(...Array(31).fill('throw'));
    const r = (await owner.post('/v1/credits/refunds', { topupId: top, amountMinor: 1000, reason: 'Never answered' }).expect(201)).body;
    for (let i = 0; i < 29; i++) await settleRefund(t.deps.db, provider_, tenant, r.id);
    expect((await account()).notices.some((n) => n.kind === 'refund_stuck')).toBe(true);
    await t.ownerDb.query('ALTER TABLE credit_refunds NO FORCE ROW LEVEL SECURITY');
    try { await t.ownerDb.query(`UPDATE credit_refunds SET created_at = now() - interval '10 minutes' WHERE id = $1`, [r.id]); }
    finally { await t.ownerDb.query('ALTER TABLE credit_refunds FORCE ROW LEVEL SECURITY'); }
    await new CreditWorker(t.deps.db, provider_).settlePendingRefunds(500);   // no longer picked up
    provider_.refundScript.length = 0;
    expect((await owner.get(`/v1/credits/documents/${r.id}`)).status).toBe(404);
  });

  it('campaign messages waiting for the daily limit do not keep credit held (recheck N1)', async () => {
    await setAvailable(100000);
    const before = (await account()).reservedMinor;
    await app((tx) => tx.query('UPDATE tenant_settings SET campaign_daily_limit = 1, campaign_min_gap_hours = 0'));
    const conn = (await app(async (tx) => (await tx.query<{ id: string }>('SELECT id FROM channel_connections LIMIT 1')).rows[0]!.id));
    const c = (await owner.post('/v1/campaigns', { name: 'Credit wait', templateId: marketing.id, connectionId: conn, params: [{ source: 'static', value: 'friend' }] }).expect(201)).body;
    await owner.post(`/v1/campaigns/${c.id}/schedule`, { at: null }).expect(200);
    await new CampaignRunner(t.deps.db).runBatch(tenant, c.id);
    const queued = await app(async (tx) => (await tx.query<{ id: string; contact_id: string }>(
      `SELECT m.id, v.contact_id FROM messages m JOIN conversations v ON v.id = m.conversation_id WHERE m.campaign_id = $1`, [c.id])).rows);
    expect(queued.length).toBeGreaterThanOrEqual(1);
    // Today's single campaign send on this number is already used (as an earlier send would have).
    await app(async (tx) => {
      const conv = (await tx.query<{ id: string }>('SELECT conversation_id AS id FROM messages WHERE id = $1', [queued[0]!.id])).rows[0]!.id;
      const m = (await tx.query<{ id: string }>(
        `INSERT INTO messages (tenant_id, conversation_id, direction, kind, body, client_message_id, sent_by_membership_id, occurred_at, status, template_id, template_params, campaign_id)
         VALUES ($1, $2, 'out', 'template', 'Earlier', $3, $4, now(), 'sent', $5, '["x"]', $6) RETURNING id`, [tenant, conv, randomUUID(), ownerMembership, marketing.id, c.id])).rows[0]!;
      await tx.query(`INSERT INTO campaign_send_counts (tenant_id, message_id, attempt, campaign_id, connection_id, contact_id, counted_at) VALUES ($1, $2, 1, $3, $4, $5, now())`,
        [tenant, m.id, c.id, conn, queued[0]!.contact_id]);
    });
    await send();
    for (const q of queued) {
      expect((await msg(q.id)).status).toBe('queued');                          // waiting for room under the limit
      expect([null, 'released']).toContain((await reservation(q.id))?.state ?? null);
    }
    expect((await account()).reservedMinor).toBe(before);
    await owner.post(`/v1/campaigns/${c.id}/cancel`, {});
    await app((tx) => tx.query('UPDATE tenant_settings SET campaign_daily_limit = 1000'));
  });

  it('an event that does not match yet is not remembered, so the provider retry is applied (M4)', async () => {
    const start = (await owner.post('/v1/credits/topups', { amountMinor: 5000 }).expect(201)).body;
    const wrongRef = provider_.event({ id: 'evt_same', type: 'payment.succeeded', providerRef: 'pay_other', amountMinor: 5000, currency: 'SAR', tenantId: tenant, topupId: start.id });
    expect((await http().post('/v1/webhooks/credits/test').set('Content-Type', 'application/json').set('X-CF-Payment-Signature', wrongRef.signature).send(wrongRef.raw).expect(200)).body.outcome).toBe('unmatched:mismatch');   // kept for a person; not remembered as applied
    const right = provider_.event({ id: 'evt_same', type: 'payment.succeeded', providerRef: `pay_test_${start.id}`, amountMinor: 5000, currency: 'SAR', tenantId: tenant, topupId: start.id });
    expect((await http().post('/v1/webhooks/credits/test').set('Content-Type', 'application/json').set('X-CF-Payment-Signature', right.signature).send(right.raw).expect(200)).body.outcome).toBe('applied');
  });

  it('a hold stays while the message still waits to be sent; a message sent again is held again (M2)', async () => {
    await setAvailable(5000);
    const c = await customer(saudi());
    const id = await app(async (tx) => {
      const m = (await tx.query<{ id: string }>(
        `INSERT INTO messages (tenant_id, conversation_id, direction, kind, body, client_message_id, sent_by_membership_id, occurred_at, status, template_id, template_params)
         VALUES ($1, $2, 'out', 'template', 'x', $3, $4, clock_timestamp(), 'queued', $5, '["Sara"]') RETURNING id`, [tenant, c, randomUUID(), ownerMembership, marketing.id])).rows[0]!;
      return m.id;
    });
    // Held as if a campaign limit had kept it queued, for longer than the stale time.
    const card = (await app(async (tx) => (await tx.query<{ id: string }>(`SELECT id FROM credit_rate_cards WHERE currency = 'SAR' AND effective_from <= now() ORDER BY effective_from DESC LIMIT 1`)).rows[0]!.id));
    await app(async (tx) => {
      await tx.query(`INSERT INTO credit_reservations (message_id, tenant_id, rate_card_id, market, category, cost_minor, price_minor, margin_bp, created_at)
                      VALUES ($1, $2, $3, 'saudi_arabia', 'marketing', 50, 60, 2000, now() - interval '80 hours')`, [id, tenant, card]);
      await tx.query(`INSERT INTO credit_entries (tenant_id, kind, amount_minor, reserved_delta, message_id) VALUES ($1, 'reserve', 0, 60, $2)`, [tenant, id]);
    });
    await new CreditWorker(t.deps.db, null).releaseStale(500);
    expect(await reservation(id)).toMatchObject({ state: 'held' });
    // Released (as a failure would), then sent again: held again, once.
    await app(async (tx) => {
      await tx.query(`UPDATE credit_reservations SET state = 'released' WHERE message_id = $1`, [id]);
      await tx.query(`INSERT INTO credit_entries (tenant_id, kind, amount_minor, reserved_delta, message_id) VALUES ($1, 'release', 0, -60, $2)`, [tenant, id]);
      await tx.query('INSERT INTO send_jobs (tenant_id, message_id) VALUES ($1, $2)', [tenant, id]);
    });
    await send();
    expect(await reservation(id)).toMatchObject({ state: 'held' });
    expect((await account()).reservedMinor).toBe(60);
    await status((await msg(id)).provider_message_id!, 'failed').expect(200);
  });

  it('Meta sub-categories map to ours and a changed category is priced on the reserved card (M6)', async () => {
    await setAvailable(5000);
    const id = await queueTemplate(await customer(saudi()), marketing);
    await send();
    const res = await reservation(id);
    await status((await msg(id)).provider_message_id!, 'delivered', { billable: true, category: 'authentication_international' }).expect(200);
    const e = await app(async (tx) => (await tx.query<{ category: string; rate_card_id: string; amount_minor: string }>(
      `SELECT category, rate_card_id, amount_minor FROM credit_entries WHERE message_id = $1 AND kind = 'charge'`, [id])).rows[0]!);
    expect(e.category).toBe('authentication');
    expect(e.rate_card_id).toBe(res!.rate_card_id);
    expect(await account()).toMatchObject({ reservedMinor: 0 });
  });

  it('statements: months in the company time zone, invalid months refused; entries numbered in order (M5, L7)', async () => {
    await owner.get('/v1/credits/statements/2026-13').expect(400);
    const st = (await owner.get(`/v1/credits/statements/${new Date().toISOString().slice(0, 7)}`).expect(200)).body;
    expect(st.timezone).toBeTruthy();
    const seqs = await app(async (tx) => (await tx.query<{ seq: string }>('SELECT seq FROM credit_entries ORDER BY seq')).rows.map((r) => Number(r.seq)));
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));
    const a = await account();
    const last = await app(async (tx) => (await tx.query<{ b: string }>('SELECT balance_after AS b FROM credit_entries ORDER BY seq DESC LIMIT 1')).rows[0]!.b);
    expect(Number(last)).toBe(a.balanceMinor);
  });

  it('removing the saved card turns automatic top-up off (L9)', async () => {
    const card = (await owner.post('/v1/credits/test/methods', { last4: '4242' }).expect(201)).body;
    await owner.put('/v1/credits/auto-topup', { enabled: true, thresholdMinor: 100, amountMinor: 5000, dailyLimitMinor: 5000, methodId: card.id, consentText: AUTO_TOPUP_CONSENT, consentVersion: 1, consentLocale: 'en' }).expect(200);
    await owner.delete(`/v1/credits/methods/${card.id}`).expect(200);
    expect((await owner.get('/v1/credits').expect(200)).body.auto.enabled).toBe(false);
    await otherOwner.delete(`/v1/credits/methods/${card.id}`).expect(404);
  });

  it('automatic top-ups never confirmed are closed with a notice instead of blocking automatic top-up (M4)', async () => {
    const c = await newUser(t, 'cr-stuck');
    const tid = await newCompany(c, 'crstuck', 'business');
    await activateSubscription(t, tid);
    await enableMfa(c);
    await staff.put(`/v1/platform/tenants/${tid}/messaging-route`, { route: 'partner_360dialog', note: 'Test: partner route' }).expect(200);
    await staff.post(`/v1/platform/tenants/${tid}/credits/account`, { currency: 'SAR' }).expect(201);
    const id = await withContext(t.deps.db, { tenantId: tid, userId: null }, async (tx) => (await tx.query<{ id: string }>(
      `INSERT INTO credit_topups (tenant_id, amount_minor, currency, kind, provider, created_at) VALUES ($1, 5000, 'SAR', 'auto', 'test', now() - interval '1 hour') RETURNING id`, [tid])).rows[0]!.id);
    await new CreditWorker(t.deps.db, provider_).closeStuckAutoTopUps(500);
    const tops = (await c.get('/v1/credits/topups').expect(200)).body;
    expect(tops.find((x: { id: string }) => x.id === id)).toMatchObject({ status: 'cancelled', failureReason: 'not_confirmed' });
    expect((await c.get('/v1/credits').expect(200)).body.notices.some((n: { kind: string }) => n.kind === 'auto_topup_failed')).toBe(true);
  });
});

describe('monthly statement and reconciliation', () => {
  it('the company statement and the platform reconciliation agree with the ledger and flag partner differences', async () => {
    const month = new Date().toISOString().slice(0, 7);
    const st = (await owner.get(`/v1/credits/statements/${month}`).expect(200)).body;
    const a = await account();
    expect(st.closingMinor).toBe(a.balanceMinor);
    expect(st.openingMinor + st.topupsMinor - st.chargesMinor - st.refundsMinor - st.reversalsMinor + st.adjustmentsMinor).toBe(st.closingMinor);
    expect(st.chargedMessages).toBeGreaterThanOrEqual(2);
    const recRes = await staff.get(`/v1/platform/credits/reconciliation/${month}`);
    if (recRes.status !== 200) throw new Error(JSON.stringify(recRes.body));
    let rec = recRes.body.rows.find((r: { tenantId: string }) => r.tenantId === tenant);
    expect(rec).toMatchObject({ status: 'awaiting_partner_figure', charges: st.chargedMessages, priceMinor: st.chargesMinor });
    expect(rec.marginMinor).toBe(rec.priceMinor - rec.costMinor);
    const pc = await staff.put(`/v1/platform/tenants/${tenant}/credits/partner-cost`, { month, currency: 'SAR', costMinor: rec.costMinor, messageCount: rec.charges, reference: 'INV-TEST-1' });
    if (pc.status !== 200) throw new Error(JSON.stringify(pc.body));
    rec = (await staff.get(`/v1/platform/credits/reconciliation/${month}`).expect(200)).body.rows.find((r: { tenantId: string }) => r.tenantId === tenant);
    expect(rec).toMatchObject({ status: 'matched', differenceMinor: 0 });
    await staff.put(`/v1/platform/tenants/${tenant}/credits/partner-cost`, { month, currency: 'SAR', costMinor: rec.costMinor + 7, messageCount: rec.charges, reference: 'INV-TEST-2' }).expect(200);
    rec = (await staff.get(`/v1/platform/credits/reconciliation/${month}`).expect(200)).body.rows.find((r: { tenantId: string }) => r.tenantId === tenant);
    expect(rec).toMatchObject({ status: 'difference', differenceMinor: 7 });
    await owner.get('/v1/platform/credits/reconciliation/' + month).expect(403);
  });

  it('a company never sees another company’s credits', async () => {
    const other = await app(async (tx) => (await tx.query('SELECT * FROM credit_entries')).rows, otherTenant);
    expect(other).toHaveLength(0);
    expect((await otherOwner.get('/v1/credits').expect(200)).body).toMatchObject({ mode: 'meta_direct' });
  });
});

describe('configuration', () => {
  it('production refuses the test payment provider', () => {
    const prod = { ...process.env, NODE_ENV: 'production', SCANNER: 'clamd', SCANNER_REQUIRE_OFFICIAL_SIGNATURES: 'true', CHANNEL_SANDBOX_ENABLED: 'false',
      SMTP_URL: 'smtp://example.test', INBOUND_APPLY: 'worker', CREDITS_PROVIDER: undefined };
    expect(() => loadConfig({ ...prod, CREDITS_PROVIDER: 'test' })).toThrow(/CREDITS_PROVIDER=test/);
    expect(loadConfig(prod).CREDITS_PROVIDER).toBe('none');
    // Outside the test suite the test provider is off unless set explicitly (review L1).
    expect(loadConfig({ ...process.env, NODE_ENV: 'development', CREDITS_PROVIDER: undefined }).CREDITS_PROVIDER).toBe('none');
  });
});
