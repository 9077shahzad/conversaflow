/**
 * Message templates (Wave 1): review status by webhook routed to the business account, sending outside the 24-hour
 * window, checks again at send time, marketing consent, recovery sync, and company isolation of template events.
 */
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withContext } from '@conversaflow/database';
import { signBody, TEMPLATE_EVENT_STATUS, type SandboxAdapter } from '../src/modules/channels';
import { Sender } from '../src/modules/sender';
import { checkTemplateBody, renderTemplate } from '../src/modules/templates.service';
import { activateSubscription, addMember, enableMfa, newCompany, newUser, startApp, type Client, type TestApp } from './helpers';

let t: TestApp;
let owner: Client;
let supervisor: Client;
let agent: Client;
let otherOwner: Client;
let sandbox: SandboxAdapter;
let tenant: string;
const NUMBER = `pn${randomUUID().slice(0, 8)}`;
const ACCOUNT = `waba${randomUUID().slice(0, 8)}`;
const OTHER_NUMBER = `pn${randomUUID().slice(0, 8)}`;
const OTHER_ACCOUNT = `waba${randomUUID().slice(0, 8)}`;
let seq = 0;
const nextWaId = () => `9714${String(Date.now()).slice(-6)}${String(++seq).padStart(2, '0')}`;

function post(raw: string) {
  return request(t.app.getHttpServer()).post('/v1/webhooks/sandbox').set('Content-Type', 'application/json')
    .set('X-Hub-Signature-256', signBody(t.deps.keys.sandboxWebhook, raw)).send(raw);
}
const deliver = (value: Record<string, unknown>) => post(JSON.stringify({ object: 'whatsapp_business_account',
  entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: NUMBER }, ...value } }] }] }));
/** Template webhooks name the business account as entry.id and carry no phone number. */
const templateEvent = (account: string, field: string, value: Record<string, unknown>, time = Math.floor(Date.now() / 1000)) =>
  post(JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: account, time, changes: [{ field, value }] }] }));
/** A review decision: the sandbox "provider" changes its own record too, as Meta would, then sends the webhook. */
const review = (account: string, providerTemplateId: string, event: string, reason: string | null = null, time?: number) => {
  const remote = (sandbox.templates.get(account) ?? []).find((x) => x.providerTemplateId === providerTemplateId);
  const status = TEMPLATE_EVENT_STATUS[event];
  if (remote && status) remote.status = status;
  return templateEvent(account, 'message_template_status_update', { event, message_template_id: Number(providerTemplateId), message_template_name: 'x', message_template_language: 'en', reason }, time);
};
const inbound = (from: string, text: string) => ({
  contacts: [{ wa_id: from, profile: { name: 'Customer' } }],
  messages: [{ from, id: `wamid.in.${randomUUID()}`, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }],
});
const app = <T>(fn: Parameters<typeof withContext<T>>[2]) => withContext<T>(t.deps.db, { tenantId: tenant, userId: null }, fn);
async function newConversation(c: Client = agent) {
  const wa = nextWaId();
  await deliver(inbound(wa, 'Hello')).expect(200);
  const items = (await c.get('/v1/conversations?limit=100').expect(200)).body.items as Array<{ id: string }>;
  for (const it of items) {
    const conv = (await c.get(`/v1/conversations/${it.id}`).expect(200)).body;
    if (conv.contact.whatsapp === wa) return { ...conv, wa };
  }
  throw new Error('conversation not found');
}
const getConv = async (id: string, c: Client = agent) => (await c.get(`/v1/conversations/${id}`).expect(200)).body;
const closeWindow = (convId: string) => app((tx) => tx.query(`UPDATE conversations SET last_inbound_at = now() - interval '30 hours' WHERE id = $1`, [convId]));
const sendTpl = (c: Client, conv: { id: string; activitySeq: number }, templateId: string, params: string[]) =>
  c.post(`/v1/conversations/${conv.id}/template`, { templateId, params, seenActivity: conv.activitySeq, clientMessageId: randomUUID() });

async function createTemplate(name: string, category: 'utility' | 'marketing', body = 'Hello {{1}}, your visit is on {{2}}. Reply here with questions.', examples = ['Sara', 'Monday']) {
  const res = await owner.post('/v1/templates', { name, language: 'en', category, bodyText: body, examples }).expect(201);
  expect(res.body).toMatchObject({ status: 'pending', quality: 'unknown', paramCount: examples.length });
  return res.body as { id: string; providerTemplateId: string };
}

