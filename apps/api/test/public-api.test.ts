/**
 * Public API v1 and outgoing webhooks (BRD v1.2 Wave 2, W2.8, CF-EXT-016, migration 0056).
 * Webhook deliveries go to a recording fetcher in these tests; nothing leaves the machine.
 */
import { createHmac, randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withContext } from '@conversaflow/database';
import { signBody } from '../src/modules/channels';
import { checkEndpointUrl, isPrivateAddress, WebhookWorker, type Fetcher } from '../src/modules/public-api';
import { activateSubscription, addMember, enableMfa, newCompany, newUser, startApp, type Client, type TestApp } from './helpers';

let t: TestApp;
let owner: Client;
let agent: Client;
let otherOwner: Client;
let tenant: string;
const NUMBER = `pn${randomUUID().slice(0, 8)}`;
let seq = 0;
const base = Math.floor(Math.random() * 5_000_000);
const fresh = () => `97157${String(base + ++seq).padStart(7, '0')}`;
const app = <T>(fn: Parameters<typeof withContext<T>>[2]) => withContext<T>(t.deps.db, { tenantId: tenant, userId: null }, fn);
const http = () => request(t.app.getHttpServer());
function say(from: string, text: string) {
  const raw = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: NUMBER },
    contacts: [{ wa_id: from, profile: { name: 'API Customer' } }],
    messages: [{ from, id: `wamid.in.${randomUUID()}`, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }] } }] }] });
  return http().post('/v1/webhooks/sandbox').set('Content-Type', 'application/json').set('X-Hub-Signature-256', signBody(t.deps.keys.sandboxWebhook, raw)).send(raw);
}
const conv = async (wa: string) => (await app((tx) => tx.query<{ id: string; version: number }>(
  `SELECT c.id, c.version FROM conversations c JOIN contact_identifiers ci ON ci.contact_id = c.contact_id WHERE ci.value = $1 ORDER BY c.created_at DESC LIMIT 1`, [wa]))).rows[0]!;
const api = (key: string) => ({
  get: (p: string) => http().get(`/api/v1${p}`).set('Authorization', `Bearer ${key}`),
  post: (p: string, body: object, idem?: string) => { const r = http().post(`/api/v1${p}`).set('Authorization', `Bearer ${key}`); return (idem ? r.set('Idempotency-Key', idem) : r).send(body); },
});
const clearLimits = async () => { const k = await t.deps.redis.keys('rl:api:*'); if (k.length) await t.deps.redis.del(...k); };

beforeAll(async () => {
  t = await startApp();
  owner = await newUser(t, 'api-owner');
  tenant = await newCompany(owner, 'api', 'business');
  await activateSubscription(t, tenant);
  await enableMfa(owner);
  agent = await addMember(t, owner, 'api-agent', 'agent');
  await owner.post('/v1/channels', { provider: 'sandbox', providerNumberId: NUMBER, displayPhone: '+966500000044', label: 'API' }).expect(201);
  otherOwner = await newUser(t, 'api-other');
  await activateSubscription(t, await newCompany(otherOwner, 'apiother', 'business'));
  await enableMfa(otherOwner);
  await clearLimits();
});
afterAll(async () => { await clearLimits(); await t?.close(); });

