/**
 * Demonstration of the complete prepaid flow in test mode (owner instruction 5): payment → credit → message through the
 * partner → delivery charged → monthly reconciliation, including failures and delayed or repeated webhooks.
 * 360dialog and Stripe are the local stand-ins (test/fakes.ts). Every step is checked and written to a transcript
 * (set CF_DEMO_TRANSCRIPT to a file path to keep it).
 */
import { writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withContext } from '@conversaflow/database';
import { partnerFundingCheck } from '../src/modules/credits';
import { stripeSignature } from '../src/modules/stripe';
import { Fake360dialog, FakeStripe } from './fakes';
import { activateSubscription, enableMfa, newCompany, newStaff, newUser, startApp, type Client, type TestApp } from './helpers';

const TOKEN = 'demo-partner-token-' + 'z'.repeat(32);
const KEY = 'sk_test_' + 'd'.repeat(24);
const WHSEC = 'whsec_' + 'e'.repeat(24);
let t: TestApp; let d360: Fake360dialog; let stripe: FakeStripe; let staff: Client; let owner: Client; let tenant: string;
const NUMBER = `9665${Date.now() % 100000000}`;
const ACCOUNT = `wabademo${randomUUID().slice(0, 6)}`;
const API_KEY = `d360demo_${randomUUID()}`;
const lines: string[] = [];
const log = (s: string) => lines.push(s);
const sar = (minor: number) => `SAR ${(minor / 100).toFixed(2)}`;
const http = () => request(t.app.getHttpServer());
const app = <T>(fn: Parameters<typeof withContext<T>>[2]) => withContext<T>(t.deps.db, { tenantId: tenant, userId: null }, fn);
const hook = (payload: unknown) => http().post('/v1/webhooks/dialog360').set('Content-Type', 'application/json').set('X-CF-Partner-Token', TOKEN).send(JSON.stringify(payload));
const statusHook = (wamid: string, status: string, pricing?: Record<string, unknown>, callback?: string) => hook({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: {
  metadata: { phone_number_id: NUMBER }, statuses: [{ id: wamid, status, timestamp: String(Math.floor(Date.now() / 1000)), recipient_id: '1',
    ...(callback ? { biz_opaque_callback_data: callback } : {}), ...(pricing ? { pricing } : {}), ...(status === 'failed' ? { errors: [{ code: 131026 }] } : {}) }] } }] }] });
const stripeHook = (event: Record<string, unknown>) => {
  const raw = JSON.stringify(event);
  return http().post('/v1/webhooks/credits/stripe').set('Content-Type', 'application/json').set('Stripe-Signature', stripeSignature(WHSEC, Math.floor(Date.now() / 1000), raw)).send(raw);
};
const balance = async () => (await owner.get('/v1/credits').expect(200)).body as { balanceMinor: number; reservedMinor: number; availableMinor: number };
const msg = (id: string) => app(async (tx) => (await tx.query<{ status: string; error_code: string | null; provider_message_id: string | null }>(
  'SELECT status, error_code, provider_message_id FROM messages WHERE id = $1', [id])).rows[0]!);
const BILLABLE = { billable: true, pricing_model: 'PMP', type: 'regular', category: 'marketing' };

beforeAll(async () => {
  d360 = await new Fake360dialog().start(); d360.keys.set(API_KEY, NUMBER);
  stripe = await new FakeStripe(KEY).start();
  t = await startApp({ DIALOG360_WEBHOOK_TOKEN: TOKEN, DIALOG360_BASE_URL: d360.url, CREDITS_PROVIDER: 'stripe', STRIPE_SECRET_KEY: KEY, STRIPE_WEBHOOK_SECRET: WHSEC, STRIPE_API_BASE: stripe.url });
  staff = await newStaff(t, 'demo-staff', 'platform_owner');
  owner = await newUser(t, 'demo-owner');
  tenant = await newCompany(owner, 'demo', 'business');
  await activateSubscription(t, tenant);
  await enableMfa(owner);
});
afterAll(async () => {
  if (process.env.CF_DEMO_TRANSCRIPT) writeFileSync(process.env.CF_DEMO_TRANSCRIPT, lines.join('\n') + '\n');
  await t?.close(); await d360?.stop(); await stripe?.stop();
});

