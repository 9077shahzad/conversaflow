/**
 * Campaign limits re-checked immediately before sending, atomically (owner instruction of 21 Oct 2026, 11:01).
 *
 * What counts (migration 0034, campaign-limits.ts): campaign messages only, from the moment they are handed to
 * WhatsApp, whatever happens next, except messages WhatsApp definitely refused ("rejected", "exhausted"). When
 * queueing, messages already queued count as well. Windows: 7 days and the minimum gap per contact; a rolling 24 hours
 * per number.
 *
 * Covered: what counts; two senders at once on the last place under the daily limit and under a contact's limit;
 * pause and resume; the edges of the 24-hour and 7-day windows. Simulated WhatsApp only.
 */
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withContext } from '@conversaflow/database';
import { signBody, type SandboxAdapter } from '../src/modules/channels';
import { claimCampaignSend } from '../src/modules/campaign-limits';
import { CampaignRunner } from '../src/modules/campaigns';
import { Sender } from '../src/modules/sender';
import { activateSubscription, addMember, enableMfa, newCompany, newUser, startApp, type Client, type TestApp } from './helpers';

let t: TestApp;
let owner: Client;
let agent: Client;
let ownerMembership: string;
let sandbox: SandboxAdapter;
let tenant: string;
let template: { id: string; providerTemplateId: string };
const ACCOUNT = `waba${randomUUID().slice(0, 8)}`;
const MAIN = `pn${randomUUID().slice(0, 8)}`;
let seq = 0;
const nextWaId = () => `9665${String(Date.now()).slice(-5)}${String(++seq).padStart(3, '0')}`;

function post(raw: string) {
  return request(t.app.getHttpServer()).post('/v1/webhooks/sandbox').set('Content-Type', 'application/json')
    .set('X-Hub-Signature-256', signBody(t.deps.keys.sandboxWebhook, raw)).send(raw);
}
const app = <T>(fn: Parameters<typeof withContext<T>>[2]) => withContext<T>(t.deps.db, { tenantId: tenant, userId: null }, fn);

/** A number of this company (each test that needs a clean 24-hour window gets its own). */
async function newNumber(): Promise<{ number: string; id: string }> {
  const number = `pn${randomUUID().slice(0, 8)}`;
  const res = await owner.post('/v1/channels', { provider: 'sandbox', providerNumberId: number, displayPhone: `+9665000${String(++seq).padStart(5, '0')}`, label: `N${seq}`, providerAccountId: ACCOUNT }).expect(201);
  return { number, id: res.body.id as string };
}
/** A contact who wrote to the main number; consent recorded unless asked otherwise. */
async function customer(name: string, consent = true) {
  const wa = nextWaId();
  await post(JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: MAIN },
    contacts: [{ wa_id: wa, profile: { name } }],
    messages: [{ from: wa, id: `wamid.in.${randomUUID()}`, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'Hello' } }] } }] }] })).expect(200);
  const contactId = (await app((tx) => tx.query<{ contact_id: string }>('SELECT contact_id FROM contact_identifiers WHERE value = $1', [wa]))).rows[0]!.contact_id;
  if (consent) await agent.post(`/v1/contacts/${contactId}/marketing-consent`, { granted: true, evidence: 'Asked for offers in chat' }).expect(200);
  return { contactId, wa };
}
/** Everyone created so far loses consent, so each test's audience is only its own customers. */
const resetAudience = () => app((tx) => tx.query('UPDATE contacts SET marketing_consent_at = NULL'));
const setLimits = (l: { daily?: number; per7d?: number; gapHours?: number }) => app((tx) => tx.query(
  `UPDATE tenant_settings SET campaign_daily_limit = coalesce($1, campaign_daily_limit),
     campaign_max_per_contact_7d = coalesce($2, campaign_max_per_contact_7d), campaign_min_gap_hours = coalesce($3, campaign_min_gap_hours)`,
  [l.daily ?? null, l.per7d ?? null, l.gapHours ?? null]));
const used = async (connectionId: string, waiting: boolean) =>
  (await app((tx) => tx.query<{ n: number }>('SELECT campaign_daily_used($1, $2) AS n', [connectionId, waiting]))).rows[0]!.n;
