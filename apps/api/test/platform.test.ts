/**
 * Platform owner console and support access (M1.6b): metadata without content; content only with an approved,
 * unexpired, two-person support grant; every support read visible in the company's own audit trail.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withContext } from '@conversaflow/database';
import { enableMfa, newCompany, newStaff, newUser, startApp, type Client, type TestApp } from './helpers';

let t: TestApp;
let lead: Client; // platform owner
let second: Client; // second platform owner (approver)
let support: Client; // support agent
let customer: Client;
let tenantA: string;
let tenantB: string;

beforeAll(async () => {
  t = await startApp();
  lead = await newStaff(t, 'lead', 'platform_owner');
  second = await newStaff(t, 'second', 'platform_owner');
  support = await newStaff(t, 'support', 'support_agent');
  customer = await newUser(t, 'customer');
  tenantA = await newCompany(customer, 'customer');
  await enableMfa(customer);
  await customer.upload('contract.txt', 'text/plain', Buffer.from('confidential terms')).expect(201);
  const otherOwner = await newUser(t, 'cust-b');
  tenantB = await newCompany(otherOwner, 'cust-b');
}, 120_000);
afterAll(() => t?.close());

describe('who can use the console', () => {
  it('a company Owner is not platform staff', async () => {
    await customer.get('/v1/platform/tenants').expect(403);
  });

  it('staff without two-step verification are refused', async () => {
    const noMfa = await newUser(t, 'nomfa');
    await t.ownerDb.query("INSERT INTO platform_staff (user_id, role, added_by) VALUES ($1, 'support_agent', 'test')", [noMfa.userId]);
    expect((await noMfa.get('/v1/platform/tenants').expect(403)).body.error.code).toBe('mfa_enrollment_required');
  });

  it('staff cannot be added through the API role or the platform role', async () => {
    await expect(t.deps.db.query("INSERT INTO platform_staff (user_id, role, added_by) VALUES ($1, 'platform_owner', 'x')", [customer.userId]))
      .rejects.toMatchObject({ code: '42501' });
    await expect(t.deps.platformDb.query("INSERT INTO platform_staff (user_id, role, added_by) VALUES ($1, 'platform_owner', 'x')", [customer.userId]))
      .rejects.toMatchObject({ code: '42501' });
  });
});

describe('directory and plans: metadata only', () => {
  it('lists companies with plan, status and counts, but no names of files or people', async () => {
    const dir = (await support.get('/v1/platform/tenants').expect(200)).body as Array<Record<string, unknown>>;
    const a = dir.find((d) => d.tenantId === tenantA)!;
    expect(a).toMatchObject({ plan: 'starter', subscriptionStatus: 'trialing', activeMembers: 1, filesCount: 1 });
    expect(JSON.stringify(dir)).not.toContain('contract.txt');
    expect(JSON.stringify(dir)).not.toContain(customer.email);
  });

  it('shows the annual draft versions as unpublished; only a platform owner may publish', async () => {
    const plans = (await support.get('/v1/platform/plans').expect(200)).body as Array<{ id: string; version: number; publishedAt: string | null; code: string }>;
    const draft = plans.find((p) => p.code === 'growth' && p.version === 2)!;
    expect(draft.publishedAt).toBeNull();
    await support.post(`/v1/platform/plans/versions/${draft.id}/publish`).expect(403);
  });

  it('feature flags: a platform owner sets one; the company sees it; support agents cannot', async () => {
    await support.put(`/v1/platform/tenants/${tenantA}/features/whatsapp_channel`, { enabled: true }).expect(403);
    await lead.put(`/v1/platform/tenants/${tenantA}/features/whatsapp_channel`, { enabled: true }).expect(204);
    const flags = (await customer.get('/v1/features').expect(200)).body as Array<{ key: string; enabled: boolean }>;
    expect(flags.find((f) => f.key === 'whatsapp_channel')!.enabled).toBe(true);
  });
});

describe('support access: two people, time-limited, audited', () => {
  let grantId: string;

  it('without a grant, staff cannot see company content — even at database level', async () => {
    expect((await support.get(`/v1/platform/tenants/${tenantA}/files`).expect(403)).body.error.message).toMatch(/No active, approved support access/);
    const rows = await withContext(t.deps.platformDb, { tenantId: tenantA, userId: support.userId! }, async (tx) =>
      (await tx.query('SELECT count(*)::int AS n FROM files')).rows[0].n);
    expect(rows).toBe(0);
  });

  it('a request needs a real reason and at most 4 hours', async () => {
    await support.post('/v1/platform/support-grants', { tenantId: tenantA, reason: 'help', minutes: 30 }).expect(400);
    await support.post('/v1/platform/support-grants', { tenantId: tenantA, reason: 'Customer ticket #4411: file will not open', minutes: 600 }).expect(400);
    grantId = (await support.post('/v1/platform/support-grants', {
      tenantId: tenantA, reason: 'Customer ticket #4411: uploaded contract will not open', minutes: 30,
    }).expect(201)).body.grantId;
    await support.get(`/v1/platform/tenants/${tenantA}/files`).expect(403); // requested is not approved
  });

  it('nobody can approve their own request, and support agents cannot approve', async () => {
    const own = (await lead.post('/v1/platform/support-grants', {
      tenantId: tenantA, reason: 'Checking an import issue reported by email', minutes: 15,
    }).expect(201)).body.grantId;
    await lead.post(`/v1/platform/support-grants/${own}/approve`).expect(409);
    await support.post(`/v1/platform/support-grants/${grantId}/approve`).expect(403);
  });

  it('once approved by a second platform owner, staff see that company only, and each look is in its audit trail', async () => {
    await second.post(`/v1/platform/support-grants/${grantId}/approve`).expect(201);
    const files = (await support.get(`/v1/platform/tenants/${tenantA}/files`).expect(200)).body;
    expect(files.map((f: { name: string }) => f.name)).toEqual(['contract.txt']);
    await support.get(`/v1/platform/tenants/${tenantB}/files`).expect(403); // the grant is for A only
    const audit = (await customer.get('/v1/audit-events').expect(200)).body as Array<{ action: string; actorUserId: string }>;
    expect(audit.map((e) => e.action)).toEqual(expect.arrayContaining(['support.access_granted', 'support.viewed']));
    expect(audit.find((e) => e.action === 'support.viewed')!.actorUserId).toBe(support.userId);
    const grants = (await customer.get('/v1/support-grants').expect(200)).body;
    expect(grants.find((g: { id: string }) => g.id === grantId)).toMatchObject({ reason: expect.stringContaining('#4411') });
  });

  it('the platform role can never change company data, even with a grant', async () => {
    await expect(withContext(t.deps.platformDb, { tenantId: tenantA, userId: support.userId! }, (tx) =>
      tx.query("UPDATE files SET original_name = 'x'"))).rejects.toMatchObject({ code: '42501' });
    await expect(withContext(t.deps.platformDb, { tenantId: tenantA, userId: support.userId! }, (tx) =>
      tx.query('DELETE FROM memberships'))).rejects.toMatchObject({ code: '42501' });
    const names = (await customer.get('/v1/files').expect(200)).body.map((f: { name: string }) => f.name);
    expect(names).toEqual(['contract.txt']);
  });

  it('access ends when revoked, and when it expires', async () => {
    await support.post(`/v1/platform/support-grants/${grantId}/revoke`).expect(204);
    await support.get(`/v1/platform/tenants/${tenantA}/files`).expect(403);

    const next = (await support.post('/v1/platform/support-grants', {
      tenantId: tenantA, reason: 'Follow-up on ticket #4411 after customer reply', minutes: 5,
    }).expect(201)).body.grantId;
    await second.post(`/v1/platform/support-grants/${next}/approve`).expect(201);
    await support.get(`/v1/platform/tenants/${tenantA}/members`).expect(200);
    // Simulate the clock passing the expiry (owner role, operations).
    const ops = await t.ownerDb.connect();
    try {
      await ops.query('BEGIN');
      await ops.query('SET LOCAL ROLE cf_ops');
      await ops.query("UPDATE support_access_grants SET expires_at = now() - interval '1 second', approved_at = now() - interval '6 minutes' WHERE id = $1", [next]);
      await ops.query('COMMIT');
    } finally {
      ops.release();
    }
    await support.get(`/v1/platform/tenants/${tenantA}/members`).expect(403);
  });
});
