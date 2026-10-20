/**
 * Slice 2 (BRD v1.2 Wave 1, owner decisions of 20 Oct 2026):
 * - reliable background sending: crashes before and after provider submission, duplicate jobs, uncertain delivery,
 *   bounded retries only when the provider definitely did not accept, safe manual retry, recovery of stuck messages;
 * - "pause replies / supervisor handling";
 * - opt-out commands with punctuation and emojis, in English and Arabic;
 * - verified number ownership before any live connection;
 * - the strengthened CI guard (open Low finding) against the reviewer's bypass and variants.
 */
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withContext } from '@conversaflow/database';
import { checkIsolation } from '@conversaflow/database/dist/check-rls';
import { consentKeyword, signBody, type SandboxAdapter } from '../src/modules/channels';
import { Sender, SimulatedCrash } from '../src/modules/sender';
import { activateSubscription, addMember, enableMfa, newCompany, newUser, startApp, type Client, type TestApp } from './helpers';

let t: TestApp;
let owner: Client;
let supervisor: Client;
let supervisor2: Client;
let agent: Client;
let sandbox: SandboxAdapter;
let tenant: string;
const ids: Record<string, string> = {};
const NUMBER = `pn${randomUUID().slice(0, 8)}`;
let seq = 0;
const nextWaId = () => `9715${String(Date.now()).slice(-6)}${String(++seq).padStart(2, '0')}`;

function deliver(value: Record<string, unknown>) {
  const raw = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages',
    value: { metadata: { phone_number_id: NUMBER }, ...value } }] }] });
  return request(t.app.getHttpServer()).post('/v1/webhooks/sandbox').set('Content-Type', 'application/json')
    .set('X-Hub-Signature-256', signBody(t.deps.keys.sandboxWebhook, raw)).send(raw);
}
const inbound = (from: string, text: string, ts = Math.floor(Date.now() / 1000)) => ({
  contacts: [{ wa_id: from, profile: { name: 'Customer' } }],
  messages: [{ from, id: `wamid.in.${randomUUID()}`, timestamp: String(ts), type: 'text', text: { body: text } }],
});
const status = (id: string, s: string, callback?: string) => ({
  statuses: [{ id, status: s, timestamp: String(Math.floor(Date.now() / 1000)), recipient_id: '1', ...(callback ? { biz_opaque_callback_data: callback } : {}) }],
});
async function newConversation(c: Client = agent) {
  const wa = nextWaId();
  await deliver(inbound(wa, 'Hello, I need help')).expect(200);
  const items = (await c.get('/v1/conversations?limit=100').expect(200)).body.items as Array<{ id: string }>;
  for (const it of items) {
    const conv = (await c.get(`/v1/conversations/${it.id}`).expect(200)).body;
    if (conv.contact.whatsapp === wa) return { ...conv, wa };
  }
  throw new Error('conversation not found');
}
const getConv = async (id: string, c: Client = agent) => (await c.get(`/v1/conversations/${id}`).expect(200)).body;
const msg = async (convId: string, messageId: string) => (await getConv(convId, supervisor)).messages.find((m: { id: string }) => m.id === messageId);
const app = (fn: Parameters<typeof withContext>[2]) => withContext(t.deps.db, { tenantId: tenant, userId: null }, fn);

/** Queues a message the way a reply does, without the immediate send, so the worker's behaviour can be tested alone. */
async function queueOnly(convId: string, text: string, membershipId: string) {
  return app(async (tx) => {
    const m = (await tx.query<{ id: string }>(
      `INSERT INTO messages (tenant_id, conversation_id, direction, kind, body, client_message_id, sent_by_membership_id, occurred_at, status)
       VALUES ($1, $2, 'out', 'text', $3, $4, $5, clock_timestamp(), 'queued') RETURNING id`,
      [tenant, convId, text, randomUUID(), membershipId])).rows[0]!;
    const j = (await tx.query<{ id: string }>('INSERT INTO send_jobs (tenant_id, message_id) VALUES ($1, $2) RETURNING id', [tenant, m.id])).rows[0]!;
    return { messageId: m.id, jobId: j.id };
  }) as Promise<{ messageId: string; jobId: string }>;
}
const expireLeases = () => app((tx) => tx.query(`UPDATE send_jobs SET lease_until = now() - interval '1 second' WHERE state = 'leased'`));
const dueNow = () => app((tx) => tx.query(`UPDATE send_jobs SET next_attempt_at = now() WHERE state = 'pending'`));
const job = async (messageId: string) => (await app((tx) => tx.query('SELECT state, attempts, last_error FROM send_jobs WHERE message_id = $1', [messageId])) as { rows: Array<{ state: string; attempts: number; last_error: string | null }> }).rows[0]!;