const sender = () => new Sender(t.deps.db, t.deps.channels);
const due = () => app((tx) => tx.query(`UPDATE send_jobs SET next_attempt_at = now() WHERE state = 'pending'`));
async function startCampaign(name: string, connectionId: string) {
  const c = (await owner.post('/v1/campaigns', { name, templateId: template.id, connectionId, params: [{ source: 'static', value: 'friend' }] }).expect(201)).body;
  await owner.post(`/v1/campaigns/${c.id}/schedule`, { at: null }).expect(200);
  await new CampaignRunner(t.deps.db).runBatch(tenant, c.id);
  return c as { id: string };
}
const messagesOf = async (campaignId: string) => (await app((tx) => tx.query<{ id: string; status: string; failure_kind: string | null; error_code: string | null; attempts: number }>(
  `SELECT id, status, failure_kind, error_code, attempts FROM messages WHERE campaign_id = $1 AND body <> 'Earlier offer' ORDER BY created_at`, [campaignId]))).rows;
const jobOf = async (messageId: string) => (await app((tx) => tx.query<{ state: string; last_error: string | null; next_attempt_at: Date }>(
  'SELECT state, last_error, next_attempt_at FROM send_jobs WHERE message_id = $1', [messageId]))).rows[0]!;
const sentTo = (number: string) => sandbox.sent.filter((x) => x.providerNumberId === number).length;

/**
 * Records a campaign message that went out `hoursAgo` (a message row plus its count row, as the sender writes them),
 * with the given outcome. Used to place earlier sends at the edges of a window.
 */
async function sentEarlier(o: { contactId: string; connectionId: string; campaignId: string; hoursAgo: number; status?: string; failureKind?: string }) {
  await app(async (tx) => {
    const conv = (await tx.query<{ id: string }>(
      `INSERT INTO conversations (tenant_id, contact_id, connection_id) VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING RETURNING id`, [tenant, o.contactId, o.connectionId])).rows[0]?.id
      ?? (await tx.query<{ id: string }>('SELECT id FROM conversations WHERE contact_id = $1 AND connection_id = $2 ORDER BY created_at LIMIT 1',
        [o.contactId, o.connectionId])).rows[0]!.id;
    const m = (await tx.query<{ id: string }>(
      `INSERT INTO messages (tenant_id, conversation_id, direction, kind, body, client_message_id, sent_by_membership_id, occurred_at, status,
                             failure_kind, error_code, template_id, template_params, campaign_id)
       VALUES ($1, $2, 'out', 'template', 'Earlier offer', $3, $4, now() - make_interval(hours => $5), $6, $7, $8, $9, '["x"]', $10) RETURNING id`,
      [tenant, conv, randomUUID(), ownerMembership, o.hoursAgo, o.status ?? 'sent', o.failureKind ?? null,
        o.failureKind ? 'earlier' : null, template.id, o.campaignId])).rows[0]!;
    await tx.query(
      `INSERT INTO campaign_send_counts (tenant_id, message_id, campaign_id, connection_id, contact_id, counted_at)
       VALUES ($1, $2, $3, $4, $5, now() - make_interval(secs => $6))`,
      [tenant, m.id, o.campaignId, o.connectionId, o.contactId, Math.round(o.hoursAgo * 3600)]);
  });
}

beforeAll(async () => {
  t = await startApp();
  sandbox = t.deps.channels.sandbox as SandboxAdapter;
  owner = await newUser(t, 'lim-owner');
  tenant = await newCompany(owner, 'lim', 'business');
  await activateSubscription(t, tenant);
  await enableMfa(owner);
  ownerMembership = (await owner.get('/v1/me/access').expect(200)).body.membershipId;
  agent = await addMember(t, owner, 'lim-agent', 'agent');
  await owner.post('/v1/channels', { provider: 'sandbox', providerNumberId: MAIN, displayPhone: '+966500000066', label: 'Main', providerAccountId: ACCOUNT }).expect(201);
  template = (await owner.post('/v1/templates', { name: 'limit_offer', language: 'en', category: 'marketing',
    bodyText: 'Hi {{1}}, our AC service offer is open this week.', examples: ['Sara'] }).expect(201)).body;
  const remote = (sandbox.templates.get(ACCOUNT) ?? []).find((x) => x.providerTemplateId === template.providerTemplateId);
  if (remote) remote.status = 'approved';
  await post(JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: ACCOUNT, time: Math.floor(Date.now() / 1000), changes: [{
    field: 'message_template_status_update', value: { event: 'APPROVED', message_template_id: Number(template.providerTemplateId), message_template_name: 'limit_offer',
      message_template_language: 'en', reason: null } }] }] })).expect(200);
  await owner.patch('/v1/settings', {}).expect(200);
});
afterAll(() => t?.close());

