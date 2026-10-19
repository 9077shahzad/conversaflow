/**
 * Company isolation at the DATABASE layer.
 * Builds two fully populated companies (A and B) through the real API, then connects as the application role
 * and tries to reach B's rows from A's context in every tenant table the database contains.
 * The table list is read from the database catalogue, so a table added later is covered automatically.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withContext } from '@conversaflow/database';
import { AutomationMetering } from '../src/modules/entitlements.service';
import { addMember, asOwner, enableMfa, invite, newCompany, newStaff, newUser, startApp, type Client, type TestApp } from './helpers';

let t: TestApp;
let a: Client;
let b: Client;
let tenantA: string;
let tenantB: string;
let tenantTables: string[];
let staff: Client;
let approver: Client;

async function populate(owner: Client, label: string, tenantId: string) {
  await enableMfa(owner);
  await addMember(t, owner, `${label}-agent`, 'agent');
  await owner.post('/v1/invitations', { email: `pending-${label}@example.test`, roleKey: 'analyst' }).expect(201);
  await owner.post('/v1/roles', { key: 'qa', name: 'Quality', permissions: ['contacts.read'] }).expect(201);
  await owner.upload(`${label}.txt`, 'text/plain', Buffer.from(`secret of ${label}`)).expect(201);
  await t.deps.db.query('SELECT 1'); // warm pool
  await withContext(t.deps.db, { tenantId, userId: owner.userId! }, (tx) =>
    tx.query("INSERT INTO usage_counters (tenant_id, key, period_start, used) VALUES ($1, 'ai_credits', date_trunc('month', now())::date, 5)", [tenantId]));
  // Settings, holidays, branches, teams and team members.
  await owner.post('/v1/settings/holidays', { day: '2026-12-25', name: `Holiday ${label}` }).expect(201);
  const branch = (await owner.post('/v1/branches', { name: `Branch ${label}` }).expect(201)).body;
  const team = (await owner.post('/v1/teams', { name: `Team ${label}`, branchId: branch.id }).expect(201)).body;
  const agentId = (await owner.get('/v1/members').expect(200)).body.find((m: { roles: string[] }) => m.roles.includes('agent')).id;
  await owner.post(`/v1/teams/${team.id}/members`, { membershipId: agentId }).expect(204);
  // A feature flag and an approved support grant, through the platform console.
  await staff.put(`/v1/platform/tenants/${tenantId}/features/ai_agents`, { enabled: true }).expect(204);
  const grant = (await staff.post('/v1/platform/support-grants', { tenantId, reason: `Isolation test fixture for ${label} company`, minutes: 5 }).expect(201)).body.grantId;
  await approver.post(`/v1/platform/support-grants/${grant}/approve`).expect(201);
  await new AutomationMetering(t.deps).recordRunOutcome({ tenantId, userId: owner.userId! }, `run-${label}`, 'completed');
  await asOwner(t, tenantId, (tx) =>
    tx.query("INSERT INTO entitlement_overrides (tenant_id, key, limit_value, reason) VALUES ($1, 'seats', 5, 'test')", [tenantId]));
  // A pilot enrolment through the console (migration 0011). Last, because it requires two-step sign-in from here on.
  await staff.post(`/v1/platform/tenants/${tenantId}/pilot`, { reason: `Isolation test pilot for ${label}` }).expect(201);
}

beforeAll(async () => {
  t = await startApp();
  staff = await newStaff(t, 'iso-staff', 'platform_owner');
  approver = await newStaff(t, 'iso-approver', 'platform_owner');
  a = await newUser(t, 'alpha');
  b = await newUser(t, 'bravo');
  tenantA = await newCompany(a, 'alpha');
  tenantB = await newCompany(b, 'bravo');
  await populate(a, 'alpha', tenantA);
  await populate(b, 'bravo', tenantB);
  const { rows } = await t.ownerDb.query<{ table: string }>(`
    SELECT c.relname AS table FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
      AND EXISTS (SELECT 1 FROM pg_attribute x WHERE x.attrelid = c.oid AND x.attname = 'tenant_id' AND NOT x.attisdropped)
    ORDER BY 1`);
  tenantTables = rows.map((r) => r.table);
});
afterAll(() => t?.close());

const ctxA = () => ({ tenantId: tenantA, userId: a.userId! });

describe('database isolation between companies', () => {
  it('covers every table that has a tenant_id column (at least the 19 known ones)', () => {
    expect(tenantTables).toEqual(expect.arrayContaining([
      'audit_events', 'branches', 'entitlement_overrides', 'files', 'invitations', 'membership_roles', 'memberships',
      'role_permissions', 'roles', 'subscriptions', 'support_access_grants', 'team_members', 'teams', 'tenant_feature_flags',
      'tenant_holidays', 'tenant_settings', 'usage_counters', 'usage_events', 'pilot_enrolments',
    ]));
    expect(tenantTables.length).toBeGreaterThanOrEqual(19);
  });

  it('company B really has data in every tenant table (so the checks below are meaningful)', async () => {
    for (const table of tenantTables) {
      const n = await withContext(t.deps.db, { tenantId: tenantB, userId: b.userId! }, async (tx) =>
        (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]!.n);
      expect(n, `${table} should have rows for company B`).toBeGreaterThan(0);
    }
  });

  it("in company A's context, no row of any other company is visible in any tenant table", async () => {
    for (const table of tenantTables) {
      const { own, foreign } = await withContext(t.deps.db, ctxA(), async (tx) => {
        const r = await tx.query<{ own: number; foreign: number }>(
          `SELECT count(*) FILTER (WHERE tenant_id = $1)::int AS own, count(*) FILTER (WHERE tenant_id <> $1)::int AS foreign FROM ${table}`,
          [tenantA]);
        return r.rows[0]!;
      });
      expect(foreign, `${table}: rows from another company leaked`).toBe(0);
      expect(own, `${table}: company A should see its own rows`).toBeGreaterThan(0);
    }
  });

  it("even when explicitly filtering by company B's id, company A gets nothing", async () => {
    for (const table of tenantTables) {
      const n = await withContext(t.deps.db, ctxA(), async (tx) =>
        (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1`, [tenantB])).rows[0]!.n);
      expect(n, table).toBe(0);
    }
  });

  it("company A cannot update or delete company B's rows in any tenant table", async () => {
    for (const table of tenantTables) {
      for (const sql of [`UPDATE ${table} SET tenant_id = tenant_id WHERE tenant_id = $1`, `DELETE FROM ${table} WHERE tenant_id = $1`]) {
        const affected = await withContext(t.deps.db, ctxA(), async (tx) => (await tx.query(sql, [tenantB])).rowCount)
          .catch((err: { code?: string }) => {
            // 42501 = no privilege at all (e.g. audit_events is append-only) — also a refusal. Nothing else is accepted.
            expect(err.code, `${table}: unexpected error ${err.code}`).toBe('42501');
            return 0;
          });
        expect(affected, `${table}: ${sql.split(' ')[0]} touched another company's rows`).toBe(0);
      }
    }
    // Company B's data is intact afterwards.
    const members = await withContext(t.deps.db, { tenantId: tenantB, userId: b.userId! }, async (tx) =>
      (await tx.query('SELECT count(*)::int AS n FROM memberships')).rows[0].n);
    expect(members).toBe(2);
  });

  it("company A cannot move its own rows into company B in any tenant table (WITH CHECK side)", async () => {
    for (const table of tenantTables) {
      const outcome = await withContext(t.deps.db, ctxA(), async (tx) => {
        const r = await tx.query(`UPDATE ${table} SET tenant_id = $1 WHERE tenant_id = $2`, [tenantB, tenantA]);
        return `updated ${r.rowCount} rows`;
      }).catch((err: { code?: string }) => err.code);
      // 42501: RLS WITH CHECK or no UPDATE privilege. 23503: composite foreign key refuses the move first.
      expect(['42501', '23503'], `${table}: rows could be moved into another company (${outcome})`).toContain(outcome);
    }
  });

  it("company A cannot insert rows labelled with company B's id", async () => {
    const attempt = withContext(t.deps.db, ctxA(), (tx) =>
      tx.query('INSERT INTO memberships (tenant_id, user_id) VALUES ($1, $2)', [tenantB, a.userId]));
    await expect(attempt).rejects.toMatchObject({ code: '42501' }); // new row violates row-level security policy
  });

  it("company A cannot link its records to company B's records (composite foreign keys)", async () => {
    const roleB = await withContext(t.deps.db, { tenantId: tenantB, userId: b.userId! }, async (tx) =>
      (await tx.query<{ id: string }>("SELECT id FROM roles WHERE key = 'owner'")).rows[0]!.id);
    const attempt = withContext(t.deps.db, ctxA(), async (tx) => {
      const m = (await tx.query<{ id: string }>('SELECT id FROM memberships LIMIT 1')).rows[0]!.id;
      await tx.query('INSERT INTO membership_roles (tenant_id, membership_id, role_id) VALUES ($1, $2, $3)', [tenantA, m, roleB]);
    });
    await expect(attempt).rejects.toMatchObject({ code: '23503' }); // foreign key violation
  });

  it('with no company selected, every tenant table looks empty', async () => {
    for (const table of tenantTables) {
      const n = await withContext(t.deps.db, { tenantId: null, userId: null }, async (tx) =>
        (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]!.n);
      expect(n, table).toBe(0);
    }
  });

  it('the company context never leaks to the next use of a pooled connection', async () => {
    const { createPool } = await import('@conversaflow/database');
    const single = createPool(process.env.DATABASE_APP_URL!, 1);
    try {
      await withContext(single, ctxA(), (tx) => tx.query('SELECT 1'));
      const { rows } = await single.query<{ t: string | null; n: number }>(
        'SELECT app_tenant_id() AS t, (SELECT count(*)::int FROM memberships) AS n');
      expect(rows[0]).toEqual({ t: null, n: 0 });
    } finally {
      await single.end();
    }
  });

  it("people and companies: A sees only its own members and companies, never B's", async () => {
    const r = await withContext(t.deps.db, ctxA(), async (tx) => ({
      users: (await tx.query<{ id: string }>('SELECT id FROM users')).rows.map((x) => x.id),
      tenants: (await tx.query<{ id: string }>('SELECT id FROM tenants')).rows.map((x) => x.id),
    }));
    expect(r.users).toContain(a.userId);
    expect(r.users).not.toContain(b.userId);
    expect(r.users).toHaveLength(2); // owner + agent
    expect(r.tenants).toEqual([tenantA]);
  });

  it('a person who belongs to BOTH companies sees only the selected company (regression: switcher rule)', async () => {
    const dual = await addMember(t, a, 'dual', 'agent');
    await dual.post('/v1/invitations/accept', { token: await invite(t, b, dual.email, 'agent') }).expect(201);
    const inA = await withContext(t.deps.db, { tenantId: tenantA, userId: dual.userId! }, async (tx) => ({
      memberships: (await tx.query<{ tenant_id: string }>('SELECT DISTINCT tenant_id FROM memberships')).rows.map((r) => r.tenant_id),
      tenants: (await tx.query<{ id: string }>('SELECT id FROM tenants')).rows.map((r) => r.id),
    }));
    expect(inA).toEqual({ memberships: [tenantA], tenants: [tenantA] });
    // With no company selected (the switcher), the person sees their own memberships in both — and nothing else.
    const switcher = await withContext(t.deps.db, { tenantId: null, userId: dual.userId! }, async (tx) => ({
      memberships: (await tx.query<{ user_id: string }>('SELECT user_id FROM memberships')).rows.map((r) => r.user_id),
      tenants: (await tx.query<{ id: string }>('SELECT id FROM tenants ORDER BY id')).rows.map((r) => r.id),
    }));
    expect(new Set(switcher.memberships)).toEqual(new Set([dual.userId]));
    expect(switcher.tenants.sort()).toEqual([tenantA, tenantB].sort());
  });

  it('the application role cannot escalate: no SET ROLE, no direct access to secret tokens', async () => {
    await expect(t.deps.db.query('SET ROLE cf_auth')).rejects.toMatchObject({ code: '42501' });
    await expect(t.deps.db.query('SET ROLE cf_owner')).rejects.toMatchObject({ code: '42501' });
    await expect(t.deps.db.query('SELECT * FROM auth_tokens')).rejects.toMatchObject({ code: '42501' });
    await expect(t.deps.db.query('ALTER TABLE files DISABLE ROW LEVEL SECURITY')).rejects.toMatchObject({ code: '42501' });
    // Column-level grants: a user's email, verification and a session's owner can never be rewritten by the app.
    const self = { tenantId: null, userId: a.userId! };
    await expect(withContext(t.deps.db, self, (tx) => tx.query("UPDATE users SET email = 'x@evil.test' WHERE id = $1", [a.userId])))
      .rejects.toMatchObject({ code: '42501' });
    await expect(withContext(t.deps.db, self, (tx) => tx.query('UPDATE users SET email_verified_at = now() WHERE id = $1', [a.userId])))
      .rejects.toMatchObject({ code: '42501' });
    await expect(withContext(t.deps.db, self, (tx) => tx.query('UPDATE sessions SET user_id = $1', [b.userId])))
      .rejects.toMatchObject({ code: '42501' });
    const role = await t.deps.db.query('SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user');
    expect(role.rows[0]).toEqual({ rolbypassrls: false, rolsuper: false });
  });
});
