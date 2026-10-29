/**
 * W1.9 (CF-EXT-005, FR-305): Click-to-WhatsApp ad attribution report, and resolving / reopening conversations.
 * Simulated WhatsApp (sandbox) and invented ads only.
 */
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withContext } from '@conversaflow/database';
import { signBody } from '../src/modules/channels';
import { ATTRIBUTION_WINDOW_DAYS } from '../src/modules/reports';
import { activateSubscription, addMember, enableMfa, newCompany, newUser, startApp, type Client, type TestApp } from './helpers';

let t: TestApp;
let owner: Client;
let agent: Client;
let agent2: Client;
let analyst: Client;
let otherOwner: Client;
let tenant: string;
const NUMBER = `pn${randomUUID().slice(0, 8)}`;
let seq = 0;
const base = Math.floor(Math.random() * 5_000_000);
const fresh = () => `97150${String(base + ++seq).padStart(7, '0')}`;
const app = <T>(fn: Parameters<typeof withContext<T>>[2]) => withContext<T>(t.deps.db, { tenantId: tenant, userId: null }, fn);
const AD = (id: string, headline = `Ad ${id}`) => ({ source_type: 'ad', source_id: id, source_url: `https://fb.me/${id}`, headline, ctwa_clid: `clid-${id}` });

function say(from: string, text: string, referral?: object) {
  const raw = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: NUMBER },
    contacts: [{ wa_id: from, profile: { name: 'Ad Customer' } }],
    messages: [{ from, id: `wamid.in.${randomUUID()}`, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text }, ...(referral ? { referral } : {}) }] } }] }] });
  return request(t.app.getHttpServer()).post('/v1/webhooks/sandbox').set('Content-Type', 'application/json')
    .set('X-Hub-Signature-256', signBody(t.deps.keys.sandboxWebhook, raw)).send(raw);
}
async function conv(wa: string) {
  return (await app((tx) => tx.query<{ id: string; version: number; status: string; activity_seq: string; resolved_at: Date | null; contact_id: string }>(
    `SELECT c.id, c.version, c.status, c.activity_seq, c.resolved_at, c.contact_id FROM conversations c JOIN contact_identifiers ci ON ci.contact_id = c.contact_id
     WHERE ci.value = $1 ORDER BY c.created_at DESC LIMIT 1`, [wa]))).rows[0]!;
}
const report = async (c: Client = owner, qs = '') => (await c.get(`/v1/reports/ads${qs}`).expect(200)).body;
type Row = { sourceId: string; conversations: number; medianFirstReplyMinutes: number | null };
const adRow = (r: { ads: Row[] }, id: string) => r.ads.find((a) => a.sourceId === id);

beforeAll(async () => {
  t = await startApp();
  owner = await newUser(t, 'ads-owner');
  tenant = await newCompany(owner, 'ads', 'business');
  await activateSubscription(t, tenant);
  await enableMfa(owner);
  agent = await addMember(t, owner, 'ads-agent', 'agent');
  agent2 = await addMember(t, owner, 'ads-agent2', 'agent');
  analyst = await addMember(t, owner, 'ads-analyst', 'analyst');
  await owner.post('/v1/channels', { provider: 'sandbox', providerNumberId: NUMBER, displayPhone: '+966500000088', label: 'Ads' }).expect(201);
  otherOwner = await newUser(t, 'ads-other');
  await activateSubscription(t, await newCompany(otherOwner, 'adsother', 'business'));
});
afterAll(() => t?.close());