describe('what counts toward the limits', () => {
  it('handed-over campaign messages count, also when uncertain or reported undelivered; refused ones, queued ones (at send time) and ordinary replies do not', async () => {
    await resetAudience();
    const n = await newNumber();
    const c = await customer('Counting Celia');
    const camp = (await owner.post('/v1/campaigns', { name: 'Counting', templateId: template.id, connectionId: n.id, params: [{ source: 'static', value: 'x' }] }).expect(201)).body;
    expect(await used(n.id, false)).toBe(0);
    await sentEarlier({ contactId: c.contactId, connectionId: n.id, campaignId: camp.id, hoursAgo: 1 });
    await sentEarlier({ contactId: c.contactId, connectionId: n.id, campaignId: camp.id, hoursAgo: 1, status: 'uncertain' });
    await sentEarlier({ contactId: c.contactId, connectionId: n.id, campaignId: camp.id, hoursAgo: 1, status: 'failed', failureKind: 'provider_reported' });
    await sentEarlier({ contactId: c.contactId, connectionId: n.id, campaignId: camp.id, hoursAgo: 1, status: 'failed', failureKind: 'rejected' });
    await sentEarlier({ contactId: c.contactId, connectionId: n.id, campaignId: camp.id, hoursAgo: 1, status: 'failed', failureKind: 'exhausted' });
    expect(await used(n.id, false)).toBe(3);
    // A queued campaign message counts when queueing (planning), not at send time.
    await setLimits({ daily: 100000, per7d: 14, gapHours: 0 });
    const queued = await startCampaign('Counting queued', n.id);
    expect(await messagesOf(queued.id)).toHaveLength(1);
    expect(await used(n.id, true)).toBe(4);
    expect(await used(n.id, false)).toBe(3);
    // An ordinary reply on the same number does not count.
    const before = await used(n.id, false);
    const conv = (await app((tx) => tx.query<{ id: string }>('SELECT id FROM conversations WHERE contact_id = $1 AND connection_id = $2', [c.contactId, n.id]))).rows[0]!;
    await app((tx) => tx.query(
      `INSERT INTO messages (tenant_id, conversation_id, direction, kind, body, client_message_id, sent_by_membership_id, occurred_at, status)
       VALUES ($1, $2, 'out', 'text', 'Thanks', $3, $4, now(), 'sent')`, [tenant, conv.id, randomUUID(), ownerMembership]));
    expect(await used(n.id, false)).toBe(before);
    await owner.post(`/v1/campaigns/${queued.id}/cancel`).expect(200);
    await due(); await sender().dispatchDue(100);
  });
});

