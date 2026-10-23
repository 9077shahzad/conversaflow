/**
 * Customer promise tracking (BRD v1.2 Wave 2, W2.6, CF-EXT-018, migration 0053).
 */
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withContext } from '@conversaflow/database';
import { signBody } from '../src/modules/channels';
import { detectPromise, PromiseWatcher } from '../src/modules/promises';
import { activateSubscription, addMember, enableMfa, newCompany, newUser, startApp, type Client, type TestApp } from './helpers';

let t: TestApp;
let owner: Client;
let agentA: Client;
let agentB: Client;
let analyst: Client;
let otherOwner: Client;
let tenant: string;
const NUMBER = `pn${randomUUID().slice(0, 8)}`;
let seq = 0;
const base = Math.floor(Math.random() * 5_000_000);
const fresh = () => `97156${String(base + ++seq).padStart(7, '0')}`;
const app = <T>(fn: Parameters<typeof withContext<T>>[2]) => withContext<T>(t.deps.db, { tenantId: tenant, userId: null }, fn);
function say(from: string, text: string) {
  const raw = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: NUMBER },
    contacts: [{ wa_id: from, profile: { name: 'Promise Customer' } }],
    messages: [{ from, id: `wamid.in.${randomUUID()}`, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }] } }] }] });
  return request(t.app.getHttpServer()).post('/v1/webhooks/sandbox').set('Content-Type', 'application/json')
    .set('X-Hub-Signature-256', signBody(t.deps.keys.sandboxWebhook, raw)).send(raw);
}
const conv = async (wa: string) => (await app((tx) => tx.query<{ id: string; version: number; activity_seq: string }>(
  `SELECT c.id, c.version, c.activity_seq FROM conversations c JOIN contact_identifiers ci ON ci.contact_id = c.contact_id WHERE ci.value = $1 ORDER BY c.created_at DESC LIMIT 1`, [wa]))).rows[0]!;
async function reply(as: Client, wa: string, text: string) {
  const c = await conv(wa);
  await as.post(`/v1/conversations/${c.id}/reply`, { text, seenActivity: Number(c.activity_seq), clientMessageId: randomUUID() }).expect(201);
  return c.id;
}
const promisesOf = async (as: Client, id: string) => (await as.get(`/v1/conversations/${id}/promises`).expect(200)).body as Array<{ id: string; status: string; dueAt: string; version: number; source: string; matchedText: string | null; ownerMembershipId: string | null }>;

beforeAll(async () => {
  t = await startApp();
  owner = await newUser(t, 'prom-owner');
  tenant = await newCompany(owner, 'prom', 'business');
  await activateSubscription(t, tenant);
  await enableMfa(owner);
  agentA = await addMember(t, owner, 'prom-a', 'agent');
  agentB = await addMember(t, owner, 'prom-b', 'agent');
  analyst = await addMember(t, owner, 'prom-an', 'analyst');
  await owner.post('/v1/channels', { provider: 'sandbox', providerNumberId: NUMBER, displayPhone: '+966500000099', label: 'Promises' }).expect(201);
  otherOwner = await newUser(t, 'prom-other');
  await activateSubscription(t, await newCompany(otherOwner, 'promother', 'business'));
});
afterAll(() => t?.close());