describe('payment → message → reconciliation (test mode)', () => {
  it('runs end to end, with failures and delayed or repeated webhooks', async () => {
    log('# Prepaid message credits: payment to message to reconciliation (test mode)');
    log('');
    log(`Run ${new Date().toISOString()}. 360dialog and Stripe are local stand-ins; no money moves and nothing leaves the machine.`);
    log('Every line below was checked by the test as it ran.');
    log('');
    log('## 1. Set-up by a platform owner');
    await staff.put(`/v1/platform/tenants/${tenant}/messaging-route`, { route: 'partner_360dialog', note: 'Demo company on the partner route' }).expect(200);
    log('- Company put on the partner route (it was on the direct Meta route, like every existing company).');
    await staff.post(`/v1/platform/tenants/${tenant}/partner-channels`, { providerNumberId: NUMBER, displayPhone: '+966500000123', label: 'Demo', accountId: ACCOUNT, apiKey: API_KEY }).expect(201);
    log('- Its WhatsApp number connected through 360dialog; the number\'s API key stored sealed.');
    await staff.post(`/v1/platform/tenants/${tenant}/credits/account`, { currency: 'SAR', lowThresholdMinor: 2000 }).expect(201);
    await staff.post('/v1/platform/credits/rate-cards', { currency: 'SAR', effectiveFrom: new Date(Date.now() + 400).toISOString(), source: 'Demo rates (not Meta prices)',
      markets: [{ prefix: '966', market: 'saudi_arabia' }],
      lines: [{ market: 'saudi_arabia', category: 'marketing', unitCostMinor: 25 }, { market: 'saudi_arabia', category: 'utility', unitCostMinor: 5 },
        { market: 'saudi_arabia', category: 'authentication', unitCostMinor: 5 }, { market: 'other', category: 'marketing', unitCostMinor: 50 },
        { market: 'other', category: 'utility', unitCostMinor: 10 }, { market: 'other', category: 'authentication', unitCostMinor: 10 }] }).expect(201);
    await new Promise((r) => setTimeout(r, 500));
    log('- Credit account opened in SAR; rate card published (Saudi marketing cost SAR 0.25, margin 20%, price SAR 0.30).');
    expect(await balance()).toMatchObject({ balanceMinor: 0 });

    log('');
    log('## 2. The customer company pays');
    const failedTop = (await owner.post('/v1/credits/topups', { amountMinor: 10000 }).expect(201)).body;
    const s1 = [...stripe.sessions.values()].at(-1)!;
    expect((await stripeHook({ id: `evt_${randomUUID()}`, type: 'checkout.session.expired', data: { object: s1 } }).expect(200)).body.outcome).toBe('failed_recorded');
    log(`- Top-up of ${sar(10000)} started; the customer abandoned Stripe Checkout (session expired): recorded as failed, no credit. Balance ${sar((await balance()).balanceMinor)}.`);
    void failedTop;
    const top = (await owner.post('/v1/credits/topups', { amountMinor: 20000 }).expect(201)).body;
    const s2 = [...stripe.sessions.values()].at(-1)!;
    stripe.pay(String(s2.id));
    const paid = { id: `evt_${randomUUID()}`, type: 'checkout.session.completed', data: { object: stripe.sessions.get(String(s2.id)) } };
    expect((await stripeHook(paid).expect(200)).body.outcome).toBe('applied');
    expect((await stripeHook(paid).expect(200)).body.outcome).toBe('duplicate');
    expect((await stripeHook({ ...paid, id: `evt_${randomUUID()}` }).expect(200)).body.outcome).toBe('already_applied');
    const receipt = (await owner.get('/v1/credits/topups').expect(200)).body.find((x: { id: string }) => x.id === top.id).receiptNo;
    log(`- Top-up of ${sar(20000)} paid at Stripe; the signed webhook credited it once (repeated twice, and once more under a new event id: no extra credit). Receipt ${receipt}. Balance ${sar((await balance()).balanceMinor)}.`);
    expect((await balance()).balanceMinor).toBe(20000);

    log('');
    log('## 3. Messages through 360dialog');
    const wa = '966551112233';
    await hook({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: NUMBER },
      contacts: [{ wa_id: wa, profile: { name: 'Demo Customer' } }], messages: [{ from: wa, id: `wamid.in.${randomUUID()}`, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'Hi' } }] } }] }] }).expect(200);
    const conv = (await app(async (tx) => (await tx.query<{ id: string; contact_id: string }>(
      `SELECT c.id, c.contact_id FROM conversations c JOIN contact_identifiers ci ON ci.contact_id = c.contact_id WHERE ci.value = $1`, [wa])).rows[0]!));
    await app(async (tx) => {
      await tx.query(`UPDATE conversations SET last_inbound_at = now() - interval '30 hours' WHERE id = $1`, [conv.id]);
      await tx.query('UPDATE contacts SET marketing_consent_at = now() WHERE id = $1', [conv.contact_id]);
    });
    const tpl = (await owner.post('/v1/templates', { name: 'demo_offer', language: 'en', category: 'marketing', bodyText: 'Hi {{1}}, our AC offer is open.', examples: ['Sara'] }).expect(201)).body;
    await hook({ object: 'whatsapp_business_account', entry: [{ id: ACCOUNT, time: Math.floor(Date.now() / 1000), changes: [{ field: 'message_template_status_update',
      value: { event: 'APPROVED', message_template_id: Number(tpl.providerTemplateId), message_template_name: 'demo_offer', message_template_language: 'en', reason: null } }] }] }).expect(200);
    log('- Customer wrote in (inbound webhook from 360dialog, secret header checked); marketing template submitted through 360dialog and approved.');
    const send = async () => {
      const cv = (await owner.get(`/v1/conversations/${conv.id}`).expect(200)).body;
      return (await owner.post(`/v1/conversations/${conv.id}/template`, { templateId: tpl.id, params: ['Sara'], seenActivity: cv.activitySeq, clientMessageId: randomUUID() }).expect(201)).body.id as string;
    };
    const m1 = await send();
    let b = await balance();
    log(`- Template sent to 360dialog: ${sar(30)} held before sending. Balance ${sar(b.balanceMinor)}, held ${sar(b.reservedMinor)}, available ${sar(b.availableMinor)}.`);
    expect(b).toMatchObject({ reservedMinor: 30, availableMinor: 19970 });
    const wamid1 = (await msg(m1)).provider_message_id!;
    await statusHook(wamid1, 'read', BILLABLE).expect(200);
    await statusHook(wamid1, 'delivered', BILLABLE).expect(200);
    await statusHook(wamid1, 'delivered', BILLABLE).expect(200);
    b = await balance();
    log(`- Meta's reports arrived out of order and repeated (read, then delivered twice): charged once. Balance ${sar(b.balanceMinor)}, held ${sar(b.reservedMinor)}.`);
    expect(b).toMatchObject({ balanceMinor: 19970, reservedMinor: 0 });

    d360.script.push({ status: 400, error: { code: 131026, message: 'Message undeliverable' } });
    const m2 = await send();
    expect(await msg(m2)).toMatchObject({ status: 'failed' });
    log(`- 360dialog refused the next one (${(await msg(m2)).error_code}): not sent, hold given back. Available ${sar((await balance()).availableMinor)}.`);
    expect((await balance()).availableMinor).toBe(19970);

    d360.script.push('drop');
    const m3 = await send();
    expect((await msg(m3)).status).toBe('uncertain');
    log('- The connection dropped after the next one was sent: marked "uncertain" (never sent again automatically); its hold stays until WhatsApp reports.');
    expect((await balance()).reservedMinor).toBe(30);
    await statusHook(`wamid.late.${randomUUID()}`, 'delivered', BILLABLE, m3).expect(200);
    b = await balance();
    log(`- WhatsApp's delayed delivery report found it by our callback reference: charged once. Balance ${sar(b.balanceMinor)}, held ${sar(b.reservedMinor)}.`);
    expect(b).toMatchObject({ balanceMinor: 19940, reservedMinor: 0 });

    // A status that arrives before the send is recorded is kept and applied afterwards.
    const early = `wamid.early.${randomUUID()}`;
    await statusHook(early, 'delivered', BILLABLE).expect(200);
    log('- A delivery report for a message not yet recorded was kept aside (no charge, no error) to be applied when the message is recorded.');

    log('');
    log('## 4. Refund and chargeback');
    const ref = (await owner.post('/v1/credits/refunds', { topupId: top.id, amountMinor: 5000, reason: 'Unused credit' }).expect(201)).body;
    const cn = (await owner.get(`/v1/credits/documents/${ref.id}`).expect(200)).body.number;
    log(`- ${sar(5000)} of unused credit refunded through Stripe (idempotency key = our refund id); credit note ${cn}. Balance ${sar((await balance()).balanceMinor)}.`);
    stripe.refundScript.push('failed');
    expect((await owner.post('/v1/credits/refunds', { topupId: top.id, amountMinor: 1000, reason: 'Refused refund' }).expect(201)).body.status).toBe('failed');
    log(`- A second refund was refused by Stripe: the ${sar(1000)} went back into the balance. Balance ${sar((await balance()).balanceMinor)}.`);
    expect((await balance()).balanceMinor).toBe(14940);
    const pi = String(stripe.sessions.get(String(s2.id))!.payment_intent);
    const dispute = { id: `evt_${randomUUID()}`, type: 'charge.dispute.closed', data: { object: { id: 'dp_demo', status: 'lost', payment_intent: pi, amount: 20000, currency: 'sar', reason: 'fraudulent' } } };
    expect((await stripeHook(dispute).expect(200)).body.outcome).toBe('reversed');
    expect((await stripeHook(dispute).expect(200)).body.outcome).toBe('duplicate');
    log(`- The bank took the ${sar(20000)} payment back (dispute lost, reported twice): only the ${sar(15000)} not already refunded was taken back, once. Balance ${sar((await balance()).balanceMinor)}.`);
    expect((await balance()).balanceMinor).toBe(-60);
    const blocked = await send();
    expect((await msg(blocked)).error_code).toBe('insufficient_credit');
    log('- With the balance below zero, the next paid message was not sent (insufficient credit) until the company tops up.');

    log('');
    log('## 5. Monthly reconciliation');
    const month = new Date().toISOString().slice(0, 7);
    let rec = (await staff.get(`/v1/platform/credits/reconciliation/${month}`).expect(200)).body.rows.find((r: { tenantId: string }) => r.tenantId === tenant);
    log(`- Before the partner's invoice: ${rec.charges} charged messages, price ${sar(rec.priceMinor)}, Meta cost ${sar(rec.costMinor)}, margin ${sar(rec.marginMinor)}; status ${rec.status}.`);
    expect(rec).toMatchObject({ charges: 2, priceMinor: 60, costMinor: 50, marginMinor: 10, status: 'awaiting_partner_figure' });
    await staff.put(`/v1/platform/tenants/${tenant}/credits/partner-cost`, { month, currency: 'SAR', costMinor: 50, messageCount: 2, reference: 'D360-INV-DEMO' }).expect(200);
    rec = (await staff.get(`/v1/platform/credits/reconciliation/${month}`).expect(200)).body.rows.find((r: { tenantId: string }) => r.tenantId === tenant);
    log(`- Partner invoice entered (${sar(50)} for 2 messages): status ${rec.status}, difference ${sar(rec.differenceMinor)}.`);
    expect(rec).toMatchObject({ status: 'matched', differenceMinor: 0 });
    const st = (await owner.get(`/v1/credits/statements/${month}`).expect(200)).body;
    log(`- Company statement: opening ${sar(st.openingMinor)}, top-ups ${sar(st.topupsMinor)}, ${st.chargedMessages} messages ${sar(st.chargesMinor)}, refunds ${sar(st.refundsMinor)}, taken back by the bank ${sar(st.reversalsMinor)}, closing ${sar(st.closingMinor)} (= ledger balance).`);
    expect(st.closingMinor).toBe((await balance()).balanceMinor);

    log('');
    log('## 6. Partner funding (separate from customer money)');
    await staff.post('/v1/platform/partner/funding', { what: 'entry', kind: 'funding', amountMinor: 50000, currency: 'USD', reference: `DEMO-WIRE-${randomUUID().slice(0, 6)}` }).expect(201);
    await staff.post('/v1/platform/partner/funding', { what: 'balance', amountMinor: 40000, currency: 'USD' }).expect(201);
    const f = await partnerFundingCheck(t.deps.db);
    log(`- Meronatic funded the partner with USD 500.00; 360dialog balance recorded at USD 400.00. Monitor: cost per day USD ${((f!.dailyCostMinor ?? 0) / 100).toFixed(2)}, customers' unspent credit USD ${((f!.customerLiabilityMinor ?? 0) / 100).toFixed(2)}, buffer required USD ${((f!.requiredBufferMinor ?? 0) / 100).toFixed(2)}, open alerts: ${f!.openAlerts.join(', ') || 'none'}.`);
    expect(f!.openAlerts).toContain('partner_balance_low');

    log('');
    log('## Result');
    log('All steps passed.');
  });
});
