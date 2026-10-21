/**
 * Messaging slice 1 (BRD v1.2 Wave 1: CF-EXT-001/002/003/026; FR-101–108, FR-201–204, FR-301).
 * Acceptance items covered: 1 (duplicate/reordered webhooks), 2 (no conflicting replies), 6 (opt-outs enforced),
 * 9 (company boundaries on the new storage), plus the 24-hour service window and honest send failures.
 * All provider traffic goes to the sandbox adapter; nothing leaves the process.
 */
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkIsolation } from '@conversaflow/database/dist/check-rls';
import { signBody, type SandboxAdapter } from '../src/modules/channels';
import { activateSubscription, addMember, enableMfa, newCompany, newUser, startApp, type Client, type TestApp } from './helpers';

let t: TestApp;
let owner: Client;
let supervisor: Client;
let agentA: Client;
let agentB: Client;
let analyst: Client;
let other: Client;
let sandbox: SandboxAdapter;
const ids: Record<string, string> = {};
const NUMBER = `pn${randomUUID().slice(0, 8)}`;
const OTHER_NUMBER = `pn${randomUUID().slice(0, 8)}`;
let seq = 0;
const nextWaId = () => `9665${String(Date.now()).slice(-6)}${String(++seq).padStart(2, '0')}`;

function webhook(value: Record<string, unknown>, number = NUMBER) {
  return {
    object: 'whatsapp_business_account',
    entry: [{ id: 'waba-test', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: number, display_phone_number: '966500000000' }, ...value } }] }],
  };
}
function inbound(from: string, text: string, opts: { id?: string; ts?: number; name?: string; referral?: object } = {}) {
  const id = opts.id ?? `wamid.in.${randomUUID()}`;
  return {
    id,
    value: {
      contacts: [{ wa_id: from, profile: { name: opts.name ?? 'Test Customer' } }],
      messages: [{ from, id, timestamp: String(opts.ts ?? Math.floor(Date.now() / 1000)), type: 'text', text: { body: text }, ...(opts.referral ? { referral: opts.referral } : {}) }],
    },
  };
}
const status = (id: string, s: string, ts = Math.floor(Date.now() / 1000)) => ({ statuses: [{ id, status: s, timestamp: String(ts), recipient_id: '1' }] });

function deliver(payload: unknown, secret = t.deps.keys.sandboxWebhook) {
  const raw = JSON.stringify(payload);
  return request(t.app.getHttpServer()).post('/v1/webhooks/sandbox')
    .set('Content-Type', 'application/json').set('X-Hub-Signature-256', signBody(secret, raw)).send(raw);
}
async function conversationFor(c: Client, waId: string) {
  const list = (await c.get('/v1/conversations?status=active&limit=100').expect(200)).body.items as Array<{ id: string; contactId: string }>;
  for (const item of list) {
    const full = (await c.get(`/v1/conversations/${item.id}`).expect(200)).body;
    if (full.contact.whatsapp === waId) return full;
  }
  throw new Error(`no conversation for ${waId}`);
}

beforeAll(async () => {
  t = await startApp();
  sandbox = t.deps.channels.sandbox as SandboxAdapter;
  owner = await newUser(t, 'msg-owner');
  ids.tenant = await newCompany(owner, 'msg', 'business');
  await activateSubscription(t, ids.tenant);
  await enableMfa(owner);
  supervisor = await addMember(t, owner, 'msg-sup', 'supervisor');
  agentA = await addMember(t, owner, 'msg-a', 'agent');
  agentB = await addMember(t, owner, 'msg-b', 'agent');
  analyst = await addMember(t, owner, 'msg-analyst', 'analyst');
  const members = (await owner.get('/v1/members').expect(200)).body as Array<{ id: string; email: string }>;
  for (const [k, c] of Object.entries({ supervisor, agentA, agentB, analyst })) ids[k] = members.find((m) => m.email === c.email)!.id;
  other = await newUser(t, 'msg-other');
  ids.otherTenant = await newCompany(other, 'msg-other', 'business');
  await enableMfa(other);
});
afterAll(() => t?.close());

