/**
 * Retry rules (owner decision of 21 Oct 2026) and the distinction between a confirmed failure and an uncertain
 * delivery:
 * - a colleague may retry a failed message if they may reply to the conversation right now;
 * - assignment, pauses, opt-outs, the sender's permission and the window are checked again at the time of sending;
 * - the original author and the person retrying are both recorded;
 * - a retry copy cannot be retried again to get round the limit (database-enforced lineage);
 * - an uncertain message still needs the explicit duplicate confirmation;
 * - every failed message carries how we know it failed; an uncertain one never does.
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
let supervisor: Client;
let agentA: Client;
let agentB: Client;
let leaver: Client;
let sandbox: SandboxAdapter;
let tenant: string;
const ids: Record<string, string> = {};
const NUMBER = `pn${randomUUID().slice(0, 8)}`;
let seq = 0;
const nextWaId = () => `9665${String(Date.now()).slice(-6)}${String(++seq).padStart(2, '0')}`;

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
const statusEvent = (id: string, s: string, code?: number) => ({
  statuses: [{ id, status: s, timestamp: String(Math.floor(Date.now() / 1000)), recipient_id: '1', ...(code ? { errors: [{ code }] } : {}) }],
});
async function newConversation(c: Client) {
  const wa = nextWaId();
  await deliver(inbound(wa, 'Hello')).expect(200);
  const items = (await c.get('/v1/conversations?limit=100').expect(200)).body.items as Array<{ id: string }>;
  for (const it of items) {
    const conv = (await c.get(`/v1/conversations/${it.id}`).expect(200)).body;
    if (conv.contact.whatsapp === wa) return { ...conv, wa };
  }
  throw new Error('conversation not found');
}
const getConv = async (id: string, c: Client = supervisor) => (await c.get(`/v1/conversations/${id}`).expect(200)).body;
const msgOf = async (convId: string, id: string) => (await getConv(convId)).messages.find((m: { id: string }) => m.id === id);
const app = <T>(fn: Parameters<typeof withContext<T>>[2]) => withContext<T>(t.deps.db, { tenantId: tenant, userId: null }, fn);
const reply = (c: Client, conv: { id: string; activitySeq: number }, text: string) =>
  c.post(`/v1/conversations/${conv.id}/reply`, { text, seenActivity: conv.activitySeq, clientMessageId: randomUUID() });
const retry = (c: Client, messageId: string, seenActivity: number, confirm?: boolean) =>
  c.post(`/v1/messages/${messageId}/retry`, { seenActivity, clientMessageId: randomUUID(), ...(confirm ? { confirmPossibleDuplicate: true } : {}) });

/** Queues a retry the way the API does, but without sending it, so the worker's checks at send time can be tested. */
async function queueRetry(convId: string, originalId: string, membershipId: string) {
  return app(async (tx) => {
    const m = (await tx.query<{ id: string }>(
      `INSERT INTO messages (tenant_id, conversation_id, direction, kind, body, client_message_id, sent_by_membership_id, occurred_at, status, retry_of)
       VALUES ($1, $2, 'out', 'text', 'retry copy', $3, $4, clock_timestamp(), 'queued', $5) RETURNING id`,
      [tenant, convId, randomUUID(), membershipId, originalId])).rows[0]!;
    const j = (await tx.query<{ id: string }>('INSERT INTO send_jobs (tenant_id, message_id) VALUES ($1, $2) RETURNING id', [tenant, m.id])).rows[0]!;
    return { messageId: m.id, jobId: j.id };
  });
}
async function failedMessageBy(c: Client, conv: { id: string; activitySeq: number }) {
  sandbox.script.push({ reject: '131026' });
  const res = await reply(c, conv, 'This will be refused').expect(201);
  expect(res.body).toMatchObject({ status: 'failed', failureKind: 'rejected' });
  return res.body.id as string;
}

