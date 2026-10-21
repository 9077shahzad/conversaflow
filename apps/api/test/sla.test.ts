/**
 * Response-time targets (SLA timers, Wave 1): business-hours arithmetic, and timers started by customer messages and
 * stopped only by replies the provider accepted.
 */
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withContext } from '@conversaflow/database';
import { signBody, type SandboxAdapter } from '../src/modules/channels';
import { addBusinessMinutes, type BusinessHours } from '../src/modules/sla';
import { activateSubscription, addMember, enableMfa, newCompany, newUser, startApp, type Client, type TestApp } from './helpers';

// Saudi working week: Sunday to Thursday, 08:00–17:00 with a break, Friday and Saturday off.
const KSA: BusinessHours = {
  sun: [['08:00', '12:00'], ['13:00', '17:00']], mon: [['08:00', '12:00'], ['13:00', '17:00']], tue: [['08:00', '12:00'], ['13:00', '17:00']],
  wed: [['08:00', '12:00'], ['13:00', '17:00']], thu: [['08:00', '12:00'], ['13:00', '17:00']],
};
const none = new Set<string>();

describe('business-hours arithmetic', () => {
  it('counts only working time in the company time zone', () => {
    // Monday 19 Oct 2026, 10:30 Riyadh (07:30 UTC) + 60 min → 11:30 Riyadh.
    expect(addBusinessMinutes(new Date('2026-10-19T07:30:00Z'), 60, KSA, 'Asia/Riyadh', none)!.toISOString()).toBe('2026-10-19T08:30:00.000Z');
    // Across the lunch break: 11:30 + 60 → 13:30.
    expect(addBusinessMinutes(new Date('2026-10-19T08:30:00Z'), 60, KSA, 'Asia/Riyadh', none)!.toISOString()).toBe('2026-10-19T10:30:00.000Z');
    // Thursday 16:30 + 60 → 30 min Thursday, then Sunday 08:30 (Friday and Saturday are off).
    expect(addBusinessMinutes(new Date('2026-10-22T13:30:00Z'), 60, KSA, 'Asia/Riyadh', none)!.toISOString()).toBe('2026-10-25T05:30:00.000Z');
    // A message at night waits for the morning.
    expect(addBusinessMinutes(new Date('2026-10-19T20:00:00Z'), 30, KSA, 'Asia/Riyadh', none)!.toISOString()).toBe('2026-10-20T05:30:00.000Z');
  });

  it('skips holidays, and uses calendar time when no hours are set', () => {
    const holidays = new Set(['2026-10-20']);
    expect(addBusinessMinutes(new Date('2026-10-19T13:30:00Z'), 60, KSA, 'Asia/Riyadh', holidays)!.toISOString()).toBe('2026-10-21T05:30:00.000Z');
    expect(addBusinessMinutes(new Date('2026-10-19T13:30:00Z'), 90, {}, 'Asia/Riyadh', none)!.toISOString()).toBe('2026-10-19T15:00:00.000Z');
  });

  it('handles a daylight-saving change (Riga, 25 Oct 2026)', () => {
    const riga: BusinessHours = { fri: [['09:00', '18:00']], mon: [['09:00', '18:00']] };
    // Friday 23 Oct 17:30 EEST (14:30 UTC) + 60 min → 30 min Friday, then Monday 26 Oct 09:30 EET (07:30 UTC).
    expect(addBusinessMinutes(new Date('2026-10-23T14:30:00Z'), 60, riga, 'Europe/Riga', none)!.toISOString()).toBe('2026-10-26T07:30:00.000Z');
  });
});

let t: TestApp;
let owner: Client;
let agent: Client;
let sandbox: SandboxAdapter;
let tenant: string;
const NUMBER = `pn${randomUUID().slice(0, 8)}`;
let seq = 0;
const nextWaId = () => `9665${String(Date.now()).slice(-5)}${String(++seq).padStart(3, '0')}`;
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
const reply = async (id: string, text = 'On it') => agent.post(`/v1/conversations/${id}/reply`,
  { text, seenActivity: (await getConv(id)).activitySeq, clientMessageId: randomUUID() });