beforeAll(async () => {
  t = await startApp();
  sandbox = t.deps.channels.sandbox as SandboxAdapter;
  owner = await newUser(t, 'send-owner');
  tenant = await newCompany(owner, 'send', 'business');
  await activateSubscription(t, tenant);
  await enableMfa(owner);
  supervisor = await addMember(t, owner, 'send-sup', 'supervisor');
  supervisor2 = await addMember(t, owner, 'send-sup2', 'supervisor');
  agent = await addMember(t, owner, 'send-agent', 'agent');
  const members = (await owner.get('/v1/members').expect(200)).body as Array<{ id: string; email: string }>;
  for (const [k, c] of Object.entries({ supervisor, supervisor2, agent })) ids[k] = members.find((m) => m.email === c.email)!.id;
  await owner.post('/v1/channels', { provider: 'sandbox', providerNumberId: NUMBER, displayPhone: '+971500000000', label: 'UAE' }).expect(201);
});
afterAll(() => t?.close());

describe('reliable sending', () => {
  it('a reply is queued with a job and sent at once; the job is finished', async () => {
    const conv = await newConversation();
    const res = await agent.post(`/v1/conversations/${conv.id}/reply`, { text: 'Hi', seenActivity: conv.activitySeq, clientMessageId: randomUUID() }).expect(201);
    expect(res.body).toMatchObject({ status: 'sent', attempts: 1 });
    expect(await job(res.body.id)).toMatchObject({ state: 'done', attempts: 1 });
    expect(sandbox.sent.at(-1)!.callbackData).toBe(res.body.id);
  });

  it('crash before submission: nothing reached the provider, so the message is sent once after recovery', async () => {
    const conv = await newConversation();
    const q = await queueOnly(conv.id, 'After a crash before sending', ids.agent!);
    const before = sandbox.sent.length;
    await expect(new Sender(t.deps.db, t.deps.channels, { crashBeforeSubmit: true }).dispatchDue()).rejects.toBeInstanceOf(SimulatedCrash);
    expect(sandbox.sent.length).toBe(before);
    expect((await msg(conv.id, q.messageId)).status).toBe('queued');
    expect(await new Sender(t.deps.db, t.deps.channels).dispatchDue()).toBe(0); // lease still held: nothing taken twice
    await expireLeases();
    await new Sender(t.deps.db, t.deps.channels).dispatchDue();
    expect(sandbox.sent.length).toBe(before + 1);
    expect((await msg(conv.id, q.messageId)).status).toBe('sent');
  });

  it('crash after submission: the provider may have it, so it becomes "uncertain" and is never sent again automatically', async () => {
    const conv = await newConversation();
    const q = await queueOnly(conv.id, 'After a crash while sending', ids.agent!);
    const before = sandbox.sent.length;
    await expect(new Sender(t.deps.db, t.deps.channels, { crashAfterSubmit: true }).dispatchDue()).rejects.toBeInstanceOf(SimulatedCrash);
    expect(sandbox.sent.length).toBe(before + 1);
    expect((await msg(conv.id, q.messageId)).status).toBe('submitting');
    await expireLeases();
    await new Sender(t.deps.db, t.deps.channels).dispatchDue();
    await new Sender(t.deps.db, t.deps.channels).dispatchDue();
    expect(sandbox.sent.length).toBe(before + 1);
    expect(await msg(conv.id, q.messageId)).toMatchObject({ status: 'uncertain', errorCode: 'interrupted' });
    // The provider's status webhook carries our reference and settles it, without any re-send.
    const wamid = sandbox.sent.at(-1)!.providerMessageId;
    await deliver(status(wamid, 'delivered', q.messageId)).expect(200);
    expect(await msg(conv.id, q.messageId)).toMatchObject({ status: 'delivered', errorCode: null });
  });

  it('duplicate jobs cannot exist, and two workers on the same job send it once', async () => {
    const conv = await newConversation();
    const q = await queueOnly(conv.id, 'Only once', ids.agent!);
    await expect(app((tx) => tx.query('INSERT INTO send_jobs (tenant_id, message_id) VALUES ($1, $2)', [tenant, q.messageId]))).rejects.toMatchObject({ code: '23505' });
    const before = sandbox.sent.length;
    const s = new Sender(t.deps.db, t.deps.channels);
    // Without a live lease nobody may process it.
    expect(await s.processJob(tenant, q.jobId)).toBe('nothing_to_do');
    // Only one of several callers obtains the lease; even if all three then try, it is sent once.
    const leases = await Promise.all([s.leaseNow(tenant, q.jobId), s.leaseNow(tenant, q.jobId), s.leaseNow(tenant, q.jobId)]);
    expect(leases.filter(Boolean)).toHaveLength(1);
    const results = await Promise.all([s.processJob(tenant, q.jobId), s.processJob(tenant, q.jobId), s.processJob(tenant, q.jobId)]);
    expect(results.filter((r) => r === 'sent')).toHaveLength(1);
    expect(sandbox.sent.length).toBe(before + 1);
  });

  it('a busy provider (definitely not accepted) is retried with back-off, then succeeds; sent exactly once', async () => {
    const conv = await newConversation();
    sandbox.script.push({ notAccepted: '130429' }, { notAccepted: '130429' });
    const before = sandbox.sent.length;
    const res = await agent.post(`/v1/conversations/${conv.id}/reply`, { text: 'Retry me', seenActivity: conv.activitySeq, clientMessageId: randomUUID() }).expect(201);
    expect(res.body).toMatchObject({ status: 'queued', errorCode: '130429' });
    expect(await job(res.body.id)).toMatchObject({ state: 'pending', attempts: 1 });
    expect(await new Sender(t.deps.db, t.deps.channels).dispatchDue()).toBe(0); // not due yet (back-off)
    await dueNow();
    await new Sender(t.deps.db, t.deps.channels).dispatchDue();
    await dueNow();
    await new Sender(t.deps.db, t.deps.channels).dispatchDue();
    expect(await msg(conv.id, res.body.id)).toMatchObject({ status: 'sent', attempts: 3 });
    expect(sandbox.sent.length).toBe(before + 1);
  });

  it('retries stop after the limit and the message is shown as failed', async () => {
    const conv = await newConversation();
    sandbox.script.push(...Array.from({ length: 5 }, () => ({ notAccepted: '130429' })));
    const res = await agent.post(`/v1/conversations/${conv.id}/reply`, { text: 'Never accepted', seenActivity: conv.activitySeq, clientMessageId: randomUUID() }).expect(201);
    for (let i = 0; i < 6; i++) { await dueNow(); await new Sender(t.deps.db, t.deps.channels).dispatchDue(); }
    expect(await msg(conv.id, res.body.id)).toMatchObject({ status: 'failed', errorCode: 'retries_exhausted:130429', attempts: 5 });
    expect(await job(res.body.id)).toMatchObject({ state: 'dead' });
  });

  it('a definite refusal is never retried automatically', async () => {
    const conv = await newConversation();
    sandbox.script.push({ reject: '131026' });
    const res = await agent.post(`/v1/conversations/${conv.id}/reply`, { text: 'Refused', seenActivity: conv.activitySeq, clientMessageId: randomUUID() }).expect(201);
    expect(res.body).toMatchObject({ status: 'failed', errorCode: '131026' });
    await dueNow(); await expireLeases();
    expect(await new Sender(t.deps.db, t.deps.channels).dispatchDue()).toBe(0);
    const list = (await agent.get('/v1/conversations?limit=100').expect(200)).body.items;
    expect(list.find((c: { id: string }) => c.id === conv.id).needsAttention).toBe(true);
  });

  it('uncertain delivery: no automatic retry; a person must confirm a possible duplicate; only one retry is possible', async () => {
    const conv = await newConversation();
    sandbox.script.push({ uncertain: 'timeout' });
    const before = sandbox.sent.length;
    const res = await agent.post(`/v1/conversations/${conv.id}/reply`, { text: 'Did this arrive?', seenActivity: conv.activitySeq, clientMessageId: randomUUID() }).expect(201);
    expect(res.body).toMatchObject({ status: 'uncertain', errorCode: 'timeout' });
    await dueNow(); await expireLeases();
    await new Sender(t.deps.db, t.deps.channels).dispatchDue();
    expect(sandbox.sent.length).toBe(before);
    let now = await getConv(conv.id);
    const noConfirm = await agent.post(`/v1/messages/${res.body.id}/retry`, { seenActivity: now.activitySeq, clientMessageId: randomUUID() }).expect(409);
    expect(noConfirm.body.error.code).toBe('confirmation_required');
    const retry = await agent.post(`/v1/messages/${res.body.id}/retry`, { seenActivity: now.activitySeq, clientMessageId: randomUUID(), confirmPossibleDuplicate: true }).expect(201);
    expect(retry.body).toMatchObject({ status: 'sent', retryOf: res.body.id, body: 'Did this arrive?' });
    now = await getConv(conv.id);
    expect(now.messages.find((m: { id: string }) => m.id === res.body.id)).toMatchObject({ status: 'uncertain', retriedAs: retry.body.id });
    expect(now.events.map((e: { kind: string }) => e.kind)).toContain('retried');
    const again = await agent.post(`/v1/messages/${res.body.id}/retry`, { seenActivity: now.activitySeq, clientMessageId: randomUUID(), confirmPossibleDuplicate: true }).expect(409);
    expect(again.body.error.code).toBe('already_retried');
    const audit = (await owner.get('/v1/audit-events').expect(200)).body as Array<{ action: string; targetId: string }>;
    expect(audit.some((e) => e.action === 'message.retried' && e.targetId === res.body.id)).toBe(true);
  });

  it('a provider slower than the timeout: the call is cancelled and shown as uncertain, long before the lease ends', async () => {
    const conv = await newConversation();
    const q = await queueOnly(conv.id, 'Slow provider', ids.agent!);
    sandbox.script.push({ slowMs: 2_000 });
    const before = sandbox.sent.length;
    const s = new Sender(t.deps.db, t.deps.channels, {}, 200);
    expect(await s.leaseNow(tenant, q.jobId)).toBe(true);
    const started = Date.now();
    expect(await s.processJob(tenant, q.jobId)).toBe('uncertain');
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(await msg(conv.id, q.messageId)).toMatchObject({ status: 'uncertain', errorCode: 'provider_timeout' });
    await new Promise((r) => setTimeout(r, 2_100));
    expect(sandbox.sent.length).toBe(before); // the cancelled call never completed
  });

  it('accepted but the answer was lost: "uncertain" until the status webhook settles it, sent once', async () => {
    const conv = await newConversation();
    sandbox.script.push({ acceptedButLost: 'connection_reset' });
    const before = sandbox.sent.length;
    const res = await agent.post(`/v1/conversations/${conv.id}/reply`, { text: 'Lost answer', seenActivity: conv.activitySeq, clientMessageId: randomUUID() }).expect(201);
    expect(res.body.status).toBe('uncertain');
    expect(sandbox.sent.length).toBe(before + 1);
    await deliver(status(sandbox.sent.at(-1)!.providerMessageId, 'read', res.body.id)).expect(200);
    expect(await msg(conv.id, res.body.id)).toMatchObject({ status: 'read', errorCode: null });
  });

  it('conditions are checked again at the moment of sending: an opt-out after queueing stops the send', async () => {
    const conv = await newConversation();
    const q = await queueOnly(conv.id, 'Queued before the opt-out', ids.agent!);
    await deliver(inbound(conv.wa, 'STOP 🛑')).expect(200);
    const before = sandbox.sent.length;
    await new Sender(t.deps.db, t.deps.channels).dispatchDue();
    expect(sandbox.sent.length).toBe(before);
    expect(await msg(conv.id, q.messageId)).toMatchObject({ status: 'failed', errorCode: 'contact_opted_out' });
  });
});

