/**
 * Wave 2, W2.1: automations (CF-EXT-007, CF-EXT-019; FR-404–406, FR-206; acceptance items 4 and 10).
 * Simulated WhatsApp (sandbox) only; invented customers.
 */
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withContext } from '@conversaflow/database';
import { signBody, type SandboxAdapter } from '../src/modules/channels';
import { AUTOMATION_LIMITS, AutomationRunner } from '../src/modules/automations';
import { AutomationMetering } from '../src/modules/entitlements.service';
import { Sender } from '../src/modules/sender';
import { activateSubscription, addMember, enableMfa, newCompany, newUser, startApp, type Client, type TestApp } from './helpers';

let t: TestApp;
let owner: Client;
let agent: Client;
let otherOwner: Client;
let tenant: string;
let sandbox: SandboxAdapter;
const NUMBER = `pn${randomUUID().slice(0, 8)}`;
let seq = 0;
const base = Math.floor(Math.random() * 5_000_000);
const fresh = () => `97150${String(base + ++seq).padStart(7, '0')}`;
const app = <T>(fn: Parameters<typeof withContext<T>>[2]) => withContext<T>(t.deps.db, { tenantId: tenant, userId: null }, fn);
const runner = () => new AutomationRunner(t.deps.db, new AutomationMetering(t.deps));
async function work() { while ((await runner().dispatchDue(100)) > 0) { /* drain */ } await new Sender(t.deps.db, t.deps.channels).dispatchDue(100); }

function say(from: string, text: string, opts: { id?: string; ts?: number } = {}) {
  const raw = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: NUMBER },
    contacts: [{ wa_id: from, profile: { name: 'Auto Customer' } }],
    messages: [{ from, id: opts.id ?? `wamid.in.${randomUUID()}`, timestamp: String(opts.ts ?? Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }] } }] }] });
  return request(t.app.getHttpServer()).post('/v1/webhooks/sandbox').set('Content-Type', 'application/json')
    .set('X-Hub-Signature-256', signBody(t.deps.keys.sandboxWebhook, raw)).send(raw);
}
const conv = async (wa: string) => (await app((tx) => tx.query<{ id: string; version: number; activity_seq: string }>(
  `SELECT c.id, c.version, c.activity_seq FROM conversations c JOIN contact_identifiers ci ON ci.contact_id = c.contact_id WHERE ci.value = $1 ORDER BY c.created_at DESC LIMIT 1`, [wa]))).rows[0]!;
const outbound = async (wa: string) => (await app((tx) => tx.query<{ body: string; status: string; automation_run_id: string | null; error_code: string | null }>(
  `SELECT m.body, m.status, m.automation_run_id, m.error_code FROM messages m JOIN conversations c ON c.id = m.conversation_id JOIN contact_identifiers ci ON ci.contact_id = c.contact_id
   WHERE ci.value = $1 AND m.direction = 'out' ORDER BY m.created_at`, [wa]))).rows;
const runsFor = async (wa: string) => (await app((tx) => tx.query<{ id: string; status: string; reason: string | null; workflow_id: string }>(
  `SELECT r.id, r.status, r.reason, r.workflow_id FROM workflow_runs r JOIN contact_identifiers ci ON ci.contact_id = r.contact_id WHERE ci.value = $1 ORDER BY r.started_at`, [wa]))).rows;

type Def = { trigger: { kind: string; keywords?: string[] }; start: string | null; steps: unknown[] };
async function publish(name: string, def: Def): Promise<string> {
  const id = (await owner.post('/v1/automations', { name, draft: def }).expect(201)).body.id as string;
  const w = (await owner.get(`/v1/automations/${id}`).expect(200)).body;
  await owner.post(`/v1/automations/${id}/publish`, { expectedVersion: w.version }).expect(200);
  return id;
}
async function pauseAll() {
  for (const a of (await owner.get('/v1/automations').expect(200)).body as Array<{ id: string; status: string }>) {
    if (a.status !== 'active') continue;
    const w = (await owner.get(`/v1/automations/${a.id}`).expect(200)).body;
    await owner.post(`/v1/automations/${a.id}/pause`, { expectedVersion: w.version }).expect(200);
  }
}
const reply = (id: string, en: string, ar: string, next: string | null = null) => ({ id, kind: 'send_reply', text: { en, ar }, next });