describe('ad attribution', () => {
  it('a conversation started from an ad is credited to it; replies, resolution and opt-outs are counted; nothing names a customer', async () => {
    const adId = `ad${randomUUID().slice(0, 6)}`;
    const a = fresh(); const b = fresh(); const c = fresh();
    await say(a, 'Hi, I saw your AC offer', AD(adId, 'Autumn AC offer')).expect(200);
    await say(b, 'Price?', AD(adId, 'Autumn AC offer')).expect(200);
    await say(c, 'Is this still on?', AD(adId, 'Autumn AC offer')).expect(200);
    // The team replies to a, resolves b; c opts out.
    const ca = await conv(a);
    await owner.post(`/v1/conversations/${ca.id}/reply`, { text: 'Yes, booking now', seenActivity: Number(ca.activity_seq), clientMessageId: randomUUID() }).expect((r) => expect([200, 201]).toContain(r.status));
    const cb = await conv(b);
    await owner.post(`/v1/conversations/${cb.id}/status`, { status: 'resolved', expectedVersion: cb.version }).expect(200);
    await say(c, 'STOP').expect(200);
    const r = await report();
    const row = adRow(r, adId)!;
    expect(row).toMatchObject({ sourceType: 'ad', headline: 'Autumn AC offer', conversations: 3, newContacts: 3, replied: 1, resolved: 1, optedOut: 1 });
    expect(typeof row.medianFirstReplyMinutes).toBe('number');
    expect(r.model).toEqual({ rule: 'first_ad_tap_in_conversation', windowDays: ATTRIBUTION_WINDOW_DAYS });
    expect(JSON.stringify(r)).not.toContain(a);                       // counts only: no numbers, no names
    expect(JSON.stringify(r)).not.toContain('Ad Customer');
  });

  it('a later ad tap in the same conversation does not move the credit; a conversation without an ad counts as "not from an ad"', async () => {
    const first = `ad${randomUUID().slice(0, 6)}`; const second = `ad${randomUUID().slice(0, 6)}`;
    const wa = fresh(); const plain = fresh();
    const before = (await report()).totals;
    await say(wa, 'From the first ad', AD(first)).expect(200);
    await say(wa, 'Now from another ad', AD(second)).expect(200);
    await say(plain, 'Hello, no ad').expect(200);
    const r = await report();
    expect(adRow(r, first)!.conversations).toBe(1);
    expect(adRow(r, second)).toBeUndefined();
    expect(r.totals.conversationsStarted - before.conversationsStarted).toBe(2);
    expect(r.totals.fromAds - before.fromAds).toBe(1);
    expect(r.totals.notFromAds - before.notFromAds).toBe(1);
  });

  it('an existing customer brought back by an ad is not counted as new', async () => {
    const adId = `ad${randomUUID().slice(0, 6)}`; const wa = fresh();
    await say(wa, 'Hello').expect(200);
    const c1 = await conv(wa);
    await owner.post(`/v1/conversations/${c1.id}/status`, { status: 'resolved', expectedVersion: c1.version }).expect(200);
    await say(wa, 'Saw your ad', AD(adId)).expect(200);                // a new conversation, from an ad
    expect(adRow(await report(), adId)).toMatchObject({ conversations: 1, newContacts: 0 });
  });

  it('outcomes are counted only within the attribution window', async () => {
    const adId = `ad${randomUUID().slice(0, 6)}`; const wa = fresh();
    await say(wa, 'Old ad tap', AD(adId)).expect(200);
    const c = await conv(wa);
    // Recorded as if the ad tap had been more than the window ago; the conversation is resolved today.
    const db = await t.ownerDb.connect();
    try {
      await db.query('BEGIN');
      await db.query('CREATE POLICY test_age ON conversation_attributions FOR ALL TO CURRENT_USER USING (true) WITH CHECK (true)');
      await db.query(`UPDATE conversation_attributions SET first_message_at = now() - make_interval(days => $2) WHERE conversation_id = $1`, [c.id, ATTRIBUTION_WINDOW_DAYS + 2]);
      await db.query('DROP POLICY test_age ON conversation_attributions');
      await db.query('COMMIT');
    } finally { db.release(); }
    await owner.post(`/v1/conversations/${c.id}/status`, { status: 'resolved', expectedVersion: c.version }).expect(200);
    const day = (d: Date) => d.toISOString().slice(0, 10);
    const from = day(new Date(Date.now() - (ATTRIBUTION_WINDOW_DAYS + 5) * 86_400_000));
    // "Today" in the company's time zone (Asia/Dubai, UTC+4): after 20:00 UTC it is already tomorrow there.
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dubai' }).format(new Date());
    const r = await report(owner, `?from=${from}&to=${today}`);
    expect(adRow(r, adId)).toMatchObject({ conversations: 1, resolved: 0 });
  });

  it('reports need reports.read; the period is checked; another company sees none of it', async () => {
    await agent.get('/v1/reports/ads').expect(403);
    expect((await report(analyst)).ads.length).toBeGreaterThan(0);
    await owner.get('/v1/reports/ads?from=2026-01-01&to=2025-01-01').expect(400);
    await owner.get('/v1/reports/ads?from=2020-01-01&to=2026-10-01').expect(400);
    await owner.get('/v1/reports/ads?from=bad').expect(400);
    const other = await report(otherOwner);
    expect(other.ads).toEqual([]);
    expect(other.totals.fromAds).toBe(0);
  });
});