describe('detecting a commitment in a team reply', () => {
  // Sunday 25 October 2026, 10:00 in Riyadh (UTC+3).
  const now = new Date('2026-10-25T07:00:00Z');
  const at = (s: string) => detectPromise(s, now, 180)?.dueAt.toISOString() ?? null;
  it('English and Arabic phrasings with a time give a deadline in the company\'s time zone', () => {
    expect(at('I will call you tomorrow')).toBe('2026-10-26T15:00:00.000Z');          // 18:00 Riyadh
    expect(at("We'll send the technician within 2 hours")).toBe('2026-10-25T09:00:00.000Z');
    expect(at('We will confirm today')).toBe('2026-10-25T15:00:00.000Z');
    expect(at('I will visit on Tuesday')).toBe('2026-10-27T15:00:00.000Z');
    expect(at('سوف نتصل بك بكرة')).toBe('2026-10-26T15:00:00.000Z');
    expect(at('بنرسل الفني خلال ساعتين')).toBe('2026-10-25T09:00:00.000Z');
    expect(at('سنمر عليكم يوم الخميس')).toBe('2026-10-29T15:00:00.000Z');
    expect(at('سأرسل لك العرض خلال ٣ أيام')).toBe('2026-10-28T07:00:00.000Z');
  });
  it('no commitment, or no time, is not a promise', () => {
    expect(at('Thanks for your message')).toBeNull();
    expect(at('We will look into it')).toBeNull();                              // no time
    expect(at('The shop opens tomorrow')).toBeNull();                           // no commitment
    expect(at('شكرًا لتواصلك')).toBeNull();
  });
});

