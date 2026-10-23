/**
 * Customer control centre, first version (BRD v1.2 Wave 2, W2.4, CF-EXT-020, migration 0051).
 * Acceptance items 3 (revoked access stops working) and 9 (customer and company boundaries).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withContext } from '@conversaflow/database';
import { signBody } from '../src/modules/channels';
import { addressKey } from '../src/modules/customer-links';
import { activateSubscription, addMember, enableMfa, newCompany, newUser, startApp, type Client, type TestApp } from './helpers';

let t: TestApp;
let owner: Client;
let agentA: Client;
let agentB: Client;
let analyst: Client;
let otherOwner: Client;
let tenant: string;
const NUMBER = `pn${randomUUID().slice(0, 8)}`;
let seq = 0;
const nextWaId = () => `9667${String(Date.now()).slice(-5)}${String(++seq).padStart(3, '0')}`;

function inbound(from: string, text: string, at = Math.floor(Date.now() / 1000)) {
  const raw = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: NUMBER },
    contacts: [{ wa_id: from, profile: { name: 'Noura Al-Harbi' } }],
    messages: [{ from, id: `wamid.in.${randomUUID()}`, timestamp: String(at), type: 'text', text: { body: text } }] } }] }] });
  return request(t.app.getHttpServer()).post('/v1/webhooks/sandbox').set('Content-Type', 'application/json')
    .set('X-Hub-Signature-256', signBody(t.deps.keys.sandboxWebhook, raw)).send(raw);
}
async function conversationFor(wa: string, as: Client = owner) {
  const id = (await withContext(t.deps.db, { tenantId: tenant, userId: null }, async (tx) => (await tx.query<{ id: string }>(
    `SELECT c.id FROM conversations c JOIN contact_identifiers ci ON ci.contact_id = c.contact_id WHERE ci.value = $1 ORDER BY c.created_at DESC LIMIT 1`, [wa])).rows[0]!.id));
  return (await as.get(`/v1/conversations/${id}`).expect(200)).body;
}
async function newConversation() {
  const wa = nextWaId();
  await inbound(wa, 'Hello').expect(200);
  return { wa, c: await conversationFor(wa) };
}
const tokenOf = (url: string) => url.split('#')[1]!;
const portal = () => request(t.app.getHttpServer());
const get = (token: string | null) => { const r = portal().get('/v1/customer/portal'); return token === null ? r : r.set('X-Customer-Link', token); };
const post = (token: string, path: string, body: unknown) =>
  portal().post(`/v1/customer/${path}`).set('X-Requested-With', 'conversaflow').set('X-Customer-Link', token).send(body as object);
/** Runs a statement as the table owner with row security relaxed on that table (test set-up only). */
async function asOwner(table: string, fn: () => Promise<unknown>) {
  await t.ownerDb.query(`ALTER TABLE ${table} NO FORCE ROW LEVEL SECURITY`);
  try { return await fn(); } finally { await t.ownerDb.query(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`); }
}
const clearLinkLimits = async () => {
  const keys = await t.deps.redis.keys('rl:clink:*');
  if (keys.length) await t.deps.redis.del(...keys);
};

beforeAll(async () => {
  t = await startApp();
  owner = await newUser(t, 'clink-owner');
  tenant = await newCompany(owner, 'clink', 'business');
  await activateSubscription(t, tenant);
  await enableMfa(owner);
  agentA = await addMember(t, owner, 'clink-a', 'agent');
  agentB = await addMember(t, owner, 'clink-b', 'agent');
  analyst = await addMember(t, owner, 'clink-an', 'analyst');
  await owner.post('/v1/channels', { provider: 'sandbox', providerNumberId: NUMBER, displayPhone: '+966500000077', label: 'Links' }).expect(201);
  otherOwner = await newUser(t, 'clink-other');
  await activateSubscription(t, await newCompany(otherOwner, 'clinkother', 'business'));
  await clearLinkLimits();
});
afterAll(async () => { await clearLinkLimits(); await t?.close(); });

describe('issuing links', () => {
  it('a member who can reply creates a link; only its hash is stored and the token is in the fragment', async () => {
    const { c } = await newConversation();
    const link = (await agentA.post(`/v1/conversations/${c.id}/customer-links`, { days: 3, locale: 'ar' }).expect(201)).body;
    expect(link.url).toMatch(/\/ar\/c#[A-Za-z0-9_-]{43}$/);
    expect(new Date(link.expiresAt).getTime() - Date.now()).toBeGreaterThan(2.9 * 86400e3);
    const stored = (await t.ownerDb.query<{ token_hash: Buffer }>('SELECT token_hash FROM customer_links WHERE id = $1', [link.id])).rows[0]!;
    expect(stored.token_hash).toHaveLength(32);
    expect(stored.token_hash.toString('base64url')).not.toBe(tokenOf(link.url));
    const listed = (await agentA.get(`/v1/conversations/${c.id}/customer-links`).expect(200)).body;
    expect(listed[0]).toMatchObject({ id: link.id, state: 'active', uses: 0 });
    expect(JSON.stringify(listed)).not.toContain(tokenOf(link.url));
    // History and audit.
    const conv = (await owner.get(`/v1/conversations/${c.id}`).expect(200)).body;
    expect(JSON.stringify(conv)).toContain('customer_link_issued');
  });

  it('refuses analysts, other companies, conversations assigned to someone else, and more than 30 days', async () => {
    const { c } = await newConversation();
    await analyst.post(`/v1/conversations/${c.id}/customer-links`, {}).expect(403);
    await otherOwner.post(`/v1/conversations/${c.id}/customer-links`, {}).expect(404);
    await agentA.post(`/v1/conversations/${c.id}/customer-links`, { days: 31 }).expect(400);
    const me = (await agentA.get('/v1/me/access').expect(200)).body.membershipId;
    await owner.post(`/v1/conversations/${c.id}/assign`, { membershipId: me, expectedVersion: c.version }).expect(200);
    await agentB.post(`/v1/conversations/${c.id}/customer-links`, {}).expect(404);
    await agentA.post(`/v1/conversations/${c.id}/customer-links`, {}).expect(201);
  });

  it('at most five links in use per customer', async () => {
    const { c } = await newConversation();
    for (let i = 0; i < 5; i++) await agentA.post(`/v1/conversations/${c.id}/customer-links`, {}).expect(201);
    expect((await agentA.post(`/v1/conversations/${c.id}/customer-links`, {})).body.error.code).toBe('too_many_links');
  });

  it('the database refuses lengthening, re-pointing or un-revoking a link', async () => {
    const { c } = await newConversation();
    const link = (await agentA.post(`/v1/conversations/${c.id}/customer-links`, { days: 1 }).expect(201)).body;
    await asOwner('customer_links', async () => {
      await expect(t.ownerDb.query(`UPDATE customer_links SET expires_at = expires_at + interval '1 day' WHERE id = $1`, [link.id])).rejects.toThrow();
      await expect(t.ownerDb.query(`UPDATE customer_links SET token_hash = $2 WHERE id = $1`, [link.id, randomBytes(32)])).rejects.toThrow();
    });
    await agentA.post(`/v1/customer-links/${link.id}/revoke`).expect(200);
    await asOwner('customer_links', () => expect(t.ownerDb.query(`UPDATE customer_links SET revoked_at = NULL, revoke_reason = NULL, revoked_by = NULL WHERE id = $1`, [link.id])).rejects.toThrow());
  });
});

describe('the customer page', () => {
  it('shows status, first name, consent and requests; never message text or team names', async () => {
    const { c } = await newConversation();
    const token = tokenOf((await agentA.post(`/v1/conversations/${c.id}/customer-links`, {}).expect(201)).body.url);
    const v = (await get(token).expect(200)).body;
    expect(v.customer.firstName).toBe('Noura');
    expect(v.consent).toEqual({ messages: 'allowed', marketing: false });
    expect(v.conversations[0]).toMatchObject({ id: c.id, status: 'open' });
    expect(JSON.stringify(v)).not.toContain('Hello');
    expect(JSON.stringify(v)).not.toMatch(/clink-a|@example\.test/);
    const used = (await agentA.get(`/v1/conversations/${c.id}/customer-links`).expect(200)).body[0];
    expect(used.uses).toBe(1);
    expect(used.lastUsedAt).toBeTruthy();
  });

  it('a wrong, malformed, missing, revoked or expired link gets the same answer', async () => {
    const { c } = await newConversation();
    const a = (await agentA.post(`/v1/conversations/${c.id}/customer-links`, {}).expect(201)).body;
    const b = (await agentA.post(`/v1/conversations/${c.id}/customer-links`, { days: 1 }).expect(201)).body;
    await get(tokenOf(a.url)).expect(200);
    await agentA.post(`/v1/customer-links/${a.id}/revoke`).expect(200);
    await asOwner('customer_links', () => t.ownerDb.query(`UPDATE customer_links SET expires_at = created_at + interval '1 second' WHERE id = $1`, [b.id]));
    await new Promise((r) => setTimeout(r, 1100));
    for (const tok of [tokenOf(a.url), tokenOf(b.url), randomBytes(32).toString('base64url'), 'short', null]) {
      const r = await get(tok as string | null).expect(403);
      expect(r.body.error.code).toBe('invalid_link');
    }
    // Revocation also stops changes, not only viewing (acceptance item 3).
    await post(tokenOf(a.url), 'consent', { messages: 'stop' }).expect(403);
    await clearLinkLimits();
  });

  it('revoking all links of a customer stops every one at once', async () => {
    const { c } = await newConversation();
    const toks = [];
    for (let i = 0; i < 3; i++) toks.push(tokenOf((await agentA.post(`/v1/conversations/${c.id}/customer-links`, {}).expect(201)).body.url));
    expect((await agentA.post(`/v1/conversations/${c.id}/customer-links/revoke-all`).expect(200)).body.revoked).toBe(3);
    for (const tok of toks) await get(tok).expect(403);
    await clearLinkLimits();
  });

  it('a suspended company\'s links stop working', async () => {
    const { c } = await newConversation();
    const token = tokenOf((await agentA.post(`/v1/conversations/${c.id}/customer-links`, {}).expect(201)).body.url);
    await get(token).expect(200);
    await asOwner('tenants', () => t.ownerDb.query(`UPDATE tenants SET status = 'suspended' WHERE id = $1`, [tenant]));
    try { await get(token).expect(403); } finally { await asOwner('tenants', () => t.ownerDb.query(`UPDATE tenants SET status = 'active' WHERE id = $1`, [tenant])); }
    await get(token).expect(200);
    await clearLinkLimits();
  });

  it('wrong links are limited per address, but a right link from the same address still works', async () => {
    const { c } = await newConversation();
    const token = tokenOf((await agentA.post(`/v1/conversations/${c.id}/customer-links`, {}).expect(201)).body.url);
    await clearLinkLimits();
    for (let i = 0; i < 20; i++) await get(randomBytes(32).toString('base64url')).expect(403);
    expect((await get(randomBytes(32).toString('base64url')).expect(429)).body.error.code).toBe('rate_limited');
    await get(token).expect(200);
    await clearLinkLimits();
  });

  it('state changes need the usual request header, so another site cannot submit them', async () => {
    const { c } = await newConversation();
    const token = tokenOf((await agentA.post(`/v1/conversations/${c.id}/customer-links`, {}).expect(201)).body.url);
    await portal().post('/v1/customer/consent').set('X-Customer-Link', token).send({ messages: 'stop' }).expect(403);
    await portal().post('/v1/customer/consent').set('X-Requested-With', 'conversaflow').set('Origin', 'https://evil.example')
      .set('X-Customer-Link', token).send({ messages: 'stop' }).expect(403);
  });
});

describe('what the customer can change', () => {
  it('language preference is saved on the contact and shown in the history', async () => {
    const { c } = await newConversation();
    const token = tokenOf((await agentA.post(`/v1/conversations/${c.id}/customer-links`, {}).expect(201)).body.url);
    await post(token, 'preferences', { locale: 'ar' }).expect(200);
    await post(token, 'preferences', { locale: 'fr' }).expect(400);
    expect((await get(token).expect(200)).body.customer.locale).toBe('ar');
  });

  it('stopping messages blocks replies like STOP does; marketing needs messages allowed; evidence names the link', async () => {
    const { c } = await newConversation();
    const link = (await agentA.post(`/v1/conversations/${c.id}/customer-links`, {}).expect(201)).body;
    const token = tokenOf(link.url);
    expect((await post(token, 'consent', { marketing: true }).expect(200)).body).toEqual({ messages: 'allowed', marketing: true });
    expect((await post(token, 'consent', { messages: 'stop' }).expect(200)).body).toEqual({ messages: 'stopped', marketing: false });
    const fresh = (await owner.get(`/v1/conversations/${c.id}`).expect(200)).body;
    const r = await agentA.post(`/v1/conversations/${c.id}/reply`, { text: 'Hi', seenActivity: Number(fresh.activitySeq ?? fresh.activity_seq ?? 0), clientMessageId: randomUUID() });
    expect(r.body.error?.code).toBe('contact_opted_out');
    expect((await post(token, 'consent', { marketing: true })).body.error.code).toBe('messages_stopped');
    expect((await post(token, 'consent', { messages: 'start' }).expect(200)).body).toEqual({ messages: 'allowed', marketing: false });
    const ev = await withContext(t.deps.db, { tenantId: tenant, userId: null }, async (tx) => (await tx.query<{ kind: string; source: string; evidence: string }>(
      `SELECT kind, source, evidence FROM consent_events e JOIN conversations c ON c.contact_id = e.contact_id WHERE c.id = $1 ORDER BY e.created_at`, [c.id])).rows);
    expect(ev.map((e) => e.kind)).toEqual(['marketing_opt_in', 'opt_out', 'opt_in']);
    expect(ev.every((e) => e.source === 'customer_link' && e.evidence === `customer_link:${link.id}`)).toBe(true);
    const audit = (await t.ownerDb.query<{ action: string }>(`SELECT action FROM audit_events WHERE tenant_id = $1 AND metadata->>'linkId' = $2`, [tenant, link.id])).rows;
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(['contact.marketing_opt_in', 'contact.opted_out', 'contact.opted_in']));
  });

  it('an older STOP delivered late cannot undo a newer choice made on the page', async () => {
    const { wa, c } = await newConversation();
    const token = tokenOf((await agentA.post(`/v1/conversations/${c.id}/customer-links`, {}).expect(201)).body.url);
    await post(token, 'consent', { messages: 'start' }).expect(200);
    await inbound(wa, 'STOP', Math.floor(Date.now() / 1000) - 600).expect(200);
    expect((await get(token).expect(200)).body.consent.messages).toBe('allowed');
    // A new STOP after the page choice still works.
    await inbound(wa, 'STOP', Math.floor(Date.now() / 1000) + 2).expect(200);
    expect((await get(token).expect(200)).body.consent.messages).toBe('stopped');
  });

  it('asking for a person or complaining reopens a resolved conversation, stops automations and is handled by the team', async () => {
    const { c } = await newConversation();
    const token = tokenOf((await agentA.post(`/v1/conversations/${c.id}/customer-links`, {}).expect(201)).body.url);
    const now = (await owner.get(`/v1/conversations/${c.id}`).expect(200)).body;
    await owner.post(`/v1/conversations/${c.id}/status`, { status: 'resolved', expectedVersion: now.version }).expect(200);
    await post(token, 'requests', { kind: 'complaint' }).expect(400);
    const req = (await post(token, 'requests', { kind: 'complaint', text: 'The technician did not arrive.' }).expect(201)).body;
    await post(token, 'requests', { kind: 'talk_to_person' }).expect(201);
    expect((await owner.get(`/v1/conversations/${c.id}`).expect(200)).body.status).toBe('open');
    const list = (await agentA.get(`/v1/conversations/${c.id}/customer-requests`).expect(200)).body;
    expect(list.map((r: { kind: string }) => r.kind)).toEqual(['talk_to_person', 'complaint']);
    await analyst.post(`/v1/customer-requests/${req.id}/handled`).expect(403);
    await otherOwner.post(`/v1/customer-requests/${req.id}/handled`).expect(404);
    await agentA.post(`/v1/customer-requests/${req.id}/handled`).expect(200);
    expect((await agentA.post(`/v1/customer-requests/${req.id}/handled`)).body.error.code).toBe('already_handled');
    const v = (await get(token).expect(200)).body;
    expect(v.requests.find((r: { id: string }) => r.id === req.id).handledAt).toBeTruthy();
    expect(JSON.stringify(v.requests)).not.toContain('technician');
  });

  it('at most five requests waiting at once', async () => {
    const { c } = await newConversation();
    const token = tokenOf((await agentA.post(`/v1/conversations/${c.id}/customer-links`, {}).expect(201)).body.url);
    for (let i = 0; i < 5; i++) await post(token, 'requests', { kind: 'talk_to_person' }).expect(201);
    expect((await post(token, 'requests', { kind: 'talk_to_person' })).body.error.code).toBe('too_many_requests');
  });
});

describe('boundaries', () => {
  it('a link only ever reaches its own customer, even with the database lookup called directly', async () => {
    const one = await newConversation();
    const two = await newConversation();
    const t1 = tokenOf((await agentA.post(`/v1/conversations/${one.c.id}/customer-links`, {}).expect(201)).body.url);
    await post(t1, 'consent', { messages: 'stop' }).expect(200);
    expect((await owner.get(`/v1/conversations/${two.c.id}`).expect(200)).body.contact.optedOut ?? false).toBeFalsy();
    const v = (await get(t1).expect(200)).body;
    expect(v.conversations.map((x: { id: string }) => x.id)).toEqual([one.c.id]);
    // The lookup returns nothing for a revoked link and nothing without the exact hash.
    const rows = await withContext(t.deps.db, { tenantId: null, userId: null }, async (tx) =>
      (await tx.query('SELECT * FROM customer_link_route($1)', [randomBytes(32)])).rows);
    expect(rows).toHaveLength(0);
    // The business role cannot see another company's links even by id.
    const theirs = await withContext(t.deps.db, { tenantId: randomUUID(), userId: null }, async (tx) =>
      (await tx.query('SELECT count(*)::int AS n FROM customer_links')).rows[0].n);
    expect(theirs).toBe(0);
  });
});

describe('review of W2.4', () => {
  it('M1: a STOP sent in the same second as a page choice still stops messages', async () => {
    const { wa, c } = await newConversation();
    const token = tokenOf((await agentA.post(`/v1/conversations/${c.id}/customer-links`, {}).expect(201)).body.url);
    await post(token, 'consent', { messages: 'start' }).expect(200);
    await inbound(wa, 'STOP', Math.floor(Date.now() / 1000)).expect(200);
    expect((await get(token).expect(200)).body.consent.messages).toBe('stopped');
  });

  it('M2: a link revoked while a request is under way cannot change anything', async () => {
    const { c } = await newConversation();
    const link = (await agentA.post(`/v1/conversations/${c.id}/customer-links`, {}).expect(201)).body;
    const token = tokenOf(link.url);
    // The team holds the link row (as revoking does) while the customer's change arrives.
    await t.ownerDb.query('ALTER TABLE customer_links NO FORCE ROW LEVEL SECURITY');
    const db = await t.ownerDb.connect();
    try {
      await db.query('BEGIN');
      await db.query(`UPDATE customer_links SET revoked_at = now(), revoked_by = NULL, revoke_reason = 'revoked_by_team' WHERE id = $1`, [link.id]);
      const pending = post(token, 'consent', { messages: 'stop' });
      await new Promise((r) => setTimeout(r, 300));
      await db.query('COMMIT');
      expect((await pending).status).toBe(403);
    } finally { db.release(); await t.ownerDb.query('ALTER TABLE customer_links FORCE ROW LEVEL SECURITY'); }
    const v = await withContext(t.deps.db, { tenantId: tenant, userId: null }, async (tx) =>
      (await tx.query<{ o: Date | null }>('SELECT opted_out_at AS o FROM contacts WHERE id = (SELECT contact_id FROM conversations WHERE id = $1)', [c.id])).rows[0]!.o);
    expect(v).toBeNull();
    await clearLinkLimits();
  });

  it('M3: a page link pasted into a reply is masked when the conversation is read back', async () => {
    const { c } = await newConversation();
    const link = (await agentA.post(`/v1/conversations/${c.id}/customer-links`, {}).expect(201)).body;
    const fresh2 = (await agentA.get(`/v1/conversations/${c.id}`).expect(200)).body;
    await agentA.post(`/v1/conversations/${c.id}/reply`, { text: `Your page: ${link.url}`, seenActivity: Number(fresh2.activitySeq), clientMessageId: randomUUID() }).expect(201);
    const after = (await agentA.get(`/v1/conversations/${c.id}`).expect(200)).body;
    expect(JSON.stringify(after.messages)).not.toContain(tokenOf(link.url));
    expect(JSON.stringify(after.messages)).toContain('/c#••••••');
  });

  it('L1/L6: limits hold when requests or links arrive at the same moment', async () => {
    const { c } = await newConversation();
    const made = await Promise.all(Array.from({ length: 8 }, () => agentA.post(`/v1/conversations/${c.id}/customer-links`, {})));
    expect(made.filter((r) => r.status === 201)).toHaveLength(5);
    const token = tokenOf(made.find((r) => r.status === 201)!.body.url);
    const reqs = await Promise.all(Array.from({ length: 8 }, () => post(token, 'requests', { kind: 'talk_to_person' })));
    expect(reqs.filter((r) => r.status === 201)).toHaveLength(5);
  });

  it('IPv6 addresses are grouped by their /64 for limits', async () => {
    expect(addressKey('2001:db8:1:2:aaaa::1')).toBe(addressKey('2001:db8:1:2:bbbb::9'));
    expect(addressKey('::ffff:10.0.0.1')).toBe('10.0.0.1');
  });
});

