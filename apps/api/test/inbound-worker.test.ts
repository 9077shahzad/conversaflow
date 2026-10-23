/**
 * AX-3 (backlog W1.3): incoming webhook events are recorded by the request and applied by the worker.
 * The app here runs with INBOUND_APPLY=worker, as production does. Simulated WhatsApp (sandbox) only.
 */
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withContext } from '@conversaflow/database';
import { signBody } from '../src/modules/channels';
import { loadConfig } from '../src/core/config';
import { InboundProcessor, INBOUND_LIMITS, recordWebhook } from '../src/modules/inbound';
import { activateSubscription, enableMfa, newCompany, newUser, startApp, type Client, type TestApp } from './helpers';

let t: TestApp;
let owner: Client;
let tenant: string;
const NUMBER = `pn${randomUUID().slice(0, 8)}`;
let seq = 0;
const base = Math.floor(Math.random() * 5_000_000);
const fresh = () => `97150${String(base + ++seq).padStart(7, '0')}`;
const app = <T>(fn: Parameters<typeof withContext<T>>[2]) => withContext<T>(t.deps.db, { tenantId: tenant, userId: null }, fn);

function payload(messages: Array<{ from: string; text: string; id?: string; ts?: number }>, statuses: Array<{ id: string; status: string }> = []) {
  return { object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: NUMBER },
    contacts: messages.map((m) => ({ wa_id: m.from, profile: { name: 'Worker Test' } })),
    messages: messages.map((m) => ({ from: m.from, id: m.id ?? `wamid.in.${randomUUID()}`, timestamp: String(m.ts ?? Math.floor(Date.now() / 1000)), type: 'text', text: { body: m.text } })),
    statuses: statuses.map((s) => ({ id: s.id, status: s.status, timestamp: String(Math.floor(Date.now() / 1000)), recipient_id: '1' })) } }] }] };
}
function deliver(p: unknown) {
  const raw = JSON.stringify(p);
  return request(t.app.getHttpServer()).post('/v1/webhooks/sandbox').set('Content-Type', 'application/json')
    .set('X-Hub-Signature-256', signBody(t.deps.keys.sandboxWebhook, raw)).send(raw);
}
const messagesFrom = async (wa: string) => (await app((tx) => tx.query<{ n: number }>(
  `SELECT count(*)::int AS n FROM messages m JOIN conversations c ON c.id = m.conversation_id JOIN contact_identifiers ci ON ci.contact_id = c.contact_id
   WHERE ci.value = $1 AND m.direction = 'in'`, [wa]))).rows[0]!.n;
const eventsFor = async (wa: string) => (await app((tx) => tx.query<{ id: string; processed_at: Date | null; failed_at: Date | null; attempts: number; last_error: string | null; next_attempt_at: Date }>(
  `SELECT id, processed_at, failed_at, attempts, last_error, next_attempt_at FROM webhook_events WHERE parsed->>'from' = $1`, [wa]))).rows;
const makeDue = () => app((tx) => tx.query(`UPDATE webhook_events SET next_attempt_at = now(), lease_until = NULL WHERE processed_at IS NULL AND failed_at IS NULL`));
/** Drains everything waiting, as the worker loop does. */
async function drain(p = new InboundProcessor(t.deps.db)) { while ((await p.dispatchDue(200)) > 0) { /* drain */ } }

beforeAll(async () => {
  t = await startApp({ INBOUND_APPLY: 'worker' });
  owner = await newUser(t, 'inw-owner');
  tenant = await newCompany(owner, 'inw', 'business');
  await activateSubscription(t, tenant);
  await enableMfa(owner);
  await owner.post('/v1/channels', { provider: 'sandbox', providerNumberId: NUMBER, displayPhone: '+966500000077', label: 'Worker' }).expect(201);
});
afterAll(() => t?.close());