beforeAll(async () => {
  t = await startApp();
  sandbox = t.deps.channels.sandbox as SandboxAdapter;
  owner = await newUser(t, 'sla-owner');
  tenant = await newCompany(owner, 'sla', 'business');
  await activateSubscription(t, tenant);
  await enableMfa(owner);
  agent = await addMember(t, owner, 'sla-agent', 'agent');
  await owner.post('/v1/channels', { provider: 'sandbox', providerNumberId: NUMBER, displayPhone: '+966500000009', label: 'KSA' }).expect(201);
  // Calendar-time targets (no business hours), so the test does not depend on the time of day it runs.
  await owner.patch('/v1/settings', { slaFirstResponseMinutes: 30, slaNextResponseMinutes: 60, businessHours: {} }).expect(200);
});
afterAll(() => t?.close());

describe('timers in conversations', () => {
  it('a new conversation gets a first-response timer; a sent reply meets it; the next message starts a next-response timer', async () => {
    const conv = await newConversation();
    expect(conv.sla).toMatchObject({ kind: 'first_response' });
    const due = new Date(conv.sla.dueAt).getTime() - new Date(conv.sla.startedAt).getTime();
    expect(due).toBe(30 * 60_000);
    const list = (await agent.get('/v1/conversations?limit=100').expect(200)).body.items;
    expect(list.find((c: { id: string }) => c.id === conv.id)).toMatchObject({ slaKind: 'first_response' });
    // A second customer message does not restart the clock.
    await deliver(inbound(conv.wa, 'Anyone there?')).expect(200);
    expect((await getConv(conv.id)).sla.dueAt).toBe(conv.sla.dueAt);
    expect((await reply(conv.id)).status).toBe(201);
    let now = await getConv(conv.id);
    expect(now.sla).toBeNull();
    expect(now.firstResponseAt).toBeTruthy();
    expect(now.events.find((e: { kind: string }) => e.kind === 'sla_met').data).toMatchObject({ target: 'first_response', minutesLate: 0 });
    await deliver(inbound(conv.wa, 'One more question')).expect(200);
    now = await getConv(conv.id);
    expect(now.sla).toMatchObject({ kind: 'next_response' });
    expect(new Date(now.sla.dueAt).getTime() - new Date(now.sla.startedAt).getTime()).toBe(60 * 60_000);
  });

  it('a late answer records a missed target with how late it was', async () => {
    const conv = await newConversation();
    await app((tx) => tx.query(`UPDATE conversations SET sla_started_at = now() - interval '2 hours', sla_due_at = now() - interval '90 minutes' WHERE id = $1`, [conv.id]));
    expect((await reply(conv.id)).status).toBe(201);
    const ev = (await getConv(conv.id)).events.find((e: { kind: string }) => e.kind === 'sla_missed');
    expect(ev.data.target).toBe('first_response');
    expect(ev.data.minutesLate).toBeGreaterThanOrEqual(90);
  });

  it('a reply that was blocked or failed is not an answer; an uncertain one counts once the provider confirms it', async () => {
    const conv = await newConversation();
    sandbox.script.push({ reject: '131026' });
    expect((await reply(conv.id, 'Refused')).status).toBe(201);
    expect((await getConv(conv.id)).sla).toMatchObject({ kind: 'first_response' });
    sandbox.script.push({ acceptedButLost: 'connection_reset' });
    const r = await reply(conv.id, 'Maybe');
    expect(r.body.status).toBe('uncertain');
    expect((await getConv(conv.id)).sla).not.toBeNull();
    const raw = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: {
      metadata: { phone_number_id: NUMBER },
      statuses: [{ id: sandbox.sent.at(-1)!.providerMessageId, status: 'delivered', timestamp: String(Math.floor(Date.now() / 1000)), recipient_id: '1', biz_opaque_callback_data: r.body.id }],
    } }] }] });
    await request(t.app.getHttpServer()).post('/v1/webhooks/sandbox').set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', signBody(t.deps.keys.sandboxWebhook, raw)).send(raw).expect(200);
    const after = await getConv(conv.id);
    expect(after.sla).toBeNull();
    expect(after.events.map((e: { kind: string }) => e.kind)).toContain('sla_met');
  });

  it('with no target set, no timer runs', async () => {
    await owner.patch('/v1/settings', { slaFirstResponseMinutes: null, slaNextResponseMinutes: null }).expect(200);
    const conv = await newConversation();
    expect(conv.sla).toBeNull();
    await owner.patch('/v1/settings', { slaFirstResponseMinutes: 30, slaNextResponseMinutes: 60 }).expect(200);
  });
});