describe('pause replies / supervisor handling', () => {
  it('only people with the pause permission can pause; a reason is required', async () => {
    const conv = await newConversation();
    await agent.post(`/v1/conversations/${conv.id}/pause`, { reason: 'I want to', minutes: 30 }).expect(403);
    await supervisor.post(`/v1/conversations/${conv.id}/pause`, { reason: '', minutes: 30 }).expect(400);
    ids.pausedConv = conv.id;
  });

  it('while paused, others cannot reply (reason shown) but the pausing supervisor can; notes still work', async () => {
    const id = ids.pausedConv!;
    const p = await supervisor.post(`/v1/conversations/${id}/pause`, { reason: 'Complaint escalated — I am calling the customer', minutes: 60 }).expect(200);
    expect(p.body).toMatchObject({ active: true, pausedByMembershipId: ids.supervisor });
    let conv = await getConv(id);
    expect(conv.pause).toMatchObject({ active: true, reason: 'Complaint escalated — I am calling the customer' });
    const blocked = await agent.post(`/v1/conversations/${id}/reply`, { text: 'Hi', seenActivity: conv.activitySeq, clientMessageId: randomUUID() }).expect(409);
    expect(blocked.body.error).toMatchObject({ code: 'replies_paused', details: { reason: 'Complaint escalated — I am calling the customer' } });
    await agent.post(`/v1/conversations/${id}/notes`, { body: 'Customer called back' }).expect(201);
    const other = await supervisor2.post(`/v1/conversations/${id}/reply`, { text: 'Hi', seenActivity: conv.activitySeq, clientMessageId: randomUUID() }).expect(409);
    expect(other.body.error.code).toBe('replies_paused');
    conv = await getConv(id, supervisor);
    await supervisor.post(`/v1/conversations/${id}/reply`, { text: 'We are on it', seenActivity: conv.activitySeq, clientMessageId: randomUUID() }).expect(201);
  });

  it('a queued message from someone else is not sent while paused', async () => {
    const conv = await getConv(ids.pausedConv!, supervisor);
    const q = await queueOnly(conv.id, 'Queued during the pause', ids.supervisor2!);
    const before = sandbox.sent.length;
    await new Sender(t.deps.db, t.deps.channels).dispatchDue();
    expect(sandbox.sent.length).toBe(before);
    expect(await msg(conv.id, q.messageId)).toMatchObject({ status: 'failed', errorCode: 'replies_paused' });
  });

  it('another supervisor can release it; the agent cannot; it is recorded', async () => {
    const id = ids.pausedConv!;
    // The agent cannot release it (the conversation is now the supervisor's, so it is not even visible to the agent).
    expect([403, 404]).toContain((await agent.delete(`/v1/conversations/${id}/pause`)).status);
    await supervisor2.delete(`/v1/conversations/${id}/pause`).expect(200);
    const conv = await getConv(id, supervisor2);
    expect(conv.pause.active).toBe(false);
    expect(conv.events.map((e: { kind: string }) => e.kind)).toEqual(expect.arrayContaining(['paused', 'resumed']));
    const audit = (await owner.get('/v1/audit-events').expect(200)).body as Array<{ action: string }>;
    expect(audit.map((e) => e.action)).toEqual(expect.arrayContaining(['conversation.replies_paused', 'conversation.replies_resumed']));
  });

  it('a pause ends by itself when it expires', async () => {
    const conv = await newConversation(supervisor);
    await supervisor.post(`/v1/conversations/${conv.id}/pause`, { reason: 'Checking the invoice first', minutes: 5 }).expect(200);
    await app((tx) => tx.query(`UPDATE conversations SET paused_until = now() - interval '1 minute' WHERE id = $1`, [conv.id]));
    const fresh = await getConv(conv.id, supervisor);
    expect(fresh.pause.active).toBe(false);
    await supervisor2.post(`/v1/conversations/${conv.id}/reply`, { text: 'Thanks for waiting', seenActivity: fresh.activitySeq, clientMessageId: randomUUID() }).expect(201);
  });
});