describe('promises in a conversation', () => {
  it('a reply with a commitment becomes a suggestion; the person confirms it; the history shows both', async () => {
    const wa = fresh();
    await say(wa, 'When can someone come?').expect(200);
    const id = await reply(agentA, wa, 'I will call you tomorrow to book the visit');
    const [p] = await promisesOf(agentA, id);
    expect(p).toMatchObject({ status: 'suggested', source: 'rule' });
    expect(p!.matchedText).toContain('tomorrow');
    await analyst.post(`/v1/promises/${p!.id}/confirm`, { expectedVersion: p!.version }).expect(403);
    await otherOwner.post(`/v1/promises/${p!.id}/confirm`, { expectedVersion: p!.version }).expect(404);
    const meA = (await agentA.get('/v1/me/access').expect(200)).body.membershipId;
    await agentA.post(`/v1/promises/${p!.id}/confirm`, { expectedVersion: p!.version }).expect(200);
    const [c] = await promisesOf(agentA, id);
    expect(c).toMatchObject({ status: 'confirmed', ownerMembershipId: meA });
    const ev = (await app((tx) => tx.query<{ kind: string }>(`SELECT kind FROM conversation_events WHERE conversation_id = $1 AND kind LIKE 'promise%' ORDER BY created_at`, [id]))).rows.map((r) => r.kind);
    expect(ev).toEqual(['promise_suggested', 'promise_confirmed']);
    // Mine: listed for A.
    expect((await agentA.get('/v1/promises').expect(200)).body.map((x: { id: string }) => x.id)).toContain(p!.id);
  });

  it('a person records a promise by hand; deadlines must be in the future; the owner must be able to reply', async () => {
    const wa = fresh();
    await say(wa, 'Please send a quote').expect(200);
    const c = await conv(wa);
    const due = new Date(Date.now() + 3 * 3600_000).toISOString();
    await agentA.post(`/v1/conversations/${c.id}/promises`, { description: 'Send the quote', dueAt: new Date(Date.now() - 1000).toISOString() }).expect(400);
    const analystId = (await analyst.get('/v1/me/access').expect(200)).body.membershipId;
    await agentA.post(`/v1/conversations/${c.id}/promises`, { description: 'Send the quote', dueAt: due, ownerMembershipId: analystId }).expect(400);
    const made = (await agentA.post(`/v1/conversations/${c.id}/promises`, { description: 'Send the quote', dueAt: due }).expect(201)).body;
    const [p] = await promisesOf(agentA, c.id);
    expect(p).toMatchObject({ id: made.id, status: 'confirmed', source: 'manual' });
  });

  it('the owner is warned an hour before; a passed deadline is missed; a miss can be recovered with a note, never undone', async () => {
    const wa = fresh();
    await say(wa, 'Can you come?').expect(200);
    const c = await conv(wa);
    const made = (await agentA.post(`/v1/conversations/${c.id}/promises`, { description: 'Technician visit', dueAt: new Date(Date.now() + 30 * 60_000).toISOString() }).expect(201)).body;
    const w = new PromiseWatcher(t.deps.db);
    await w.dispatchDue();
    let [p] = await promisesOf(agentA, c.id);
    expect(p!.status).toBe('confirmed');
    const warned = (await app((tx) => tx.query<{ w: Date | null }>('SELECT warned_at AS w FROM promises WHERE id = $1', [made.id]))).rows[0]!.w;
    expect(warned).toBeTruthy();
    // The deadline passes.
    await t.ownerDb.query('ALTER TABLE promises NO FORCE ROW LEVEL SECURITY');
    try { await t.ownerDb.query(`UPDATE promises SET due_at = now() - interval '1 minute' WHERE id = $1`, [made.id]); }
    finally { await t.ownerDb.query('ALTER TABLE promises FORCE ROW LEVEL SECURITY'); }
    await w.dispatchDue();
    [p] = await promisesOf(agentA, c.id);
    expect(p!.status).toBe('missed');
    await agentA.post(`/v1/promises/${made.id}/close`, { outcome: 'recovered', expectedVersion: p!.version }).expect(400);   // needs a note
    await agentA.post(`/v1/promises/${made.id}/close`, { outcome: 'cancelled', expectedVersion: p!.version }).expect(409);
    await agentA.post(`/v1/promises/${made.id}/close`, { outcome: 'recovered', note: 'Visited the next morning with a discount', expectedVersion: p!.version }).expect(200);
    [p] = await promisesOf(agentA, c.id);
    expect(p!.status).toBe('recovered');
    // The database refuses going back.
    await t.ownerDb.query('ALTER TABLE promises NO FORCE ROW LEVEL SECURITY');
    try { await expect(t.ownerDb.query(`UPDATE promises SET status = 'confirmed' WHERE id = $1`, [made.id])).rejects.toThrow(); }
    finally { await t.ownerDb.query('ALTER TABLE promises FORCE ROW LEVEL SECURITY'); }
    const ev = (await app((tx) => tx.query<{ kind: string }>(`SELECT kind FROM conversation_events WHERE conversation_id = $1 AND kind LIKE 'promise%' ORDER BY created_at`, [c.id]))).rows.map((r) => r.kind);
    expect(ev).toEqual(['promise_confirmed', 'promise_due_soon', 'promise_missed', 'promise_recovered']);
  });

  it('with automatic confirmation approved, a detected promise is confirmed for the writer; another agent cannot see a conversation assigned elsewhere', async () => {
    await agentA.put('/v1/promises/settings', { autoConfirm: true }).expect(403);
    await owner.put('/v1/promises/settings', { autoConfirm: true }).expect(200);
    const wa = fresh();
    await say(wa, 'Any news?').expect(200);
    const c = await conv(wa);
    const meA = (await agentA.get('/v1/me/access').expect(200)).body.membershipId;
    await owner.post(`/v1/conversations/${c.id}/assign`, { membershipId: meA, expectedVersion: c.version }).expect(200);
    await reply(agentA, wa, 'سوف نتصل بك بكرة');
    const [p] = await promisesOf(agentA, c.id);
    expect(p).toMatchObject({ status: 'confirmed', ownerMembershipId: meA });
    await agentB.get(`/v1/conversations/${c.id}/promises`).expect(404);
    await owner.put('/v1/promises/settings', { autoConfirm: false }).expect(200);
  });

  it('a suggestion that is not a real promise is dismissed', async () => {
    const wa = fresh();
    await say(wa, 'Hi').expect(200);
    const id = await reply(agentA, wa, 'We will be closed tomorrow for the holiday');
    const [p] = await promisesOf(agentA, id);
    expect(p!.status).toBe('suggested');
    await agentA.post(`/v1/promises/${p!.id}/close`, { outcome: 'dismissed', expectedVersion: p!.version }).expect(200);
    expect((await promisesOf(agentA, id))[0]!.status).toBe('dismissed');
  });
});