describe('API keys', () => {
  it('only owners and admins with two-step sign-in create keys; the key is shown once and only its hash is stored', async () => {
    await agent.post('/v1/developers/keys', { name: 'Agent key', scopes: ['conversations:read'] }).expect(403);
    const k = (await owner.post('/v1/developers/keys', { name: 'CRM sync', scopes: ['conversations:read', 'contacts:read'] }).expect(201)).body;
    expect(k.key).toMatch(/^cf_live_[a-z0-9]{8}_[A-Za-z0-9_-]{43}$/);
    const listed = (await owner.get('/v1/developers/keys').expect(200)).body;
    expect(JSON.stringify(listed)).not.toContain(k.key.split('_').at(-1));
    expect(listed[0]).toMatchObject({ name: 'CRM sync', state: 'active', prefix: k.prefix });
    await owner.post('/v1/developers/keys', { name: 'Bad', scopes: ['everything'] }).expect(400);
  });

  it('a key reads within its scopes only; wrong, revoked and expired keys get the same refusal, and each request is logged', async () => {
    const k = (await owner.post('/v1/developers/keys', { name: 'Reader', scopes: ['conversations:read'] }).expect(201)).body;
    const wa = fresh();
    await say(wa, 'Hello from the API test').expect(200);
    const list = (await api(k.key).get('/conversations?limit=1').expect(200)).body;
    expect(list.data).toHaveLength(1);
    expect(list.nextCursor === null || typeof list.nextCursor === 'string').toBe(true);
    const c = await conv(wa);
    const msgs = (await api(k.key).get(`/conversations/${c.id}/messages`).expect(200)).body;
    expect(msgs.data[0]).toMatchObject({ direction: 'in', text: 'Hello from the API test' });
    expect((await api(k.key).get('/contacts').expect(403)).body.error.code).toBe('missing_scope');
    expect((await api(k.key).post(`/conversations/${c.id}/messages`, { text: 'x' }, randomUUID()).expect(403)).body.error.code).toBe('missing_scope');
    for (const bad of ['cf_live_aaaaaaaa_' + 'A'.repeat(43), 'nonsense', '']) {
      expect((await http().get('/api/v1/conversations').set('Authorization', `Bearer ${bad}`).expect(401)).body.error.code).toBe('invalid_api_key');
    }
    await owner.post(`/v1/developers/keys/${k.id}/revoke`).expect(200);
    await api(k.key).get('/conversations').expect(401);
    const log = (await owner.get(`/v1/developers/keys/${k.id}/log`).expect(200)).body as Array<{ route: string; status: number }>;
    expect(log.map((l) => `${l.route} ${l.status}`)).toEqual(expect.arrayContaining(['GET /conversations 200', 'GET /contacts 403', 'POST /conversations/:id/messages 403']));
    expect(JSON.stringify(log)).not.toContain(k.key);
    await clearLimits();
  });

  it('pages through conversations with a cursor, without repeats', async () => {
    const k = (await owner.post('/v1/developers/keys', { name: 'Pager', scopes: ['conversations:read'] }).expect(201)).body;
    for (let i = 0; i < 3; i++) await say(fresh(), `page ${i}`).expect(200);
    const seen = new Set<string>(); let cur: string | null = null; let pages = 0;
    do {
      const r: { data: Array<{ id: string }>; nextCursor: string | null } = (await api(k.key).get(`/conversations?limit=2${cur ? `&cursor=${cur}` : ''}`).expect(200)).body;
      for (const d of r.data) { expect(seen.has(d.id)).toBe(false); seen.add(d.id); }
      cur = r.nextCursor; pages++;
    } while (cur && pages < 20);
    expect(seen.size).toBeGreaterThanOrEqual(3);
    await api(k.key).get('/conversations?cursor=not-valid').expect(400);
  });

  it('a reply through the API acts as the key\'s member, with every reply check, once per Idempotency-Key', async () => {
    const k = (await owner.post('/v1/developers/keys', { name: 'Sender', scopes: ['messages:send', 'conversations:read'] }).expect(201)).body;
    const wa = fresh();
    await say(wa, 'Can you send me the price?').expect(200);
    const c = await conv(wa);
    await api(k.key).post(`/conversations/${c.id}/messages`, { text: 'No key' }).expect(400);
    const idem = randomUUID();
    const a = (await api(k.key).post(`/conversations/${c.id}/messages`, { text: 'Sent by our CRM' }, idem).expect(201)).body;
    const b = (await api(k.key).post(`/conversations/${c.id}/messages`, { text: 'Sent by our CRM' }, idem).expect(201)).body;
    expect(b.id).toBe(a.id);
    const m = (await app((tx) => tx.query<{ api_key_id: string | null; n: number }>(`SELECT api_key_id, (SELECT count(*)::int FROM messages WHERE conversation_id = $1 AND direction = 'out') AS n FROM messages WHERE id = $2`, [c.id, a.id]))).rows[0]!;
    expect(m).toMatchObject({ api_key_id: k.id, n: 1 });
    // Opted out: refused like a person's reply.
    await say(wa, 'STOP').expect(200);
    expect((await api(k.key).post(`/conversations/${c.id}/messages`, { text: 'Again' }, randomUUID())).status).toBe(409);
  });

  it('a key stops working when its member loses access; another company never sees this company\'s data', async () => {
    const k = (await owner.post('/v1/developers/keys', { name: 'Other', scopes: ['conversations:read'] }).expect(201)).body;
    const theirs = (await otherOwner.get('/v1/developers/keys').expect(200)).body;
    expect(theirs.map((x: { id: string }) => x.id)).not.toContain(k.id);
    await otherOwner.post(`/v1/developers/keys/${k.id}/revoke`).expect(404);
    // The member is suspended: their keys stop at once.
    const ownerMembership = (await owner.get('/v1/me/access').expect(200)).body.membershipId;
    await t.ownerDb.query('ALTER TABLE memberships NO FORCE ROW LEVEL SECURITY');
    try {
      await t.ownerDb.query(`UPDATE memberships SET status = 'suspended' WHERE id = $1`, [ownerMembership]);
      await api(k.key).get('/conversations').expect(401);
    } finally {
      await t.ownerDb.query(`UPDATE memberships SET status = 'active' WHERE id = $1`, [ownerMembership]);
      await t.ownerDb.query('ALTER TABLE memberships FORCE ROW LEVEL SECURITY');
    }
    await api(k.key).get('/conversations').expect(200);
    await clearLimits();
  });
});