beforeAll(async () => {
  t = await startApp();
  sandbox = t.deps.channels.sandbox as SandboxAdapter;
  owner = await newUser(t, 'auto-owner');
  tenant = await newCompany(owner, 'auto', 'business');
  await activateSubscription(t, tenant);
  await enableMfa(owner);
  agent = await addMember(t, owner, 'auto-agent', 'agent');
  await owner.post('/v1/channels', { provider: 'sandbox', providerNumberId: NUMBER, displayPhone: '+966500000099', label: 'Auto' }).expect(201);
  otherOwner = await newUser(t, 'auto-other');
  await activateSubscription(t, await newCompany(otherOwner, 'autoother', 'business'));
});
afterAll(() => t?.close());

describe('building and publishing', () => {
  it('publishing refuses loops, missing links, unreachable steps and unknown tags, with plain reasons', async () => {
    const id = (await owner.post('/v1/automations', { name: 'Broken' }).expect(201)).body.id;
    let w = (await owner.get(`/v1/automations/${id}`).expect(200)).body;
    const loop: Def = { trigger: { kind: 'message_received' }, start: 'a', steps: [reply('a', 'Hi', 'مرحبا', 'b'), { id: 'b', kind: 'wait', minutes: 5, next: 'a' }, reply('c', 'Never', 'أبدًا')] };
    w = { ...w, ...(await owner.put(`/v1/automations/${id}/draft`, { draft: loop, expectedVersion: w.version }).expect(200)).body };
    const res = await owner.post(`/v1/automations/${id}/publish`, { expectedVersion: w.version }).expect(422);
    expect(res.body.error.details.problems.map((p: { code: string }) => p.code)).toEqual(expect.arrayContaining(['cycle']));
    const missing: Def = { trigger: { kind: 'message_received' }, start: 'a', steps: [reply('a', 'Hi', 'مرحبا', 'zz')] };
    const s2 = (await owner.put(`/v1/automations/${id}/draft`, { draft: missing, expectedVersion: w.version }).expect(200)).body;
    expect(s2.problems.map((p: { code: string }) => p.code)).toContain('unknown_next');
    const tagless: Def = { trigger: { kind: 'message_received' }, start: 'a', steps: [{ id: 'a', kind: 'add_tag', tagId: randomUUID(), next: null }] };
    const s3 = (await owner.put(`/v1/automations/${id}/draft`, { draft: tagless, expectedVersion: s2.version }).expect(200)).body;
    const r3 = await owner.post(`/v1/automations/${id}/publish`, { expectedVersion: s3.version }).expect(422);
    expect(r3.body.error.details.problems).toEqual([{ code: 'unknown_tag', step: 'a' }]);
    // A stale editor is refused.
    await owner.put(`/v1/automations/${id}/draft`, { draft: missing, expectedVersion: 0 }).expect(409);
    await owner.put(`/v1/automations/${id}/draft`, { draft: { ...missing, steps: Array.from({ length: 31 }, (_, i) => reply(`s${i}`, 'x', 'x')) }, expectedVersion: s3.version }).expect(400);
  });

  it('only people who manage automations can see or change them; other companies see nothing; published versions never change', async () => {
    await agent.get('/v1/automations').expect(403);
    const id = await publish('Visible only here', { trigger: { kind: 'message_received', keywords: ['zzz-unused'] }, start: 'a', steps: [reply('a', 'Hi', 'مرحبا')] });
    expect((await otherOwner.get('/v1/automations').expect((r) => expect([200, 403]).toContain(r.status))).body).not.toEqual(expect.arrayContaining([expect.objectContaining({ id })]));
    await otherOwner.get(`/v1/automations/${id}`).expect((r) => expect([403, 404]).toContain(r.status));
    await expect(app((tx) => tx.query(`UPDATE workflow_versions SET definition = '{}' WHERE workflow_id = $1`, [id]))).rejects.toThrow();
  });
});

