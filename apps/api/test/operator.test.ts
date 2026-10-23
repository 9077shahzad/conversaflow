/**
 * Conversa Operator slice 1 (Operator addendum v1.0, migration 0059): price lists, cases, quote versions, approval,
 * sending and the customer's acceptance. Covers AC-04, AC-05, AC-06, parts of AC-08, AC-18, AC-19 and AC-20.
 * WhatsApp is the sandbox here; nothing leaves the machine.
 */
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withContext } from '@conversaflow/database';
import { signBody } from '../src/modules/channels';
import { QuoteExpiryWorker, quoteMessage } from '../src/modules/operator';
import { Sender } from '../src/modules/sender';
import { formatMoney, priceQuote, RateCard } from '../src/modules/operator-pricing';
import { activateSubscription, addMember, enableMfa, newCompany, newUser, startApp, type Client, type TestApp } from './helpers';

let t: TestApp;
let owner: Client;
let supervisor: Client;
let agent: Client;
let otherOwner: Client;
let tenant: string;
const NUMBER = `pn${randomUUID().slice(0, 8)}`;
let seq = 0;
const base = Math.floor(Math.random() * 5_000_000);
const fresh = () => `97158${String(base + ++seq).padStart(7, '0')}`;
const app = <T>(fn: Parameters<typeof withContext<T>>[2]) => withContext<T>(t.deps.db, { tenantId: tenant, userId: null }, fn);
const http = () => request(t.app.getHttpServer());
function say(from: string, text: string) {
  const raw = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: NUMBER },
    contacts: [{ wa_id: from, profile: { name: 'Operator Customer' } }],
    messages: [{ from, id: `wamid.in.${randomUUID()}`, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }] } }] }] });
  return http().post('/v1/webhooks/sandbox').set('Content-Type', 'application/json').set('X-Hub-Signature-256', signBody(t.deps.keys.sandboxWebhook, raw)).send(raw);
}
const conv = async (wa: string) => (await app((tx) => tx.query<{ id: string; version: number }>(
  `SELECT c.id, c.version FROM conversations c JOIN contact_identifiers ci ON ci.contact_id = c.contact_id WHERE ci.value = $1 ORDER BY c.created_at DESC LIMIT 1`, [wa]))).rows[0]!;
