/**
 * Automatic assignment of new conversations (BRD v1.2 Wave 1, CF-EXT-002, migration 0039): off by default, round
 * robin, least busy, business hours only, who is eligible, concurrency, and settings permissions and audit.
 */
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withContext } from '@conversaflow/database';
import { signBody } from '../src/modules/channels';
import { activateSubscription, addMember, enableMfa, newCompany, newUser, startApp, type Client, type TestApp } from './helpers';

let t: TestApp;
let owner: Client;
let supervisor: Client;
let agents: Client[];
let ids: string[];
let otherOwner: Client;
let tenant: string;
const NUMBER = `pn${randomUUID().slice(0, 8)}`;
let seq = 0;
const nextWaId = () => `9665${String(Date.now()).slice(-5)}${String(++seq).padStart(3, '0')}`;
const app = <T>(fn: Parameters<typeof withContext<T>>[2]) => withContext<T>(t.deps.db, { tenantId: tenant, userId: null }, fn);

function inboundRaw(from: string, text: string) {
  return JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: NUMBER },
    contacts: [{ wa_id: from, profile: { name: 'Customer' } }],
    messages: [{ from, id: `wamid.in.${randomUUID()}`, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }] } }] }] });
}
const post = (raw: string) => request(t.app.getHttpServer()).post('/v1/webhooks/sandbox').set('Content-Type', 'application/json')
  .set('X-Hub-Signature-256', signBody(t.deps.keys.sandboxWebhook, raw)).send(raw);
/** A customer writes for the first time; returns who the new conversation went to (null = nobody). */
async function newCustomer(): Promise<{ wa: string; assigned: string | null; conversationId: string }> {
  const wa = nextWaId();
  await post(inboundRaw(wa, 'Hello')).expect(200);
  const row = (await app((tx) => tx.query<{ id: string; assigned: string | null }>(
    `SELECT c.id, c.assigned_membership_id AS assigned FROM conversations c JOIN contact_identifiers ci ON ci.contact_id = c.contact_id WHERE ci.value = $1`, [wa]))).rows[0]!;
  return { wa, assigned: row.assigned, conversationId: row.id };
}
const configure = (mode: string, memberIds: string[], hoursOnly = false) => supervisor.put('/v1/inbox/assignment', { mode, hoursOnly, memberIds });
/** Resolves every open conversation, so each test starts with nobody busy. */
const clearLoad = () => app((tx) => tx.query(`UPDATE conversations SET status = 'resolved' WHERE status <> 'resolved'`));

beforeAll(async () => {
  t = await startApp();
  owner = await newUser(t, 'aa-owner');
  tenant = await newCompany(owner, 'aa', 'business');
  await activateSubscription(t, tenant);
  await enableMfa(owner);
  supervisor = await addMember(t, owner, 'aa-sup', 'supervisor');
  agents = [await addMember(t, owner, 'aa-a', 'agent'), await addMember(t, owner, 'aa-b', 'agent'), await addMember(t, owner, 'aa-c', 'agent')];
  ids = [];
  for (const a of agents) ids.push((await a.get('/v1/me/access').expect(200)).body.membershipId);
  await owner.post('/v1/channels', { provider: 'sandbox', providerNumberId: NUMBER, displayPhone: '+966500000033', label: 'Assign' }).expect(201);
  await owner.patch('/v1/settings', {}).expect(200);
  otherOwner = await newUser(t, 'aa-other');
  await activateSubscription(t, await newCompany(otherOwner, 'aaother', 'business'));
});
afterAll(() => t?.close());
beforeEach(async () => { await clearLoad(); await owner.patch('/v1/settings', { businessHours: {} }).expect(200); });

describe('settings', () => {
  it('is off by default; only people who can assign may change it; members must be active in this company; changes are audited', async () => {
    expect((await supervisor.get('/v1/inbox/assignment').expect(200)).body).toMatchObject({ mode: 'off', hoursOnly: false });
    expect((await newCustomer()).assigned).toBeNull();
    await agents[0]!.put('/v1/inbox/assignment', { mode: 'round_robin', memberIds: [ids[0]] }).expect(403);
    await agents[0]!.get('/v1/inbox/assignment').expect(403);
    await configure('round_robin', []).expect(400);                       // on, but nobody to receive conversations
    const foreign = (await otherOwner.get('/v1/me/access').expect(200)).body.membershipId;
    await configure('round_robin', [ids[0]!, foreign]).expect(400);       // a member of another company
    const s = (await configure('round_robin', ids).expect(200)).body;
    expect(s.mode).toBe('round_robin');
    expect(s.members.filter((m: { onList: boolean }) => m.onList).map((m: { id: string }) => m.id).sort()).toEqual([...ids].sort());
    await configure('off', ids).expect(200);
    const audit = (await owner.get('/v1/audit-events').expect(200)).body as Array<{ action: string }>;
    expect(audit.map((a) => a.action)).toContain('assignment.updated');
    // Another company's settings are separate.
    expect((await otherOwner.get('/v1/inbox/assignment').expect(200)).body.mode).toBe('off');
  });
});

