/**
 * Company and platform dashboards (owner request of 30 Oct 2026). Sandbox WhatsApp; no money moves.
 */
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withContext } from '@conversaflow/database';
import { signBody } from '../src/modules/channels';
import { countryOf } from '../src/modules/dashboard';
import { activateSubscription, addMember, enableMfa, newCompany, newStaff, newUser, startApp, type Client, type TestApp } from './helpers';

let t: TestApp;
let owner: Client;
let agent: Client;
let analyst: Client;
let staff: Client;
let otherOwner: Client;
let tenant: string;
const NUMBER = `pn${randomUUID().slice(0, 8)}`;
let seq = 0;
const base = Math.floor(Math.random() * 5_000_000);
const saudi = () => `96650${String(base + ++seq).padStart(7, '0')}`;
const emirati = () => `97150${String(base + ++seq).padStart(7, '0')}`;
const app = <T>(fn: Parameters<typeof withContext<T>>[2]) => withContext<T>(t.deps.db, { tenantId: tenant, userId: null }, fn);
function say(from: string, text: string) {
  const raw = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: NUMBER },
    contacts: [{ wa_id: from, profile: { name: 'Dashboard Customer' } }],
    messages: [{ from, id: `wamid.in.${randomUUID()}`, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }] } }] }] });
  return request(t.app.getHttpServer()).post('/v1/webhooks/sandbox').set('Content-Type', 'application/json').set('X-Hub-Signature-256', signBody(t.deps.keys.sandboxWebhook, raw)).send(raw);
}
const conv = async (wa: string) => (await app((tx) => tx.query<{ id: string; version: number; activity_seq: string }>(
  `SELECT c.id, c.version, c.activity_seq FROM conversations c JOIN contact_identifiers ci ON ci.contact_id = c.contact_id WHERE ci.value = $1 ORDER BY c.created_at DESC LIMIT 1`, [wa]))).rows[0]!;
const day = (offset: number) => new Date(Date.now() + offset * 86400_000).toISOString().slice(0, 10);
const period = `from=${day(-2)}&to=${day(2)}`;
const dash = async (c: Client = owner, qs = period) => (await c.get(`/v1/reports/dashboard?${qs}`).expect(200)).body;

beforeAll(async () => {
  t = await startApp();
  owner = await newUser(t, 'dash-owner');
  tenant = await newCompany(owner, 'dash', 'business');
  await activateSubscription(t, tenant);
  await enableMfa(owner);
  agent = await addMember(t, owner, 'dash-agent', 'agent');
  analyst = await addMember(t, owner, 'dash-an', 'analyst');
  await owner.post('/v1/channels', { provider: 'sandbox', providerNumberId: NUMBER, displayPhone: '+966500000044', label: 'Dashboard' }).expect(201);
  otherOwner = await newUser(t, 'dash-other');
  await activateSubscription(t, await newCompany(otherOwner, 'dashother', 'business'));
  staff = await newStaff(t, 'dash-staff', 'platform_owner');
});
afterAll(() => t?.close());

