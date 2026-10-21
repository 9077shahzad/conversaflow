/**
 * Owner instructions of 21 Oct 2026:
 * - a late provider answer keeps its message id for reconciliation, never downgrades a settled status, never resends;
 * - a later status webhook finds the exact message even when several were sent to the same customer;
 * - "not accepted after 5 attempts" needs five recorded definite refusals; any ambiguous attempt leaves it uncertain;
 * - retry eligibility differs for ordinary replies (24-hour window) and approved templates (outside it).
 */
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withContext } from '@conversaflow/database';
import { signBody, type SandboxAdapter } from '../src/modules/channels';
import { Sender } from '../src/modules/sender';
import { activateSubscription, addMember, enableMfa, newCompany, newUser, startApp, type Client, type TestApp } from './helpers';

let t: TestApp;
let owner: Client;
let agent: Client;
let sandbox: SandboxAdapter;
let tenant: string;
let agentId: string;
const NUMBER = `pn${randomUUID().slice(0, 8)}`;
const ACCOUNT = `waba${randomUUID().slice(0, 8)}`;
let seq = 0;
const nextWaId = () => `9665${String(Date.now()).slice(-5)}${String(++seq).padStart(3, '0')}`;

function post(raw: string) {
  return request(t.app.getHttpServer()).post('/v1/webhooks/sandbox').set('Content-Type', 'application/json')
    .set('X-Hub-Signature-256', signBody(t.deps.keys.sandboxWebhook, raw)).send(raw);
}
const deliver = (value: Record<string, unknown>) => post(JSON.stringify({ object: 'whatsapp_business_account',
  entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: NUMBER }, ...value } }] }] }));