beforeAll(async () => {
  t = await startApp();
  sandbox = t.deps.channels.sandbox as SandboxAdapter;
  owner = await newUser(t, 'retry-owner');
  tenant = await newCompany(owner, 'retry', 'business');
  await activateSubscription(t, tenant);
  await enableMfa(owner);
  supervisor = await addMember(t, owner, 'retry-sup', 'supervisor');
  agentA = await addMember(t, owner, 'retry-a', 'agent');
  agentB = await addMember(t, owner, 'retry-b', 'agent');
  leaver = await addMember(t, owner, 'retry-leaver', 'agent');
  const members = (await owner.get('/v1/members').expect(200)).body as Array<{ id: string; email: string }>;
  for (const [k, c] of Object.entries({ supervisor, agentA, agentB, leaver })) ids[k] = members.find((m) => m.email === c.email)!.id;
  await owner.post('/v1/channels', { provider: 'sandbox', providerNumberId: NUMBER, displayPhone: '+966500000000', label: 'KSA' }).expect(201);
});
afterAll(() => t?.close());

describe('retrying a colleague\'s failed message', () => {
  it('is refused while the conversation is assigned to the colleague, and allowed once it is free', async () => {
    const conv = await newConversation(agentA);
    const failed = await failedMessageBy(agentA, conv);
    // Agent B cannot even see a conversation assigned to A; the supervisor sees it but A is handling it.
    expect((await retry(agentB, failed, 0)).status).toBe(404);
    let now = await getConv(conv.id);
    expect((await retry(supervisor, failed, now.activitySeq)).body.error.code).toBe('assigned_to_other');
    // A hands it back; now B may reply to it, so B may retry A's message.
    await agentA.post(`/v1/conversations/${conv.id}/assign`, { membershipId: null, expectedVersion: (await getConv(conv.id, agentA)).version }).expect(200);
    now = await getConv(conv.id, agentB);
    const res = await retry(agentB, failed, now.activitySeq).expect(201);
    expect(res.body).toMatchObject({
      status: 'sent', retryOf: failed, retryNumber: 1,
      sentByMembershipId: ids.agentB, originalAuthorMembershipId: ids.agentA,
    });
    // Both people are recorded in the conversation history and the audit log.
    now = await getConv(conv.id);
    const ev = now.events.find((e: { kind: string }) => e.kind === 'retried');
    expect(ev.data).toMatchObject({ originalAuthorMembershipId: ids.agentA, retriedByMembershipId: ids.agentB, failureKind: 'rejected' });
    expect(ev.actorMembershipId).toBe(ids.agentB);
    const audit = (await owner.get('/v1/audit-events').expect(200)).body as Array<{ action: string; targetId: string; metadata: Record<string, unknown> }>;
    expect(audit.find((e) => e.action === 'message.retried' && e.targetId === failed)!.metadata)
      .toMatchObject({ originalAuthorMembershipId: ids.agentA, retriedByMembershipId: ids.agentB });
    expect(now.people[ids.agentA!]).toBeTruthy();
  });

  it('a pause refuses the retry up front (other reply checks are shared with replies)', async () => {
    const conv = await newConversation(agentA);
    const failed = await failedMessageBy(agentA, conv);
    await supervisor.post(`/v1/conversations/${conv.id}/pause`, { reason: 'Supervisor is calling the customer', minutes: 30 }).expect(200);
    const now = await getConv(conv.id, agentA);
    expect((await retry(agentA, failed, now.activitySeq)).body.error.code).toBe('replies_paused');
  });
});