describe('round robin', () => {
  it('hands new conversations out strictly in turn, wrapping round, and records it in the conversation history', async () => {
    await configure('round_robin', ids).expect(200);
    const got: string[] = [];
    for (let i = 0; i < 6; i++) got.push((await newCustomer()).assigned!);
    // The same rotation twice over, every member once per round.
    expect(new Set(got.slice(0, 3))).toEqual(new Set(ids));
    expect(got.slice(3)).toEqual(got.slice(0, 3));
    const one = await newCustomer();
    const detail = (await owner.get(`/v1/conversations/${one.conversationId}`).expect(200)).body;
    expect(detail.events.find((e: { kind: string }) => e.kind === 'auto_assigned')).toMatchObject({ data: { membershipId: one.assigned, mode: 'round_robin' } });
    expect(detail.people[one.assigned!]).toBeTruthy();
  });

  it('a later message in an existing conversation is never reassigned', async () => {
    await configure('round_robin', ids).expect(200);
    const c = await newCustomer();
    await post(inboundRaw(c.wa, 'Any update?')).expect(200);
    await post(inboundRaw(c.wa, 'Hello again')).expect(200);
    const now = (await app((tx) => tx.query<{ a: string }>('SELECT assigned_membership_id AS a FROM conversations WHERE id = $1', [c.conversationId]))).rows[0]!.a;
    expect(now).toBe(c.assigned);
  });

  it('several first messages arriving at once are still handed out one each, in turn', async () => {
    await configure('round_robin', ids).expect(200);
    const was = Array.from({ length: 6 }, () => nextWaId());
    await Promise.all(was.map((wa) => post(inboundRaw(wa, 'Hi')).expect(200)));
    const rows = (await app((tx) => tx.query<{ a: string }>(
      `SELECT c.assigned_membership_id AS a FROM conversations c JOIN contact_identifiers ci ON ci.contact_id = c.contact_id WHERE ci.value = ANY($1)`, [was]))).rows;
    const counts = ids.map((id) => rows.filter((r) => r.a === id).length);
    expect(counts).toEqual([2, 2, 2]);
  });
});

describe('first replies and busy deliveries', () => {
  it('a conversation we started (for example by a campaign) is assigned when the customer first replies', async () => {
    await configure('round_robin', ids).expect(200);
    const wa = nextWaId();
    const owned = (await owner.get('/v1/me/access').expect(200)).body.membershipId;
    const convId = await app(async (tx) => {
      const contact = (await tx.query<{ id: string }>('INSERT INTO contacts (tenant_id, display_name) VALUES ($1, $2) RETURNING id', [tenant, 'Campaign customer'])).rows[0]!.id;
      await tx.query(`INSERT INTO contact_identifiers (tenant_id, contact_id, kind, value) VALUES ($1, $2, 'whatsapp', $3)`, [tenant, contact, wa]);
      const conn = (await tx.query<{ id: string }>('SELECT id FROM channel_connections WHERE provider_number_id = $1', [NUMBER])).rows[0]!.id;
      return (await tx.query<{ id: string }>('INSERT INTO conversations (tenant_id, contact_id, connection_id) VALUES ($1, $2, $3) RETURNING id', [tenant, contact, conn])).rows[0]!.id;
    });
    expect(owned).toBeTruthy();
    await post(inboundRaw(wa, 'Yes, please book me')).expect(200);
    const a = (await app((tx) => tx.query<{ a: string | null }>('SELECT assigned_membership_id AS a FROM conversations WHERE id = $1', [convId]))).rows[0]!.a;
    expect(ids).toContain(a);
  });

  it('two deliveries carrying the same new customers in opposite orders both complete (no deadlock), one conversation each', async () => {
    await configure('round_robin', ids).expect(200);
    const x = nextWaId(); const y = nextWaId();
    const bundle = (order: string[]) => JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: {
      metadata: { phone_number_id: NUMBER },
      contacts: order.map((wa) => ({ wa_id: wa, profile: { name: 'Customer' } })),
      messages: order.map((wa, i) => ({ from: wa, id: `wamid.in.${randomUUID()}`, timestamp: String(Math.floor(Date.now() / 1000) + i), type: 'text', text: { body: 'Hi' } })) } }] }] });
    const results = await Promise.all([post(bundle([x, y])), post(bundle([y, x])), post(bundle([x, y])), post(bundle([y, x]))]);
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    const rows = (await app((tx) => tx.query<{ value: string; n: number; assigned: number }>(
      `SELECT ci.value, count(c.id)::int AS n, count(c.assigned_membership_id)::int AS assigned
       FROM contact_identifiers ci JOIN conversations c ON c.contact_id = ci.contact_id WHERE ci.value = ANY($1) GROUP BY ci.value ORDER BY ci.value`, [[x, y]]))).rows;
    expect(rows.map((r) => [r.n, r.assigned])).toEqual([[1, 1], [1, 1]]);
  });
});