const inbound = (from: string, text: string) => ({
  contacts: [{ wa_id: from, profile: { name: 'Customer' } }],
  messages: [{ from, id: `wamid.in.${randomUUID()}`, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }],
});
const status = (id: string, s: string, callback?: string) => ({
  statuses: [{ id, status: s, timestamp: String(Math.floor(Date.now() / 1000)), recipient_id: '1', ...(callback ? { biz_opaque_callback_data: callback } : {}) }],
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
const getConv = async (id: string) => (await agent.get(`/v1/conversations/${id}`).expect(200)).body;
const msgOf = async (convId: string, id: string) => (await getConv(convId)).messages.find((m: { id: string }) => m.id === id);
async function queueOnly(convId: string, text: string) {
  return app(async (tx) => {
    const m = (await tx.query<{ id: string }>(
      `INSERT INTO messages (tenant_id, conversation_id, direction, kind, body, client_message_id, sent_by_membership_id, occurred_at, status)
       VALUES ($1, $2, 'out', 'text', $3, $4, $5, clock_timestamp(), 'queued') RETURNING id`, [tenant, convId, text, randomUUID(), agentId])).rows[0]!;
    const j = (await tx.query<{ id: string }>('INSERT INTO send_jobs (tenant_id, message_id) VALUES ($1, $2) RETURNING id', [tenant, m.id])).rows[0]!;
    return { messageId: m.id, jobId: j.id };
  });
}
const attempts = async (messageId: string) => (await app((tx) => tx.query<{ attempt: number; outcome: string; code: string | null; provider_message_id: string | null }>(
  'SELECT attempt, outcome, code, provider_message_id FROM send_attempts WHERE message_id = $1 ORDER BY created_at', [messageId]))).rows;
const providerId = async (messageId: string) => (await app((tx) => tx.query<{ p: string | null }>('SELECT provider_message_id AS p FROM messages WHERE id = $1', [messageId]))).rows[0]!.p;

beforeAll(async () => {
  t = await startApp();
  sandbox = t.deps.channels.sandbox as SandboxAdapter;
  owner = await newUser(t, 'late-owner');
  tenant = await newCompany(owner, 'late', 'business');
  await activateSubscription(t, tenant);
  await enableMfa(owner);
  agent = await addMember(t, owner, 'late-agent', 'agent');
  agentId = (await agent.get('/v1/me/access').expect(200)).body.membershipId;
  await owner.post('/v1/channels', { provider: 'sandbox', providerNumberId: NUMBER, displayPhone: '+966500000077', label: 'KSA', providerAccountId: ACCOUNT }).expect(201);
});
afterAll(() => t?.close());

describe('late provider answers', () => {
  it('an answer after the timeout is recorded: uncertain becomes sent, with the provider id, sent once', async () => {
    const conv = await newConversation();
    const q = await queueOnly(conv.id, 'Late answer');
    const wamid = `wamid.late.${randomUUID()}`;
    sandbox.nextIds.push(wamid);
    sandbox.script.push({ slowMs: 600 });
    const before = sandbox.sent.length;
    const s = new Sender(t.deps.db, t.deps.channels, {}, 150, undefined, 3_000);
    expect(await s.leaseNow(tenant, q.jobId)).toBe(true);
    expect(await s.processJob(tenant, q.jobId)).toBe('uncertain');
    expect(await msgOf(conv.id, q.messageId)).toMatchObject({ status: 'uncertain', errorCode: 'provider_timeout' });
    await s.settleLate();
    expect(await msgOf(conv.id, q.messageId)).toMatchObject({ status: 'sent', errorCode: null });
    expect(await providerId(q.messageId)).toBe(wamid);
    expect(sandbox.sent.length).toBe(before + 1);
    expect((await attempts(q.messageId)).map((a) => a.outcome)).toEqual(['uncertain', 'late_accepted']);
    // A later status with only the provider id (no reference) now finds it.
    await deliver(status(wamid, 'read')).expect(200);
    expect((await msgOf(conv.id, q.messageId)).status).toBe('read');
  });

  it('a late answer after the webhook already said "delivered" keeps "delivered" and still records the id', async () => {
    const conv = await newConversation();
    const q = await queueOnly(conv.id, 'Delivered first');
    const wamid = `wamid.late.${randomUUID()}`;
    sandbox.nextIds.push(wamid);
    sandbox.script.push({ slowMs: 700 });
    const s = new Sender(t.deps.db, t.deps.channels, {}, 150, undefined, 3_000);
    expect(await s.leaseNow(tenant, q.jobId)).toBe(true);
    expect(await s.processJob(tenant, q.jobId)).toBe('uncertain');
    await deliver(status(wamid, 'delivered', q.messageId)).expect(200);
    await s.settleLate();
    expect(await msgOf(conv.id, q.messageId)).toMatchObject({ status: 'delivered' });
    expect(await providerId(q.messageId)).toBe(wamid);
  });

  it('an answer that never comes within the late window: the request is cancelled, nothing is sent, it stays uncertain', async () => {
    const conv = await newConversation();
    const q = await queueOnly(conv.id, 'Never answered');
    sandbox.script.push({ slowMs: 1_500 });
    const before = sandbox.sent.length;
    const s = new Sender(t.deps.db, t.deps.channels, {}, 150, undefined, 300);
    expect(await s.leaseNow(tenant, q.jobId)).toBe(true);
    expect(await s.processJob(tenant, q.jobId)).toBe('uncertain');
    await s.settleLate();
    await new Promise((r) => setTimeout(r, 1_600));
    expect(sandbox.sent.length).toBe(before);
    expect(await msgOf(conv.id, q.messageId)).toMatchObject({ status: 'uncertain' });
    expect(await providerId(q.messageId)).toBeNull();
  });
});

describe('exact matching when several messages went to the same customer', () => {
  it('each status update finds its own message, by our reference or by the provider id, never by customer or time', async () => {
    const conv = await newConversation();
    const ids = [`wamid.a.${randomUUID()}`, `wamid.b.${randomUUID()}`, `wamid.c.${randomUUID()}`];
    const sent: string[] = [];
    for (const [i, id] of ids.entries()) {
      sandbox.nextIds.push(id);
      sandbox.script.push({ acceptedButLost: 'connection_reset' }); // accepted, but we never learn the id
      const fresh = await getConv(conv.id);
      sent.push((await agent.post(`/v1/conversations/${conv.id}/reply`, { text: `Message ${i + 1}`, seenActivity: fresh.activitySeq, clientMessageId: randomUUID() }).expect(201)).body.id);
    }
    for (const m of sent) expect((await msgOf(conv.id, m)).status).toBe('uncertain');
    // Updates arrive out of order, each carrying our reference (Meta's biz_opaque_callback_data).
    await deliver(status(ids[2]!, 'read', sent[2])).expect(200);
    await deliver(status(ids[0]!, 'delivered', sent[0])).expect(200);
    await deliver(status(ids[1]!, 'failed', sent[1])).expect(200);
    expect(await msgOf(conv.id, sent[0]!)).toMatchObject({ status: 'delivered' });
    expect(await msgOf(conv.id, sent[1]!)).toMatchObject({ status: 'failed', failureKind: 'provider_reported' });
    expect(await msgOf(conv.id, sent[2]!)).toMatchObject({ status: 'read' });
    expect(await Promise.all(sent.map(providerId))).toEqual(ids);
    // Later updates without a reference match by provider id alone.
    await deliver(status(ids[0]!, 'read')).expect(200);
    expect((await msgOf(conv.id, sent[0]!)).status).toBe('read');
    // An update whose reference names a message that already has a different provider id cannot take it over.
    const res = await deliver(status(`wamid.other.${randomUUID()}`, 'delivered', sent[2])).expect(200);
    expect(res.body).toMatchObject({ orphan: 1 });
    expect(await providerId(sent[2]!)).toBe(ids[2]);
  });
});

describe('evidence behind "not accepted after 5 attempts"', () => {
  const run = async () => {
    for (let i = 0; i < 7; i++) {
      await app((tx) => tx.query(`UPDATE send_jobs SET next_attempt_at = now() WHERE state = 'pending'`));
      await new Sender(t.deps.db, t.deps.channels).dispatchDue();
    }
  };

  it('five recorded definite refusals: confirmed failure, with the evidence shown', async () => {
    const conv = await newConversation();
    sandbox.script.push(...Array.from({ length: 5 }, () => ({ notAccepted: '130429' })));
    const res = await agent.post(`/v1/conversations/${conv.id}/reply`, { text: 'Busy', seenActivity: conv.activitySeq, clientMessageId: randomUUID() }).expect(201);
    await run();
    const m = await msgOf(conv.id, res.body.id);
    expect(m).toMatchObject({ status: 'failed', failureKind: 'exhausted' });
    expect(m.attemptLog.map((a: { outcome: string }) => a.outcome)).toEqual(Array(5).fill('not_accepted'));
    expect(m.attemptLog.map((a: { attempt: number }) => a.attempt)).toEqual([1, 2, 3, 4, 5]);
  });

  it('refusals followed by an attempt with no answer: uncertain, never "not accepted"', async () => {
    const conv = await newConversation();
    sandbox.script.push({ notAccepted: '130429' }, { notAccepted: '130429' }, { uncertain: 'timeout' });
    const res = await agent.post(`/v1/conversations/${conv.id}/reply`, { text: 'Mixed', seenActivity: conv.activitySeq, clientMessageId: randomUUID() }).expect(201);
    await run();
    const m = await msgOf(conv.id, res.body.id);
    expect(m).toMatchObject({ status: 'uncertain', failureKind: null });
    expect(m.attemptLog.map((a: { outcome: string }) => a.outcome)).toEqual(['not_accepted', 'not_accepted', 'uncertain']);
  });

  it('if any earlier attempt of the message was ambiguous, five refusals still do not make it a confirmed failure', async () => {
    const conv = await newConversation();
    const q = await queueOnly(conv.id, 'Earlier ambiguity');
    await app((tx) => tx.query(`INSERT INTO send_attempts (tenant_id, message_id, attempt, outcome, code) VALUES ($1, $2, 1, 'interrupted', 'interrupted')`, [tenant, q.messageId]));
    sandbox.script.push(...Array.from({ length: 5 }, () => ({ notAccepted: '130429' })));
    await run();
    expect(await msgOf(conv.id, q.messageId)).toMatchObject({ status: 'uncertain', errorCode: 'mixed_attempt_outcomes' });
  });
});

describe('retry eligibility: ordinary replies versus approved templates', () => {
  it('after the window closes a failed reply cannot be retried, a failed approved template can; the reasons are given', async () => {
    const conv = await newConversation();
    sandbox.script.push({ reject: '131026' });
    const reply = await agent.post(`/v1/conversations/${conv.id}/reply`, { text: 'Reply', seenActivity: conv.activitySeq, clientMessageId: randomUUID() }).expect(201);
    const tpl = (await owner.post('/v1/templates', { name: `elig_${seq}`, language: 'en', category: 'utility', bodyText: 'Hello {{1}}, your visit is today.', examples: ['A'] }).expect(201)).body;
    await post(JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: ACCOUNT, time: Math.floor(Date.now() / 1000), changes: [{ field: 'message_template_status_update',
      value: { event: 'APPROVED', message_template_id: Number(tpl.providerTemplateId), message_template_name: 'x', message_template_language: 'en', reason: null } }] }] })).expect(200);
    sandbox.templates.get(ACCOUNT)!.find((x) => x.providerTemplateId === tpl.providerTemplateId)!.status = 'approved';
    sandbox.script.push({ reject: '131026' });
    const sentTpl = await agent.post(`/v1/conversations/${conv.id}/template`, { templateId: tpl.id, params: ['Sara'], seenActivity: (await getConv(conv.id)).activitySeq, clientMessageId: randomUUID() }).expect(201);
    expect(sentTpl.body.status).toBe('failed');
    await app((tx) => tx.query(`UPDATE conversations SET last_inbound_at = now() - interval '30 hours' WHERE id = $1`, [conv.id]));
    const view = await getConv(conv.id);
    expect(view.messages.find((m: { id: string }) => m.id === reply.body.id).retryBlock).toBe('template_required');
    expect(view.messages.find((m: { id: string }) => m.id === sentTpl.body.id).retryBlock).toBeNull();
    expect((await agent.post(`/v1/messages/${reply.body.id}/retry`, { seenActivity: view.activitySeq, clientMessageId: randomUUID() })).body.error.code).toBe('template_required');
    const r = await agent.post(`/v1/messages/${sentTpl.body.id}/retry`, { seenActivity: view.activitySeq, clientMessageId: randomUUID() }).expect(201);
    expect(r.body.status).toBe('sent');
    // A template that is no longer approved: a failed copy of it is not retryable, with that reason.
    sandbox.script.push({ reject: '131026' });
    const second = await agent.post(`/v1/conversations/${conv.id}/template`, { templateId: tpl.id, params: ['Sara'], seenActivity: (await getConv(conv.id)).activitySeq, clientMessageId: randomUUID() }).expect(201);
    await post(JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: ACCOUNT, time: Math.floor(Date.now() / 1000) + 5, changes: [{ field: 'message_template_status_update',
      value: { event: 'PAUSED', message_template_id: Number(tpl.providerTemplateId), message_template_name: 'x', message_template_language: 'en', reason: 'quality' } }] }] })).expect(200);
    expect((await getConv(conv.id)).messages.find((m: { id: string }) => m.id === second.body.id).retryBlock).toBe('template_not_approved');
    const again = await agent.post(`/v1/conversations/${conv.id}/template`, { templateId: tpl.id, params: ['Sara'], seenActivity: (await getConv(conv.id)).activitySeq, clientMessageId: randomUUID() });
    expect(again.body.error.code).toBe('template_not_approved');
  });
});
