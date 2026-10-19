/** Role permissions: every system role against every Phase 1 endpoint, plus escalation and MFA rules. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SYSTEM_ROLES } from '../src/modules/rbac';
import { addMember, enableMfa, newCompany, newUser, startApp, uniqueEmail, type Client, type TestApp } from './helpers';

let t: TestApp;
let owner: Client;
const members: Record<string, Client> = {};
let counter = 0;

type Call = (c: Client) => Promise<{ status: number }>;
const ENDPOINTS: Array<{ name: string; permission: string; call: Call }> = [
  { name: 'GET /v1/tenant', permission: 'tenant.read', call: (c) => c.get('/v1/tenant') },
  { name: 'PATCH /v1/tenant', permission: 'tenant.update', call: (c) => c.patch('/v1/tenant', { timezone: 'Asia/Riyadh' }) },
  { name: 'GET /v1/members', permission: 'members.read', call: (c) => c.get('/v1/members') },
  { name: 'POST /v1/invitations', permission: 'members.invite', call: (c) => c.post('/v1/invitations', { email: uniqueEmail('inv'), roleKey: 'agent' }) },
  { name: 'GET /v1/roles', permission: 'roles.read', call: (c) => c.get('/v1/roles') },
  { name: 'POST /v1/roles', permission: 'roles.manage', call: (c) => c.post('/v1/roles', { key: `custom_${++counter}`, name: 'Custom role', permissions: ['tenant.read'] }) },
  { name: 'GET /v1/entitlements', permission: 'billing.read', call: (c) => c.get('/v1/entitlements') },
  { name: 'GET /v1/audit-events', permission: 'audit.read', call: (c) => c.get('/v1/audit-events') },
  { name: 'GET /v1/files', permission: 'files.read', call: (c) => c.get('/v1/files') },
  { name: 'POST /v1/files', permission: 'files.write', call: (c) => c.upload('note.txt', 'text/plain', Buffer.from('hello')) },
];

beforeAll(async () => {
  t = await startApp();
  owner = await newUser(t, 'boss');
  await newCompany(owner, 'matrix', 'business');
  await enableMfa(owner);
  members.owner = owner;
  for (const role of ['admin', 'supervisor', 'agent', 'analyst']) {
    members[role] = await addMember(t, owner, role, role);
    await enableMfa(members[role]!); // isolate the permission check from the MFA rule
  }
}, 120_000);
afterAll(() => t?.close());

describe('permission matrix: system roles x Phase 1 endpoints', () => {
  for (const role of Object.keys(SYSTEM_ROLES)) {
    for (const e of ENDPOINTS) {
      const allowed = (SYSTEM_ROLES[role]!.permissions as readonly string[]).includes(e.permission);
      it(`${role.padEnd(10)} ${allowed ? 'CAN   ' : 'CANNOT'} ${e.name}`, async () => {
        const res = await e.call(members[role]!);
        if (allowed) expect(res.status, `${role} ${e.name}`).toBeLessThan(300);
        else expect(res.status, `${role} ${e.name}`).toBe(403);
      });
    }
  }
});

describe('privileged actions and escalation', () => {
  it('an Owner without two-step verification can read settings but cannot change them', async () => {
    const solo = await newUser(t, 'solo');
    await newCompany(solo, 'solo');
    await solo.get('/v1/tenant').expect(200);
    const res = await solo.patch('/v1/tenant', { timezone: 'Europe/Riga' }).expect(403);
    expect(res.body.error.code).toBe('mfa_enrollment_required');
    await solo.post('/v1/invitations', { email: uniqueEmail('n'), roleKey: 'agent' }).expect(403);
  });

  it('without a company selected, company endpoints refuse', async () => {
    const lone = await newUser(t, 'lone');
    const res = await lone.get('/v1/tenant').expect(403);
    expect(res.body.error.code).toBe('no_active_company');
  });

  it('an Admin cannot make anyone Owner, nor change or remove an Owner', async () => {
    const admin = members.admin!;
    const list = (await owner.get('/v1/members').expect(200)).body as Array<{ id: string; roles: string[] }>;
    const ownerId = list.find((m) => m.roles.includes('owner'))!.id;
    const agentId = list.find((m) => m.roles.includes('agent'))!.id;
    await admin.put(`/v1/members/${agentId}/roles`, { roleKeys: ['owner'] }).expect(403);
    await admin.put(`/v1/members/${ownerId}/roles`, { roleKeys: ['agent'] }).expect(403);
    await admin.delete(`/v1/members/${ownerId}`).expect(403);
    await admin.post('/v1/invitations', { email: uniqueEmail('o'), roleKey: 'owner' }).expect(403);
  });

  it('the last Owner cannot be demoted', async () => {
    const ownerId = ((await owner.get('/v1/members').expect(200)).body as Array<{ id: string; roles: string[] }>)
      .find((m) => m.roles.includes('owner'))!.id;
    const res = await owner.put(`/v1/members/${ownerId}/roles`, { roleKeys: ['admin'] }).expect(409);
    expect(res.body.error.code).toBe('last_owner');
  });

  it('nobody can create a custom role with permissions they do not hold', async () => {
    const res = await members.admin!.post('/v1/roles', { key: 'payer', name: 'Payer', permissions: ['billing.manage'] }).expect(403);
    expect(res.body.error.message).toMatch(/billing\.manage/);
  });

  it('a custom role grants exactly its permissions', async () => {
    await owner.post('/v1/roles', { key: 'viewer', name: 'Viewer', permissions: ['tenant.read', 'contacts.read'] }).expect(201);
    const viewer = await addMember(t, owner, 'viewer', 'viewer');
    await viewer.get('/v1/tenant').expect(200);
    await viewer.get('/v1/members').expect(403);
    await viewer.get('/v1/files').expect(403);
  });

  it('role changes apply on the next request', async () => {
    const analyst = members.analyst!;
    await analyst.get('/v1/files').expect(403);
    const id = ((await owner.get('/v1/members').expect(200)).body as Array<{ id: string; email: string }>)
      .find((m) => m.email === analyst.email)!.id;
    await owner.put(`/v1/members/${id}/roles`, { roleKeys: ['agent'] }).expect(204);
    await analyst.get('/v1/files').expect(200);
  });
});