describe('live runs', () => {
  it('a customer message starts a run; the reply goes out in the customer\'s language through the normal checks; a repeated delivery starts nothing new', async () => {
    await pauseAll();
    await publish('Welcome', { trigger: { kind: 'conversation_started' }, start: 'hello', steps: [
      { id: 'hello', kind: 'condition', if: { kind: 'within_business_hours' }, then: 'open', else: 'closed' },
      reply('open', 'Hi {name}, thanks for writing. A colleague will answer shortly.', 'مرحبًا {name}، شكرًا لتواصلك. سيرد عليك أحد الزملاء قريبًا.'),
      reply('closed', 'Hi {name}, we are closed now.', 'مرحبًا {name}، نحن خارج أوقات العمل الآن.'),
    ] });
    const wa = fresh(); const id = `wamid.in.${randomUUID()}`;
    const before = sandbox.sent.length;
    await say(wa, 'السلام عليكم، عندي سؤال', { id }).expect(200);
    await say(wa, 'السلام عليكم، عندي سؤال', { id }).expect(200);   // the same message delivered twice
    await work();
    const out = await outbound(wa);
    expect(out).toHaveLength(1);
    expect(out[0]!.body).toMatch(/^مرحبًا Auto Customer،/);              // Arabic, because the customer wrote in Arabic
    expect(out[0]!.automation_run_id).not.toBeNull();
    expect(sandbox.sent.length).toBe(before + 1);
    expect((await runsFor(wa)).map((r) => r.status)).toEqual(['completed']);
    // A later message in the same conversation does not trigger "conversation started" again.
    await say(wa, 'Another question').expect(200);
    await work();
    expect(await outbound(wa)).toHaveLength(1);
  });

  it('keywords decide which messages start a run (English and Arabic, any case)', async () => {
    await pauseAll();
    await publish('Prices', { trigger: { kind: 'message_received', keywords: ['price', 'سعر'] }, start: 'p', steps: [reply('p', 'Our price list: example.test/prices', 'قائمة أسعارنا: example.test/prices')] });
    const a = fresh(); const b = fresh(); const c = fresh();
    await say(a, 'What is the PRICE?').expect(200);
    await say(b, 'كم سعر التنظيف؟').expect(200);
    await say(c, 'Hello there').expect(200);
    await work();
    expect(await outbound(a)).toHaveLength(1);
    expect(await outbound(b)).toHaveLength(1);
    expect(await outbound(c)).toHaveLength(0);
  });

  it('a run follows the version it started on; publishing again or rolling back does not change it (acceptance 4)', async () => {
    await pauseAll();
    const id = await publish('Follow-up', { trigger: { kind: 'message_received', keywords: ['follow'] }, start: 'w', steps: [{ id: 'w', kind: 'wait', minutes: 60, next: 'r' }, reply('r', 'Version one', 'الإصدار الأول')] });
    const wa = fresh();
    await say(wa, 'please follow up').expect(200);
    await work();                                                    // waits 60 minutes
    let w = (await owner.get(`/v1/automations/${id}`).expect(200)).body;
    const s = (await owner.put(`/v1/automations/${id}/draft`, { draft: { trigger: { kind: 'message_received', keywords: ['follow'] }, start: 'w', steps: [{ id: 'w', kind: 'wait', minutes: 60, next: 'r' }, reply('r', 'Version two', 'الإصدار الثاني')] }, expectedVersion: w.version }).expect(200)).body;
    expect((await owner.post(`/v1/automations/${id}/publish`, { expectedVersion: s.version }).expect(200)).body.publishedVersion).toBe(2);
    await app((tx) => tx.query(`UPDATE workflow_runs SET next_at = now() WHERE workflow_id = $1 AND status = 'waiting'`, [id]));
    await work();
    expect((await outbound(wa)).map((m) => m.body)).toEqual(['Version one']);
    // Rolling back publishes version 1 again as version 3; the history is kept.
    w = (await owner.get(`/v1/automations/${id}`).expect(200)).body;
    const rb = (await owner.post(`/v1/automations/${id}/rollback`, { toVersion: 1, expectedVersion: w.version }).expect(200)).body;
    expect(rb.publishedVersion).toBe(3);
    w = (await owner.get(`/v1/automations/${id}`).expect(200)).body;
    expect(w.versions.map((v: { number: number; rolledBackFrom: number | null }) => [v.number, v.rolledBackFrom])).toEqual([[3, 1], [2, null], [1, null]]);
    const audit = (await app((tx) => tx.query<{ action: string }>(`SELECT action FROM audit_events WHERE target_id = $1 ORDER BY created_at`, [id]))).rows.map((r) => r.action);
    expect(audit).toEqual(expect.arrayContaining(['automation.published', 'automation.rolled_back']));
  });

  it('a person takes over: a reply from the team stops a waiting run, and its queued message is not sent (FR-206)', async () => {
    await pauseAll();
    await publish('Nudge', { trigger: { kind: 'message_received', keywords: ['nudge'] }, start: 'w', steps: [{ id: 'w', kind: 'wait', minutes: 30, next: 'r' }, reply('r', 'Still there?', 'هل ما زلت هنا؟')] });
    const wa = fresh();
    await say(wa, 'nudge me').expect(200);
    await work();
    const c = await conv(wa);
    await owner.post(`/v1/conversations/${c.id}/reply`, { text: 'Hi, I am here to help', seenActivity: Number(c.activity_seq), clientMessageId: randomUUID() }).expect(201);
    expect((await runsFor(wa)).map((r) => [r.status, r.reason])).toEqual([['stopped', 'person_replied']]);
    await app((tx) => tx.query(`UPDATE workflow_runs SET next_at = now() WHERE conversation_id = $1`, [c.id]));
    await work();
    expect((await outbound(wa)).map((m) => m.body)).toEqual(['Hi, I am here to help']);
    // While a person is handling the conversation, new messages do not start automations.
    await say(wa, 'nudge again').expect(200);
    await work();
    expect((await runsFor(wa)).map((r) => [r.status, r.reason])).toEqual([['stopped', 'person_replied'], ['skipped', 'person_handling']]);
  });

  it('an automation message queued before a person stepped in is refused at send time', async () => {
    await pauseAll();
    await publish('Quick', { trigger: { kind: 'message_received', keywords: ['quick'] }, start: 'r', steps: [reply('r', 'Automatic answer', 'إجابة تلقائية')] });
    const wa = fresh();
    await say(wa, 'quick question').expect(200);
    while ((await runner().dispatchDue(100)) > 0) { /* queue the message but do not send it yet */ }
    const c = await conv(wa);
    await owner.post(`/v1/conversations/${c.id}/pause`, { reason: 'I am calling this customer', minutes: 30 }).expect((r) => expect([200, 201]).toContain(r.status));
    await new Sender(t.deps.db, t.deps.channels).dispatchDue(100);
    const auto = (await outbound(wa)).find((m) => m.automation_run_id);
    expect(auto).toMatchObject({ status: 'failed', error_code: 'replies_paused' });
  });

  it('the same checks as a person: an opted-out customer gets nothing, and a customer is not run more than the daily limit', async () => {
    await pauseAll();
    await publish('Every message', { trigger: { kind: 'message_received' }, start: 'r', steps: [reply('r', 'Thanks', 'شكرًا')] });
    const stopped = fresh();
    await say(stopped, 'STOP').expect(200);                          // an opt-out keyword never starts an automation
    await work();
    expect(await runsFor(stopped)).toEqual([]);
    await say(stopped, 'one more thing').expect(200);
    await work();
    expect((await outbound(stopped)).filter((m) => m.automation_run_id)).toEqual([]);
    const log = (await app((tx) => tx.query<{ outcome: string; detail: { reason?: string } }>(
      `SELECT s.outcome, s.detail FROM workflow_run_steps s JOIN workflow_runs r ON r.id = s.run_id JOIN contact_identifiers ci ON ci.contact_id = r.contact_id WHERE ci.value = $1`, [stopped]))).rows;
    expect(log).toEqual([{ outcome: 'blocked', detail: { reason: 'contact_opted_out' } }]);
    const chatty = fresh();
    for (let i = 0; i < AUTOMATION_LIMITS.runsPerContactPerDay + 2; i++) await say(chatty, `message ${i}`).expect(200);
    await work();
    const runs = await runsFor(chatty);
    expect(runs.filter((r) => r.status === 'completed')).toHaveLength(AUTOMATION_LIMITS.runsPerContactPerDay);
    expect(runs.filter((r) => r.reason === 'daily_limit')).toHaveLength(2);
  });

  it('pausing an automation stops its runs under way and starts no new ones', async () => {
    await pauseAll();
    const id = await publish('Slow', { trigger: { kind: 'message_received', keywords: ['slow'] }, start: 'w', steps: [{ id: 'w', kind: 'wait', minutes: 10, next: 'r' }, reply('r', 'Later', 'لاحقًا')] });
    const wa = fresh();
    await say(wa, 'slow one').expect(200);
    await work();
    const w = (await owner.get(`/v1/automations/${id}`).expect(200)).body;
    await owner.post(`/v1/automations/${id}/pause`, { expectedVersion: w.version }).expect(200);
    expect((await runsFor(wa)).map((r) => [r.status, r.reason])).toEqual([['stopped', 'automation_paused']]);
    await say(wa, 'slow two').expect(200);
    await work();
    expect(await runsFor(wa)).toHaveLength(1);
    expect(await outbound(wa)).toEqual([]);
  });
});