describe('company dashboard', () => {
  it('counts volumes, delivery, replies, people and activity by destination; labels sandbox data; compares with the period before', async () => {
    const before = await dash();
    const a = saudi(); const b = emirati();
    await say(a, 'Hello').expect(200);
    await say(b, 'مرحبا').expect(200);
    const ca = await conv(a);
    await owner.post(`/v1/conversations/${ca.id}/reply`, { text: 'Welcome', seenActivity: Number(ca.activity_seq), clientMessageId: randomUUID() }).expect(201);
    const r = await dash();
    expect(r.dataSource).toBe('sandbox');
    expect(r.totals.inbound - before.totals.inbound).toBe(2);
    expect(r.totals.outbound - before.totals.outbound).toBe(1);
    expect(r.totals.conversationsStarted - before.totals.conversationsStarted).toBe(2);
    expect(r.totals.conversationsReplied - before.totals.conversationsReplied).toBe(1);
    expect(r.previous.period.to < r.period.from).toBe(true);
    expect(r.daily).toHaveLength(r.period.days);
    expect(r.responseBuckets.map((x: { bucket: string }) => x.bucket)).toEqual(['lt5m', 'lt15m', 'lt1h', 'lt4h', 'gte4h', 'none']);
    expect(r.agents.length).toBeGreaterThanOrEqual(1);
    expect(r.agents[0].name).toBeTruthy();                                       // the owner may see team names
    const countries = r.activity.map((x: { country: string }) => x.country);
    expect(countries).toEqual(expect.arrayContaining(['SA', 'AE']));
    expect(r.activity[0].channel).toBe(r.channels[0].id);
    expect(r.credits.state).toBe('direct');                                    // pays Meta directly: no credit figures
    expect(r.unavailable).toContain('whatsapp_cost_direct');
    // No customer names, numbers or message text anywhere in the dashboard.
    const json = JSON.stringify(r);
    expect(json).not.toContain('Dashboard Customer');
    expect(json).not.toContain(a);
    expect(json).not.toContain('Welcome');
  });

  it('permissions: an agent cannot open it; an analyst sees no billing and no names without members.read; another company sees none of it', async () => {
    await agent.get(`/v1/reports/dashboard?${period}`).expect(403);
    await agent.get(`/v1/reports/dashboard/records?${period}`).expect(403);
    const an = await dash(analyst);
    expect(an.credits.state).toBe('no_permission');
    const other = await dash(otherOwner);
    expect(other.totals.inbound).toBe(0);
    expect(other.activity).toEqual([]);
    await owner.get('/v1/reports/dashboard?from=2020-01-01&to=2026-01-01').expect(400);
    await owner.get('/v1/reports/dashboard?from=bad').expect(400);
  });

  it('drill-down lists the messages behind a figure (metadata only), filtered by day, direction, country and number; visibility as in the inbox', async () => {
    const r = await dash();
    const rec = (await owner.get(`/v1/reports/dashboard/records?${period}&direction=in&country=AE`).expect(200)).body;
    expect(rec.records.length).toBeGreaterThanOrEqual(1);
    expect(rec.records.every((x: { direction: string; country: string }) => x.direction === 'in' && x.country === 'AE')).toBe(true);
    expect(Object.keys(rec.records[0]).sort()).toEqual(['at', 'category', 'channelId', 'channelLabel', 'conversationId', 'country', 'direction', 'failure', 'id', 'kind', 'sender', 'status']);
    expect(JSON.stringify(rec)).not.toContain('مرحبا');
    const byChannel = (await owner.get(`/v1/reports/dashboard/records?${period}&channel=${r.channels[0].id}&limit=1`).expect(200)).body;
    expect(byChannel.records).toHaveLength(1);
    expect(byChannel.next).toBeTruthy();
    // The analyst cannot see all conversations: a conversation assigned to someone else is left out and counted.
    const wa = saudi();
    await say(wa, 'Assigned elsewhere').expect(200);
    const c = await conv(wa);
    const members = (await owner.get('/v1/members').expect(200)).body as Array<{ id: string; email: string }>;
    const agentMember = members.find((m) => m.email.includes('dash-agent'))!;
    await owner.post(`/v1/conversations/${c.id}/assign`, { membershipId: agentMember.id, expectedVersion: c.version }).expect(200);
    const asAnalyst = (await analyst.get(`/v1/reports/dashboard/records?${period}&direction=in&limit=100`).expect(200)).body;
    expect(asAnalyst.records.some((x: { conversationId: string }) => x.conversationId === c.id)).toBe(false);
    expect(asAnalyst.hiddenOutsideYourConversations).toBeGreaterThanOrEqual(1);
    const asOwner = (await owner.get(`/v1/reports/dashboard/records?${period}&direction=in&limit=100`).expect(200)).body;
    expect(asOwner.records.some((x: { conversationId: string }) => x.conversationId === c.id)).toBe(true);
    expect(asOwner.hiddenOutsideYourConversations).toBe(0);
  });

  it('maps numbers to destination countries by the longest calling code', () => {
    expect(countryOf('966501234567')).toBe('SA');
    expect(countryOf('971501234567')).toBe('AE');
    expect(countryOf('201001234567')).toBe('EG');
    expect(countryOf('14155550123')).toBe('US');
    expect(countryOf('8613800000000')).toBe('ZZ');
    expect(countryOf(null)).toBe('ZZ');
  });
});

describe('platform owner dashboard', () => {
  it('platform owners see companies, subscription value, messaging figures, partner funding and alerts; nobody else does', async () => {
    expect((await staff.get('/v1/platform/me').expect(200)).body.role).toBe('platform_owner');
    expect((await owner.get('/v1/platform/me').expect(200)).body.role).toBeNull();
    const d = (await staff.get(`/v1/platform/dashboard?${period}`).expect(200)).body;
    expect(d.period).toMatchObject({ timeZone: 'UTC' });
    expect(d.companies.total).toBeGreaterThanOrEqual(2);
    expect(Array.isArray(d.subscriptionValue)).toBe(true);
    expect(Array.isArray(d.messaging)).toBe(true);
    expect(Array.isArray(d.customerPayments)).toBe(true);
    expect(Array.isArray(d.alerts)).toBe(true);
    expect(d.partner).toMatchObject({ partner: '360dialog' });
    expect(typeof d.unmatchedPayments).toBe('number');
    await owner.get(`/v1/platform/dashboard?${period}`).expect(403);
    await staff.get('/v1/platform/dashboard?from=2020-01-01&to=2026-01-01').expect(409);
  });
});
