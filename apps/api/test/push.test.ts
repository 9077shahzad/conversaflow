/**
 * Notifications on agents' devices (BRD v1.2 Wave 2, W2.5, CF-EXT-013, migration 0052).
 * The push service is the recording sender: nothing reaches a real browser in these tests.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withContext } from '@conversaflow/database';
import { signBody } from '../src/modules/channels';
import { isPushServiceUrl, PushWorker, RecordingPushSender } from '../src/modules/push';
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
const fresh = () => `97155${String(base + ++seq).padStart(7, '0')}`;
const app = <T>(fn: Parameters<typeof withContext<T>>[2]) => withContext<T>(t.deps.db, { tenantId: tenant, userId: null }, fn);
const device = () => ({ endpoint: `https://push.example.test/${randomUUID()}`, keys: { p256dh: randomBytes(65).toString('base64url'), auth: randomBytes(16).toString('base64url') } });
function say(from: string, text: string) {
  const raw = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: NUMBER },
    contacts: [{ wa_id: from, profile: { name: 'Hidden Name' } }],
    messages: [{ from, id: `wamid.in.${randomUUID()}`, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }] } }] }] });
  return request(t.app.getHttpServer()).post('/v1/webhooks/sandbox').set('Content-Type', 'application/json')
    .set('X-Hub-Signature-256', signBody(t.deps.keys.sandboxWebhook, raw)).send(raw);
}
const conv = async (wa: string) => (await app((tx) => tx.query<{ id: string; version: number }>(
  `SELECT c.id, c.version FROM conversations c JOIN contact_identifiers ci ON ci.contact_id = c.contact_id WHERE ci.value = $1 ORDER BY c.created_at DESC LIMIT 1`, [wa]))).rows[0]!;
const sender = () => t.deps.push as RecordingPushSender;
async function send() { const w = new PushWorker(t.deps.db, t.deps.push); while ((await w.dispatchDue(100)) > 0) { /* drain */ } }
const sentTo = (endpoint: string) => sender().sent.filter((s) => s.endpoint === endpoint);

beforeAll(async () => {
  t = await startApp();
  owner = await newUser(t, 'push-owner');
  tenant = await newCompany(owner, 'push', 'business');
  await activateSubscription(t, tenant);
  await enableMfa(owner);
  agentA = await addMember(t, owner, 'push-a', 'agent');
  agentB = await addMember(t, owner, 'push-b', 'agent');
  analyst = await addMember(t, owner, 'push-an', 'analyst');
  await owner.post('/v1/channels', { provider: 'sandbox', providerNumberId: NUMBER, displayPhone: '+966500000088', label: 'Push' }).expect(201);
  otherOwner = await newUser(t, 'push-other');
  await activateSubscription(t, await newCompany(otherOwner, 'pushother', 'business'));
});
afterAll(() => t?.close());

describe('devices and preferences', () => {
  it('a member adds and removes their own devices; others cannot touch them; analysts have no notifications', async () => {
    expect((await agentA.get('/v1/me/notifications/info').expect(200)).body).toEqual({ publicKey: null, delivery: 'recording' });
    const d = device();
    const id = (await agentA.post('/v1/me/notifications/devices', d).expect(201)).body.id;
    // The same device again is updated, not added twice.
    expect((await agentA.post('/v1/me/notifications/devices', d).expect(201)).body.id).toBe(id);
    expect((await agentA.get('/v1/me/notifications/devices').expect(200)).body).toHaveLength(1);
    expect((await agentB.get('/v1/me/notifications/devices').expect(200)).body).toHaveLength(0);
    await agentB.delete(`/v1/me/notifications/devices/${id}`).expect(404);
    await otherOwner.delete(`/v1/me/notifications/devices/${id}`).expect(404);
    await analyst.get('/v1/me/notifications/devices').expect(403);
    await agentA.post('/v1/me/notifications/devices', { ...device(), endpoint: 'http://insecure.example.test/x' }).expect(400);
    await agentA.post('/v1/me/notifications/devices/remove', { endpoint: d.endpoint }).expect(200);
    expect((await agentA.get('/v1/me/notifications/devices').expect(200)).body).toHaveLength(0);
  });

  it('at most 10 devices per member', async () => {
    for (let i = 0; i < 10; i++) await agentB.post('/v1/me/notifications/devices', device()).expect(201);
    expect((await agentB.post('/v1/me/notifications/devices', device())).body.error.code).toBe('too_many_devices');
    for (const x of (await agentB.get('/v1/me/notifications/devices').expect(200)).body) await agentB.delete(`/v1/me/notifications/devices/${x.id}`).expect(200);
  });
});