describe('resolving and reopening conversations', () => {
  it('resolving stops the reply timer and is recorded; the next customer message starts a new conversation; reopening the old one is then refused', async () => {
    const wa = fresh();
    await say(wa, 'Need help').expect(200);
    const c = await conv(wa);
    const res = (await agent.post(`/v1/conversations/${c.id}/status`, { status: 'resolved', expectedVersion: c.version }).expect(200)).body;
    expect(res).toMatchObject({ status: 'resolved' });
    const after = (await app((tx) => tx.query<{ status: string; resolved_at: Date | null; sla_kind: string | null }>('SELECT status, resolved_at, sla_kind FROM conversations WHERE id = $1', [c.id]))).rows[0]!;
    expect(after.status).toBe('resolved'); expect(after.resolved_at).not.toBeNull(); expect(after.sla_kind).toBeNull();
    const ev = (await app((tx) => tx.query<{ data: { from: string; to: string } }>(`SELECT data FROM conversation_events WHERE conversation_id = $1 AND kind = 'status_changed'`, [c.id]))).rows;
    expect(ev.map((e) => e.data)).toEqual([{ from: 'open', to: 'resolved' }]);
    await agent.post(`/v1/conversations/${c.id}/status`, { status: 'resolved', expectedVersion: res.version }).expect(409);
    await say(wa, 'Another question').expect(200);
    const c2 = await conv(wa);
    expect(c2.id).not.toBe(c.id);
    const r = await owner.post(`/v1/conversations/${c.id}/status`, { status: 'open', expectedVersion: res.version }).expect(409);
    expect(r.body.error.code).toBe('newer_conversation_open');
  });

  it('reopening works when nothing newer is open; a stale version is refused; someone else\'s conversation needs inbox.assign', async () => {
    const wa = fresh();
    await say(wa, 'Hello').expect(200);
    const c = await conv(wa);
    const agentId = (await agent.get('/v1/me/access').expect(200)).body.membershipId;
    const assigned = (await owner.post(`/v1/conversations/${c.id}/assign`, { membershipId: agentId, expectedVersion: c.version }).expect(200)).body;
    expect((await agent2.post(`/v1/conversations/${c.id}/status`, { status: 'resolved', expectedVersion: assigned.version }).expect((x) => expect([403, 404, 409]).toContain(x.status))).status).not.toBe(200);
    await owner.post(`/v1/conversations/${c.id}/status`, { status: 'resolved', expectedVersion: assigned.version - 1 }).expect(409);
    const done = (await owner.post(`/v1/conversations/${c.id}/status`, { status: 'resolved', expectedVersion: assigned.version }).expect(200)).body;
    const back = (await agent.post(`/v1/conversations/${c.id}/status`, { status: 'open', expectedVersion: done.version }).expect(200)).body;
    expect(back.status).toBe('open');
    expect((await conv(wa)).resolved_at).toBeNull();
  });
});

describe('second recheck of W1.9', () => {
  it('W2: an ad tapped today in a conversation that began earlier is not counted in today\'s ad rows or totals; rows add up to "from ads"', async () => {
    const today = (await report()).period.to;
    const adId = `ad${randomUUID().slice(0, 6)}`;
    const wa = fresh();
    await say(wa, 'Hello, no ad yet').expect(200);
    const c = await conv(wa);
    await t.ownerDb.query('ALTER TABLE conversations NO FORCE ROW LEVEL SECURITY');
    try { await t.ownerDb.query(`UPDATE conversations SET first_inbound_at = now() - interval '3 days' WHERE id = $1`, [c.id]); }
    finally { await t.ownerDb.query('ALTER TABLE conversations FORCE ROW LEVEL SECURITY'); }
    await say(wa, 'Now I tapped your ad', AD(adId)).expect(200);
    const r = await report(owner, `?from=${today}&to=${today}`);
    expect(adRow(r, adId)).toBeUndefined();
    const sum = r.ads.reduce((n: number, a: { conversations: number }) => n + a.conversations, 0);
    expect(sum).toBe(r.totals.fromAds);
  });
});

