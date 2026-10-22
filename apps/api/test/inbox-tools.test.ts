/**
 * Tags and saved replies (BRD v1.2 Wave 1, CF-EXT-002, migration 0037).
 */
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signBody } from '../src/modules/channels';
import { activateSubscription, addMember, enableMfa, newCompany, newUser, startApp, type Client, type TestApp } from './helpers';

let t: TestApp;
let owner: Client;
let supervisor: Client;
let agentA: Client;
let agentB: Client;
let analyst: Client;
let otherOwner: Client;
const NUMBER = `pn${randomUUID().slice(0, 8)}`;
let seq = 0;
const nextWaId = () => `9665${String(Date.now()).slice(-5)}${String(++seq).padStart(3, '0')}`;

function inbound(from: string, text: string) {
  const raw = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: NUMBER },
    contacts: [{ wa_id: from, profile: { name: 'Customer' } }],
    messages: [{ from, id: `wamid.in.${randomUUID()}`, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }] } }] }] });
  return request(t.app.getHttpServer()).post('/v1/webhooks/sandbox').set('Content-Type', 'application/json')
    .set('X-Hub-Signature-256', signBody(t.deps.keys.sandboxWebhook, raw)).send(raw);
}
async function newConversation(): Promise<string> {
  const wa = nextWaId();
  await inbound(wa, 'Hello').expect(200);
  const items = (await owner.get('/v1/conversations?limit=100').expect(200)).body.items as Array<{ id: string }>;
  for (const it of items) {
    const c = (await owner.get(`/v1/conversations/${it.id}`).expect(200)).body;
    if (c.contact.whatsapp === wa) return c.id;
  }
  throw new Error('conversation not found');
}

beforeAll(async () => {
  t = await startApp();
  owner = await newUser(t, 'tools-owner');
  const tenant = await newCompany(owner, 'tools', 'business');
  await activateSubscription(t, tenant);
  await enableMfa(owner);
  supervisor = await addMember(t, owner, 'tools-sup', 'supervisor');
  agentA = await addMember(t, owner, 'tools-a', 'agent');
  agentB = await addMember(t, owner, 'tools-b', 'agent');
  analyst = await addMember(t, owner, 'tools-analyst', 'analyst');
  await owner.post('/v1/channels', { provider: 'sandbox', providerNumberId: NUMBER, displayPhone: '+966500000055', label: 'Tools' }).expect(201);
  otherOwner = await newUser(t, 'tools-other');
  await activateSubscription(t, await newCompany(otherOwner, 'toolsother', 'business'));
});
afterAll(() => t?.close());