describe('outgoing webhooks', () => {
  const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  let answer = 200;
  const fetcher: Fetcher = async (url, init) => { calls.push({ url, headers: init.headers, body: init.body }); return { status: answer }; };
  const deliver = async () => { const w = new WebhookWorker(t.deps.db, fetcher, true); while ((await w.dispatchDue(100)) > 0) { /* drain */ } };

  it('addresses must be https on the public internet in production', async () => {
    expect(isPrivateAddress('10.1.2.3')).toBe(true);
    expect(isPrivateAddress('169.254.169.254')).toBe(true);
    expect(isPrivateAddress('::1')).toBe(true);
    expect(isPrivateAddress('8.8.8.8')).toBe(false);
    await expect(checkEndpointUrl('http://example.test/hook', false)).rejects.toMatchObject({ status: 400 });
    await expect(checkEndpointUrl('https://127.0.0.1/hook', false)).rejects.toMatchObject({ status: 400 });
    await expect(checkEndpointUrl('https://user:pw@8.8.8.8/hook', false)).rejects.toMatchObject({ status: 400 });
    await agent.post('/v1/developers/webhooks', { url: 'https://127.0.0.1/hook', events: ['message.received'] }).expect(403);
  });

  it('events are signed and delivered once per event; failures are retried and recorded; a delivery can be sent again', async () => {
    const hook = (await owner.post('/v1/developers/webhooks', { url: 'https://127.0.0.1:9443/hook', events: ['message.received', 'conversation.resolved'] }).expect(201)).body;
    expect(hook.secret).toMatch(/^whsec_/);
    const wa = fresh();
    await say(wa, 'Webhook please').expect(200);
    await deliver();
    const got = calls.filter((x) => JSON.parse(x.body).data.text === 'Webhook please');
    expect(got).toHaveLength(1);
    const h = got[0]!.headers;
    expect(h['conversaflow-event']).toBe('message.received');
    const [tPart, v1] = h['conversaflow-signature']!.split(',');
    const ts = tPart!.slice(2);
    expect(v1).toBe(`v1=${createHmac('sha256', hook.secret).update(`${ts}.${got[0]!.body}`).digest('hex')}`);
    // The receiver fails: retried later, not lost.
    answer = 500;
    const c = await conv(wa);
    await owner.post(`/v1/conversations/${c.id}/status`, { status: 'resolved', expectedVersion: c.version }).expect(200);
    await deliver();
    let ds = (await owner.get(`/v1/developers/webhooks/${hook.id}/deliveries`).expect(200)).body as Array<{ id: string; event: string; state: string; lastStatus: number; attempts: number; eventId: string }>;
    const resolved = ds.find((x) => x.event === 'conversation.resolved')!;
    expect(resolved).toMatchObject({ state: 'pending', lastStatus: 500, attempts: 1 });
    // Sent again by hand once the receiver works: same event id.
    answer = 200;
    await owner.post(`/v1/developers/deliveries/${resolved.id}/resend`).expect(201);
    await deliver();
    ds = (await owner.get(`/v1/developers/webhooks/${hook.id}/deliveries`).expect(200)).body;
    const again = ds.find((x) => x.event === 'conversation.resolved' && x.state === 'delivered')!;
    expect(again.eventId).toBe(resolved.eventId);
  });

  it('after a secret rotation both secrets sign for 24 hours; a switched-off endpoint gets nothing', async () => {
    const hook = (await owner.post('/v1/developers/webhooks', { url: 'https://127.0.0.1:9443/rotate', events: ['message.received'] }).expect(201)).body;
    const next = (await owner.post(`/v1/developers/webhooks/${hook.id}/rotate`).expect(200)).body;
    await say(fresh(), 'after rotation').expect(200);
    await deliver();
    const sig = calls.filter((x) => x.url.endsWith('/rotate')).at(-1)!.headers['conversaflow-signature']!;
    expect(sig.split(',').filter((p) => p.startsWith('v1='))).toHaveLength(2);
    expect(next.secret).not.toBe(hook.secret);
    await owner.patch(`/v1/developers/webhooks/${hook.id}`, { enabled: false }).expect(200);
    const before = calls.filter((x) => x.url.endsWith('/rotate')).length;
    await say(fresh(), 'while off').expect(200);
    await deliver();
    expect(calls.filter((x) => x.url.endsWith('/rotate')).length).toBe(before);
  });
});