describe('rehearsal (CF-EXT-019, acceptance 10)', () => {
  it('shows what would happen for a sample message, in the chosen language and branch, and sends or changes nothing', async () => {
    const tag = (await owner.post('/v1/tags', { name: `Lead-${randomUUID().slice(0, 4)}`, color: 'teal' }).expect(201)).body;
    const id = (await owner.post('/v1/automations', { name: 'Rehearse me', draft: { trigger: { kind: 'message_received' }, start: 'c', steps: [
      { id: 'c', kind: 'condition', if: { kind: 'message_contains', words: ['booking', 'حجز'] }, then: 'yes', else: 'no' },
      reply('yes', 'Hi {name}, let us book it.', 'مرحبًا {name}، لنحجز لك موعدًا.', 'tag'),
      { id: 'tag', kind: 'add_tag', tagId: tag.id, next: 'w' },
      { id: 'w', kind: 'wait', minutes: 120, next: 'h' },
      { id: 'h', kind: 'handoff', note: 'Booking request', next: null },
      reply('no', 'Thanks for writing.', 'شكرًا لتواصلك.'),
    ] } }).expect(201)).body.id;
    const counts = async () => (await app((tx) => tx.query<{ m: number; j: number; t: number }>(
      `SELECT (SELECT count(*)::int FROM messages) AS m, (SELECT count(*)::int FROM send_jobs) AS j, (SELECT count(*)::int FROM conversation_tags) AS t`))).rows[0]!;
    const before = await counts(); const sentBefore = sandbox.sent.length;
    const r = (await owner.post(`/v1/automations/${id}/rehearse`, { text: 'أبي حجز لتنظيف المكيف', language: 'ar', contactName: 'سارة' }).expect(201)).body;
    expect(r).toMatchObject({ mode: 'rehearsal', status: 'completed' });
    expect(r.steps.map((s: { stepId: string; outcome: string }) => [s.stepId, s.outcome])).toEqual([['c', 'done'], ['yes', 'would_do'], ['tag', 'would_do'], ['w', 'would_do'], ['h', 'would_do']]);
    expect(r.steps[1].detail.text).toBe('مرحبًا سارة، لنحجز لك موعدًا.');
    const other = (await owner.post(`/v1/automations/${id}/rehearse`, { text: 'Hello', language: 'en' }).expect(201)).body;
    expect(other.steps.map((s: { stepId: string }) => s.stepId)).toEqual(['c', 'no']);
    expect(other.steps[1].detail.text).toBe('Thanks for writing.');
    expect(await counts()).toEqual(before);                         // nothing recorded, queued or tagged
    expect(sandbox.sent.length).toBe(sentBefore);                    // nothing reached the (simulated) provider
    // The database refuses a message linked to a rehearsal run, whatever the application does.
    const c = (await app((tx) => tx.query<{ id: string }>('SELECT id FROM conversations LIMIT 1'))).rows[0]!;
    await expect(app((tx) => tx.query(
      `INSERT INTO messages (tenant_id, conversation_id, direction, kind, body, occurred_at, status, automation_run_id, automation_step) VALUES ($1, $2, 'out', 'text', 'x', now(), 'queued', $3, 'yes')`,
      [tenant, c.id, r.id]))).rejects.toThrow(/rehearsal/);
  });
});