describe('checks again at the time of sending', () => {
  async function failedUnassigned() {
    const conv = await newConversation(agentA);
    const failed = await failedMessageBy(agentA, conv);
    await app((tx) => tx.query('UPDATE conversations SET assigned_membership_id = NULL WHERE id = $1', [conv.id]));
    return { conv, failed };
  }
  const run = () => new Sender(t.deps.db, t.deps.channels).dispatchDue();

  it('reassigned to someone else before it was sent: blocked, nothing sent', async () => {
    const { conv, failed } = await failedUnassigned();
    const q = await queueRetry(conv.id, failed, ids.agentB!);
    await app((tx) => tx.query('UPDATE conversations SET assigned_membership_id = $2 WHERE id = $1', [conv.id, ids.agentA]));
    const before = sandbox.sent.length;
    await run();
    expect(sandbox.sent.length).toBe(before);
    expect(await msgOf(conv.id, q.messageId)).toMatchObject({ status: 'failed', failureKind: 'blocked', errorCode: 'assigned_to_other' });
  });

  it('replies paused before it was sent: blocked', async () => {
    const { conv, failed } = await failedUnassigned();
    const q = await queueRetry(conv.id, failed, ids.agentB!);
    await supervisor.post(`/v1/conversations/${conv.id}/pause`, { reason: 'Handling a complaint', minutes: null }).expect(200);
    await app((tx) => tx.query('UPDATE conversations SET assigned_membership_id = NULL WHERE id = $1', [conv.id]));
    await run();
    expect(await msgOf(conv.id, q.messageId)).toMatchObject({ status: 'failed', failureKind: 'blocked', errorCode: 'replies_paused' });
  });

  it('the customer opted out before it was sent: blocked', async () => {
    const { conv, failed } = await failedUnassigned();
    const q = await queueRetry(conv.id, failed, ids.agentB!);
    await deliver(inbound(conv.wa, 'إيقاف')).expect(200);
    await run();
    expect(await msgOf(conv.id, q.messageId)).toMatchObject({ status: 'failed', failureKind: 'blocked', errorCode: 'contact_opted_out' });
  });

  it('the person retrying lost permission to reply before it was sent: blocked', async () => {
    const { conv, failed } = await failedUnassigned();
    const q = await queueRetry(conv.id, failed, ids.leaver!);
    await owner.put(`/v1/members/${ids.leaver}/roles`, { roleKeys: ['analyst'] }).expect(204);
    await run();
    expect(await msgOf(conv.id, q.messageId)).toMatchObject({ status: 'failed', failureKind: 'blocked', errorCode: 'sender_not_allowed' });
  });

  it('the 24-hour window closed before it was sent: blocked', async () => {
    const { conv, failed } = await failedUnassigned();
    const q = await queueRetry(conv.id, failed, ids.agentB!);
    await app((tx) => tx.query(`UPDATE conversations SET last_inbound_at = now() - interval '25 hours' WHERE id = $1`, [conv.id]));
    await run();
    expect(await msgOf(conv.id, q.messageId)).toMatchObject({ status: 'failed', failureKind: 'blocked', errorCode: 'template_required' });
  });
});

describe('the retry limit cannot be bypassed', () => {
  it('a retry copy that fails cannot be retried again, through the API or directly', async () => {
    const conv = await newConversation(agentA);
    const failed = await failedMessageBy(agentA, conv);
    sandbox.script.push({ reject: '131026' });
    let now = await getConv(conv.id, agentA);
    const first = await retry(agentA, failed, now.activitySeq).expect(201);
    expect(first.body).toMatchObject({ status: 'failed', retryNumber: 1 });
    now = await getConv(conv.id, agentA);
    expect(now.messages.find((m: { id: string }) => m.id === first.body.id).retryable).toBe(false);
    expect((await retry(agentA, first.body.id, now.activitySeq)).body.error.code).toBe('retry_limit_reached');
    // Straight into the database: retrying the copy breaks the chain limit; retrying the original again is a duplicate.
    await expect(queueRetry(conv.id, first.body.id, ids.agentA!)).rejects.toMatchObject({ code: '23514' });
    await expect(queueRetry(conv.id, failed, ids.agentA!)).rejects.toMatchObject({ code: '23505' });
  });

  it('the lineage is set by the database, not by the request', async () => {
    const conv = await newConversation(agentA);
    const failed = await failedMessageBy(agentA, conv);
    const spoofed = await app(async (tx) => (await tx.query<{ retry_root: string; retry_number: number; original_author_membership_id: string }>(
      `INSERT INTO messages (tenant_id, conversation_id, direction, kind, body, client_message_id, sent_by_membership_id, occurred_at, status,
                             retry_of, retry_root, retry_number, original_author_membership_id)
       VALUES ($1, $2, 'out', 'text', 'x', $3, $4, clock_timestamp(), 'queued', $5, $6, 0, $4)
       RETURNING retry_root, retry_number, original_author_membership_id`,
      [tenant, conv.id, randomUUID(), ids.agentB, failed, randomUUID()])).rows[0]!);
    expect(spoofed).toEqual({ retry_root: failed, retry_number: 1, original_author_membership_id: ids.agentA });
    // A message that did not fail cannot be retried, and lineage cannot be edited afterwards.
    const ok = await reply(agentA, await getConv(conv.id, agentA), 'Delivered fine').expect(201);
    await expect(queueRetry(conv.id, ok.body.id, ids.agentA!)).rejects.toMatchObject({ code: '23514' });
    await expect(app((tx) => tx.query('UPDATE messages SET retry_number = 0 WHERE id = $1', [ok.body.id]))).rejects.toMatchObject({ code: '42501' });
  });

  it('two people retrying at the same time produce one retry', async () => {
    const conv = await newConversation(agentA);
    const failed = await failedMessageBy(agentA, conv);
    await app((tx) => tx.query('UPDATE conversations SET assigned_membership_id = NULL WHERE id = $1', [conv.id]));
    const seen = (await getConv(conv.id)).activitySeq;
    const results = await Promise.all([retry(agentA, failed, seen), retry(agentB, failed, seen), retry(supervisor, failed, seen)]);
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status !== 201).every((r) => [404, 409].includes(r.status))).toBe(true);
  });
});