describe('send-time check under concurrency', () => {
  it('several senders running together, daily limit lowered after queueing: exactly one goes, the others wait without an attempt (end to end; the forced-overlap test proves the lock)', async () => {
    await resetAudience();
    const n = await newNumber();
    for (const name of ['Daily Dina', 'Daily Duha', 'Daily Dawud']) await customer(name);
    await setLimits({ daily: 100000, per7d: 14, gapHours: 0 });
    const camp = await startCampaign('Daily race', n.id);                 // three queued while the limit was high
    expect((await messagesOf(camp.id)).map((m) => m.status)).toEqual(['queued', 'queued', 'queued']);
    await setLimits({ daily: 1 });                                         // the company lowers the limit afterwards
    await Promise.all([sender().dispatchDue(100), sender().dispatchDue(100), sender().dispatchDue(100)]);
    const msgs = await messagesOf(camp.id);
    expect(msgs.filter((m) => m.status === 'sent')).toHaveLength(1);
    expect(sentTo(n.number)).toBe(1);
    for (const m of msgs.filter((x) => x.status === 'queued')) {
      expect(m.attempts).toBe(0);
      const j = await jobOf(m.id);
      expect([j.state, j.last_error]).toEqual(['pending', 'daily_limit']);
      expect(j.next_attempt_at.getTime()).toBeGreaterThan(Date.now() + 23 * 3_600_000);   // when room frees up
    }
    expect(msgs.filter((m) => m.status === 'queued')).toHaveLength(2);
    expect((await owner.get(`/v1/campaigns/${camp.id}`).expect(200)).body.status).toBe('running');
    await owner.post(`/v1/campaigns/${camp.id}/cancel`).expect(200);
    await due(); await sender().dispatchDue(100);
    expect(sentTo(n.number)).toBe(1);
    await setLimits({ daily: 100000 });
  });

  it('two campaigns queued for one contact, contact limit tightened after queueing, several senders running together: only one reaches the contact (end to end)', async () => {
    await resetAudience();
    const n = await newNumber();
    await customer('Shared Shatha');
    await setLimits({ daily: 100000, per7d: 2, gapHours: 0 });
    const a = await startCampaign('Contact race A', n.id);
    const b = await startCampaign('Contact race B', n.id);
    expect([...await messagesOf(a.id), ...await messagesOf(b.id)].map((m) => m.status)).toEqual(['queued', 'queued']);
    await setLimits({ per7d: 1 });                                        // tightened after both were queued
    await Promise.all([sender().dispatchDue(100), sender().dispatchDue(100)]);
    const all = [...await messagesOf(a.id), ...await messagesOf(b.id)];
    expect(all.filter((m) => m.status === 'sent')).toHaveLength(1);
    expect(all.filter((m) => m.status === 'failed').map((m) => `${m.failure_kind}:${m.error_code}`)).toEqual(['blocked:frequency_limit']);
    expect(sentTo(n.number)).toBe(1);
    await setLimits({ per7d: 2, gapHours: 24 });
  });

  it('the minimum gap is checked at send time too', async () => {
    await resetAudience();
    const n = await newNumber();
    await customer('Gap Ghalia');
    await setLimits({ daily: 100000, per7d: 14, gapHours: 0 });
    const a = await startCampaign('Gap A', n.id);
    const b = await startCampaign('Gap B', n.id);
    await setLimits({ gapHours: 24 });
    await sender().dispatchDue(100);
    const all = [...await messagesOf(a.id), ...await messagesOf(b.id)];
    expect(all.map((m) => m.status).sort()).toEqual(['failed', 'sent']);
    expect(all.find((m) => m.status === 'failed')!.error_code).toBe('frequency_limit');
    await setLimits({ per7d: 2, gapHours: 24 });
  });
});

describe('atomic check and count', () => {
  it('two transactions checking the last place at the same moment: the second waits for the first and is refused', async () => {
    await resetAudience();
    const n = await newNumber();
    for (const name of ['Atomic Aseel', 'Atomic Anas']) await customer(name);
    await setLimits({ daily: 100000, per7d: 14, gapHours: 0 });
    const camp = await startCampaign('Atomic', n.id);
    const [m1, m2] = await app((tx) => tx.query<{ id: string; conversation_id: string }>(
      `SELECT id, conversation_id FROM messages WHERE campaign_id = $1 AND body <> 'Earlier offer' ORDER BY created_at`, [camp.id])).then((r) => r.rows);
    await setLimits({ daily: 1 });
    const claim = (m: { id: string; conversation_id: string }, hold: number) => app((tx) => claimCampaignSend(tx, tenant,
      { messageId: m.id, campaignId: camp.id, conversationId: m.conversation_id }, { afterCheck: () => new Promise((r) => setTimeout(r, hold)) }));
    // The first has checked and is paused before recording its count when the second starts its check.
    const first = claim(m1!, 400);
    await new Promise((r) => setTimeout(r, 100));
    const second = claim(m2!, 0);
    const verdicts = await Promise.all([first, second]);
    expect(verdicts[0]).toEqual({ ok: true });
    expect(verdicts[1]).toMatchObject({ ok: false, reason: 'daily_limit' });
    expect(await used(n.id, false)).toBe(1);
    await owner.post(`/v1/campaigns/${camp.id}/cancel`).expect(200);
    await due(); await sender().dispatchDue(100);
    await setLimits({ daily: 100000 });
  });
});