beforeAll(async () => {
  t = await startApp();
  sandbox = t.deps.channels.sandbox as SandboxAdapter;
  owner = await newUser(t, 'tpl-owner');
  tenant = await newCompany(owner, 'tpl', 'business');
  await activateSubscription(t, tenant);
  await enableMfa(owner);
  supervisor = await addMember(t, owner, 'tpl-sup', 'supervisor');
  agent = await addMember(t, owner, 'tpl-agent', 'agent');
  await owner.post('/v1/channels', { provider: 'sandbox', providerNumberId: NUMBER, displayPhone: '+971500000001', label: 'UAE', providerAccountId: ACCOUNT }).expect(201);
  otherOwner = await newUser(t, 'tpl-other');
  const other = await newCompany(otherOwner, 'tplother', 'business');
  await activateSubscription(t, other);
  await enableMfa(otherOwner);
  await otherOwner.post('/v1/channels', { provider: 'sandbox', providerNumberId: OTHER_NUMBER, displayPhone: '+971500000002', label: 'Other', providerAccountId: OTHER_ACCOUNT }).expect(201);
});
afterAll(() => t?.close());

describe('template rules', () => {
  it('checks bodies the way Meta review does', () => {
    expect(checkTemplateBody('Hi {{1}}, see you {{2}}.', ['a', 'b'])).toBeNull();
    expect(checkTemplateBody('{{1}} is ready.', ['a'])).toMatch(/start or end/);
    expect(checkTemplateBody('Ready for {{1}}', ['a'])).toMatch(/start or end/);
    expect(checkTemplateBody('Hi {{2}} and {{1}} today', ['a', 'b'])).toMatch(/in order/); // Meta: numbering must run in order
    expect(checkTemplateBody('Hi {{1}} and {{3}} today', ['a', 'b'])).toMatch(/in order/);
    expect(checkTemplateBody('Hi {{1}} today', [])).toMatch(/sample value/);
    expect(checkTemplateBody('Hi {{1} today', [])).toMatch(/form/);
    expect(renderTemplate({ header_text: null, body_text: 'Hi {{1}}, on {{2}}.', footer_text: 'MServe' }, ['Sara', 'Monday'])).toBe('Hi Sara, on Monday.\n\nMServe');
  });

  it('only people with templates.manage can create them; bad bodies are refused before submission', async () => {
    await agent.post('/v1/templates', { name: 'x_agent', language: 'en', category: 'utility', bodyText: 'Hello there', examples: [] }).expect(403);
    const bad = await owner.post('/v1/templates', { name: 'bad_one', language: 'en', category: 'utility', bodyText: '{{1}} hello', examples: ['a'] }).expect(400);
    expect(bad.body.error.message).toMatch(/start or end/);
    await owner.post('/v1/templates', { name: 'Bad Name', language: 'en', category: 'utility', bodyText: 'Hello', examples: [] }).expect(400);
  });
});