describe('confirmed failure versus uncertain delivery', () => {
  it('an uncertain message from a colleague still needs the duplicate confirmation', async () => {
    const conv = await newConversation(agentA);
    sandbox.script.push({ uncertain: 'timeout' });
    const res = await reply(agentA, conv, 'Maybe delivered').expect(201);
    expect(res.body).toMatchObject({ status: 'uncertain', failureKind: null });
    await app((tx) => tx.query('UPDATE conversations SET assigned_membership_id = NULL WHERE id = $1', [conv.id]));
    const seen = (await getConv(conv.id, agentB)).activitySeq;
    expect((await retry(agentB, res.body.id, seen)).body.error.code).toBe('confirmation_required');
    const ok = await retry(agentB, res.body.id, seen, true).expect(201);
    expect(ok.body).toMatchObject({ originalAuthorMembershipId: ids.agentA, sentByMembershipId: ids.agentB });
    const ev = (await getConv(conv.id)).events.find((e: { kind: string }) => e.kind === 'retried');
    expect(ev.data).toMatchObject({ originalStatus: 'uncertain', confirmedPossibleDuplicate: true });
  });

  it('every failure records how we know; a provider-reported failure is one too; uncertain never is', async () => {
    const conv = await newConversation(agentA);
    // exhausted
    sandbox.script.push(...Array.from({ length: 5 }, () => ({ notAccepted: '130429' })));
    const busy = await reply(agentA, conv, 'Busy').expect(201);
    for (let i = 0; i < 6; i++) {
      await app((tx) => tx.query(`UPDATE send_jobs SET next_attempt_at = now() WHERE state = 'pending'`));
      await new Sender(t.deps.db, t.deps.channels).dispatchDue();
    }
    expect(await msgOf(conv.id, busy.body.id)).toMatchObject({ status: 'failed', failureKind: 'exhausted' });
    // provider_reported: accepted, then a failed status webhook
    const later = await reply(agentA, await getConv(conv.id, agentA), 'Accepted then failed').expect(201);
    await deliver(statusEvent(sandbox.sent.at(-1)!.providerMessageId, 'failed', 131049)).expect(200);
    expect(await msgOf(conv.id, later.body.id)).toMatchObject({ status: 'failed', failureKind: 'provider_reported', errorCode: '131049' });
    // The database refuses a failed message without a kind, and an uncertain one with a kind.
    await expect(app((tx) => tx.query(`UPDATE messages SET status = 'failed', failure_kind = NULL WHERE id = $1`, [later.body.id]))).rejects.toMatchObject({ code: '23514' });
    await expect(app((tx) => tx.query(`UPDATE messages SET status = 'uncertain', failure_kind = 'rejected' WHERE id = $1`, [later.body.id]))).rejects.toMatchObject({ code: '23514' });
  });
});