describe('tags', () => {
  it('supervisors manage the list; agents can see it but not change it; names are unique per company, any letter case', async () => {
    const vip = (await supervisor.post('/v1/tags', { name: 'VIP', color: 'amber' }).expect(201)).body;
    expect(vip).toMatchObject({ name: 'VIP', color: 'amber' });
    expect((await supervisor.post('/v1/tags', { name: ' vip ' })).body.error.code).toBe('name_taken');
    await agentA.post('/v1/tags', { name: 'Agent tag' }).expect(403);
    await agentA.patch(`/v1/tags/${vip.id}`, { name: 'Changed' }).expect(403);
    await agentA.delete(`/v1/tags/${vip.id}`).expect(403);
    expect((await agentA.get('/v1/tags').expect(200)).body.map((x: { name: string }) => x.name)).toContain('VIP');
    await analyst.get('/v1/tags').expect(403);
    await supervisor.post('/v1/tags', { name: 'Two\nlines' }).expect(400);
    await supervisor.post('/v1/tags', { name: 'Bad colour', color: 'pink' }).expect(400);
    // Another company can use the same name and never sees ours.
    await otherOwner.post('/v1/tags', { name: 'VIP' }).expect(201);
    expect((await otherOwner.get('/v1/tags').expect(200)).body).toHaveLength(1);
    await otherOwner.patch(`/v1/tags/${vip.id}`, { name: 'Taken over' }).expect(404);
    await otherOwner.delete(`/v1/tags/${vip.id}`).expect(404);
  });

  it('an agent tags a conversation they can see; the tag shows in the list, the filter and the history; repeating changes nothing', async () => {
    const tag = (await supervisor.post('/v1/tags', { name: 'Complaint', color: 'red' }).expect(201)).body;
    const conv = await newConversation();
    const after = (await agentA.put(`/v1/conversations/${conv}/tags/${tag.id}`).expect(200)).body;
    expect(after).toEqual([{ id: tag.id, name: 'Complaint', color: 'red' }]);
    await agentA.put(`/v1/conversations/${conv}/tags/${tag.id}`).expect(200);
    const detail = (await agentA.get(`/v1/conversations/${conv}`).expect(200)).body;
    expect(detail.tags).toEqual([{ id: tag.id, name: 'Complaint', color: 'red' }]);
    expect(detail.events.filter((e: { kind: string }) => e.kind === 'tagged')).toHaveLength(1);
    const filtered = (await agentA.get(`/v1/conversations?tag=${tag.id}`).expect(200)).body.items as Array<{ id: string; tags: unknown[] }>;
    expect(filtered.map((x) => x.id)).toEqual([conv]);
    expect(filtered[0]!.tags).toEqual([{ id: tag.id, name: 'Complaint', color: 'red' }]);
    await agentA.delete(`/v1/conversations/${conv}/tags/${tag.id}`).expect(200);
    expect((await agentA.get(`/v1/conversations?tag=${tag.id}`).expect(200)).body.items).toHaveLength(0);
    const events = (await agentA.get(`/v1/conversations/${conv}`).expect(200)).body.events.map((e: { kind: string }) => e.kind);
    expect(events.filter((k: string) => k === 'tagged' || k === 'untagged')).toEqual(['tagged', 'untagged']);
  });

  it('an agent cannot tag a conversation assigned to a colleague, and nobody can use another company\'s tag or conversation', async () => {
    const tag = (await supervisor.post('/v1/tags', { name: 'Riyadh' }).expect(201)).body;
    const conv = await newConversation();
    const me = (await agentB.get('/v1/me/access').expect(200)).body.membershipId;
    const c = (await owner.get(`/v1/conversations/${conv}`).expect(200)).body;
    await owner.post(`/v1/conversations/${conv}/assign`, { membershipId: me, expectedVersion: c.version }).expect(200);
    await agentA.put(`/v1/conversations/${conv}/tags/${tag.id}`).expect(404);
    await agentB.put(`/v1/conversations/${conv}/tags/${tag.id}`).expect(200);
    const foreign = (await otherOwner.get('/v1/tags').expect(200)).body[0];
    await owner.put(`/v1/conversations/${conv}/tags/${foreign.id}`).expect(404);
    await otherOwner.put(`/v1/conversations/${conv}/tags/${foreign.id}`).expect(404);
  });

  it('deleting a tag removes it from conversations and is audited', async () => {
    const tag = (await supervisor.post('/v1/tags', { name: 'Temporary' }).expect(201)).body;
    const conv = await newConversation();
    await agentA.put(`/v1/conversations/${conv}/tags/${tag.id}`).expect(200);
    await supervisor.patch(`/v1/tags/${tag.id}`, { name: 'Temporary (old)', color: 'slate' }).expect(200);
    await supervisor.delete(`/v1/tags/${tag.id}`).expect(204);
    expect((await agentA.get(`/v1/conversations/${conv}`).expect(200)).body.tags).toEqual([]);
    const audit = (await owner.get('/v1/audit-events').expect(200)).body as Array<{ action: string }>;
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(['tag.created', 'tag.updated', 'tag.deleted']));
  });
});

describe('saved replies', () => {
  it('supervisors manage them; agents read them; inserting is up to the reply box, so nothing is sent by the list itself', async () => {
    const r = (await supervisor.post('/v1/saved-replies', { title: 'Opening hours', body: 'We are open Sunday to Thursday, 8:00 to 17:00.', language: 'en' }).expect(201)).body;
    await supervisor.post('/v1/saved-replies', { title: 'مواعيد العمل', body: 'نعمل من الأحد إلى الخميس، من 8:00 إلى 17:00.', language: 'ar' }).expect(201);
    expect((await supervisor.post('/v1/saved-replies', { title: 'opening HOURS', body: 'x' })).body.error.code).toBe('name_taken');
    await agentA.post('/v1/saved-replies', { title: 'Mine', body: 'x' }).expect(403);
    await agentA.patch(`/v1/saved-replies/${r.id}`, { body: 'changed' }).expect(403);
    const list = (await agentA.get('/v1/saved-replies').expect(200)).body as Array<{ title: string; language: string | null }>;
    expect(list.map((x) => x.title)).toEqual(expect.arrayContaining(['Opening hours', 'مواعيد العمل']));
    const updated = (await supervisor.patch(`/v1/saved-replies/${r.id}`, { body: 'We are open Sunday to Thursday, 8:00 to 18:00.', language: null }).expect(200)).body;
    expect(updated).toMatchObject({ body: 'We are open Sunday to Thursday, 8:00 to 18:00.', language: null });
    await supervisor.post('/v1/saved-replies', { title: 'Empty', body: '   ' }).expect(400);
    await analyst.get('/v1/saved-replies').expect(403);
    expect((await otherOwner.get('/v1/saved-replies').expect(200)).body).toEqual([]);
    await otherOwner.delete(`/v1/saved-replies/${r.id}`).expect(404);
    await supervisor.delete(`/v1/saved-replies/${r.id}`).expect(204);
    const audit = (await owner.get('/v1/audit-events').expect(200)).body as Array<{ action: string }>;
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(['saved_reply.created', 'saved_reply.updated', 'saved_reply.deleted']));
  });
});