describe('channels', () => {
  it('only people allowed to manage channels can connect one; live WhatsApp waits for Meta onboarding', async () => {
    await agentA.post('/v1/channels', { provider: 'sandbox', providerNumberId: NUMBER, displayPhone: '+966500000000', label: 'Main' }).expect(403);
    await owner.post('/v1/channels', { provider: 'whatsapp_cloud', providerNumberId: 'x123', displayPhone: '+966500000001', label: 'Live' }).expect(409);
    const ch = await owner.post('/v1/channels', { provider: 'sandbox', providerNumberId: NUMBER, displayPhone: '+966500000000', label: 'Main' }).expect(201);
    expect(ch.body).toMatchObject({ provider: 'sandbox', status: 'active' });
    expect((await agentA.get('/v1/channels').expect(200)).body).toHaveLength(1);
  });

  it('a number can never be claimed by a second company, and the answer does not say who holds it', async () => {
    const dup = await other.post('/v1/channels', { provider: 'sandbox', providerNumberId: NUMBER, displayPhone: '+966500000000', label: 'Mine' }).expect(409);
    expect(dup.body.error.code).toBe('number_unavailable');
    await other.post('/v1/channels', { provider: 'sandbox', providerNumberId: OTHER_NUMBER, displayPhone: '+971500000000', label: 'UAE' }).expect(201);
  });
});

describe('webhook intake (acceptance 1)', () => {
  it('answers the subscription check only with the right token', async () => {
    const http = request(t.app.getHttpServer());
    await http.get('/v1/webhooks/sandbox').query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong-token-1234567', 'hub.challenge': 'abc' }).expect(403);
    const ok = await http.get('/v1/webhooks/sandbox').query({ 'hub.mode': 'subscribe', 'hub.verify_token': t.deps.keys.sandboxVerifyToken, 'hub.challenge': 'abc123' }).expect(200);
    expect(ok.text).toBe('abc123');
  });

  it('refuses unsigned, wrongly signed and tampered deliveries', async () => {
    const payload = webhook(inbound(nextWaId(), 'hello').value);
    const raw = JSON.stringify(payload);
    const http = request(t.app.getHttpServer());
    await http.post('/v1/webhooks/sandbox').set('Content-Type', 'application/json').send(raw).expect(401);
    await deliver(payload, 'a-different-secret-entirely').expect(401);
    await http.post('/v1/webhooks/sandbox').set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', signBody(t.deps.keys.sandboxWebhook, raw)).send(raw.replace('hello', 'HELLO')).expect(401);
  });

  it('a repeated delivery is recorded once and changes nothing', async () => {
    const wa = nextWaId();
    const m = inbound(wa, 'Do you service AC units in Dammam?', { name: 'Fahad' });
    const first = await deliver(webhook(m.value)).expect(200);
    expect(first.body).toMatchObject({ applied: 1, duplicate: 0 });
    const again = await deliver(webhook(m.value)).expect(200);
    expect(again.body).toMatchObject({ applied: 0, duplicate: 1 });
    const conv = await conversationFor(agentA, wa);
    expect(conv.messages).toHaveLength(1);
    expect(conv.contact).toMatchObject({ displayName: 'Fahad', optedOut: false, whatsapp: wa });
    ids.waFahad = wa;
  });

  it('messages delivered out of order are shown in the order they happened', async () => {
    const wa = nextWaId();
    const now = Math.floor(Date.now() / 1000);
    const older = inbound(wa, 'first', { ts: now - 120 });
    const newer = inbound(wa, 'second', { ts: now - 60 });
    await deliver(webhook(newer.value)).expect(200);
    await deliver(webhook(older.value)).expect(200);
    const conv = await conversationFor(agentA, wa);
    expect(conv.messages.map((x: { body: string }) => x.body)).toEqual(['first', 'second']);
    expect(conv.lastMessageId).toBe(conv.messages[1].id);
  });

  it('events for an unknown number are counted and dropped, never stored in any company', async () => {
    const res = await deliver(webhook(inbound(nextWaId(), 'stray').value, 'pn-unknown-number')).expect(200);
    expect(res.body).toMatchObject({ applied: 0, unrouted: 1 });
  });

  it('a customer message lands only in the company that owns the number', async () => {
    const wa = nextWaId();
    await deliver(webhook(inbound(wa, 'UAE enquiry').value, OTHER_NUMBER)).expect(200);
    const otherConv = await conversationFor(other, wa);
    await owner.get(`/v1/conversations/${otherConv.id}`).expect(404);
    await agentA.get(`/v1/conversations/${otherConv.id}`).expect(404);
    const mine = (await owner.get('/v1/conversations?limit=100').expect(200)).body.items;
    expect(mine.find((c: { id: string }) => c.id === otherConv.id)).toBeUndefined();
  });
});