describe('review status by webhook', () => {
  it('pending templates cannot be sent; approval arrives by webhook and is applied once', async () => {
    const tpl = await createTemplate('visit_reminder', 'utility');
    const conv = await newConversation();
    await closeWindow(conv.id);
    const fresh = await getConv(conv.id);
    expect((await sendTpl(agent, fresh, tpl.id, ['Sara', 'Monday'])).body.error.code).toBe('template_not_approved');
    const time = Math.floor(Date.now() / 1000);
    const first = await review(ACCOUNT, tpl.providerTemplateId, 'APPROVED', null, time).expect(200);
    expect(first.body).toMatchObject({ applied: 1 });
    const again = await review(ACCOUNT, tpl.providerTemplateId, 'APPROVED', null, time).expect(200);
    expect(again.body).toMatchObject({ duplicate: 1, applied: 0 });
    const list = (await agent.get('/v1/templates').expect(200)).body as Array<{ id: string; status: string; lastEvent: string }>;
    expect(list.find((x) => x.id === tpl.id)).toMatchObject({ status: 'approved', lastEvent: 'APPROVED' });
  });

  it('an approved template is sent outside the window, once, as a template, priced by its category', async () => {
    const tpl = (await agent.get('/v1/templates').expect(200)).body.find((x: { name: string }) => x.name === 'visit_reminder');
    const conv = await newConversation();
    await closeWindow(conv.id);
    const fresh = await getConv(conv.id);
    // A free-form reply is refused, a template is not.
    expect((await agent.post(`/v1/conversations/${conv.id}/reply`, { text: 'hi', seenActivity: fresh.activitySeq, clientMessageId: randomUUID() })).body.error.code).toBe('template_required');
    const before = sandbox.sent.length;
    const res = await sendTpl(agent, fresh, tpl.id, ['Sara', 'Monday 10:00']).expect(201);
    expect(res.body).toMatchObject({ status: 'sent' });
    expect(sandbox.sent.length).toBe(before + 1);
    expect(sandbox.sent.at(-1)!.template).toEqual({ name: 'visit_reminder', language: 'en', params: ['Sara', 'Monday 10:00'] });
    const m = (await getConv(conv.id)).messages.find((x: { id: string }) => x.id === res.body.id);
    expect(m).toMatchObject({ kind: 'template', templateId: tpl.id, pricingCategory: 'utility', body: 'Hello Sara, your visit is on Monday 10:00. Reply here with questions.' });
    // Wrong number of values, or a value with a line break, is refused.
    const f2 = await getConv(conv.id);
    await sendTpl(agent, f2, tpl.id, ['only one']).expect(400);
    await sendTpl(agent, f2, tpl.id, ['Sara', 'Mon\nday']).expect(400);
  });

  it('a template paused after queueing is not sent; the failure is confirmed and says why', async () => {
    const tpl = await createTemplate('pause_check', 'utility');
    await review(ACCOUNT, tpl.providerTemplateId, 'APPROVED').expect(200);
    const conv = await newConversation();
    await closeWindow(conv.id);
    const fresh = await getConv(conv.id);
    const agentMembership = (await agent.get('/v1/me/access').expect(200)).body.membershipId as string;
    // Queue without sending, then Meta pauses the template (quality), then the worker runs.
    const ids = await app(async (tx) => {
      const m = (await tx.query<{ id: string }>(
        `INSERT INTO messages (tenant_id, conversation_id, direction, kind, body, client_message_id, sent_by_membership_id, occurred_at, status, template_id, template_params)
         VALUES ($1, $2, 'out', 'template', 'x', $3, $5, clock_timestamp(), 'queued', $4, '["a","b"]')
         RETURNING id`, [tenant, conv.id, randomUUID(), tpl.id, agentMembership])).rows[0]!;
      await tx.query('INSERT INTO send_jobs (tenant_id, message_id) VALUES ($1, $2)', [tenant, m.id]);
      return m.id;
    });
    void fresh;
    await review(ACCOUNT, tpl.providerTemplateId, 'PAUSED', 'Low quality').expect(200);
    const before = sandbox.sent.length;
    await new Sender(t.deps.db, t.deps.channels).dispatchDue();
    expect(sandbox.sent.length).toBe(before);
    const m = (await getConv(conv.id, supervisor)).messages.find((x: { id: string }) => x.id === ids);
    expect(m).toMatchObject({ status: 'failed', failureKind: 'blocked', errorCode: 'template_not_approved' });
  });

  it('quality and completed category changes apply; an announced change only shows as pending', async () => {
    const tpl = await createTemplate('quality_check', 'utility');
    await templateEvent(ACCOUNT, 'message_template_quality_update', { previous_quality_score: 'GREEN', new_quality_score: 'RED', message_template_id: Number(tpl.providerTemplateId) }).expect(200);
    await templateEvent(ACCOUNT, 'template_category_update', { message_template_id: Number(tpl.providerTemplateId), new_category: 'MARKETING', correct_category: 'MARKETING', category_update_timestamp: 1 }).expect(200);
    let row = (await owner.get('/v1/templates').expect(200)).body.find((x: { id: string }) => x.id === tpl.id);
    expect(row).toMatchObject({ quality: 'red', category: 'utility', lastEvent: 'CATEGORY_CHANGE_PENDING' });
    await templateEvent(ACCOUNT, 'template_category_update', { message_template_id: Number(tpl.providerTemplateId), new_category: 'MARKETING', previous_category: 'UTILITY' }).expect(200);
    row = (await owner.get('/v1/templates').expect(200)).body.find((x: { id: string }) => x.id === tpl.id);
    expect(row).toMatchObject({ category: 'marketing', lastEvent: 'CATEGORY_CHANGED' });
  });

  it('template events for another company\'s account, or an unknown template, change nothing here', async () => {
    const tpl = await createTemplate('isolation_check', 'utility');
    const res = await review(OTHER_ACCOUNT, tpl.providerTemplateId, 'APPROVED').expect(200);
    expect(res.body).toMatchObject({ applied: 0, unknownTemplate: 1 });
    const unrouted = await review('wabaunknown', tpl.providerTemplateId, 'APPROVED').expect(200);
    expect(unrouted.body).toMatchObject({ unrouted: 1 });
    const row = (await owner.get('/v1/templates').expect(200)).body.find((x: { id: string }) => x.id === tpl.id);
    expect(row.status).toBe('pending');
    // The other company cannot see this company's templates.
    expect(((await otherOwner.get('/v1/templates').expect(200)).body as Array<{ id: string }>).some((x) => x.id === tpl.id)).toBe(false);
  });

  it('recovery sync reads the provider\'s current status when a webhook was missed', async () => {
    const tpl = await createTemplate('sync_check', 'utility');
    const remote = sandbox.templates.get(ACCOUNT)!.find((x) => x.providerTemplateId === tpl.providerTemplateId)!;
    remote.status = 'approved'; remote.quality = 'green';
    await agent.post('/v1/templates/sync').expect(403);
    const res = await owner.post('/v1/templates/sync').expect(200);
    expect(res.body.updated).toBeGreaterThanOrEqual(1);
    const row = (await owner.get('/v1/templates').expect(200)).body.find((x: { id: string }) => x.id === tpl.id);
    expect(row).toMatchObject({ status: 'approved', quality: 'green', lastEvent: 'SYNC' });
  });
});