describe('who is told, and what the alert says', () => {
  it('the assigned person is told; nobody else is unless they asked for unassigned conversations', async () => {
    const a = device(); const b = device();
    await agentA.post('/v1/me/notifications/devices', a).expect(201);
    await agentB.post('/v1/me/notifications/devices', b).expect(201);
    // Unassigned conversation: nobody asked to hear about those yet.
    const wa = fresh();
    await say(wa, 'My AC is leaking, here is my address 12 King Fahd Road').expect(200);
    await send();
    expect(sentTo(a.endpoint)).toHaveLength(0);
    expect(sentTo(b.endpoint)).toHaveLength(0);
    // B asks for unassigned conversations.
    await agentB.put('/v1/me/notifications/preferences', { assigned: true, unassigned: true, customerRequests: true }).expect(200);
    await say(wa, 'Hello?').expect(200);
    await send();
    expect(sentTo(b.endpoint)).toHaveLength(1);
    expect(sentTo(a.endpoint)).toHaveLength(0);
    // Assigned to A: only A hears about the next message.
    const c = await conv(wa);
    const aId = (await agentA.get('/v1/me/access').expect(200)).body.membershipId;
    await owner.post(`/v1/conversations/${c.id}/assign`, { membershipId: aId, expectedVersion: c.version }).expect(200);
    await say(wa, 'Anyone there?').expect(200);
    await send();
    expect(sentTo(a.endpoint)).toHaveLength(1);
    expect(sentTo(b.endpoint)).toHaveLength(1);
    const alert = sentTo(a.endpoint)[0]!.payload;
    expect(alert.url).toBe(`/en/app/inbox?c=${c.id}`);
    // Nothing the customer wrote, their name or number appears in the alert.
    const text = JSON.stringify(alert);
    for (const secret of ['leaking', 'King Fahd', 'Hidden Name', wa, 'Anyone']) expect(text).not.toContain(secret);
  });

  it('a burst of messages is one alert per device until it is sent; STOP and START do not alert', async () => {
    const d = device();
    await agentB.post('/v1/me/notifications/devices', d).expect(201);
    const wa = fresh();
    for (const m of ['one', 'two', 'three']) await say(wa, m).expect(200);
    await send();
    expect(sentTo(d.endpoint)).toHaveLength(1);
    await say(wa, 'STOP').expect(200);
    await send();
    expect(sentTo(d.endpoint)).toHaveLength(1);
  });

  it('a device the push service says is gone is removed with its waiting alerts', async () => {
    const d = device();
    await agentB.post('/v1/me/notifications/devices', d).expect(201);
    sender().gone.add(d.endpoint);
    await say(fresh(), 'Hello').expect(200);
    await send();
    const gone = (await app((tx) => tx.query<{ n: number }>('SELECT count(*)::int AS n FROM push_subscriptions WHERE endpoint = $1', [d.endpoint]))).rows[0]!.n;
    expect(gone).toBe(0);
    const listed = (await agentB.get('/v1/me/notifications/devices').expect(200)).body.map((x: { endpoint: string }) => x.endpoint);
    expect(listed).not.toContain(d.endpoint);
  });

  it('a test alert goes to the member\'s own devices only', async () => {
    const mine = device();
    await owner.post('/v1/me/notifications/devices', mine).expect(201);
    const before = sender().sent.length;
    await owner.post('/v1/me/notifications/test').expect(201);
    await send();
    expect(sender().sent.length - before).toBe(1);
    expect(sentTo(mine.endpoint)[0]!.payload.title).toBe('Notifications are on');
    expect((await analyst.post('/v1/me/notifications/test')).status).toBe(403);
  });

  it('the worker\'s lease function sees only scheduling columns, and another company\'s jobs stay invisible to the business role', async () => {
    const other = await withContext(t.deps.db, { tenantId: randomUUID(), userId: null }, async (tx) =>
      (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM push_jobs')).rows[0]!.n);
    expect(other).toBe(0);
  });
});

describe('review of W2.5', () => {
  it('H1: a device must point at a browser push service, by name, on the standard port; tests are limited', async () => {
    for (const bad of ['https://10.0.0.5:8443/x', 'https://169.254.169.254/latest', 'https://internal.corp/x', 'https://fcm.googleapis.com:8443/x', 'http://fcm.googleapis.com/x', 'https://[::1]/x']) {
      expect(isPushServiceUrl(bad, false), bad).toBe(false);
    }
    expect(isPushServiceUrl('https://fcm.googleapis.com/fcm/send/abc', false)).toBe(true);
    expect(isPushServiceUrl('https://web.push.apple.com/abc', false)).toBe(true);
    expect(isPushServiceUrl('https://push.example.test/abc', false)).toBe(false);
    await agentA.post('/v1/me/notifications/devices', { ...device(), endpoint: 'https://169.254.169.254/latest' }).expect(400);
    const keys = await t.deps.redis.keys('rl:push:test:*'); if (keys.length) await t.deps.redis.del(...keys);
    await agentA.post('/v1/me/notifications/devices', device()).expect(201);
    for (let i = 0; i < 5; i++) await agentA.post('/v1/me/notifications/test').expect(201);
    expect((await agentA.post('/v1/me/notifications/test')).status).toBe(429);
    const k2 = await t.deps.redis.keys('rl:push:test:*'); if (k2.length) await t.deps.redis.del(...k2);
    const listed = (await agentA.get('/v1/me/notifications/devices').expect(200)).body[0];
    expect(listed).not.toHaveProperty('failures');
  });

  it('M1: a member suspended after an alert is queued is not told', async () => {
    const d = device();
    const c = await addMember(t, owner, `push-s-${randomUUID().slice(0, 4)}`, 'agent');
    await c.post('/v1/me/notifications/devices', d).expect(201);
    await c.put('/v1/me/notifications/preferences', { assigned: true, unassigned: true, customerRequests: true }).expect(200);
    await say(fresh(), 'Hello there').expect(200);
    const id = (await c.get('/v1/me/access').expect(200)).body.membershipId;
    await t.ownerDb.query('ALTER TABLE memberships NO FORCE ROW LEVEL SECURITY');
    try { await t.ownerDb.query(`UPDATE memberships SET status = 'suspended' WHERE id = $1`, [id]); }
    finally { await t.ownerDb.query('ALTER TABLE memberships FORCE ROW LEVEL SECURITY'); }
    await send();
    expect(sentTo(d.endpoint)).toHaveLength(0);
  });

  it('two messages at the same moment queue one alert per device', async () => {
    const d = device();
    await agentB.post('/v1/me/notifications/devices', d).expect(201);
    const wa = fresh();
    await Promise.all([say(wa, 'one'), say(wa, 'two'), say(wa, 'three')]);
    const n = (await app((tx) => tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM push_jobs j JOIN push_subscriptions s ON s.id = j.subscription_id
      WHERE s.endpoint = $1 AND j.state IN ('pending', 'leased')`, [d.endpoint]))).rows[0]!.n;
    expect(n).toBeLessThanOrEqual(1);
    await send();
  });
});

