/**
 * Provider health and recovery (Wave 1): a company's view of its connection, sending and media, and recovery actions
 * that can never message a customer twice.
 */
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withContext } from '@conversaflow/database';
import { signBody, type SandboxAdapter } from '../src/modules/channels';
import { MediaFetcher } from '../src/modules/media';
import { activateSubscription, addMember, enableMfa, newCompany, newUser, startApp, type Client, type TestApp } from './helpers';

let t: TestApp;
let owner: Client;
let supervisor: Client;
let agent: Client;
let otherOwner: Client;
let sandbox: SandboxAdapter;
let tenant: string;
const NUMBER = `pn${randomUUID().slice(0, 8)}`;
let seq = 0;
const nextWaId = () => `9689${String(Date.now()).slice(-5)}${String(++seq).padStart(3, '0')}`;
function deliver(value: Record<string, unknown>) {
  const raw = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages',
    value: { metadata: { phone_number_id: NUMBER }, ...value } }] }] });
  return request(t.app.getHttpServer()).post('/v1/webhooks/sandbox').set('Content-Type', 'application/json')
    .set('X-Hub-Signature-256', signBody(t.deps.keys.sandboxWebhook, raw)).send(raw);
}
const inbound = (from: string, text: string) => ({
  contacts: [{ wa_id: from, profile: { name: 'Customer' } }],
  messages: [{ from, id: `wamid.in.${randomUUID()}`, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }],
});
const app = <T>(fn: Parameters<typeof withContext<T>>[2]) => withContext<T>(t.deps.db, { tenantId: tenant, userId: null }, fn);
async function newConversation() {
  const wa = nextWaId();
  await deliver(inbound(wa, 'Hello')).expect(200);
  const items = (await agent.get('/v1/conversations?limit=100').expect(200)).body.items as Array<{ id: string }>;
  for (const it of items) {
    const conv = (await agent.get(`/v1/conversations/${it.id}`).expect(200)).body;
    if (conv.contact.whatsapp === wa) return { ...conv, wa };
  }
  throw new Error('conversation not found');
}
const health = async (c: Client = supervisor) => (await c.get('/v1/channels/health').expect(200)).body;

beforeAll(async () => {
  t = await startApp();
  sandbox = t.deps.channels.sandbox as SandboxAdapter;
  owner = await newUser(t, 'health-owner');
  tenant = await newCompany(owner, 'health', 'business');
  await activateSubscription(t, tenant);
  await enableMfa(owner);
  supervisor = await addMember(t, owner, 'health-sup', 'supervisor');
  agent = await addMember(t, owner, 'health-agent', 'agent');
  await owner.post('/v1/channels', { provider: 'sandbox', providerNumberId: NUMBER, displayPhone: '+968900000000', label: 'Oman' }).expect(201);
  otherOwner = await newUser(t, 'health-other');
  const other = await newCompany(otherOwner, 'healthother', 'business');
  await activateSubscription(t, other);
});
afterAll(() => t?.close());

describe('health overview', () => {
  it('supervisors can see it, agents cannot; a quiet, working connection is healthy', async () => {
    await agent.get('/v1/channels/health').expect(403);
    await newConversation();
    const h = await health();
    expect(h).toMatchObject({ status: 'healthy', problems: [] });
    expect(h.connections[0]).toMatchObject({ label: 'Oman', status: 'active' });
    expect(h.connections[0].events24h).toBeGreaterThan(0);
  });

  it('an uncertain delivery and a confirmed failure need attention, listed with their conversation, uncertain first', async () => {
    const conv = await newConversation();
    sandbox.script.push({ reject: '131026' });
    await agent.post(`/v1/conversations/${conv.id}/reply`, { text: 'Refused', seenActivity: conv.activitySeq, clientMessageId: randomUUID() }).expect(201);
    const c2 = (await agent.get(`/v1/conversations/${conv.id}`).expect(200)).body;
    sandbox.script.push({ uncertain: 'timeout' });
    await agent.post(`/v1/conversations/${conv.id}/reply`, { text: 'Unknown', seenActivity: c2.activitySeq, clientMessageId: randomUUID() }).expect(201);
    const h = await health();
    expect(h.status).toBe('attention');
    expect(h.problems.map((p: { code: string }) => p.code)).toEqual(expect.arrayContaining(['uncertain_deliveries', 'failed_deliveries']));
    expect(h.delivery).toMatchObject({ uncertain7d: 1, failed7d: { rejected: 1 } });
    expect(h.attention[0]).toMatchObject({ status: 'uncertain', conversationId: conv.id, failureKind: null });
    expect(h.attention[1]).toMatchObject({ status: 'failed', failureKind: 'rejected', errorCode: '131026' });
    // Another company sees none of this.
    await enableMfa(otherOwner);
    const theirs = (await otherOwner.get('/v1/channels/health').expect(200)).body;
    expect(theirs.attention).toEqual([]);
    expect(theirs.problems.map((p: { code: string }) => p.code)).toContain('no_connection');
  });

  it('a send job stuck past its lease shows the connection as degraded', async () => {
    const conv = await newConversation();
    const membership = (await agent.get('/v1/me/access').expect(200)).body.membershipId as string;
    await app(async (tx) => {
      const m = (await tx.query<{ id: string }>(
        `INSERT INTO messages (tenant_id, conversation_id, direction, kind, body, client_message_id, sent_by_membership_id, occurred_at, status)
         VALUES ($1, $2, 'out', 'text', 'stuck', $3, $4, clock_timestamp(), 'queued') RETURNING id`, [tenant, conv.id, randomUUID(), membership])).rows[0]!;
      await tx.query(`INSERT INTO send_jobs (tenant_id, message_id, state, lease_until) VALUES ($1, $2, 'leased', now() - interval '5 minutes')`, [tenant, m.id]);
    });
    const h = await health();
    expect(h.status).toBe('degraded');
    expect(h.sending.stuck).toBe(1);
    expect(h.problems[0]).toMatchObject({ code: 'sending_delayed', level: 'degraded' });
    await app((tx) => tx.query(`UPDATE send_jobs SET state = 'done', lease_until = NULL WHERE state = 'leased'`));
  });
});

