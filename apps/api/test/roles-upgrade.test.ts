/**
 * SR-1: the application's built-in role definitions, fresh installations and the upgrade list stay in step.
 * (The upgrade of an existing company is tested in upgrade.test.ts with a populated older database.)
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withContext } from '@conversaflow/database';
import { SYSTEM_ROLES } from '../src/modules/rbac';
import { firstReleasePermissions } from './permission-history';
import { newCompany, newUser, startApp, type TestApp } from './helpers';

let t: TestApp;
beforeAll(async () => { t = await startApp(); });
afterAll(() => t?.close());

describe('built-in role permissions', () => {
  it('a fresh company gets exactly the defined permissions on each built-in role', async () => {
    const owner = await newUser(t, 'roles-fresh');
    const tenant = await newCompany(owner, 'rolesfresh', 'business');
    const rows = await withContext(t.deps.db, { tenantId: tenant, userId: owner.userId! }, async (tx) => (await tx.query<{ key: string; perms: string[] }>(
      `SELECT r.key, array_agg(rp.permission_key ORDER BY rp.permission_key) AS perms
       FROM roles r JOIN role_permissions rp ON rp.role_id = r.id WHERE r.is_system GROUP BY r.key`)).rows);
    for (const [key, role] of Object.entries(SYSTEM_ROLES)) expect(rows.find((r) => r.key === key)?.perms, key).toEqual([...role.permissions].sort());
  });

  it('every permission a built-in role gained after the first release is on the upgrade list, and nothing more', async () => {
    const base = firstReleasePermissions();
    const grants = await withContext(t.deps.db, { tenantId: null, userId: null }, async (tx) =>
      (await tx.query<{ role_key: string; permission_key: string }>('SELECT role_key, permission_key FROM system_role_grants')).rows);
    const expected = Object.entries(SYSTEM_ROLES).flatMap(([key, role]) => role.permissions.filter((p) => !base.has(p)).map((p) => `${key}:${p}`)).sort();
    expect(grants.map((g) => `${g.role_key}:${g.permission_key}`).sort()).toEqual(expected);
  });
});