describe('replies (acceptance 2) and delivery statuses', () => {
  it('an analyst cannot open the inbox', async () => {
    await analyst.get('/v1/conversations').expect(403);
  });

  it('replying claims an unassigned conversation and is sent once, even if the request is retried', async () => {
    const conv = await conversationFor(agentA, ids.waFahad!);
    const clientMessageId = randomUUID();
    const before = sandbox.sent.length;
    const r1 = await agentA.post(`/v1/conversations/${conv.id}/reply`, { text: 'Yes, we do. Which area?', seenActivity: conv.activitySeq, clientMessageId }).expect(201);
    expect(r1.body).toMatchObject({ status: 'sent', direction: 'out' });
    const r2 = await agentA.post(`/v1/conversations/${conv.id}/reply`, { text: 'Yes, we do. Which area?', seenActivity: conv.activitySeq, clientMessageId }).expect(201);
    expect(r2.body.id).toBe(r1.body.id);
    expect(sandbox.sent.length).toBe(before + 1);
    expect(sandbox.sent[sandbox.sent.length - 1]).toMatchObject({ to: ids.waFahad, providerNumberId: NUMBER });
    const after = await agentA.get(`/v1/conversations/${conv.id}`).expect(200);
    expect(after.body.assignedMembershipId).toBe(ids.agentA);
    // Now assigned to agent A: agent B can no longer see it at all.
    await agentB.get(`/v1/conversations/${conv.id}`).expect(404);
    ids.convFahad = conv.id;
    ids.sentFahad = r1.body.id;
  });

  it('statuses only move forward, whatever order they arrive in, and repeats are ignored', async () => {
    const wamid = sandbox.sent[sandbox.sent.length - 1]!.providerMessageId;
    await deliver(webhook(status(wamid, 'read'))).expect(200);
    const late = await deliver(webhook(status(wamid, 'delivered'))).expect(200);
    expect(late.body).toMatchObject({ stale: 1 });
    expect((await deliver(webhook(status(wamid, 'read'))).expect(200)).body).toMatchObject({ duplicate: 1 });
    const conv = await agentA.get(`/v1/conversations/${ids.convFahad}`).expect(200);
    expect(conv.body.messages.find((m: { id: string }) => m.id === ids.sentFahad).status).toBe('read');
  });

  it('a status that arrives before the send is recorded is kept and applied afterwards', async () => {
    const wa = nextWaId();
    await deliver(webhook(inbound(wa, 'Is anyone there?').value)).expect(200);
    const conv = await conversationFor(agentB, wa);
    const fixed = `wamid.sandbox.fixed.${randomUUID()}`;
    expect((await deliver(webhook(status(fixed, 'delivered'))).expect(200)).body).toMatchObject({ orphan: 1 });
    sandbox.nextIds.push(fixed);
    await agentB.post(`/v1/conversations/${conv.id}/reply`, { text: 'Hello, how can we help?', seenActivity: conv.activitySeq, clientMessageId: randomUUID() }).expect(201);
    const again = await agentB.get(`/v1/conversations/${conv.id}`).expect(200);
    expect(again.body.messages.at(-1)).toMatchObject({ direction: 'out', status: 'delivered' });
  });

  it('a reply is refused when a newer customer message arrived after the agent last looked', async () => {
    const wa = nextWaId();
    await deliver(webhook(inbound(wa, 'I need a plumber').value)).expect(200);
    const seen = await conversationFor(agentA, wa);
    await deliver(webhook(inbound(wa, 'Actually, an electrician').value)).expect(200);
    const res = await agentA.post(`/v1/conversations/${seen.id}/reply`, { text: 'Sure, a plumber.', seenActivity: seen.activitySeq, clientMessageId: randomUUID() }).expect(409);
    expect(res.body.error.code).toBe('conversation_changed');
  });

  it('two agents answering the same conversation at the same moment: exactly one reply is sent', async () => {
    const wa = nextWaId();
    await deliver(webhook(inbound(wa, 'Price for deep cleaning?').value)).expect(200);
    const conv = await conversationFor(agentA, wa);
    const before = sandbox.sent.length;
    const [a, b] = await Promise.all([
      agentA.post(`/v1/conversations/${conv.id}/reply`, { text: 'From agent A', seenActivity: conv.activitySeq, clientMessageId: randomUUID() }),
      agentB.post(`/v1/conversations/${conv.id}/reply`, { text: 'From agent B', seenActivity: conv.activitySeq, clientMessageId: randomUUID() }),
    ]);
    expect([a.status, b.status].filter((s) => s === 201)).toHaveLength(1);
    expect([a.status, b.status].every((s) => s === 201 || s === 409 || s === 404)).toBe(true);
    expect(sandbox.sent.length).toBe(before + 1);
  });

  it('a supervisor must say "take over" before answering someone else’s conversation, and it is recorded', async () => {
    const conv = (await supervisor.get(`/v1/conversations/${ids.convFahad}`).expect(200)).body;
    const blocked = await supervisor.post(`/v1/conversations/${conv.id}/reply`, { text: 'Supervisor here', seenActivity: conv.activitySeq, clientMessageId: randomUUID() }).expect(409);
    expect(blocked.body.error.code).toBe('assigned_to_other');
    await supervisor.post(`/v1/conversations/${conv.id}/reply`, { text: 'Supervisor here', seenActivity: conv.activitySeq, clientMessageId: randomUUID(), takeover: true }).expect(201);
    const after = (await supervisor.get(`/v1/conversations/${conv.id}`).expect(200)).body;
    expect(after.assignedMembershipId).toBe(ids.supervisor);
    expect(after.events.map((e: { kind: string }) => e.kind)).toContain('takeover');
    const audit = (await owner.get('/v1/audit-events').expect(200)).body as Array<{ action: string }>;
    expect(audit.map((e) => e.action)).toContain('conversation.takeover');
  });

  it('a provider refusal is shown as failed, never as sent', async () => {
    const wa = nextWaId();
    await deliver(webhook(inbound(wa, 'Hello').value)).expect(200);
    const conv = await conversationFor(agentA, wa);
    sandbox.script.push({ reject: '131047' });
    const res = await agentA.post(`/v1/conversations/${conv.id}/reply`, { text: 'Hi!', seenActivity: conv.activitySeq, clientMessageId: randomUUID() }).expect(201);
    expect(res.body).toMatchObject({ status: 'failed', errorCode: '131047' });
  });
});

