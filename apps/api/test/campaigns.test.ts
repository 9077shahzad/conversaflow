/**
 * Campaigns (Wave 1, owner instructions of 21 Oct 2026): audience preview, recorded consent, suppression list,
 * scheduling, frequency limits, cost estimate, pause/resume/cancel; eligibility re-checked immediately before each
 * send (including opt-outs after scheduling); duplicate jobs, partial failures and recovery without duplicate sending.
 */
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withContext } from '@conversaflow/database';
import { signBody, type SandboxAdapter } from '../src/modules/channels';
import { CampaignBatchCrash, CampaignRunner } from '../src/modules/campaigns';
import { Sender } from '../src/modules/sender';
import { activateSubscription, addMember, enableMfa, newCompany, newUser, startApp, type Client, type TestApp } from './helpers';

let t: TestApp;
let owner: Client;
let agent: Client;
let otherOwner: Client;
let sandbox: SandboxAdapter;
let tenant: string;
let marketing: { id: string; providerTemplateId: string };
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
const inbound = (from: string, text: string, name = 'Customer') => ({
  contacts: [{ wa_id: from, profile: { name } }],
  messages: [{ from, id: `wamid.in.${randomUUID()}`, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }],
});
const review = (providerTemplateId: string, event: string) => {
  const remote = (sandbox.templates.get(ACCOUNT) ?? []).find((x) => x.providerTemplateId === providerTemplateId);
  if (remote) remote.status = event === 'APPROVED' ? 'approved' : event === 'PAUSED' ? 'paused' : remote.status;
  return post(JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: ACCOUNT, time: Math.floor(Date.now() / 1000) + (++seq), changes: [{
    field: 'message_template_status_update', value: { event, message_template_id: Number(providerTemplateId), message_template_name: 'x', message_template_language: 'en', reason: null } }] }] }));
};
const app = <T>(fn: Parameters<typeof withContext<T>>[2]) => withContext<T>(t.deps.db, { tenantId: tenant, userId: null }, fn);

/** Creates a contact by an inbound message; consent and suppression as asked. Returns its contact id and number. */
async function customer(name: string, opts: { consent?: boolean; suppressed?: boolean } = {}) {
  const wa = nextWaId();
  await deliver(inbound(wa, 'Hello', name)).expect(200);
  const contactId = (await app((tx) => tx.query<{ contact_id: string }>(`SELECT contact_id FROM contact_identifiers WHERE value = $1`, [wa]))).rows[0]!.contact_id;
  if (opts.consent) await agent.post(`/v1/contacts/${contactId}/marketing-consent`, { granted: true, evidence: 'Asked for offers in chat' }).expect(200);
  if (opts.suppressed) await owner.post('/v1/suppressions', { waNumber: `+${wa}`, reason: 'customer_request', note: 'Asked by phone' }).expect(201);
  return { contactId, wa, name };
}
/** Fresh company state for each campaign test: everyone created so far loses consent, so audiences stay small. */
const resetAudience = () => app((tx) => tx.query('UPDATE contacts SET marketing_consent_at = NULL'));
const params = [{ source: 'contact_name', fallback: 'there' }];
const createCampaign = async (name: string, extra: Record<string, unknown> = {}) =>
  (await owner.post('/v1/campaigns', { name, templateId: marketing.id, params, ...extra }).expect(201)).body;
