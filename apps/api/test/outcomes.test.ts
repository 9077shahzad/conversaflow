/**
 * Outcome and cost dashboard (BRD v1.2 Wave 2, W2.9, CF-EXT-022). Simulated WhatsApp and simulated AI.
 */
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withContext } from '@conversaflow/database';
import { signBody } from '../src/modules/channels';
import { activateSubscription, addMember, enableMfa, newCompany, newUser, startApp, type Client, type TestApp } from './helpers';

let t: TestApp;
let owner: Client;
let agent: Client;
let analyst: Client;
let otherOwner: Client;
let tenant: string;
const NUMBER = `pn${randomUUID().slice(0, 8)}`;
let seq = 0;
const base = Math.floor(Math.random() * 5_000_000);
const fresh = () => `97158${String(base + ++seq).padStart(7, '0')}`;
const app = <T>(fn: Parameters<typeof withContext<T>>[2]) => withContext<T>(t.deps.db, { tenantId: tenant, userId: null }, fn);
function say(from: string, text: string) {
  const raw = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: NUMBER },
    contacts: [{ wa_id: from, profile: { name: 'Outcome Customer' } }],
    messages: [{ from, id: `wamid.in.${randomUUID()}`, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }] } }] }] });
  return request(t.app.getHttpServer()).post('/v1/webhooks/sandbox').set('Content-Type', 'application/json').set('X-Hub-Signature-256', signBody(t.deps.keys.sandboxWebhook, raw)).send(raw);
}
const conv = async (wa: string) => (await app((tx) => tx.query<{ id: string; version: number; activity_seq: string }>(
  `SELECT c.id, c.version, c.activity_seq FROM conversations c JOIN contact_identifiers ci ON ci.contact_id = c.contact_id WHERE ci.value = $1 ORDER BY c.created_at DESC LIMIT 1`, [wa]))).rows[0]!;
const report = async (c: Client = owner) => (await c.get('/v1/reports/outcomes').expect(200)).body;

beforeAll(async () => {
  t = await startApp();
  owner = await newUser(t, 'out-owner');
  tenant = await newCompany(owner, 'out', 'business');
  await activateSubscription(t, tenant);
  await enableMfa(owner);
  agent = await addMember(t, owner, 'out-agent', 'agent');
  analyst = await addMember(t, owner, 'out-an', 'analyst');
  await owner.post('/v1/channels', { provider: 'sandbox', providerNumberId: NUMBER, displayPhone: '+966500000033', label: 'Outcomes' }).expect(201);
  otherOwner = await newUser(t, 'out-other');
  await activateSubscription(t, await newCompany(otherOwner, 'outother', 'business'));
});
afterAll(() => t?.close());

describe('outcome dashboard', () => {
  it('counts started, resolved with and without a person, repeat contacts, replies by who, and says what it cannot measure', async () => {
    const before = await report();
    const a = fresh(); const b = fresh();
    await say(a, 'Need a plumber').expect(200);
    await say(b, 'Just saying thanks').expect(200);
    const ca = await conv(a);
    await owner.post(`/v1/conversations/${ca.id}/reply`, { text: 'On our way', seenActivity: Number(ca.activity_seq), clientMessageId: randomUUID() }).expect(201);
    const ca2 = await conv(a);
    await owner.post(`/v1/conversations/${ca2.id}/status`, { status: 'resolved', expectedVersion: ca2.version }).expect(200);
    const cb = await conv(b);
    await owner.post(`/v1/conversations/${cb.id}/status`, { status: 'resolved', expectedVersion: cb.version }).expect(200);
    // Customer a comes back: a repeat contact.
    await say(a, 'The leak is back').expect(200);
    const r = await report();
    expect(r.conversations.started - before.conversations.started).toBe(3);
    expect(r.conversations.repeatWithin30Days - before.conversations.repeatWithin30Days).toBe(1);
    expect(r.conversations.resolved - before.conversations.resolved).toBe(2);
    expect(r.conversations.resolvedWithoutPerson - before.conversations.resolvedWithoutPerson).toBe(1);
    expect(r.replies.byPeople - before.replies.byPeople).toBe(1);
    expect(r.costs).toMatchObject({ includes: ['ai'], missing: ['whatsapp_messages', 'team_time'] });
    expect(r.notMeasuredYet.map((x: { what: string }) => x.what)).toEqual(['bookings_and_orders', 'payments_and_refunds', 'satisfaction', 'whatsapp_costs']);
    expect(JSON.stringify(r)).not.toContain('Outcome Customer');
  });

  it('promises due in the period: kept on time, missed and put right', async () => {
    const before = (await report()).promises;
    const wa = fresh();
    await say(wa, 'When?').expect(200);
    const c = await conv(wa);
    const due = new Date(Date.now() + 3600_000).toISOString();
    const kept = (await owner.post(`/v1/conversations/${c.id}/promises`, { description: 'Call back', dueAt: due }).expect(201)).body;
    await owner.post(`/v1/promises/${kept.id}/close`, { outcome: 'kept', expectedVersion: 0 }).expect(200);
    await owner.post(`/v1/conversations/${c.id}/promises`, { description: 'Send quote', dueAt: due }).expect(201);
    const p = (await report()).promises;
    expect(p.due - before.due).toBe(2);
    expect(p.keptOnTime - before.keptOnTime).toBe(1);
    expect(p.stillOpen - before.stillOpen).toBe(1);
  });

  it('analysts may read it (reports.read); agents may not; another company sees only its own numbers', async () => {
    await report(analyst);
    await agent.get('/v1/reports/outcomes').expect(403);
    const theirs = await report(otherOwner);
    expect(theirs.conversations.started).toBe(0);
    await owner.get('/v1/reports/outcomes?from=2026-01-01&to=2027-06-01').expect(400);
  });
});