describe('review of W2.1', () => {
  it('M1: a run waiting out a wait cannot be moved on early by a worker holding an old lease', async () => {
    await pauseAll();
    await publish('Two replies', { trigger: { kind: 'message_received', keywords: ['twice'] }, start: 'a', steps: [reply('a', 'First', 'الأولى', 'w'), { id: 'w', kind: 'wait', minutes: 600, next: 'b' }, reply('b', 'Second', 'الثانية')] });
    const wa = fresh();
    await say(wa, 'twice please').expect(200);
    const [run] = await runsFor(wa);
    await runner().advance(tenant, run!.id);                         // reaches the wait
    await runner().advance(tenant, run!.id);                         // a stale second worker
    await new Sender(t.deps.db, t.deps.channels).dispatchDue(100);
    expect((await outbound(wa)).map((m) => m.body)).toEqual(['First']);
    expect((await runsFor(wa))[0]!.status).toBe('waiting');
  });

  it('M3: the monthly allowance is reserved when a run starts, so runs waiting in the middle count too', async () => {
    await pauseAll();
    await publish('Slow allowance', { trigger: { kind: 'message_received', keywords: ['allowance'] }, start: 'w', steps: [{ id: 'w', kind: 'wait', minutes: 60, next: 'r' }, reply('r', 'Done', 'تم')] });
    const db = await t.ownerDb.connect();
    try {
      await db.query(`INSERT INTO entitlement_overrides (tenant_id, key, limit_value, reason) VALUES ($1, 'automation_executions', 0, 'test')
                      ON CONFLICT (tenant_id, key) DO UPDATE SET limit_value = 0`, [tenant]).catch(async () => {
        await db.query('BEGIN');
        await db.query('CREATE POLICY test_ov ON entitlement_overrides FOR ALL TO CURRENT_USER USING (true) WITH CHECK (true)');
        await db.query(`INSERT INTO entitlement_overrides (tenant_id, key, limit_value, reason) VALUES ($1, 'automation_executions', 0, 'test')`, [tenant]);
        await db.query('DROP POLICY test_ov ON entitlement_overrides');
        await db.query('COMMIT');
      });
    } finally { db.release(); }
    const wa = fresh();
    await say(wa, 'allowance check').expect(200);
    await work();
    expect((await runsFor(wa)).map((r) => [r.status, r.reason])).toEqual([['skipped', 'plan_limit']]);
    const db2 = await t.ownerDb.connect();
    try {
      await db2.query('BEGIN');
      await db2.query('CREATE POLICY test_ov2 ON entitlement_overrides FOR ALL TO CURRENT_USER USING (true) WITH CHECK (true)');
      await db2.query(`DELETE FROM entitlement_overrides WHERE tenant_id = $1 AND key = 'automation_executions'`, [tenant]);
      await db2.query('DROP POLICY test_ov2 ON entitlement_overrides');
      await db2.query('COMMIT');
    } finally { db2.release(); }
  });

  it('M4: a finished run\'s queued message is not sent once a person has replied', async () => {
    await pauseAll();
    await publish('Fast answer', { trigger: { kind: 'message_received', keywords: ['fast'] }, start: 'r', steps: [reply('r', 'Automatic answer', 'إجابة تلقائية')] });
    const wa = fresh();
    await say(wa, 'fast question').expect(200);
    while ((await runner().dispatchDue(100)) > 0) { /* queue only */ }
    expect((await runsFor(wa))[0]!.status).toBe('completed');
    const c = await conv(wa);
    await owner.post(`/v1/conversations/${c.id}/reply`, { text: 'Human here', seenActivity: Number(c.activity_seq), clientMessageId: randomUUID() }).expect(201);
    await new Sender(t.deps.db, t.deps.channels).dispatchDue(100);
    const auto = (await outbound(wa)).find((m) => m.automation_run_id);
    expect(auto).toMatchObject({ status: 'failed', error_code: 'person_replied' });
  });

  it('L1: keywords match whole words, and common Arabic spellings are treated alike', async () => {
    await pauseAll();
    await publish('Greeting', { trigger: { kind: 'message_received', keywords: ['hi', 'اسعار'] }, start: 'r', steps: [reply('r', 'Hello!', 'أهلًا!')] });
    const a = fresh(); const b = fresh(); const c = fresh();
    await say(a, 'I need to ship this').expect(200);
    await say(b, 'Hi there').expect(200);
    await say(c, 'ابغى أسعاركم... أقصد الأسعار').expect(200);
    await work();
    expect(await outbound(a)).toHaveLength(0);
    expect(await outbound(b)).toHaveLength(1);
    expect(await outbound(c)).toHaveLength(1);
  });

  it('L2/L6: rehearsal runs are never picked up by the worker, and no message can ever point at one', async () => {
    const id = (await owner.post('/v1/automations', { name: 'Reh only', draft: { trigger: { kind: 'message_received' }, start: 'r', steps: [reply('r', 'x', 'x')] } }).expect(201)).body.id;
    const r = (await owner.post(`/v1/automations/${id}/rehearse`, { text: 'hello' }).expect(201)).body;
    const claimed = await withContext(t.deps.db, { tenantId: null, userId: null }, async (tx) => (await tx.query<{ run_id: string }>('SELECT * FROM automation_claim(200, 60)')).rows);
    expect(claimed.map((x) => x.run_id)).not.toContain(r.id);
    const c = (await app((tx) => tx.query<{ id: string }>('SELECT id FROM conversations LIMIT 1'))).rows[0]!;
    await expect(t.ownerDb.query(
      `INSERT INTO messages (tenant_id, conversation_id, direction, kind, body, occurred_at, status, client_message_id, automation_run_id, automation_step, automation_run_mode)
       VALUES ($1, $2, 'out', 'text', 'x', now(), 'queued', gen_random_uuid(), $3, 'r', 'live')`, [tenant, c.id, r.id])).rejects.toThrow();
  });

  it('L4: a person being assigned the conversation stops its automation runs', async () => {
    await pauseAll();
    await publish('Assigned stop', { trigger: { kind: 'message_received', keywords: ['assignme'] }, start: 'w', steps: [{ id: 'w', kind: 'wait', minutes: 30, next: 'r' }, reply('r', 'Later', 'لاحقًا')] });
    const wa = fresh();
    await say(wa, 'assignme please').expect(200);
    await work();
    const c = await conv(wa);
    const agentId = (await agent.get('/v1/me/access').expect(200)).body.membershipId;
    await owner.post(`/v1/conversations/${c.id}/assign`, { membershipId: agentId, expectedVersion: c.version }).expect(200);
    expect((await runsFor(wa)).map((r) => [r.status, r.reason])).toEqual([['stopped', 'person_assigned']]);
  });

  it('L7/L8: an incomplete draft can be saved; publishing lists what is missing, including template values', async () => {
    const id = (await owner.post('/v1/automations', { name: 'Half done' }).expect(201)).body.id;
    let w = (await owner.get(`/v1/automations/${id}`).expect(200)).body;
    const draft = { trigger: { kind: 'message_received' }, start: 'a', steps: [
      { id: 'a', kind: 'add_tag', tagId: '', next: 'b' }, { id: 'b', kind: 'send_reply', text: { en: '', ar: '' }, next: 'c' }, { id: 'c', kind: 'handoff', note: '', next: null }] };
    const saved = (await owner.put(`/v1/automations/${id}/draft`, { draft, expectedVersion: w.version }).expect(200)).body;
    expect(saved.problems.map((p: { code: string }) => p.code).sort()).toEqual(['empty_message', 'empty_note', 'unknown_tag']);
    w = (await owner.get(`/v1/automations/${id}`).expect(200)).body;
    await owner.post(`/v1/automations/${id}/publish`, { expectedVersion: w.version }).expect(422);
  });
});