describe('the webhook request records and answers; the worker applies', () => {
  it('a delivery is acknowledged with nothing applied yet, then the worker applies it once', async () => {
    const wa = fresh();
    const res = await deliver(payload([{ from: wa, text: 'Hello' }])).expect(200);
    expect(res.body).toMatchObject({ queued: 1, applied: 0, duplicate: 0 });
    expect(await messagesFrom(wa)).toBe(0);                         // not in the inbox yet
    await drain();
    expect(await messagesFrom(wa)).toBe(1);
    await drain();
    expect(await messagesFrom(wa)).toBe(1);                         // a second pass changes nothing
  });

  it('a repeated delivery before the worker runs is recorded once and applied once', async () => {
    const wa = fresh(); const id = `wamid.in.${randomUUID()}`;
    expect((await deliver(payload([{ from: wa, text: 'Once', id }])).expect(200)).body).toMatchObject({ queued: 1 });
    expect((await deliver(payload([{ from: wa, text: 'Once', id }])).expect(200)).body).toMatchObject({ queued: 0, duplicate: 1 });
    await drain();
    expect(await messagesFrom(wa)).toBe(1);
  });

  it('nothing is lost if the process stops between recording and applying: the lease runs out and a worker applies it', async () => {
    const wa = fresh();
    // Recorded as in request mode (leased to a request that then "crashes" and never applies it).
    const { recorded } = await recordWebhook(t.deps.db, 'sandbox', payload([{ from: wa, text: 'Lost request' }]), true);
    expect(recorded).toHaveLength(1);
    await drain();
    expect(await messagesFrom(wa)).toBe(0);                         // still leased to the dead request
    await app((tx) => tx.query(`UPDATE webhook_events SET lease_until = now() - interval '1 second' WHERE id = $1`, [recorded[0]!.event_id]));
    await drain();
    expect(await messagesFrom(wa)).toBe(1);
  });

  it('a crash while applying leaves nothing half-done; the event is retried with back-off and applied once', async () => {
    const wa = fresh();
    await deliver(payload([{ from: wa, text: 'Crash once' }])).expect(200);
    // Two crashes: the batch attempt, then the event's own attempt (a failed batch is retried event by event at once).
    let crashes = 2;
    const crashing = new InboundProcessor(t.deps.db, { beforeMark: () => { if (crashes > 0) { crashes--; throw Object.assign(new Error('simulated'), { code: 'simulated_crash' }); } } });
    await drain(crashing);
    expect(await messagesFrom(wa)).toBe(0);                         // the whole transaction rolled back
    const [e] = await eventsFor(wa);
    expect(e).toMatchObject({ attempts: 1, last_error: 'simulated_crash', processed_at: null, failed_at: null });
    expect(e!.next_attempt_at.getTime()).toBeGreaterThan(Date.now());   // waits before trying again
    await drain();
    expect(await messagesFrom(wa)).toBe(0);                         // not due yet
    await makeDue();
    await drain(crashing);
    expect(await messagesFrom(wa)).toBe(1);
  });

  it('two workers at once apply each event exactly once, and messages from one customer keep their order', async () => {
    const people = Array.from({ length: 6 }, () => fresh());
    const now = Math.floor(Date.now() / 1000);
    for (let i = 0; i < 5; i++) {
      await deliver(payload(people.map((wa) => ({ from: wa, text: `Message ${i}`, ts: now - 50 + i })))).expect(200);
    }
    await Promise.all([drain(new InboundProcessor(t.deps.db)), drain(new InboundProcessor(t.deps.db)), drain(new InboundProcessor(t.deps.db))]);
    // Workers that met a customer another worker was applying put those events back for a few seconds.
    await makeDue(); await drain();
    for (const wa of people) {
      expect(await messagesFrom(wa)).toBe(5);
      const last = (await app((tx) => tx.query<{ body: string }>(
        `SELECT m.body FROM conversations c JOIN messages m ON m.id = c.last_message_id JOIN contact_identifiers ci ON ci.contact_id = c.contact_id WHERE ci.value = $1`, [wa]))).rows[0]!;
      expect(last.body).toBe('Message 4');
      const contacts = (await app((tx) => tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM contact_identifiers WHERE value = $1`, [wa]))).rows[0]!.n;
      expect(contacts).toBe(1);
    }
  });

  it('one event that keeps failing does not hold up others; after the last attempt it is shown on channel health and can be tried again', async () => {
    const good = fresh(); const bad = fresh();
    await deliver(payload([{ from: good, text: 'Fine' }, { from: bad, text: 'Poison' }])).expect(200);
    const badIds = new Set((await eventsFor(bad)).map((e) => e.id));
    const picky = new InboundProcessor(t.deps.db, { beforeMark: (ids) => { if (ids.some((id) => badIds.has(id))) throw Object.assign(new Error('x'), { code: 'bad_event' }); } });
    await drain(picky);
    expect(await messagesFrom(good)).toBe(1);                       // applied on its own
    expect(await messagesFrom(bad)).toBe(0);
    for (let i = 1; i < INBOUND_LIMITS.maxAttempts; i++) { await makeDue(); await drain(picky); }
    const [e] = await eventsFor(bad);
    expect(e).toMatchObject({ attempts: INBOUND_LIMITS.maxAttempts, last_error: 'bad_event' });
    expect(e!.failed_at).not.toBeNull();
    await makeDue(); await drain(picky);
    expect((await eventsFor(bad))[0]!.attempts).toBe(INBOUND_LIMITS.maxAttempts);   // given up: no more attempts
    const health = (await owner.get('/v1/channels/health').expect(200)).body;
    expect(health.webhooks.failed).toBeGreaterThanOrEqual(1);
    expect(health.problems.map((p: { code: string }) => p.code)).toContain('incoming_failed');
    // A person asks for it to be tried again (audited); this time it applies.
    expect((await owner.post('/v1/channels/recovery/incoming').expect(200)).body.requeued).toBeGreaterThanOrEqual(1);
    await drain();
    expect(await messagesFrom(bad)).toBe(1);
    const audit = (await app((tx) => tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_events WHERE action = 'channel.inbound_retried'`))).rows[0]!.n;
    expect(audit).toBeGreaterThanOrEqual(1);
  });

  it('a waiting backlog is visible on channel health, and only someone who manages channels can ask for a retry', async () => {
    const wa = fresh();
    await deliver(payload([{ from: wa, text: 'Waiting' }])).expect(200);
    const health = (await owner.get('/v1/channels/health').expect(200)).body;
    expect(health.webhooks.unprocessed).toBeGreaterThanOrEqual(1);
    expect(health.webhooks.oldestWaitingAt).not.toBeNull();
    const stranger = await newUser(t, 'inw-stranger');
    await stranger.post('/v1/channels/recovery/incoming').expect((r) => expect([401, 403]).toContain(r.status));
    await drain();
    expect((await owner.get('/v1/channels/health').expect(200)).body.webhooks.unprocessed).toBe(0);
  });

  it('the lookup the worker uses sees only waiting events and never their content', async () => {
    const cols = (await t.ownerDb.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.column_privileges WHERE grantee = 'cf_dispatch' AND table_name = 'webhook_events' AND privilege_type = 'SELECT'`)).rows.map((r) => r.column_name).sort();
    expect(cols).not.toContain('payload');
    expect(cols).not.toContain('parsed');
  });
});

describe('review of AX-3', () => {
  const optedOut = async (wa: string) => (await app((tx) => tx.query<{ o: boolean }>(
    `SELECT ct.opted_out_at IS NOT NULL AS o FROM contacts ct JOIN contact_identifiers ci ON ci.contact_id = ct.id WHERE ci.value = $1`, [wa]))).rows[0]!.o;

  it('M1: STOP and START take effect in the order the customer sent them, even when an older one is retried later', async () => {
    const wa = fresh(); const now = Math.floor(Date.now() / 1000);
    await deliver(payload([{ from: wa, text: 'STOP', ts: now - 300 }])).expect(200);
    await drain();
    expect(await optedOut(wa)).toBe(true);
    const startId = `wamid.in.${randomUUID()}`;
    await deliver(payload([{ from: wa, text: 'START', ts: now - 200, id: startId }])).expect(200);
    const startEvents = new Set((await app((tx) => tx.query<{ id: string }>(`SELECT id FROM webhook_events WHERE parsed->>'providerMessageId' = $1`, [startId]))).rows.map((r) => r.id));
    const failing = new InboundProcessor(t.deps.db, { beforeMark: (ids) => { if (ids.some((id) => startEvents.has(id))) throw Object.assign(new Error('x'), { code: 'flaky' }); } });
    await drain(failing);                                           // START keeps failing for now
    await deliver(payload([{ from: wa, text: 'STOP', ts: now - 100 }])).expect(200);
    await drain(failing);
    expect(await optedOut(wa)).toBe(true);
    await makeDue(); await drain();                                 // the old START finally applies
    expect(await optedOut(wa)).toBe(true);                          // the newer STOP still stands
    expect(await messagesFrom(wa)).toBe(3);                         // every message is still in the thread
  });

  it('L1: a company with a large backlog does not hold up another company\'s messages', async () => {
    const otherOwner = await newUser(t, 'inw-other');
    const other = await newCompany(otherOwner, 'inwother', 'business');
    await activateSubscription(t, other);
    await enableMfa(otherOwner);
    const OTHER = `pn${randomUUID().slice(0, 8)}`;
    await otherOwner.post('/v1/channels', { provider: 'sandbox', providerNumberId: OTHER, displayPhone: '+966500000078', label: 'Other' }).expect(201);
    await drain();
    const busy = Array.from({ length: 120 }, () => fresh());
    for (let i = 0; i < busy.length; i += 40) await deliver(payload(busy.slice(i, i + 40).map((wa) => ({ from: wa, text: 'Backlog' })))).expect(200);
    const waOther = fresh();
    const p = { object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: OTHER },
      contacts: [{ wa_id: waOther, profile: { name: 'Other company customer' } }],
      messages: [{ from: waOther, id: `wamid.in.${randomUUID()}`, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'Hello' } }] } }] }] };
    await deliver(p).expect(200);
    // One lease of 60: at most 50 come from the busy company, so the other company's message is included.
    const claimed = await withContext(t.deps.db, { tenantId: null, userId: null }, async (tx) =>
      (await tx.query<{ event_id: string; tenant_id: string; connection_id: string | null; account_ref: string | null }>('SELECT * FROM inbound_claim(60, 120)')).rows);
    expect(claimed.filter((c) => c.tenant_id === tenant).length).toBeLessThanOrEqual(50);
    expect(claimed.filter((c) => c.tenant_id === other).length).toBe(1);
    await new InboundProcessor(t.deps.db).process(claimed);
    const seen = (await withContext(t.deps.db, { tenantId: other, userId: null }, (tx) => tx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM messages m JOIN conversations c ON c.id = m.conversation_id JOIN contact_identifiers ci ON ci.contact_id = c.contact_id WHERE ci.value = $1`, [waOther]))).rows[0]!.n;
    expect(seen).toBe(1);
    await drain();
  });

  it('L2: an event without its parsed form is marked failed instead of being leased again forever', async () => {
    const conn = (await app((tx) => tx.query<{ id: string }>('SELECT id FROM channel_connections LIMIT 1'))).rows[0]!.id;
    const id = (await app((tx) => tx.query<{ id: string }>(
      `INSERT INTO webhook_events (tenant_id, connection_id, event_key, kind, payload) VALUES ($1, $2, $3, 'message', '{}') RETURNING id`,
      [tenant, conn, `legacy-${randomUUID()}`]))).rows[0]!.id;
    await drain();
    const row = (await app((tx) => tx.query<{ failed_at: Date | null; last_error: string | null }>('SELECT failed_at, last_error FROM webhook_events WHERE id = $1', [id]))).rows[0]!;
    expect(row.failed_at).not.toBeNull();
    expect(row.last_error).toBe('unparsed');
    await owner.post('/v1/channels/recovery/incoming').expect(200);  // tidy up for the other tests
    await drain();
  });

  it('L3: an event waiting out its back-off is shown as retrying, not as the background service being stopped', async () => {
    const wa = fresh();
    await deliver(payload([{ from: wa, text: 'Retry me' }])).expect(200);
    const ids = new Set((await eventsFor(wa)).map((e) => e.id));
    await drain(new InboundProcessor(t.deps.db, { beforeMark: (x) => { if (x.some((i) => ids.has(i))) throw Object.assign(new Error('x'), { code: 'flaky' }); } }));
    const h = (await owner.get('/v1/channels/health').expect(200)).body;
    expect(h.webhooks.retrying).toBeGreaterThanOrEqual(1);
    expect(h.webhooks.overdue).toBe(0);
    await makeDue(); await drain();
  });
});

