/**
 * Guided setup (BRD v1.2 Wave 2, W2.7, CF-EXT-024): checklist, starter packs, plain description to a draft.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withContext } from '@conversaflow/database';
import { describeToDraft } from '../src/modules/setup';
import { activateSubscription, addMember, enableMfa, newCompany, newUser, startApp, type Client, type TestApp } from './helpers';

let t: TestApp;
let owner: Client;
let agent: Client;
let otherOwner: Client;
let tenant: string;
const app = <T>(fn: Parameters<typeof withContext<T>>[2]) => withContext<T>(t.deps.db, { tenantId: tenant, userId: null }, fn);

beforeAll(async () => {
  t = await startApp();
  owner = await newUser(t, 'setup-owner');
  tenant = await newCompany(owner, 'setup', 'business');
  await activateSubscription(t, tenant);
  await enableMfa(owner);
  agent = await addMember(t, owner, 'setup-agent', 'agent');
  otherOwner = await newUser(t, 'setup-other');
  await activateSubscription(t, await newCompany(otherOwner, 'setupother', 'business'));
});
afterAll(() => t?.close());

describe('plain description to an automation draft', () => {
  const tags = new Map([['vip', 'b3d1d4c6-0000-4000-8000-000000000001']]);
  it('English: outside hours, reply, hand over', () => {
    const r = describeToDraft('When a customer writes outside business hours, reply "We are closed now and will answer in the morning." and hand over to the team.', tags);
    expect(r.notUnderstood).toBe(false);
    expect(r.draft.start).toBe('step-hours');
    expect(r.draft.steps.map((s) => s.kind)).toEqual(['condition', 'send_reply', 'handoff']);
    expect(r.draft.steps[1]).toMatchObject({ text: { en: 'We are closed now and will answer in the morning.' } });
  });
  it('Arabic: a keyword, a reply, a wait and a tag, in the order written', () => {
    const r = describeToDraft('عندما يكتب العميل "الأسعار" رد "أسعارنا في الرابط" ثم انتظر 2 ساعة ثم أضف الوسم "VIP"', tags);
    expect(r.draft.trigger.keywords).toEqual(['الأسعار']);
    expect(r.draft.steps.map((s) => s.kind)).toEqual(['send_reply', 'wait', 'add_tag']);
    expect(r.draft.steps[1]).toMatchObject({ minutes: 120 });
    expect(r.draft.steps[2]).toMatchObject({ tagId: 'b3d1d4c6-0000-4000-8000-000000000001' });
  });
  it('anything it cannot read is reported as not understood, never guessed', () => {
    expect(describeToDraft('Make customers happy please', tags).notUnderstood).toBe(true);
  });
  it('review of W2.7: words between the verb and the keyword; quoted replies are not instructions; unknown tags and zero waits refused', () => {
    expect(describeToDraft('When a customer says the word "menu", reply "Here it is"', tags).draft.trigger.keywords).toEqual(['menu']);
    // A keyword it cannot read is never turned into "every message".
    expect(describeToDraft('When a customer writes "unfinished, reply "x"', tags).notUnderstood).toBe(true);
    const q = describeToDraft('When a customer writes, reply "Please wait 10 minutes, we reply after hours too and hand over to the team later"', tags);
    expect(q.draft.steps.map((s) => s.kind)).toEqual(['send_reply']);
    expect(q.draft.start).not.toBe('step-hours');
    expect(describeToDraft('When a customer writes, add the tag "Unknown"', tags)).toMatchObject({ notUnderstood: true, reason: 'unknown_tag' });
    expect(describeToDraft('When a customer writes, wait 0 minutes and hand over to the team', tags)).toMatchObject({ notUnderstood: true, reason: 'wait' });
    expect(describeToDraft('When a customer writes, then reply "hello"', tags).draft.trigger.keywords).toEqual([]);
  });
});

describe('setup', () => {
  it('the checklist is worked out from the company\'s records and changes as things are done', async () => {
    const c0 = (await owner.get('/v1/setup/checklist').expect(200)).body;
    expect(c0.items).toMatchObject({ channel: false, savedReply: false, automation: false });
    await owner.post('/v1/channels', { provider: 'sandbox', providerNumberId: `pn${randomUUID().slice(0, 8)}`, displayPhone: '+966500000022', label: 'Setup' }).expect(201);
    const c1 = (await owner.get('/v1/setup/checklist').expect(200)).body;
    expect(c1.items.channel).toBe(true);
    expect(c1.done).toBe(c0.done + 1);
  });

  it('a starter pack adds tags, saved replies and unpublished knowledge drafts once, and offers an automation draft', async () => {
    await agent.post('/v1/setup/packs/home_services/apply').expect(403);   // agents may add none of the parts
    // Two clicks at once add nothing twice.
    const [a, a2] = await Promise.all([owner.post('/v1/setup/packs/home_services/apply'), owner.post('/v1/setup/packs/home_services/apply')]);
    expect(a.status).toBe(200); expect(a2.status).toBe(200);
    expect(a.body.tags + a2.body.tags).toBe(4);
    expect(a.body.articles + a2.body.articles).toBe(2);
    const b = (await owner.post('/v1/setup/packs/home_services/apply').expect(200)).body;
    expect(b).toMatchObject({ tags: 0, replies: 0, articles: 0 });
    const audits = (await t.ownerDb.query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_events WHERE tenant_id = $1 AND action = 'tag.created' AND metadata->>'pack' = 'home_services'`, [tenant])).rows[0]!.n;
    expect(audits).toBe(4);
    const auto = (await owner.post('/v1/setup/describe', { name: b.automation.name, description: b.automation.description }).expect(201)).body;
    a.body.automationId = auto.id;
    const published = (await app((tx) => tx.query<{ n: number }>('SELECT count(*)::int AS n FROM knowledge_articles WHERE published'))).rows[0]!.n;
    expect(published).toBe(0);
    const w = (await owner.get(`/v1/automations/${a.body.automationId}`).expect(200)).body;
    expect(w.status).toBe('draft');
    expect(w.draft.steps.map((s: { kind: string }) => s.kind)).toEqual(['condition', 'send_reply', 'handoff']);
    // The rehearsal works on the drafted automation, outside business hours or not.
    await owner.post(`/v1/automations/${a.body.automationId}/rehearse`, { text: 'Hello?' }).expect(201);
    expect((await otherOwner.get('/v1/tags').expect(200)).body).toHaveLength(0);
    await owner.post('/v1/setup/packs/unknown/apply').expect(404);
  });

  it('a description becomes a draft through the API; one that cannot be read is refused with a plain reason', async () => {
    const r = (await owner.post('/v1/setup/describe', { name: 'Menu', description: 'When a customer writes "menu", reply "Here is our menu"' }).expect(201)).body;
    expect(r.understood).toEqual(expect.arrayContaining(['keyword', 'send_reply']));
    expect((await owner.post('/v1/setup/describe', { name: 'Vague', description: 'Be nice to people' }).expect(422)).body.error.code).toBe('not_understood');
  });
});