describe('opt-out commands (owner decision 3)', () => {
  it.each([
    'STOP', 'Stop.', 'stop!!!', 'STOP 🛑', '🛑 stop 🛑', 'Stop ✋🏽', 'stop 👍🏻', '"stop"', 'Unsubscribe.', 'stop all!',
    'إيقاف', 'ايقاف', 'إِيقاف', 'إيـقـاف', 'إيقاف 🙏', 'إيقاف!!', 'توقف.', 'إلغاء الاشتراك', 'الغاء الاشتراك ✋', 'أوقف', 'اوقف!',
    '\u200fإيقاف', 'إيقاف\u200f', '\u202bSTOP\u202c', 'ST\u200cOP', '\ufeffstop', '\u2067إيقاف\u2069 🙏',
  ])('"%s" is an opt-out', (text) => expect(consentKeyword(text)).toBe('opt_out'));

  it.each(['START', 'Start 👍', 'ابدأ', 'ابدا ✅', 'اشتراك!'])('"%s" is an opt-in', (text) => expect(consentKeyword(text)).toBe('opt_in'));

  it.each([
    'please stop', 'stop the technician', 'Stop by tomorrow?', "don't stop", 'S T O P', 'stopped',
    'إلغاء', 'الغاء الموعد', 'لا تتوقف', 'إيقاف المكيف من فضلك', 'I want to start a booking',
  ])('"%s" is an ordinary message', (text) => expect(consentKeyword(text)).toBeNull());

  it('an emoji opt-out through a real webhook blocks replies', async () => {
    const conv = await newConversation();
    await deliver(inbound(conv.wa, 'إيقاف 🙏')).expect(200);
    const fresh = await getConv(conv.id);
    expect(fresh.contact.optedOut).toBe(true);
  });
});