describe('temporary refusals by WhatsApp (final recheck, finding P2-1)', () => {
  const countRows = async (messageId: string) => (await app((tx) => tx.query('SELECT 1 FROM campaign_send_counts WHERE message_id = $1', [messageId]))).rowCount;
  const attemptsOf = async (messageId: string) => (await app((tx) => tx.query<{ outcome: string }>(
    'SELECT outcome FROM send_attempts WHERE message_id = $1 ORDER BY created_at', [messageId]))).rows.map((r) => r.outcome);
  /** Runs this message's job now (only this one, so other test files' jobs cannot take the scripted outcomes). */
  async function attempt(messageId: string) {
    await app((tx) => tx.query(`UPDATE send_jobs SET next_attempt_at = now() WHERE message_id = $1 AND state = 'pending'`, [messageId]));
    const job = (await app((tx) => tx.query<{ id: string }>('SELECT id FROM send_jobs WHERE message_id = $1', [messageId]))).rows[0]!.id;
    const s = sender();
    if (await s.leaseNow(tenant, job)) await s.processJob(tenant, job);
  }

  it('declined once, then accepted: retried and sent once, counted once, the minimum gap does not block its own retry', async () => {
    await resetAudience();
    const n = await newNumber();
    await customer('Retry Rasha');
    await setLimits({ daily: 100000, per7d: 2, gapHours: 24 });
    const camp = await startCampaign('Temporary refusal', n.id);
    const m = (await messagesOf(camp.id))[0]!;
    sandbox.script.push({ notAccepted: '130429' });
    await attempt(m.id);
    expect((await messagesOf(camp.id))[0]!.status).toBe('queued');
    await attempt(m.id);
    expect((await messagesOf(camp.id))[0]!.status).toBe('sent');
    expect(await attemptsOf(m.id)).toEqual(['not_accepted', 'accepted']);
    expect(await countRows(m.id)).toBe(1);
    expect(await used(n.id, false)).toBe(1);
    expect(sentTo(n.number)).toBe(1);
  });

  it('declined on all five attempts: "exhausted", and it no longer counts toward any limit', async () => {
    await resetAudience();
    const n = await newNumber();
    const c = await customer('Declined Duaa');
    await setLimits({ daily: 100000, per7d: 2, gapHours: 24 });
    const camp = await startCampaign('Declined five times', n.id);
    const m = (await messagesOf(camp.id))[0]!;
    sandbox.script.push(...Array.from({ length: 5 }, () => ({ notAccepted: '130429' })));
    for (let i = 0; i < 5; i++) await attempt(m.id);
    expect((await messagesOf(camp.id))[0]).toMatchObject({ status: 'failed', failure_kind: 'exhausted' });
    expect(await used(n.id, false)).toBe(0);
    const blocked = (await app((tx) => tx.query<{ b: boolean }>('SELECT campaign_contact_blocked($1, 2, 24, false) AS b', [c.contactId]))).rows[0]!.b;
    expect(blocked).toBe(false);
    expect(sentTo(n.number)).toBe(0);
  });

  it('declined once, then stopped by a later check (campaign cancelled): "blocked", and it no longer counts', async () => {
    await resetAudience();
    const n = await newNumber();
    const c = await customer('Stopped Sana');
    await setLimits({ daily: 100000, per7d: 2, gapHours: 24 });
    const camp = await startCampaign('Declined then cancelled', n.id);
    const m = (await messagesOf(camp.id))[0]!;
    sandbox.script.push({ notAccepted: '130429' });
    await attempt(m.id);
    expect(await used(n.id, false)).toBe(1);                              // holds its place while it waits to be retried
    await owner.post(`/v1/campaigns/${camp.id}/cancel`).expect(200);
    await attempt(m.id);
    expect((await messagesOf(camp.id))[0]).toMatchObject({ status: 'failed', failure_kind: 'blocked', error_code: 'campaign_cancelled' });
    expect(await used(n.id, false)).toBe(0);
    const blocked = (await app((tx) => tx.query<{ b: boolean }>('SELECT campaign_contact_blocked($1, 2, 24, false) AS b', [c.contactId]))).rows[0]!.b;
    expect(blocked).toBe(false);
    expect(sentTo(n.number)).toBe(0);
  });
});

