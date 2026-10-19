/**
 * Isolation guard, run in CI after migrations. Fails the build when:
 *  - a table with a tenant_id column lacks row-level security, FORCE, or a policy;
 *  - any table that has RLS enabled is not forced;
 *  - the application role can bypass RLS, is a superuser, or owns any object;
 *  - a SECURITY DEFINER function has no fixed search_path or is owned by an unexpected role.
 */
import pg from 'pg';

export async function checkIsolation(ownerUrl: string): Promise<string[]> {
  const client = new pg.Client({ connectionString: ownerUrl });
  await client.connect();
  const problems: string[] = [];
  try {
    const tenantTables = await client.query<{ table: string; rls: boolean; forced: boolean; policies: number }>(`
      SELECT c.relname AS table, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
             (SELECT count(*)::int FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = c.relname) AS policies
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
        AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)`);
    for (const t of tenantTables.rows) {
      if (!t.rls) problems.push(`${t.table}: has tenant_id but row-level security is not enabled`);
      if (!t.forced) problems.push(`${t.table}: row-level security is not FORCED`);
      if (t.policies === 0) problems.push(`${t.table}: no RLS policy defined`);
    }

    const unforced = await client.query<{ table: string }>(`
      SELECT c.relname AS table FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity AND NOT c.relforcerowsecurity`);
    for (const t of unforced.rows) problems.push(`${t.table}: RLS enabled but not forced`);

    const role = await client.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'cf_app'");
    if (role.rowCount !== 1) problems.push('role cf_app does not exist');
    else if (role.rows[0]!.rolsuper || role.rows[0]!.rolbypassrls) problems.push('cf_app can bypass row-level security');

    const owned = await client.query<{ name: string }>(`
      SELECT c.relname AS name FROM pg_class c WHERE c.relowner = (SELECT oid FROM pg_roles WHERE rolname = 'cf_app')
      UNION ALL
      SELECT p.proname FROM pg_proc p WHERE p.proowner = (SELECT oid FROM pg_roles WHERE rolname = 'cf_app')`);
    for (const o of owned.rows) problems.push(`cf_app owns ${o.name}; it must own nothing`);

    const membership = await client.query(`
      SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member WHERE r.rolname = 'cf_app'`);
    if ((membership.rowCount ?? 0) > 0) problems.push('cf_app is a member of another role; it must not inherit privileges');

    const definers = await client.query<{ name: string; owner: string; config: string[] | null }>(`
      SELECT p.proname AS name, pg_get_userbyid(p.proowner) AS owner, p.proconfig AS config
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.prosecdef`);
    for (const f of definers.rows) {
      if (!f.config?.some((c) => c.startsWith('search_path='))) problems.push(`${f.name}: SECURITY DEFINER without fixed search_path`);
      if (f.name.startsWith('auth_') && f.owner !== 'cf_auth') problems.push(`${f.name}: must be owned by cf_auth, is ${f.owner}`);
    }
    return problems;
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  checkIsolation(process.env.DATABASE_URL ?? '').then(
    (problems) => {
      if (problems.length) {
        console.error(`Isolation check FAILED (${problems.length}):\n - ${problems.join('\n - ')}`);
        process.exit(1);
      }
      console.log('Isolation check passed: every tenant table has forced RLS and a policy; cf_app cannot bypass RLS.');
    },
    (err) => {
      console.error(err.message);
      process.exit(1);
    },
  );
}