describe('verified number ownership before any live connection', () => {
  it('the business role cannot create a live WhatsApp connection, through the API or directly', async () => {
    await owner.post('/v1/channels', { provider: 'whatsapp_cloud', providerNumberId: 'live123', displayPhone: '+971500000001', label: 'Live' }).expect(409);
    await expect(app((tx) => tx.query(
      `INSERT INTO channel_connections (tenant_id, provider, provider_number_id, display_phone, label) VALUES ($1, 'whatsapp_cloud', 'live124', '+97150', 'Live')`,
      [tenant]))).rejects.toMatchObject({ code: '23514' });
    await expect(app((tx) => tx.query(
      `INSERT INTO channel_connections (tenant_id, provider, provider_number_id, display_phone, label, ownership_verified_at, ownership_method)
       VALUES ($1, 'whatsapp_cloud', 'live125', '+97150', 'Live', now(), 'embedded_signup_v4')`, [tenant]))).rejects.toMatchObject({ code: '42501' });
  });
});

describe('strengthened CI guard (open Low finding)', () => {
  const guard = () => checkIsolation(process.env.DATABASE_URL!);
  const reset = async (sql: string[]) => { for (const q of sql) await t.ownerDb.query(q).catch(() => undefined); };

  it('starts clean', async () => expect(await guard()).toEqual([]));

  it("flags the reviewer's bypass: a read grant to cf_ops and a cf_ops function that exposes it", async () => {
    try {
      await t.ownerDb.query('GRANT SELECT ON messages TO cf_ops');
      await t.ownerDb.query('CREATE POLICY zz_ops_read ON messages FOR SELECT TO cf_ops USING (true)');
      await t.ownerDb.query(`CREATE FUNCTION zz_ops_msgs() RETURNS SETOF messages LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$ SELECT * FROM messages $$`);
      await t.ownerDb.query('ALTER FUNCTION zz_ops_msgs() OWNER TO cf_ops');
      await t.ownerDb.query('GRANT EXECUTE ON FUNCTION zz_ops_msgs() TO cf_app');
      expect(await guard()).toEqual(expect.arrayContaining([
        'cf_ops can read company table messages; it is not on the reviewed list',
        'zz_ops_msgs() (owned by cf_ops) is a privileged function a login role can run; it is not on the reviewed list',
      ]));
    } finally {
      await reset(['DROP FUNCTION IF EXISTS zz_ops_msgs()', 'DROP POLICY IF EXISTS zz_ops_read ON messages', 'REVOKE SELECT ON messages FROM cf_ops']);
    }
    expect(await guard()).toEqual([]);
  });

  it('flags a PUBLIC grant, a login role reading a new table, a new function by an allowed reader, and inherited reads', async () => {
    try {
      await t.ownerDb.query('GRANT SELECT ON contacts TO PUBLIC');
      await t.ownerDb.query('GRANT SELECT (body) ON messages TO cf_identity');
      await t.ownerDb.query(`CREATE FUNCTION zz_auth_peek() RETURNS bigint LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$ SELECT count(*) FROM invitations $$`);
      await t.ownerDb.query('ALTER FUNCTION zz_auth_peek() OWNER TO cf_auth');
      await t.ownerDb.query('GRANT cf_ops TO cf_dispatch');
      const problems = await guard();
      expect(problems).toEqual(expect.arrayContaining([
        'cf_notify can read company table contacts; it is not on the reviewed list',
        'cf_identity can read company table messages; it is not on the reviewed list',
        'zz_auth_peek() (owned by cf_auth) is a privileged function a login role can run; it is not on the reviewed list',
        'cf_dispatch can read company table audit_events; it is not on the reviewed list',
      ]));
    } finally {
      await reset(['REVOKE SELECT ON contacts FROM PUBLIC', 'REVOKE SELECT (body) ON messages FROM cf_identity',
        'DROP FUNCTION IF EXISTS zz_auth_peek()', 'REVOKE cf_ops FROM cf_dispatch']);
    }
    expect(await guard()).toEqual([]);
  });

  it('review S2a: an owner policy plus a view over a company table is flagged', async () => {
    try {
      await t.ownerDb.query('CREATE POLICY zz_own ON messages FOR SELECT TO CURRENT_USER USING (true)');
      await t.ownerDb.query('CREATE VIEW zz_msgs AS SELECT id, tenant_id, body, conversation_id FROM messages');
      await t.ownerDb.query('GRANT SELECT ON zz_msgs TO cf_app');
      const problems = await guard();
      expect(problems).toEqual(expect.arrayContaining([
        'policy zz_own on company table messages applies to <owner>; it is not on the reviewed list',
        'view zz_msgs reads company table messages; views over company tables are not allowed',
      ]));
    } finally {
      await reset(['DROP VIEW IF EXISTS zz_msgs', 'DROP POLICY IF EXISTS zz_own ON messages']);
    }
    expect(await guard()).toEqual([]);
  });

  it('review S2b: replacing the body of a reviewed privileged function is flagged', async () => {
    const original = (await t.ownerDb.query<{ src: string }>("SELECT pg_get_functiondef('platform_list_mfa_resets(text)'::regprocedure) AS src")).rows[0]!.src;
    try {
      await t.ownerDb.query(`CREATE OR REPLACE FUNCTION platform_list_mfa_resets(p_token text) RETURNS jsonb
        LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$ SELECT '[]'::jsonb $$`);
      expect(await guard()).toContain('platform_list_mfa_resets(text) has changed since it was reviewed (definition or owner)');
    } finally {
      await t.ownerDb.query(original);
    }
    expect(await guard()).toEqual([]);
  });
});