describe('recovery actions', () => {
  it('re-applies delivery statuses that arrived before their message; only channel managers may; nothing is sent', async () => {
    const conv = await newConversation();
    const wamid = `wamid.out.${randomUUID()}`;
    // A status for a message we have not recorded yet, received 20 minutes ago.
    await app((tx) => tx.query(
      `INSERT INTO webhook_events (tenant_id, connection_id, event_key, kind, payload, received_at, processed_at, outcome)
       SELECT $1, id, $2, 'status', $3, now() - interval '20 minutes', now() - interval '20 minutes', 'orphan_status' FROM channel_connections`,
      [tenant, `st:${wamid}:read`, JSON.stringify({ id: wamid, status: 'read', timestamp: '1', recipient_id: '1' })]));
    expect((await health()).problems.map((p: { code: string }) => p.code)).toContain('statuses_waiting');
    // The message is recorded later with that provider id (e.g. a delayed confirmation from another process).
    const membership = (await agent.get('/v1/me/access').expect(200)).body.membershipId as string;
    const msgId = await app(async (tx) => (await tx.query<{ id: string }>(
      `INSERT INTO messages (tenant_id, conversation_id, direction, kind, body, client_message_id, sent_by_membership_id, occurred_at, status, provider_message_id)
       VALUES ($1, $2, 'out', 'text', 'late', $3, $4, clock_timestamp(), 'sent', $5) RETURNING id`, [tenant, conv.id, randomUUID(), membership, wamid])).rows[0]!.id);
    const before = sandbox.sent.length;
    await supervisor.post('/v1/channels/recovery/statuses').expect(403);
    const res = await owner.post('/v1/channels/recovery/statuses').expect(200);
    expect(res.body.applied).toBe(1);
    expect(sandbox.sent.length).toBe(before);
    const m = (await agent.get(`/v1/conversations/${conv.id}`).expect(200)).body.messages.find((x: { id: string }) => x.id === msgId);
    expect(m.status).toBe('read');
    // Running it again changes nothing.
    expect((await owner.post('/v1/channels/recovery/statuses').expect(200)).body).toMatchObject({ applied: 0 });
    const audit = (await owner.get('/v1/audit-events').expect(200)).body as Array<{ action: string }>;
    expect(audit.map((a) => a.action)).toContain('channel.recovery.statuses_reapplied');
  });

  it('a failed media download can be tried again within 7 days; older media cannot', async () => {
    const conv = await newConversation();
    await deliver({ contacts: [{ wa_id: conv.wa, profile: { name: 'C' } }], messages: [{ from: conv.wa, id: `wamid.in.${randomUUID()}`,
      timestamp: String(Math.floor(Date.now() / 1000)), type: 'image', image: { id: 'media-later', mime_type: 'image/jpeg' } }] }).expect(200);
    const fetcher = new MediaFetcher(t.deps.db, t.deps.channels, t.deps.storage, t.deps.scanner, t.deps.config.MAX_UPLOAD_BYTES);
    await fetcher.dispatchDue(); // unknown id → failed
    let h = await health();
    const problem = h.mediaProblems.find((x: { conversationId: string }) => x.conversationId === conv.id);
    expect(problem).toMatchObject({ mediaStatus: 'failed', canRetry: true });
    sandbox.media.set('media-later', { data: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]), contentType: 'image/jpeg' });
    await owner.post(`/v1/channels/recovery/media/${problem.id}`).expect(200);
    await fetcher.dispatchDue();
    h = await health();
    expect(h.mediaProblems.some((x: { id: string }) => x.id === problem.id)).toBe(false);
    // Only a failed download can be retried (this one is now available).
    expect((await owner.post(`/v1/channels/recovery/media/${problem.id}`)).body.error.code).toBe('not_retryable');
    // Older than Meta's 7-day media lifetime: refused with a plain reason.
    const old = await app(async (tx) => (await tx.query<{ id: string }>(
      `INSERT INTO messages (tenant_id, conversation_id, direction, kind, provider_message_id, occurred_at, status, media_type, media_status, provider_media_id, created_at)
       VALUES ($1, $2, 'in', 'media', $3, now() - interval '8 days', 'received', 'image', 'failed', 'media-old', now() - interval '8 days') RETURNING id`,
      [tenant, conv.id, `wamid.in.${randomUUID()}`])).rows[0]!.id);
    expect((await owner.post(`/v1/channels/recovery/media/${old}`)).body.error.code).toBe('media_expired');
  });
});