describe('least busy', () => {
  it('gives the conversation to whoever has the fewest open conversations; equally busy members take turns', async () => {
    await configure('least_busy', ids).expect(200);
    // Agent A already has two open conversations, agent B one, agent C none.
    for (const [i, n] of [[0, 2], [1, 1]] as const) {
      for (let k = 0; k < n; k++) {
        const c = await newCustomer();
        await app((tx) => tx.query('UPDATE conversations SET assigned_membership_id = $2 WHERE id = $1', [c.conversationId, ids[i]]));
      }
    }
    await app((tx) => tx.query(`UPDATE conversations SET assigned_membership_id = NULL WHERE assigned_membership_id = $1`, [ids[2]]));
    const first = await newCustomer();
    expect(first.assigned).toBe(ids[2]);                                  // C had none
    const second = await newCustomer();
    expect([ids[1], ids[2]]).toContain(second.assigned);                  // B and C now have one each
    const third = await newCustomer();
    expect(third.assigned).not.toBe(ids[0]);
    expect(new Set([second.assigned, third.assigned])).toEqual(new Set([ids[1], ids[2]]));
  });
});

describe('who can receive conversations', () => {
  it('skips members who are not on the list, who have left, or whose role can no longer reply', async () => {
    await configure('round_robin', ids).expect(200);
    await owner.put(`/v1/members/${ids[1]}/roles`, { roleKeys: ['analyst'] }).expect(204);   // can no longer reply
    await owner.delete(`/v1/members/${ids[2]}`).expect(204);                                  // left the company
    const got = new Set<string | null>();
    for (let i = 0; i < 4; i++) got.add((await newCustomer()).assigned);
    expect(got).toEqual(new Set([ids[0]]));
    await owner.put(`/v1/members/${ids[1]}/roles`, { roleKeys: ['agent'] }).expect(204);
  });

  it('with nobody eligible, the conversation simply stays unassigned', async () => {
    await configure('round_robin', [ids[2]!]).expect(400);                // removed in the previous test: not active
    await app((tx) => tx.query('DELETE FROM assignment_members WHERE membership_id <> $1', [ids[1]]));
    await owner.put(`/v1/members/${ids[1]}/roles`, { roleKeys: ['analyst'] }).expect(204);
    expect((await newCustomer()).assigned).toBeNull();
    await owner.put(`/v1/members/${ids[1]}/roles`, { roleKeys: ['agent'] }).expect(204);
  });
});

describe('business hours only', () => {
  it('assigns during business hours and leaves new conversations unassigned outside them', async () => {
    const tz = (await app((tx) => tx.query<{ tz: string }>('SELECT timezone AS tz FROM tenants WHERE id = $1', [tenant]))).rows[0]!.tz;
    const dayKeys = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
    const todayShort = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(new Date()).toLowerCase().slice(0, 3);
    const today = dayKeys.indexOf(todayShort);
    const tomorrow = dayKeys[(today + 1) % 7]!;
    await configure('round_robin', [ids[0]!], true).expect(200);
    await owner.patch('/v1/settings', { businessHours: { [tomorrow]: [['00:00', '23:59']] } }).expect(200);   // closed today
    expect((await newCustomer()).assigned).toBeNull();
    await owner.patch('/v1/settings', { businessHours: { [dayKeys[today]!]: [['00:00', '23:59']] } }).expect(200);   // open today
    const now = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());
    if (now < '23:59') expect((await newCustomer()).assigned).toBe(ids[0]);
    // With hours-only off, the closed day makes no difference.
    await owner.patch('/v1/settings', { businessHours: { [tomorrow]: [['00:00', '23:59']] } }).expect(200);
    await configure('round_robin', [ids[0]!], false).expect(200);
    expect((await newCustomer()).assigned).toBe(ids[0]);
  });
});