describe('pause and resume', () => {
  it('a message held by a pause is checked again on resume: if another campaign used the room meanwhile, it waits; it goes once room frees', async () => {
    await resetAudience();
    const n = await newNumber();
    await customer('Paused Parwin');
    await setLimits({ daily: 100000, per7d: 14, gapHours: 0 });
    const a = await startCampaign('Held by pause', n.id);
    await owner.post(`/v1/campaigns/${a.id}/pause`).expect(200);
    await setLimits({ gapHours: 1 });                                     // Parwin's held message keeps her out of b
    await customer('Other Omran');
    const b = await startCampaign('Used the room', n.id);
    await sender().dispatchDue(100);                                      // b's message goes; a's is held by the pause
    expect((await messagesOf(b.id))[0]!.status).toBe('sent');
    expect((await messagesOf(a.id))[0]!.status).toBe('queued');
    await setLimits({ daily: 1 });                                        // the number's room is now used up
    await owner.post(`/v1/campaigns/${a.id}/resume`).expect(200);
    await due(); await sender().dispatchDue(100);
    const held = (await messagesOf(a.id))[0]!;
    expect([held.status, held.attempts]).toEqual(['queued', 0]);
    expect((await jobOf(held.id)).last_error).toBe('daily_limit');
    expect(sentTo(n.number)).toBe(1);
    await setLimits({ daily: 2 });                                        // room again
    await due(); await sender().dispatchDue(100);
    expect((await messagesOf(a.id))[0]!.status).toBe('sent');
    expect(sentTo(n.number)).toBe(2);
    await new CampaignRunner(t.deps.db).runBatch(tenant, a.id);
    expect((await owner.get(`/v1/campaigns/${a.id}`).expect(200)).body.status).toBe('completed');
    await setLimits({ daily: 100000, per7d: 2, gapHours: 24 });
  });
});

describe('window edges', () => {
  it('daily window: a send 23 hours ago still counts (the next waits about an hour); one 25 hours ago no longer does', async () => {
    await resetAudience();
    const inside = await newNumber();
    const outside = await newNumber();
    const filler = await customer('Earlier Ehab', false);
    await customer('Window Wafa');
    await setLimits({ daily: 100000, per7d: 14, gapHours: 0 });
    const a = await startCampaign('Inside the window', inside.id);
    const b = await startCampaign('Outside the window', outside.id);
    await sentEarlier({ contactId: filler.contactId, connectionId: inside.id, campaignId: a.id, hoursAgo: 23 });
    await sentEarlier({ contactId: filler.contactId, connectionId: outside.id, campaignId: b.id, hoursAgo: 25 });
    await setLimits({ daily: 1 });
    await sender().dispatchDue(100);
    const held = (await messagesOf(a.id))[0]!;
    expect(held.status).toBe('queued');
    const wait = (await jobOf(held.id)).next_attempt_at.getTime() - Date.now();
    expect(wait).toBeGreaterThan(55 * 60_000);
    expect(wait).toBeLessThan(65 * 60_000);
    expect((await messagesOf(b.id)).map((m) => m.status)).toEqual(['sent']);
    expect(sentTo(inside.number)).toBe(0);
    expect(sentTo(outside.number)).toBe(1);
    await owner.post(`/v1/campaigns/${a.id}/cancel`).expect(200);
    await due(); await sender().dispatchDue(100);
    await setLimits({ daily: 100000 });
  });

  it('7-day window: a campaign message 6 days 23 hours ago still counts at send time; one 7 days 1 hour ago does not', async () => {
    await resetAudience();
    const n = await newNumber();
    const recent = await customer('Recent Rami');
    const older = await customer('Older Ola');
    await setLimits({ daily: 100000, per7d: 1, gapHours: 0 });
    const camp = await startCampaign('Seven days', n.id);                // both queued (nothing counted yet)
    expect((await messagesOf(camp.id)).map((m) => m.status)).toEqual(['queued', 'queued']);
    // Earlier campaign messages appear after queueing (for example, sent by another worker in the meantime).
    await sentEarlier({ contactId: recent.contactId, connectionId: n.id, campaignId: camp.id, hoursAgo: 6 * 24 + 23 });
    await sentEarlier({ contactId: older.contactId, connectionId: n.id, campaignId: camp.id, hoursAgo: 7 * 24 + 1 });
    await sender().dispatchDue(100);
    const byContact = await app((tx) => tx.query<{ contact_id: string; status: string; error_code: string | null }>(
      `SELECT c.contact_id, m.status, m.error_code FROM messages m JOIN conversations c ON c.id = m.conversation_id
       WHERE m.campaign_id = $1 AND m.body <> 'Earlier offer'`, [camp.id]));
    const of = (id: string) => byContact.rows.find((r) => r.contact_id === id)!;
    expect([of(recent.contactId).status, of(recent.contactId).error_code]).toEqual(['failed', 'frequency_limit']);
    expect(of(older.contactId).status).toBe('sent');
    expect(sentTo(n.number)).toBe(1);
    await setLimits({ per7d: 2, gapHours: 24 });
  });
});