describe('consent', () => {
  it('a marketing template needs recorded marketing consent; STOP withdraws it; an opted-out contact gets nothing', async () => {
    const tpl = await createTemplate('spring_offer', 'marketing', 'Hi {{1}}, our spring AC service offer is open this week.', ['Sara']);
    await review(ACCOUNT, tpl.providerTemplateId, 'APPROVED').expect(200);
    const conv = await newConversation();
    let fresh = await getConv(conv.id);
    expect((await sendTpl(agent, fresh, tpl.id, ['Sara'])).body.error.code).toBe('marketing_consent_required');
    await agent.post(`/v1/contacts/${fresh.contact.id}/marketing-consent`, { granted: true, evidence: 'Customer asked for offers in chat' }).expect(200);
    fresh = await getConv(conv.id);
    expect(fresh.contact.marketingConsentAt).toBeTruthy();
    await sendTpl(agent, fresh, tpl.id, ['Sara']).expect(201);
    // STOP: opted out, and marketing consent withdrawn (START does not restore it).
    await deliver(inbound(conv.wa, 'STOP')).expect(200);
    fresh = await getConv(conv.id);
    expect(fresh.contact).toMatchObject({ optedOut: true, marketingConsentAt: null });
    expect((await sendTpl(agent, fresh, tpl.id, ['Sara'])).body.error.code).toBe('marketing_consent_required');
    const util = (await agent.get('/v1/templates').expect(200)).body.find((x: { name: string }) => x.name === 'visit_reminder');
    expect((await sendTpl(agent, fresh, util.id, ['Sara', 'Monday'])).body.error.code).toBe('contact_opted_out');
    expect((await agent.post(`/v1/contacts/${fresh.contact.id}/marketing-consent`, { granted: true, evidence: 'Asked again on the phone' })).body.error.code).toBe('contact_opted_out');
    await deliver(inbound(conv.wa, 'START')).expect(200);
    expect((await getConv(conv.id)).contact).toMatchObject({ optedOut: false, marketingConsentAt: null });
    const audit = (await owner.get('/v1/audit-events').expect(200)).body as Array<{ action: string }>;
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(['contact.marketing_opt_in', 'template.submitted']));
  });

  it('a failed template can be retried outside the window, and is checked again', async () => {
    const util = (await agent.get('/v1/templates').expect(200)).body.find((x: { name: string }) => x.name === 'visit_reminder');
    const conv = await newConversation();
    await closeWindow(conv.id);
    sandbox.script.push({ reject: '131026' });
    const res = await sendTpl(agent, await getConv(conv.id), util.id, ['Sara', 'Monday']).expect(201);
    expect(res.body).toMatchObject({ status: 'failed', failureKind: 'rejected' });
    const r = await agent.post(`/v1/messages/${res.body.id}/retry`, { seenActivity: (await getConv(conv.id)).activitySeq, clientMessageId: randomUUID() }).expect(201);
    expect(r.body).toMatchObject({ status: 'sent', retryOf: res.body.id });
    expect(sandbox.sent.at(-1)!.template?.name).toBe('visit_reminder');
  });
});