const runner = (faults = {}) => new CampaignRunner(t.deps.db, faults);
/** Sets the number's rolling 24-hour campaign limit to what has been used so far plus `extra`. */
async function allowMore(extra: number) {
  await app(async (tx) => {
    const used = (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM messages WHERE campaign_id IS NOT NULL AND created_at > now() - interval '24 hours'`)).rows[0]!.n;
    await tx.query('UPDATE tenant_settings SET campaign_daily_limit = $1', [used + extra]);
  });
}
const noLimit = () => app((tx) => tx.query('UPDATE tenant_settings SET campaign_daily_limit = 100000'));
const sender = () => new Sender(t.deps.db, t.deps.channels);
const messagesOf = async (campaignId: string) => (await app((tx) => tx.query<{ id: string; status: string; failure_kind: string | null; error_code: string | null; contact_id: string }>(
  `SELECT m.id, m.status, m.failure_kind, m.error_code, c.contact_id FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE m.campaign_id = $1`, [campaignId]))).rows;
async function runAll(campaignId: string) {
  for (let i = 0; i < 10; i++) {
    await runner().runBatch(tenant, campaignId);
    await app((tx) => tx.query(`UPDATE send_jobs SET next_attempt_at = now() WHERE state = 'pending'`));
    await sender().dispatchDue(100);
    if ((await owner.get(`/v1/campaigns/${campaignId}`).expect(200)).body.status === 'completed') break;
  }
}

beforeAll(async () => {
  t = await startApp();
  sandbox = t.deps.channels.sandbox as SandboxAdapter;
  owner = await newUser(t, 'camp-owner');
  tenant = await newCompany(owner, 'camp', 'business');
  await activateSubscription(t, tenant);
  await enableMfa(owner);
  agent = await addMember(t, owner, 'camp-agent', 'agent');
  await owner.post('/v1/channels', { provider: 'sandbox', providerNumberId: NUMBER, displayPhone: '+966500000088', label: 'KSA', providerAccountId: ACCOUNT }).expect(201);
  marketing = (await owner.post('/v1/templates', { name: 'autumn_offer', language: 'en', category: 'marketing',
    bodyText: 'Hi {{1}}, our autumn AC service offer is open this week. Reply YES to book.', examples: ['Sara'] }).expect(201)).body;
  await review(marketing.providerTemplateId, 'APPROVED').expect(200);
  await owner.patch('/v1/settings', {}).expect(200); // creates the company's settings row
  await app((tx) => tx.query('UPDATE tenant_settings SET campaign_daily_limit = 100000'));
  otherOwner = await newUser(t, 'camp-other');
  const other = await newCompany(otherOwner, 'campother', 'business');
  await activateSubscription(t, other);
  await enableMfa(otherOwner);
});
afterAll(() => t?.close());

describe('access', () => {
  it('only people with campaigns.manage (two-step sign-in) can preview or create; other companies cannot see them', async () => {
    await agent.post('/v1/campaigns/preview', { templateId: marketing.id, params }).expect(403);
    await agent.get('/v1/campaigns').expect(403);
    const c = await createCampaign('Access check');
    await otherOwner.get(`/v1/campaigns/${c.id}`).expect(404);
    await otherOwner.post(`/v1/campaigns/${c.id}/cancel`).expect(404);
  });
});

describe('audience preview and cost estimate', () => {
  it('counts the eligible audience, explains every exclusion, shows personalised samples, and never guesses a cost', async () => {
    await resetAudience();
    await customer('Amal', { consent: true });
    await customer('Basim', { consent: true });
    await customer('Carla');                                       // no recorded consent
    await customer('Dana', { consent: true, suppressed: true });   // suppressed
    const optedOut = await customer('Eyad', { consent: true });
    await deliver(inbound(optedOut.wa, 'STOP')).expect(200);      // STOP also withdraws marketing consent
    const p = (await owner.post('/v1/campaigns/preview', { templateId: marketing.id, params }).expect(200)).body;
    expect(p.eligible).toBe(2);
    expect(p.excluded).toMatchObject({ no_consent: expect.any(Number), suppressed: 1, opted_out: 1 });
    expect(p.sample.map((s: { text: string }) => s.text)).toEqual(expect.arrayContaining([
      'Hi Amal, our autumn AC service offer is open this week. Reply YES to book.',
      'Hi Basim, our autumn AC service offer is open this week. Reply YES to book.',
    ]));
    // No verified Meta marketing rate is on file for Saudi Arabia: no total, and the line says so.
    expect(p.cost).toMatchObject({ category: 'marketing', complete: false, total: null });
    expect(p.cost.lines).toEqual([expect.objectContaining({ market: 'SA', recipients: 2, rate: null })]);
    // With a verified rate on file, the total is computed from it (a test rate, removed afterwards).
    await t.ownerDb.query(`INSERT INTO provider_rates (provider, market, category, unit, currency, rate, effective_from, source_url, source_checked_on, status, reconciliation_note)
      VALUES ('meta_whatsapp', 'SA', 'marketing', 'message', 'USD', 0.05, '2026-01-01', 'https://example.test/rate', '2026-10-21', 'verified', 'test only')`).catch(() => undefined);
    const rated = await withContext(t.deps.db, { tenantId: tenant, userId: null }, async (tx) => (await tx.query('SELECT count(*)::int AS n FROM provider_rates WHERE market = $1 AND category = $2', ['SA', 'marketing'])).rows[0].n);
    if (rated > 0) {
      const p2 = (await owner.post('/v1/campaigns/preview', { templateId: marketing.id, params }).expect(200)).body;
      expect(p2.cost).toMatchObject({ complete: true, total: 0.1 });
      await t.ownerDb.query(`DELETE FROM provider_rates WHERE source_url = 'https://example.test/rate'`).catch(() => undefined);
    }
    // Parameters must match the template.
    await owner.post('/v1/campaigns/preview', { templateId: marketing.id, params: [] }).expect(400);
  });
});

describe('sending', () => {
  it('sends once to each eligible contact; an opt-out after scheduling is respected at queue time and at send time', async () => {
    await resetAudience();
    const a = await customer('Faris', { consent: true });
    const b = await customer('Ghada', { consent: true });
    const c = await customer('Hamza', { consent: true });
    // Only one message may start for now, so the opt-out lands between the two recipients.
    await allowMore(1);
    const camp = await createCampaign('Autumn offer');
    await owner.post(`/v1/campaigns/${camp.id}/schedule`, { at: null }).expect(200);
    await deliver(inbound(c.wa, 'إيقاف')).expect(200);                // after scheduling, before start: never chosen
    expect((await runner().runBatch(tenant, camp.id)).queued).toBe(1);   // starts: chooses a and b; queues one
    const first = await messagesOf(camp.id);
    const queuedFor = first[0]!.contact_id;
    const other = queuedFor === a.contactId ? b : a;
    // The other recipient opts out after being chosen but before being queued: skipped with that reason.
    await deliver(inbound(other.wa, 'STOP')).expect(200);
    await noLimit();
    await runner().runBatch(tenant, camp.id);
    const before = sandbox.sent.length;
    await sender().dispatchDue(100);
    expect(sandbox.sent.length).toBe(before + 1);
    // Completed by the next batch, once none of its messages is still waiting (review finding S4-2).
    await runner().runBatch(tenant, camp.id);
    const view = (await owner.get(`/v1/campaigns/${camp.id}`).expect(200)).body;
    expect(view.status).toBe('completed');
    expect(view.progress).toMatchObject({ sent: 1, 'skipped:opted_out': 1 });
    expect(sandbox.sent.at(-1)!.template).toMatchObject({ name: 'autumn_offer', params: [expect.any(String)] });
  });

  it('an opt-out after the message was queued stops it at send time; nothing is sent', async () => {
    await resetAudience();
    const a = await customer('Iman', { consent: true });
    const camp = await createCampaign('Late opt-out');
    await owner.post(`/v1/campaigns/${camp.id}/schedule`, { at: null }).expect(200);
    await runner().runBatch(tenant, camp.id);
    await deliver(inbound(a.wa, 'STOP')).expect(200);
    const before = sandbox.sent.length;
    await sender().dispatchDue(100);
    expect(sandbox.sent.length).toBe(before);
    expect((await messagesOf(camp.id))[0]).toMatchObject({ status: 'failed', failure_kind: 'blocked', error_code: 'contact_opted_out' });
  });

  it('a contact added to the suppression list after queueing is not sent the message', async () => {
    await resetAudience();
    const a = await customer('Jamal', { consent: true });
    const camp = await createCampaign('Suppressed late');
    await owner.post(`/v1/campaigns/${camp.id}/schedule`, { at: null }).expect(200);
    await runner().runBatch(tenant, camp.id);
    await owner.post('/v1/suppressions', { waNumber: a.wa, reason: 'complaint' }).expect(201);
    await sender().dispatchDue(100);
    expect((await messagesOf(camp.id))[0]).toMatchObject({ status: 'failed', error_code: 'suppressed' });
  });
});

describe('no duplicate sending', () => {
  it('two runners on the same campaign at once queue each recipient once; a direct duplicate is refused by the database', async () => {
    await resetAudience();
    for (const n of ['Kamal', 'Lina', 'Majed', 'Nada']) await customer(n, { consent: true });
    const camp = await createCampaign('Concurrent runners');
    await owner.post(`/v1/campaigns/${camp.id}/schedule`, { at: null }).expect(200);
    const results = await Promise.allSettled([runner().runBatch(tenant, camp.id), runner().runBatch(tenant, camp.id), runner().runBatch(tenant, camp.id)]);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    const msgs = await messagesOf(camp.id);
    expect(msgs).toHaveLength(4);
    expect(new Set(msgs.map((m) => m.contact_id)).size).toBe(4);
    // The worker's lookup hands a due campaign to one worker at a time.
    await app((tx) => tx.query(`UPDATE campaigns SET status = 'running', lease_until = NULL WHERE id = $1`, [camp.id]));
    const claims = await Promise.all([1, 2, 3].map(() => withContext(t.deps.db, { tenantId: null, userId: null }, async (tx) =>
      (await tx.query<{ campaign_id: string }>('SELECT * FROM campaign_claim(20, 60)')).rows.filter((r) => r.campaign_id === camp.id).length)));
    expect(claims.reduce((x, y) => x + y, 0)).toBe(1);
    // Queueing a recipient's message a second time fails on its idempotency key.
    const r = (await app((tx) => tx.query<{ id: string; message_id: string }>('SELECT id, message_id FROM campaign_recipients WHERE campaign_id = $1 LIMIT 1', [camp.id]))).rows[0]!;
    const m = (await app((tx) => tx.query<{ conversation_id: string; sent_by_membership_id: string }>('SELECT conversation_id, sent_by_membership_id FROM messages WHERE id = $1', [r.message_id]))).rows[0]!;
    await expect(app((tx) => tx.query(
      `INSERT INTO messages (tenant_id, conversation_id, direction, kind, body, client_message_id, sent_by_membership_id, occurred_at, status, template_id, template_params, campaign_id)
       VALUES ($1, $2, 'out', 'template', 'x', $3, $4, now(), 'queued', $5, '["x"]', $6)`, [tenant, m.conversation_id, r.id, m.sent_by_membership_id, marketing.id, camp.id]))).rejects.toMatchObject({ code: '23505' });
  });

  it('a crash in the middle of a batch queues nothing; the next run queues everyone exactly once', async () => {
    await resetAudience();
    for (const n of ['Omar', 'Pari', 'Qasim']) await customer(n, { consent: true });
    const camp = await createCampaign('Crash recovery');
    await owner.post(`/v1/campaigns/${camp.id}/schedule`, { at: null }).expect(200);
    await expect(runner({ crashAfterQueued: 2 }).runBatch(tenant, camp.id)).rejects.toBeInstanceOf(CampaignBatchCrash);
    expect(await messagesOf(camp.id)).toHaveLength(0);
    expect((await owner.get(`/v1/campaigns/${camp.id}`).expect(200)).body.status).toBe('scheduled'); // the start rolled back too
    await runAll(camp.id);
    const msgs = await messagesOf(camp.id);
    expect(msgs).toHaveLength(3);
    expect(msgs.every((x) => x.status === 'sent')).toBe(true);
  });

  it('partial failures: one refused send does not stop the others; nothing is resent on later runs', async () => {
    await resetAudience();
    for (const n of ['Rami', 'Sana', 'Tariq']) await customer(n, { consent: true });
    const camp = await createCampaign('Partial failure');
    await owner.post(`/v1/campaigns/${camp.id}/schedule`, { at: null }).expect(200);
    await runner().runBatch(tenant, camp.id);
    sandbox.script.push('ok', { reject: '131026' }, 'ok');
    const before = sandbox.sent.length;
    await sender().dispatchDue(100);
    await runAll(camp.id);
    await runAll(camp.id);
    expect(sandbox.sent.length).toBe(before + 2);
    const view = (await owner.get(`/v1/campaigns/${camp.id}`).expect(200)).body;
    expect(view).toMatchObject({ status: 'completed', progress: { sent: 2, 'failed:rejected': 1 } });
  });
});

describe('frequency limits, scheduling and template changes', () => {
  it('a contact who received a campaign recently is skipped by the next one', async () => {
    await resetAudience();
    await customer('Ula', { consent: true });
    const first = await createCampaign('First');
    await owner.post(`/v1/campaigns/${first.id}/schedule`, { at: null }).expect(200);
    await runAll(first.id);
    const p = (await owner.post('/v1/campaigns/preview', { templateId: marketing.id, params }).expect(200)).body;
    expect(p.excluded.frequency_limit).toBeGreaterThanOrEqual(1);
    const second = await createCampaign('Second');
    await owner.post(`/v1/campaigns/${second.id}/schedule`, { at: null }).expect(200);
    await runAll(second.id);
    expect((await owner.get(`/v1/campaigns/${second.id}`).expect(200)).body.progress).toMatchObject({ 'skipped:frequency_limit': 1 });
  });

  it('a campaign scheduled for later does not start early', async () => {
    await resetAudience();
    await customer('Wafa', { consent: true });
    const camp = await createCampaign('Later');
    await owner.post(`/v1/campaigns/${camp.id}/schedule`, { at: new Date(Date.now() + 3_600_000).toISOString() }).expect(200);
    expect((await runner().runBatch(tenant, camp.id)).queued).toBe(0);
    expect(await messagesOf(camp.id)).toHaveLength(0);
  });

  it('a template paused by WhatsApp after scheduling stops the campaign\'s sends', async () => {
    await resetAudience();
    await customer('Yara', { consent: true });
    const tpl = (await owner.post('/v1/templates', { name: `pause_${seq}`, language: 'en', category: 'marketing', bodyText: 'Hi {{1}}, a short note from us today.', examples: ['A'] }).expect(201)).body;
    await review(tpl.providerTemplateId, 'APPROVED').expect(200);
    const camp = (await owner.post('/v1/campaigns', { name: 'Paused template', templateId: tpl.id, params }).expect(201)).body;
    await owner.post(`/v1/campaigns/${camp.id}/schedule`, { at: null }).expect(200);
    await review(tpl.providerTemplateId, 'PAUSED').expect(200);
    await runAll(camp.id);
    expect((await owner.get(`/v1/campaigns/${camp.id}`).expect(200)).body.progress).toMatchObject({ 'skipped:template_not_approved': 1 });
    // And a draft cannot be scheduled with a template that is not approved.
    const draft = (await owner.post('/v1/campaigns', { name: 'Draft', templateId: tpl.id, params }).expect(201)).body;
    expect((await owner.post(`/v1/campaigns/${draft.id}/schedule`, { at: null })).body.error.code).toBe('template_not_approved');
  });
});

describe('pause, resume and cancel', () => {
  it('pausing holds queued messages and queues no more; resuming sends them once; cancelling stops the rest', async () => {
    await resetAudience();
    for (const n of ['Zaid', 'Abeer', 'Bader']) await customer(n, { consent: true });
    await allowMore(1);
    const camp = await createCampaign('Pause test');
    await owner.post(`/v1/campaigns/${camp.id}/schedule`, { at: null }).expect(200);
    await runner().runBatch(tenant, camp.id);                         // one queued
    await owner.post(`/v1/campaigns/${camp.id}/pause`).expect(200);
    const before = sandbox.sent.length;
    await sender().dispatchDue(100);
    expect(sandbox.sent.length).toBe(before);                          // held, not sent, not failed
    expect((await messagesOf(camp.id))[0]!.status).toBe('queued');
    await noLimit();
    expect((await runner().runBatch(tenant, camp.id)).queued).toBe(0); // paused: nothing more queued
    await owner.post(`/v1/campaigns/${camp.id}/resume`).expect(200);
    await allowMore(1);
    await runner().runBatch(tenant, camp.id);                         // one more queued
    await app((tx) => tx.query(`UPDATE send_jobs SET next_attempt_at = now() WHERE state = 'pending'`));
    await sender().dispatchDue(100);
    expect(sandbox.sent.length).toBe(before + 2);                      // the held one, once, and the new one
    await owner.post(`/v1/campaigns/${camp.id}/cancel`).expect(200);
    await sender().dispatchDue(100);
    await noLimit();
    await runner().runBatch(tenant, camp.id);
    const view = (await owner.get(`/v1/campaigns/${camp.id}`).expect(200)).body;
    expect(view.status).toBe('cancelled');
    expect(view.progress['skipped:campaign_cancelled']).toBe(1);
    expect((await owner.post(`/v1/campaigns/${camp.id}/resume`)).body.error.code).toBe('campaign_state');
    const audit = (await owner.get('/v1/audit-events').expect(200)).body as Array<{ action: string }>;
    expect(audit.map((x) => x.action)).toEqual(expect.arrayContaining(['campaign.created', 'campaign.scheduled', 'campaign.paused', 'campaign.resumed', 'campaign.cancelled']));
  });
});

describe('suppression list', () => {
  it('can be listed, added to and removed from, and is audited', async () => {
    const res = await owner.post('/v1/suppressions', { waNumber: '+966511112222', reason: 'legal', note: 'Regulator request' }).expect(201);
    expect((await owner.get('/v1/suppressions').expect(200)).body.some((s: { id: string }) => s.id === res.body.id)).toBe(true);
    await owner.delete(`/v1/suppressions/${res.body.id}`).expect(204);
    await agent.get('/v1/suppressions').expect(403);
    const audit = (await owner.get('/v1/audit-events').expect(200)).body as Array<{ action: string }>;
    expect(audit.map((x) => x.action)).toEqual(expect.arrayContaining(['suppression.added', 'suppression.removed']));
  });
});

describe('review of slice 4', () => {
  it('S4-1: a campaign message is never retried from the inbox (it would skip the suppression list and the campaign checks)', async () => {
    await resetAudience();
    const a = await customer('Retry Rana', { consent: true });
    await allowMore(1);
    const camp = await createCampaign('Retry check');
    await owner.post(`/v1/campaigns/${camp.id}/schedule`, { at: null }).expect(200);
    await runner().runBatch(tenant, camp.id);
    await owner.post('/v1/suppressions', { waNumber: `+${a.wa}`, reason: 'complaint' }).expect(201);
    await sender().dispatchDue(100);
    const msg = (await messagesOf(camp.id))[0]!;
    expect([msg.status, msg.error_code]).toEqual(['failed', 'suppressed']);
    const convId = (await app((tx) => tx.query<{ conversation_id: string }>('SELECT conversation_id FROM messages WHERE id = $1', [msg.id]))).rows[0]!.conversation_id;
    const conv = (await owner.get(`/v1/conversations/${convId}`).expect(200)).body;
    expect(conv.messages.find((m: { id: string }) => m.id === msg.id).retryBlock).toBe('campaign_message');
    const before = sandbox.sent.length;
    const res = await owner.post(`/v1/messages/${msg.id}/retry`, { seenActivity: conv.activitySeq, clientMessageId: randomUUID() });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('campaign_message');
    await sender().dispatchDue(100);
    expect(sandbox.sent.length).toBe(before);
    await noLimit();
  });

  it('S4-2: with everyone queued but not yet sent, the campaign stays running and can still be cancelled; nothing is sent', async () => {
    await resetAudience();
    await customer('Queued Qais', { consent: true });
    await customer('Queued Huda', { consent: true });
    const camp = await createCampaign('Cancel after queueing');
    await owner.post(`/v1/campaigns/${camp.id}/schedule`, { at: null }).expect(200);
    expect((await runner().runBatch(tenant, camp.id)).status).toBe('running');   // all queued, none sent yet
    expect((await owner.get(`/v1/campaigns/${camp.id}`).expect(200)).body.status).toBe('running');
    await owner.post(`/v1/campaigns/${camp.id}/cancel`).expect(200);
    const before = sandbox.sent.length;
    await sender().dispatchDue(100);
    expect(sandbox.sent.length).toBe(before);
    expect((await messagesOf(camp.id)).map((m) => `${m.status}:${m.error_code}`)).toEqual(['failed:campaign_cancelled', 'failed:campaign_cancelled']);
  });

  it('S4-2: once its messages have left, the campaign completes', async () => {
    await resetAudience();
    await customer('Done Dalia', { consent: true });
    const camp = await createCampaign('Completes');
    await owner.post(`/v1/campaigns/${camp.id}/schedule`, { at: null }).expect(200);
    await runAll(camp.id);
    const view = (await owner.get(`/v1/campaigns/${camp.id}`).expect(200)).body;
    expect(view.status).toBe('completed');
    expect(view.progress.sent).toBe(1);
  });

  it('S4-3: a campaign paused before it started and then resumed still chooses its recipients and sends', async () => {
    await resetAudience();
    await customer('Paused Pari', { consent: true });
    const camp = await createCampaign('Pause before start');
    await owner.post(`/v1/campaigns/${camp.id}/schedule`, { at: new Date(Date.now() + 3_600_000).toISOString() }).expect(200);
    await owner.post(`/v1/campaigns/${camp.id}/pause`).expect(200);
    expect((await owner.post(`/v1/campaigns/${camp.id}/resume`).expect(200)).body.status).toBe('scheduled');
    await app((tx) => tx.query('UPDATE campaigns SET scheduled_at = now() WHERE id = $1', [camp.id]));   // the time arrives
    await runAll(camp.id);
    const view = (await owner.get(`/v1/campaigns/${camp.id}`).expect(200)).body;
    expect(view.status).toBe('completed');
    expect(view.progress.sent).toBe(1);
  });

  it('N1: a campaign waiting for room keeps its lease, so the worker does not pick it again at once; queueing releases it', async () => {
    await resetAudience();
    await customer('Wait Wafa', { consent: true });
    await customer('Wait Waleed', { consent: true });
    await allowMore(1);
    const camp = await createCampaign('Waiting for room');
    await owner.post(`/v1/campaigns/${camp.id}/schedule`, { at: null }).expect(200);
    const leaseLeft = async () => (await app((tx) => tx.query<{ s: number | null }>(
      'SELECT extract(epoch FROM lease_until - now())::int AS s FROM campaigns WHERE id = $1', [camp.id]))).rows[0]!.s;
    expect((await runner().runBatch(tenant, camp.id)).queued).toBe(1);   // progress: lease released
    expect(await leaseLeft()).toBeNull();
    expect((await runner().runBatch(tenant, camp.id)).queued).toBe(0);   // no room: nothing changed
    expect(await leaseLeft()).toBeGreaterThan(20);                       // kept, so not claimable again at once
    const claimed = await withContext(t.deps.db, { tenantId: null, userId: null }, async (tx) =>
      (await tx.query<{ campaign_id: string }>('SELECT * FROM campaign_claim(20, 120)')).rows.map((r) => r.campaign_id));
    expect(claimed).not.toContain(camp.id);
    await owner.post(`/v1/campaigns/${camp.id}/cancel`).expect(200);
    await sender().dispatchDue(100);
    await noLimit();
  });

  it('S4-4: two campaigns batched at the same moment cannot together exceed the daily limit or message one contact twice', async () => {
    await resetAudience();
    await customer('Shared Sami', { consent: true });
    const one = await createCampaign('Concurrent one');
    const two = await createCampaign('Concurrent two');
    await owner.post(`/v1/campaigns/${one.id}/schedule`, { at: null }).expect(200);
    await owner.post(`/v1/campaigns/${two.id}/schedule`, { at: null }).expect(200);
    await allowMore(1);
    await Promise.all([runner().runBatch(tenant, one.id), runner().runBatch(tenant, two.id)]);
    const queued = [...await messagesOf(one.id), ...await messagesOf(two.id)];
    expect(queued).toHaveLength(1);
    for (const c of [one, two]) await owner.post(`/v1/campaigns/${c.id}/cancel`).expect(200);
    await noLimit();
  });
});