describe('service window and consent (acceptance 6)', () => {
  it('after 24 hours only an approved template may be sent', async () => {
    const wa = nextWaId();
    await deliver(webhook(inbound(wa, 'Old question', { ts: Math.floor(Date.now() / 1000) - 25 * 3600 }).value)).expect(200);
    const conv = await conversationFor(agentA, wa);
    expect(conv.windowOpen).toBe(false);
    const res = await agentA.post(`/v1/conversations/${conv.id}/reply`, { text: 'Sorry for the delay', seenActivity: conv.activitySeq, clientMessageId: randomUUID() }).expect(409);
    expect(res.body.error.code).toBe('template_required');
  });

  it('a timestamp in the future cannot hold the window open', async () => {
    const wa = nextWaId();
    await deliver(webhook(inbound(wa, 'From the future', { ts: Math.floor(Date.now() / 1000) + 365 * 24 * 3600 }).value)).expect(200);
    const conv = await conversationFor(agentA, wa);
    expect(new Date(conv.messages[0].occurredAt).getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('"STOP" (or "إيقاف") opts the customer out with evidence, and every reply is then refused; "START" opts back in', async () => {
    const wa = nextWaId();
    await deliver(webhook(inbound(wa, 'Please send me the quote').value)).expect(200);
    const stop = inbound(wa, 'إيقاف');
    await deliver(webhook(stop.value)).expect(200);
    let conv = await conversationFor(agentA, wa);
    expect(conv.contact.optedOut).toBe(true);
    expect(conv.events.map((e: { kind: string; data: { evidence?: string } }) => [e.kind, e.data.evidence])).toContainEqual(['opted_out', stop.id]);
    const res = await agentA.post(`/v1/conversations/${conv.id}/reply`, { text: 'Here is the quote', seenActivity: conv.activitySeq, clientMessageId: randomUUID() }).expect(409);
    expect(res.body.error.code).toBe('contact_opted_out');
    const audit = (await owner.get('/v1/audit-events').expect(200)).body as Array<{ action: string; targetId: string }>;
    expect(audit.some((e) => e.action === 'contact.opted_out' && e.targetId === conv.contact.id)).toBe(true);

    // A sentence that merely contains the word does not change consent.
    await deliver(webhook(inbound(wa, 'please do not stop the service').value)).expect(200);
    expect((await conversationFor(agentA, wa)).contact.optedOut).toBe(true);

    await deliver(webhook(inbound(wa, 'START').value)).expect(200);
    conv = await conversationFor(agentA, wa);
    expect(conv.contact.optedOut).toBe(false);
    await agentA.post(`/v1/conversations/${conv.id}/reply`, { text: 'Welcome back', seenActivity: conv.activitySeq, clientMessageId: randomUUID() }).expect(201);
  });
});

describe('assignment and notes', () => {
  it('two agents claiming the same conversation at once: exactly one succeeds', async () => {
    const wa = nextWaId();
    await deliver(webhook(inbound(wa, 'Booking for Thursday').value)).expect(200);
    const conv = await conversationFor(agentA, wa);
    const [a, b] = await Promise.all([
      agentA.post(`/v1/conversations/${conv.id}/assign`, { membershipId: ids.agentA, expectedVersion: conv.version }),
      agentB.post(`/v1/conversations/${conv.id}/assign`, { membershipId: ids.agentB, expectedVersion: conv.version }),
    ]);
    ids.convBooking = conv.id;
    // The loser gets 409 if it raced the update, or 404 if it started after the winner committed (the conversation is
    // then someone else's and hidden from an agent without inbox.read_all). Either way exactly one claim succeeds.
    const statuses = [a.status, b.status];
    expect(statuses.filter((s) => s === 200), JSON.stringify([a.body, b.body])).toHaveLength(1);
    expect(statuses.every((s) => s === 200 || s === 409 || s === 404)).toBe(true);
  });

  it('agents cannot assign conversations to other people; supervisors can, to people who may reply', async () => {
    const conv = (await supervisor.get(`/v1/conversations/${ids.convBooking}`).expect(200)).body;
    const holder = conv.assignedMembershipId === ids.agentA ? agentA : agentB;
    const otherAgentId = conv.assignedMembershipId === ids.agentA ? ids.agentB : ids.agentA;
    await holder.post(`/v1/conversations/${conv.id}/assign`, { membershipId: otherAgentId, expectedVersion: conv.version }).expect(403);
    await supervisor.post(`/v1/conversations/${conv.id}/assign`, { membershipId: ids.analyst, expectedVersion: conv.version }).expect(400);
    const ok = await supervisor.post(`/v1/conversations/${conv.id}/assign`, { membershipId: otherAgentId, expectedVersion: conv.version }).expect(200);
    expect(ok.body.assignedMembershipId).toBe(otherAgentId);
    await supervisor.post(`/v1/conversations/${conv.id}/assign`, { membershipId: null, expectedVersion: conv.version }).expect(409);
  });

  it('internal notes are visible to the team and are never sent to the customer', async () => {
    const before = sandbox.sent.length;
    await supervisor.post(`/v1/conversations/${ids.convBooking}/notes`, { body: 'VIP customer — confirm technician before replying.' }).expect(201);
    expect(sandbox.sent.length).toBe(before);
    const conv = (await supervisor.get(`/v1/conversations/${ids.convBooking}`).expect(200)).body;
    expect(conv.notes[0]).toMatchObject({ body: 'VIP customer — confirm technician before replying.', authorMembershipId: ids.supervisor });
    expect(conv.messages.every((m: { body: string }) => !m.body?.includes('VIP'))).toBe(true);
  });

  it('click-to-WhatsApp referral data is kept with the message for later attribution', async () => {
    const wa = nextWaId();
    await deliver(webhook(inbound(wa, 'I saw your ad', { referral: { source_type: 'ad', source_id: '120200000000', source_url: 'https://fb.me/x', ctwa_clid: 'clid-test' } }).value)).expect(200);
    const conv = await conversationFor(agentA, wa);
    expect(conv.messages[0].fromAd).toBe(true);
  });
});

describe('review fixes for slice 1', () => {
  it('M1: a customer message delivered late, with an older timestamp, still blocks an uninformed reply', async () => {
    const wa = nextWaId();
    const now = Math.floor(Date.now() / 1000);
    await deliver(webhook(inbound(wa, 'Hello', { ts: now - 600 }).value)).expect(200);
    let conv = await conversationFor(agentA, wa);
    await agentA.post(`/v1/conversations/${conv.id}/reply`, { text: 'Hi, how can we help?', seenActivity: conv.activitySeq, clientMessageId: randomUUID() }).expect(201);
    conv = await conversationFor(agentA, wa);
    // Written five minutes ago, delivered only now (phone was offline).
    await deliver(webhook(inbound(wa, 'Actually, cancel my booking', { ts: now - 300 }).value)).expect(200);
    const res = await agentA.post(`/v1/conversations/${conv.id}/reply`, { text: 'Your booking is confirmed', seenActivity: conv.activitySeq, clientMessageId: randomUUID() }).expect(409);
    expect(res.body.error.code).toBe('conversation_changed');
    const fresh = await conversationFor(agentA, wa);
    expect(fresh.messages.map((m: { body: string }) => m.body)).toEqual(['Hello', 'Actually, cancel my booking', 'Hi, how can we help?']);
  });

  it('M3: two people choosing the same idempotency key do not collide', async () => {
    const key = randomUUID();
    const waA = nextWaId(); const waB = nextWaId();
    await deliver(webhook(inbound(waA, 'Question one').value)).expect(200);
    await deliver(webhook(inbound(waB, 'Question two').value)).expect(200);
    const a = await conversationFor(agentA, waA);
    await agentA.post(`/v1/conversations/${a.id}/reply`, { text: 'Answer one', seenActivity: a.activitySeq, clientMessageId: key }).expect(201);
    const b = await conversationFor(agentB, waB);
    const res = await agentB.post(`/v1/conversations/${b.id}/reply`, { text: 'Answer two', seenActivity: b.activitySeq, clientMessageId: key }).expect(201);
    expect(res.body).toMatchObject({ body: 'Answer two', status: 'sent' });
  });

  it('M4: a large signed delivery is accepted; an oversized one gets 413, not a server error', async () => {
    const wa = nextWaId();
    const now = Math.floor(Date.now() / 1000);
    const messages = Array.from({ length: 300 }, (_, i) => ({ from: wa, id: `wamid.big.${randomUUID()}`, timestamp: String(now - 300 + i), type: 'text', text: { body: `Line ${i} `.padEnd(1000, 'x') } }));
    const big = await deliver(webhook({ contacts: [{ wa_id: wa, profile: { name: 'Bulk' } }], messages })).expect(200);
    expect(big.body).toMatchObject({ applied: 300 });
    const huge = JSON.stringify({ object: 'whatsapp_business_account', pad: 'x'.repeat(4 * 1024 * 1024) });
    const res = await request(t.app.getHttpServer()).post('/v1/webhooks/sandbox').set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', signBody(t.deps.keys.sandboxWebhook, huge)).send(huge).expect(413);
    expect(res.body.error.code).toBe('too_large');
  });

  it('opt-out keywords tolerate punctuation and Arabic diacritics, but not other sentences', async () => {
    for (const word of ['Stop.', 'STOP!', 'إيقافّ', 'إيـقاف']) {
      const wa = nextWaId();
      await deliver(webhook(inbound(wa, word).value)).expect(200);
      expect((await conversationFor(agentA, wa)).contact.optedOut, word).toBe(true);
    }
    const wa = nextWaId();
    await deliver(webhook(inbound(wa, 'stop sending the technician, I fixed it').value)).expect(200);
    expect((await conversationFor(agentA, wa)).contact.optedOut).toBe(false);
  });

  it('M5: the CI guard flags any widening of the webhook-routing role', async () => {
    const owner = t.ownerDb;
    expect(await checkIsolation(process.env.DATABASE_URL!)).toEqual([]);
    try {
      await owner.query('GRANT SELECT ON messages TO cf_channel');
      await owner.query('GRANT SELECT (display_phone) ON channel_connections TO cf_channel');
      await owner.query(`CREATE FUNCTION zz_all_messages() RETURNS bigint LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
        AS $$ SELECT count(*) FROM messages $$`);
      await owner.query('ALTER FUNCTION zz_all_messages() OWNER TO cf_channel');
      const problems = await checkIsolation(process.env.DATABASE_URL!);
      expect(problems).toEqual(expect.arrayContaining([
        'cf_channel has privileges on messages; it may only read the routing columns of channel_connections and provider_accounts',
        'cf_channel has more than read access on channel_connections.display_phone',
        'cf_channel owns zz_all_messages(), which is not a reviewed routing function',
      ]));
    } finally {
      await owner.query('DROP FUNCTION IF EXISTS zz_all_messages()');
      await owner.query('REVOKE SELECT ON messages FROM cf_channel');
      await owner.query('REVOKE SELECT (display_phone) ON channel_connections FROM cf_channel');
    }
    expect(await checkIsolation(process.env.DATABASE_URL!)).toEqual([]);
  });
});