describe('recheck of the AX-3 fixes', () => {
  it('N2: a customer whose lock is held elsewhere defers only their own events, at once and without using an attempt', async () => {
    const busy = fresh(); const other = fresh();
    await deliver(payload([{ from: busy, text: 'one' }, { from: busy, text: 'two' }, { from: busy, text: 'three' }])).expect(200);
    await deliver(payload([{ from: other, text: 'not blocked' }])).expect(200);
    // Something else (for example a contact import) holds the busy customer's lock.
    const holder = await t.ownerDb.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${tenant}:wa:${busy}`]);
      const started = Date.now();
      await new InboundProcessor(t.deps.db).dispatchDue(200);
      expect(Date.now() - started).toBeLessThan(4000);               // no waiting on the held lock
      expect(await messagesFrom(other)).toBe(1);
      expect(await messagesFrom(busy)).toBe(0);
      for (const e of await eventsFor(busy)) {
        expect(e.attempts).toBe(0);                                  // not counted as a failure
        expect(e.next_attempt_at.getTime()).toBeGreaterThan(Date.now());
      }
    } finally { await holder.query('ROLLBACK'); holder.release(); }
    await makeDue(); await drain();
    expect(await messagesFrom(busy)).toBe(3);
  });
});

describe('second recheck of the AX-3 fixes', () => {
  it('the company\'s assignment lock is tried too: a long group elsewhere defers these events at once, without an attempt', async () => {
    const me = (await owner.get('/v1/me/access').expect(200)).body.membershipId;
    await owner.put('/v1/inbox/assignment', { mode: 'round_robin', hoursOnly: false, memberIds: [me] }).expect(200);
    const wa = fresh();
    await deliver(payload([{ from: wa, text: 'assignment busy' }])).expect(200);
    const holder = await t.ownerDb.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${tenant}:auto-assign`]);
      const started = Date.now();
      await new InboundProcessor(t.deps.db).dispatchDue(200);
      expect(Date.now() - started).toBeLessThan(1500);               // no 2-second lock wait
      expect(await messagesFrom(wa)).toBe(0);
      for (const e of await eventsFor(wa)) expect(e.attempts).toBe(0);
    } finally { await holder.query('ROLLBACK'); holder.release(); }
    await makeDue(); await drain();
    expect(await messagesFrom(wa)).toBe(1);
    await owner.put('/v1/inbox/assignment', { mode: 'off', hoursOnly: false, memberIds: [] }).expect(200);
  });

  it('an event put back again and again shows as delayed on channel health once it has waited 10 minutes', async () => {
    await drain();
    const wa = fresh();
    await deliver(payload([{ from: wa, text: 'kept waiting' }])).expect(200);
    // As if it had arrived 11 minutes ago and been deferred each time since (no attempt used, next try in the future).
    await t.ownerDb.query('ALTER TABLE webhook_events NO FORCE ROW LEVEL SECURITY');
    try {
      await t.ownerDb.query(`UPDATE webhook_events SET received_at = now() - interval '11 minutes', next_attempt_at = now() + interval '5 seconds'
                             WHERE processed_at IS NULL AND parsed::text LIKE $1`, [`%${wa}%`]);
    } finally { await t.ownerDb.query('ALTER TABLE webhook_events FORCE ROW LEVEL SECURITY'); }
    const health = (await owner.get('/v1/channels/health').expect(200)).body;
    expect(health.webhooks.overdue).toBeGreaterThanOrEqual(1);
    expect(health.problems.map((x: { code: string }) => x.code)).toContain('incoming_delayed');
    await makeDue(); await drain();
  });
});

describe('configuration', () => {
  it('production refuses to apply incoming events inside the request', () => {
    const prod = { ...process.env, NODE_ENV: 'production', SCANNER: 'clamd', SCANNER_REQUIRE_OFFICIAL_SIGNATURES: 'true', CHANNEL_SANDBOX_ENABLED: 'false', SMTP_URL: 'smtp://example.test' };
    expect(() => loadConfig({ ...prod, INBOUND_APPLY: 'request' })).toThrow(/INBOUND_APPLY=worker/);
    expect(loadConfig(prod).INBOUND_APPLY).toBe('worker');
    expect(loadConfig({ ...process.env, NODE_ENV: 'test', INBOUND_APPLY: undefined }).INBOUND_APPLY).toBe('request');
  });
});