const portal = (token: string) => ({
  view: () => http().get('/v1/quote').set('X-Quote-Link', token),
  accept: (body: object) => http().post('/v1/quote/accept').set('X-Requested-With', 'conversaflow').set('X-Quote-Link', token).send(body),
});
const tokenOf = async (messageId: string) => {
  const body = (await app((tx) => tx.query<{ body: string }>('SELECT body FROM messages WHERE id = $1', [messageId]))).rows[0]!.body;
  return /#([A-Za-z0-9_-]{43})/.exec(body)![1]!;
};
/** Sends a quote as a person who has read the conversation up to now. */
const sendQ = async (as: Client, id: string, expectedVersion: number, status = 200) => {
  const a = (await app((tx) => tx.query<{ a: string }>(`SELECT c.activity_seq AS a FROM op_quotes q JOIN op_cases k ON k.id = q.case_id
    JOIN conversations c ON c.id = k.conversation_id WHERE q.id = $1`, [id]))).rows[0];
  return as.post(`/v1/operator/quotes/${id}/send`, { expectedVersion, seenActivity: Number(a?.a ?? 0) }).expect(status);
};
const asOwnerQ = async (table: string, sql: string, params: unknown[]) => {
  await t.ownerDb.query(`ALTER TABLE ${table} NO FORCE ROW LEVEL SECURITY`);
  try { return await t.ownerDb.query(sql, params); } finally { await t.ownerDb.query(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`); }
};

/** The AC maintenance price list used as the pricing fixture (amounts in halalas). */
const CARD = {
  currency: 'SAR', taxRateBp: 1500, taxLabel: 'VAT', calloutCharge: 5000, minimumCharge: 20000, manualDiscountLimitBp: 1000, approvalAbove: 500000,
  depositBp: 2000, validityHours: 48, areas: { khobar: 0, dammam: 2500 },
  services: [
    { serviceKey: 'split_service', nameEn: 'Split AC service', nameAr: 'صيانة مكيف سبليت', kind: 'fixed', unitPrice: 12000, maxQuantity: 20, unitCost: 6000,
      tiers: [{ fromQuantity: 4, discountBp: 1000 }, { fromQuantity: 8, discountBp: 1500 }] },
    { serviceKey: 'window_service', nameEn: 'Window AC service', nameAr: 'صيانة مكيف شباك', kind: 'fixed', unitPrice: 9000 },
    { serviceKey: 'fault_inspection', nameEn: 'AC fault inspection', nameAr: 'معاينة عطل مكيف', kind: 'inspection', unitPrice: 9900 },
  ],
};

beforeAll(async () => {
  t = await startApp();
  owner = await newUser(t, 'op-owner');
  tenant = await newCompany(owner, 'op', 'business');
  await activateSubscription(t, tenant);
  await enableMfa(owner);
  supervisor = await addMember(t, owner, 'op-sup', 'supervisor');
  await enableMfa(supervisor);
  agent = await addMember(t, owner, 'op-agent', 'agent');
  await owner.post('/v1/channels', { provider: 'sandbox', providerNumberId: NUMBER, displayPhone: '+966500000055', label: 'Operator' }).expect(201);
  otherOwner = await newUser(t, 'op-other');
  await activateSubscription(t, await newCompany(otherOwner, 'opother', 'business'));
  await enableMfa(otherOwner);
});
afterAll(() => t?.close());

describe('deterministic pricing (AC-04, AC-05)', () => {
  const card = RateCard.parse(CARD);
  it('fixtures match to the halala', () => {
    // 4 split units in Khobar: 4 × 120.00 = 480.00, tier 10% = 48.00 → 432.00; callout 50.00 → 482.00; VAT 15% = 72.30 → 554.30; deposit 20% = 110.86.
    const a = priceQuote(card, { lines: [{ serviceKey: 'split_service', quantity: 4 }], areaKey: 'khobar' });
    expect(a).toMatchObject({ ok: true, taxable: 48200, tax: 7230, total: 55430, deposit: 11086, inspectionOnly: false, needsApproval: [] });
    // 1 window unit in Dammam: 90.00 + callout 50.00 + travel 25.00 = 165.00 → minimum 200.00 (top-up 35.00); VAT 30.00 → 230.00.
    const b = priceQuote(card, { lines: [{ serviceKey: 'window_service', quantity: 1 }], areaKey: 'dammam' });
    expect(b).toMatchObject({ ok: true, minimumTopUp: 3500, taxable: 20000, tax: 3000, total: 23000 });
    // A manual discount above the card's limit needs approval; it never touches callout or travel.
    const c = priceQuote(card, { lines: [{ serviceKey: 'split_service', quantity: 2 }], areaKey: 'khobar', manualDiscountBp: 2000 });
    expect(c).toMatchObject({ ok: true, manualDiscount: 4800, taxable: 24000 + 5000 - 4800, needsApproval: ['manual_discount'] });
    // Half-up rounding on odd amounts.
    const odd = RateCard.parse({ ...CARD, calloutCharge: 0, minimumCharge: 0, services: [{ ...CARD.services[1], unitPrice: 333 }] });
    expect(priceQuote(odd, { lines: [{ serviceKey: 'window_service', quantity: 1 }], areaKey: 'khobar' })).toMatchObject({ tax: 50, total: 383 });
  });
  it('an unknown fault is an inspection visit, never a repair price; mixing is refused', () => {
    const i = priceQuote(card, { lines: [{ serviceKey: 'fault_inspection', quantity: 3 }], areaKey: 'khobar' });
    expect(i).toMatchObject({ ok: true, inspectionOnly: true });
    expect(i.ok && i.lines[0]!.quantity).toBe(1);
    expect(priceQuote(card, { lines: [{ serviceKey: 'fault_inspection', quantity: 1 }, { serviceKey: 'split_service', quantity: 1 }], areaKey: 'khobar' })).toMatchObject({ ok: false, reason: 'mixed_inspection' });
    expect(priceQuote(card, { lines: [{ serviceKey: 'split_service', quantity: 1 }], areaKey: 'riyadh' })).toMatchObject({ ok: false, reason: 'outside_area' });
    expect(priceQuote(card, { lines: [{ serviceKey: 'split_service', quantity: 21 }], areaKey: 'khobar' })).toMatchObject({ ok: false, reason: 'quantity' });
  });
  it('currencies keep their own decimals; messages are fixed wording', () => {
    expect(formatMoney(55430, 'SAR')).toBe('554.30 SAR');
    expect(formatMoney(1234, 'KWD')).toBe('1.234 KWD');
    const a = priceQuote(card, { lines: [{ serviceKey: 'split_service', quantity: 4 }], areaKey: 'khobar' });
    if (!a.ok) throw new Error('fixture');
    const en = quoteMessage('en', 1, a, new Date('2026-10-25T12:00:00Z'), 'https://x.test/en/q#t', 'Asia/Riyadh');
    expect(en).toContain('554.30 SAR');
    expect(en).toContain('does not book a time');
    expect(quoteMessage('ar', 1, a, new Date('2026-10-25T12:00:00Z'), 'https://x.test/ar/q#t', 'Asia/Riyadh')).toContain('554.30 ر.س');
  });
  it('a price list that contradicts itself is refused', () => {
    expect(RateCard.safeParse({ ...CARD, services: [CARD.services[0], CARD.services[0]] }).success).toBe(false);
    expect(RateCard.safeParse({ ...CARD, areas: {} }).success).toBe(false);
  });
});

describe('set-up and access', () => {
  it('the module stays off until a published price list and terms in both languages exist; only operator.manage changes it', async () => {
    await owner.put('/v1/operator/settings', { enabled: true }).expect(409);
    await supervisor.put('/v1/operator/settings', { termsEn: 'x' }).expect(403);
    await agent.post('/v1/operator/rate-cards', { card: CARD }).expect(403);
    await owner.post('/v1/operator/rate-cards', { card: { ...CARD, currency: 'XYZ' } }).expect(400);
    const rc = (await owner.post('/v1/operator/rate-cards', { card: CARD, note: 'First list' }).expect(201)).body;
    await owner.post(`/v1/operator/rate-cards/${rc.id}/publish`).expect(200);
    await owner.post(`/v1/operator/rate-cards/${rc.id}/publish`).expect(409);
    await owner.put('/v1/operator/settings', { termsEn: 'Prices include VAT. Cancellation free up to 4 hours before the visit.', termsAr: 'الأسعار شاملة الضريبة. الإلغاء مجاني حتى 4 ساعات قبل الزيارة.' }).expect(200);
    await owner.put('/v1/operator/settings', { enabled: true, mode: 'assist' }).expect(200);
    const s = (await agent.get('/v1/operator/settings').expect(200)).body;
    expect(s).toMatchObject({ enabled: true, mode: 'assist', paused: false, publishedRateCard: { version: rc.version } });
    // A published list never changes.
    await expect(asOwnerQ('op_rate_cards', `UPDATE op_rate_cards SET card = '{}'::jsonb WHERE id = $1`, [rc.id])).rejects.toThrow();
    // Another company sees none of it.
    expect((await otherOwner.get('/v1/operator/rate-cards').expect(200)).body).toHaveLength(0);
  });
});

describe('quotes (AC-06, AC-08, AC-18–AC-20)', () => {
  async function caseFor(as: Client = agent) {
    const wa = fresh();
    await say(wa, 'أحتاج صيانة أربع وحدات تكييف غداً مساءً في الخبر').expect(200);
    const c = await conv(wa);
    const k = (await as.post(`/v1/operator/conversations/${c.id}/cases`).expect(201)).body;
    return { wa, c, k };
  }

  it('a case records facts with their state; unknown stays unknown; one open case per conversation', async () => {
    const { c, k } = await caseFor();
    expect((await agent.post(`/v1/operator/conversations/${c.id}/cases`).expect(201)).body).toMatchObject({ id: k.id, existing: true });
    await agent.patch(`/v1/operator/cases/${k.id}/facts`, { facts: { quantity: { state: 'stated' } }, expectedVersion: 0 }).expect(400);
    await agent.patch(`/v1/operator/cases/${k.id}/facts`, { facts: { quantity: { state: 'stated', value: '4', original: 'أربع وحدات' }, area: { state: 'confirmed', value: 'khobar' } }, expectedVersion: 0 }).expect(200);
    await agent.patch(`/v1/operator/cases/${k.id}/facts`, { facts: { access: { state: 'unknown' } }, expectedVersion: 0 }).expect(409);
    const got = (await agent.get(`/v1/operator/cases/${k.id}`).expect(200)).body;
    expect(got.facts.quantity).toMatchObject({ state: 'stated', value: '4', original: 'أربع وحدات', source: 'person' });
    expect(got.facts.preferred_time).toMatchObject({ state: 'unknown' });
    expect(got.events.map((e: { kind: string }) => e.kind)).toEqual(['case_opened', 'facts_updated']);
    await otherOwner.get(`/v1/operator/cases/${k.id}`).expect(404);
  });

  it('a quote is sent as fixed wording with a single-use link; opening never accepts; acceptance is once, for that version', async () => {
    const { k } = await caseFor();
    const q = (await agent.post(`/v1/operator/cases/${k.id}/quotes`, { lines: [{ serviceKey: 'split_service', quantity: 4 }], areaKey: 'khobar' }).expect(201)).body;
    expect(q).toMatchObject({ number: 1, status: 'draft', priced: { total: 55430 } });
    const sent = (await sendQ(agent, q.id, 0, 200)).body;
    const token = await tokenOf(sent.messageId);
    const v = (await portal(token).view().expect(200)).body;
    expect(v).toMatchObject({ number: 1, status: 'sent', total: 55430, tax: 7230, deposit: 11086, canAccept: true, currency: 'SAR' });
    expect(JSON.stringify(v)).not.toContain('unitCost');
    expect((await agent.get(`/v1/operator/cases/${k.id}`).expect(200)).body.quotes[0].status).toBe('sent');   // opening did not accept
    await portal(token).accept({ quoteNumber: 1 }).expect(400);                  // explicit agreement needed
    await portal(token).accept({ quoteNumber: 1, agree: true }).expect(200);
    expect((await portal(token).accept({ quoteNumber: 1, agree: true }).expect(200)).body).toMatchObject({ status: 'accepted' });   // replay: same result, once
    const n = (await app((tx) => tx.query<{ n: number }>('SELECT count(*)::int AS n FROM op_acceptances WHERE quote_id = $1', [q.id]))).rows[0]!.n;
    expect(n).toBe(1);
    const got = (await agent.get(`/v1/operator/cases/${k.id}`).expect(200)).body;
    expect(got.quotes[0]).toMatchObject({ status: 'accepted', acceptance: { channel: 'customer_link' } });
    expect(got.events.map((e: { kind: string }) => e.kind)).toEqual(['case_opened', 'quote_created', 'quote_sent', 'quote_accepted']);
    // The link now shows the honest outcome, and offers nothing more to do.
    expect((await portal(token).view().expect(200)).body).toMatchObject({ status: 'accepted', canAccept: false });
    // Wrong and missing tokens never say why.
    await portal('A'.repeat(43)).view().expect(403);
    await http().get('/v1/quote').expect(403);
  });

  it('a new version supersedes the old one and its link; an expired quote cannot be accepted (AC-06)', async () => {
    const { k } = await caseFor();
    const q1 = (await agent.post(`/v1/operator/cases/${k.id}/quotes`, { lines: [{ serviceKey: 'split_service', quantity: 2 }], areaKey: 'khobar' }).expect(201)).body;
    const s1 = (await sendQ(agent, q1.id, 0, 200)).body;
    const t1 = await tokenOf(s1.messageId);
    const q2 = (await agent.post(`/v1/operator/cases/${k.id}/quotes`, { lines: [{ serviceKey: 'split_service', quantity: 3 }], areaKey: 'khobar' }).expect(201)).body;
    expect(q2.number).toBe(2);
    await portal(t1).accept({ quoteNumber: 1, agree: true }).expect(403);       // superseded: its link was revoked
    const s2 = (await sendQ(agent, q2.id, 0, 200)).body;
    const t2 = await tokenOf(s2.messageId);
    await portal(t2).accept({ quoteNumber: 1, agree: true }).expect(409);       // not the version on this link
    // Validity ends.
    await t.ownerDb.query('ALTER TABLE op_quotes DISABLE TRIGGER op_quotes_guard');
    try { await asOwnerQ('op_quotes', `UPDATE op_quotes SET valid_until = now() - interval '1 minute' WHERE id = $1`, [q2.id]); }
    finally { await t.ownerDb.query('ALTER TABLE op_quotes ENABLE TRIGGER op_quotes_guard'); }
    await portal(t2).accept({ quoteNumber: 2, agree: true }).expect(409);
    expect(await new QuoteExpiryWorker(t.deps.db).dispatchDue()).toBeGreaterThanOrEqual(1);
    const got = (await agent.get(`/v1/operator/cases/${k.id}`).expect(200)).body;
    expect(got.quotes.map((x: { number: number; status: string }) => [x.number, x.status])).toEqual([[2, 'expired'], [1, 'superseded']]);
    // A quote's content never changes.
    await expect(asOwnerQ('op_quotes', `UPDATE op_quotes SET total_minor = 1 WHERE id = $1`, [q1.id])).rejects.toThrow();
  });

  it('a quote that needs approval waits; its author cannot approve it while someone else can; the inspection path', async () => {
    const { k } = await caseFor();
    const q = (await agent.post(`/v1/operator/cases/${k.id}/quotes`, { lines: [{ serviceKey: 'split_service', quantity: 2 }], areaKey: 'khobar', manualDiscountBp: 2000 }).expect(201)).body;
    expect(q).toMatchObject({ status: 'pending_approval', priced: { needsApproval: ['manual_discount'] } });
    await sendQ(agent, q.id, 0, 409);
    await agent.post(`/v1/operator/quotes/${q.id}/approve`, { expectedVersion: 0 }).expect(403);   // no approval permission
    const list = (await supervisor.get('/v1/operator/approvals').expect(200)).body;
    expect(list.map((x: { id: string }) => x.id)).toContain(q.id);
    await supervisor.post(`/v1/operator/quotes/${q.id}/approve`, { expectedVersion: 0 }).expect(200);
    await sendQ(agent, q.id, 1, 200);
    // Large orders stay under the approval amount when the tiers apply.
    const { k: k2 } = await caseFor(owner);
    const big = (await owner.post(`/v1/operator/cases/${k2.id}/quotes`, { lines: [{ serviceKey: 'split_service', quantity: 20 }], areaKey: 'dammam', manualDiscountBp: 500 }).expect(201)).body;
    expect(big.status).toBe('draft');                                    // 20 × 120 less 15%: under the approval amount
    const { k: k3 } = await caseFor(owner);
    const insp = (await owner.post(`/v1/operator/cases/${k3.id}/quotes`, { lines: [{ serviceKey: 'fault_inspection', quantity: 2 }], areaKey: 'khobar' }).expect(201)).body;
    expect(insp.priced).toMatchObject({ inspectionOnly: true });
    const got = (await owner.get(`/v1/operator/cases/${k3.id}`).expect(200)).body;
    expect(got.quotes[0].scopeEn).toContain('repair price is given after the inspection');
    await owner.post(`/v1/operator/cases/${k3.id}/quotes`, { lines: [{ serviceKey: 'split_service', quantity: 1 }], areaKey: 'riyadh' }).expect(400);
  });

  it('the emergency pause stops sending; terms changed after a quote need a new version; staff-recorded acceptance needs a note (AC-20)', async () => {
    const { k } = await caseFor();
    const q = (await agent.post(`/v1/operator/cases/${k.id}/quotes`, { lines: [{ serviceKey: 'window_service', quantity: 1 }], areaKey: 'khobar' }).expect(201)).body;
    await agent.post('/v1/operator/pause').expect(403);
    await owner.post('/v1/operator/pause', { reason: 'Checking prices' }).expect(200);
    expect((await sendQ(agent, q.id, 0, 409)).body.error.code).toBe('operator_paused');
    await owner.post('/v1/operator/resume').expect(200);
    const sent = (await sendQ(agent, q.id, 0, 200)).body;
    await agent.post(`/v1/operator/quotes/${q.id}/record-acceptance`, { evidenceNote: 'Customer agreed on a call at 10:05', expectedVersion: 1 }).expect(403);
    await supervisor.post(`/v1/operator/quotes/${q.id}/record-acceptance`, { evidenceNote: 'ok', expectedVersion: 1 }).expect(400);
    await supervisor.post(`/v1/operator/quotes/${q.id}/record-acceptance`, { evidenceNote: 'Customer agreed on a call at 10:05', expectedVersion: 1 }).expect(200);
    await portal(await tokenOf(sent.messageId)).view().expect(403);      // an unused link closes when the acceptance is recorded another way
    const { k: k2 } = await caseFor();
    const q2 = (await agent.post(`/v1/operator/cases/${k2.id}/quotes`, { lines: [{ serviceKey: 'window_service', quantity: 1 }], areaKey: 'khobar' }).expect(201)).body;
    const s = (await owner.get('/v1/operator/settings').expect(200)).body;
    await owner.put('/v1/operator/settings', { termsEn: `${s.termsEn} Parking is the customer's responsibility.` }).expect(200);
    expect((await sendQ(agent, q2.id, 0, 409)).body.error.code).toBe('terms_changed');
  });

  it('every reply check applies to quote messages; another company cannot reach quotes or links', async () => {
    const { c, k } = await caseFor();
    const q = (await agent.post(`/v1/operator/cases/${k.id}/quotes`, { lines: [{ serviceKey: 'window_service', quantity: 2 }], areaKey: 'khobar' }).expect(201)).body;
    await sendQ(otherOwner, q.id, 0, 404);
    await otherOwner.post(`/v1/operator/cases/${k.id}/quotes`, { lines: [{ serviceKey: 'window_service', quantity: 1 }], areaKey: 'khobar' }).expect(409);   // their module is off
    // The customer opts out: the quote cannot be sent.
    await app((tx) => tx.query('UPDATE contacts SET opted_out_at = now() WHERE id = (SELECT contact_id FROM conversations WHERE id = $1)', [c.id]));
    expect((await sendQ(agent, q.id, 0, 409)).body.error.code).toBe('contact_opted_out');
    const st = (await app((tx) => tx.query<{ status: string }>('SELECT status FROM op_quotes WHERE id = $1', [q.id]))).rows[0]!.status;
    expect(st).toBe('draft');
  });
});

describe('review of Operator slice 1', () => {
  const card = RateCard.parse(CARD);
  it('pricing: the minimum charge applies after a discount; one line per service; a ceiling on totals', () => {
    // 1 window unit (90.00), 50% off = 45.00 → 45.00 + callout 50.00 = 95.00 → minimum 200.00.
    const r = priceQuote(card, { lines: [{ serviceKey: 'window_service', quantity: 1 }], areaKey: 'khobar', manualDiscountBp: 5000 });
    expect(r).toMatchObject({ ok: true, manualDiscount: 4500, minimumTopUp: 10500, taxable: 20000 });
    expect(priceQuote(card, { lines: [{ serviceKey: 'split_service', quantity: 1 }, { serviceKey: 'split_service', quantity: 2 }], areaKey: 'khobar' })).toMatchObject({ ok: false, reason: 'duplicate_line' });
    const huge = RateCard.parse({ ...CARD, services: [{ ...CARD.services[1], unitPrice: 1_000_000_000, maxQuantity: 100 }] });
    expect(priceQuote(huge, { lines: [{ serviceKey: 'window_service', quantity: 100 }], areaKey: 'khobar' })).toMatchObject({ ok: false, reason: 'too_large' });
  });

  async function sentQuote() {
    const wa = fresh();
    await say(wa, 'Two window units please').expect(200);
    const c = await conv(wa);
    const k = (await agent.post(`/v1/operator/conversations/${c.id}/cases`).expect(201)).body;
    const q = (await agent.post(`/v1/operator/cases/${k.id}/quotes`, { lines: [{ serviceKey: 'window_service', quantity: 2 }], areaKey: 'khobar' }).expect(201)).body;
    return { wa, c, k, q };
  }

  it('quote links are masked for staff, and quote text never becomes a promise; quote messages are not retried', async () => {
    const { c, k, q } = await sentQuote();
    const sent = (await sendQ(agent, q.id, 0)).body;
    const msgs = (await agent.get(`/v1/conversations/${c.id}`).expect(200)).body;
    const text = JSON.stringify(msgs);
    expect(text).toContain('/q#••••••');
    expect(text).not.toMatch(/\/q#[A-Za-z0-9_-]{43}/);
    const promises = (await agent.get(`/v1/conversations/${c.id}/promises`).expect(200)).body;
    expect(promises).toHaveLength(0);
    await app((tx) => tx.query(`UPDATE messages SET status = 'failed', failure_kind = 'rejected' WHERE id = $1`, [sent.messageId]));
    expect((await agent.post(`/v1/messages/${sent.messageId}/retry`, { seenActivity: 0, clientMessageId: randomUUID() }).expect(409)).body.error.code).toBe('quote_message');
    expect(k.id).toBeTruthy();
  });

  it('a quote waiting to be delivered is held by the pause and blocked once withdrawn (AC-20)', async () => {
    const { q } = await sentQuote();
    const sent = (await sendQ(agent, q.id, 0)).body;
    // Put the message back in the queue as if the first attempt had not happened yet.
    await app(async (tx) => {
      await tx.query(`UPDATE messages SET status = 'queued', provider_message_id = NULL WHERE id = $1`, [sent.messageId]);
      await tx.query(`UPDATE send_jobs SET state = 'leased', lease_until = now() + interval '1 minute' WHERE message_id = $1`, [sent.messageId]);
    }).catch(() => undefined);
    const job = (await app((tx) => tx.query<{ id: string }>('SELECT id FROM send_jobs WHERE message_id = $1', [sent.messageId]))).rows[0]!.id;
    await owner.post('/v1/operator/pause', {}).expect(200);
    const sender = new Sender(t.deps.db, t.deps.channels);
    expect(await sender.processJob(tenant, job)).toBe('retry_later');
    await owner.post('/v1/operator/resume').expect(200);
    await agent.post(`/v1/operator/quotes/${q.id}/withdraw`, { expectedVersion: 1 }).expect(200);
    await app((tx) => tx.query(`UPDATE send_jobs SET state = 'leased', lease_until = now() + interval '1 minute' WHERE id = $1`, [job]));
    expect(await sender.processJob(tenant, job)).toBe('failed');
    const m = (await app((tx) => tx.query<{ error_code: string }>('SELECT error_code FROM messages WHERE id = $1', [sent.messageId]))).rows[0]!;
    expect(m.error_code).toBe('quote_closed');
  });

  it('sending needs the latest messages read; a new draft version puts the case back to open; someone else\'s conversation is theirs', async () => {
    const { wa, c, k, q } = await sentQuote();
    const before = (await app((tx) => tx.query<{ a: string }>('SELECT activity_seq AS a FROM conversations WHERE id = $1', [c.id]))).rows[0]!.a;
    await say(wa, 'Actually, cancel please').expect(200);
    expect((await agent.post(`/v1/operator/quotes/${q.id}/send`, { expectedVersion: 0, seenActivity: Number(before) }).expect(409)).body.error.code).toBe('conversation_changed');
    await sendQ(agent, q.id, 0);
    expect((await agent.get(`/v1/operator/cases/${k.id}`).expect(200)).body.status).toBe('waiting_customer');
    await agent.post(`/v1/operator/cases/${k.id}/quotes`, { lines: [{ serviceKey: 'window_service', quantity: 1 }], areaKey: 'khobar' }).expect(201);
    expect((await agent.get(`/v1/operator/cases/${k.id}`).expect(200)).body.status).toBe('open');
    // The supervisor sees the conversation but the agent is handling it: no new version from the supervisor.
    expect((await supervisor.post(`/v1/operator/cases/${k.id}/quotes`, { lines: [{ serviceKey: 'window_service', quantity: 3 }], areaKey: 'khobar' }).expect(409)).body.error.code).toBe('assigned_to_other');
  });

  it('a used or revoked link cannot be revived, and approval details never change', async () => {
    const { q } = await sentQuote();
    const sent = (await sendQ(agent, q.id, 0)).body;
    await portal(await tokenOf(sent.messageId)).accept({ quoteNumber: 1, agree: true }).expect(200);
    await expect(asOwnerQ('op_quote_links', 'UPDATE op_quote_links SET used_at = NULL WHERE quote_id = $1', [q.id])).rejects.toThrow();
    const audit = (await t.ownerDb.query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_events WHERE tenant_id = $1 AND target_id = $2 AND action = 'operator.quote_accepted_by_customer'`, [tenant, q.id])).rows[0]!.n;
    expect(audit).toBe(1);
  });
});

