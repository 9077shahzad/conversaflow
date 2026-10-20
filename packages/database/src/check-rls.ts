/**
 * Isolation guard, run in CI after migrations. Fails the build when:
 *  - a table with a tenant_id column lacks row-level security, FORCE, or a policy;
 *  - any table that has RLS enabled is not forced;
 *  - any login role can bypass RLS, is a superuser, owns any object or inherits another role;
 *  - the business API role (cf_app) has any right over credentials or billing state, or anyone but cf_notify can mint email tokens;
 *  - the platform console role has direct table access, or a platform function does not take a session token;
 *  - a SECURITY DEFINER function has no fixed search_path or is owned by an unexpected role.
 */
import pg from 'pg';

const LOGIN_ROLES = ['cf_app', 'cf_identity', 'cf_notify', 'cf_platform'];
const CREDENTIAL_TABLES = ['user_credentials', 'mfa_factors', 'mfa_recovery_codes', 'auth_tokens', 'auth_email_requests', 'auth_keys', 'mfa_attempts', 'mfa_activation_codes', 'mfa_reset_requests'];
/** The only privileged functions allowed to write pilot or seat-override records, both token-bound to a platform owner. */
const PILOT_WRITERS_ALLOWED = ['platform_enrol_pilot(text,uuid,integer,integer,text)', 'platform_end_pilot(text,uuid)'];
/** Roles that may hold write rights on pilot enrolments and seat overrides: the table owner and cf_pilot (migration 0018). */
const PILOT_TABLE_WRITERS = ['cf_owner', 'cf_pilot'];
/** Privileged trigger functions reviewed and allowed although their owner could write those tables (billing guards). */
const REVIEWED_TRIGGER_FUNCTIONS = ['subscription_new_is_trial()', 'subscription_requires_published_version()'];

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

    for (const roleName of LOGIN_ROLES) {
      const role = await client.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1', [roleName]);
      if (role.rowCount !== 1) problems.push(`role ${roleName} does not exist`);
      else if (role.rows[0]!.rolsuper || role.rows[0]!.rolbypassrls) problems.push(`${roleName} can bypass row-level security`);

      const owned = await client.query<{ name: string }>(`
        SELECT c.relname AS name FROM pg_class c WHERE c.relowner = (SELECT oid FROM pg_roles WHERE rolname = $1)
        UNION ALL
        SELECT p.proname FROM pg_proc p WHERE p.proowner = (SELECT oid FROM pg_roles WHERE rolname = $1)`, [roleName]);
      for (const o of owned.rows) problems.push(`${roleName} owns ${o.name}; it must own nothing`);

      const membership = await client.query(
        'SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member WHERE r.rolname = $1', [roleName]);
      if ((membership.rowCount ?? 0) > 0) problems.push(`${roleName} is a member of another role; it must not inherit privileges`);
    }

    // Credential separation (ADR-024 resolution): the business API role has no rights over credentials.
    for (const table of CREDENTIAL_TABLES) {
      const { rows } = await client.query<{ any: boolean }>(
        `SELECT has_table_privilege('cf_app', $1, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
             OR has_any_column_privilege('cf_app', $1, 'SELECT,INSERT,UPDATE') AS any`, [table]);
      if (rows[0]!.any) problems.push(`cf_app has privileges on credential table ${table}`);
    }
    const sess = await client.query<{ ins: boolean; mfa: boolean; tok: boolean }>(`
      SELECT has_table_privilege('cf_app', 'sessions', 'INSERT') AS ins,
             has_column_privilege('cf_app', 'sessions', 'mfa_verified_at', 'UPDATE') AS mfa,
             has_column_privilege('cf_app', 'sessions', 'token_hash', 'SELECT') AS tok`);
    if (sess.rows[0]!.ins || sess.rows[0]!.mfa || sess.rows[0]!.tok) problems.push('cf_app can create sessions, mark them MFA-verified or read their token hashes');
    const fns = await client.query<{ sig: string }>(`
      SELECT p.oid::regprocedure::text AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND (p.proname LIKE 'auth\\_%' OR p.proname LIKE 'platform\\_%' OR p.proname = 'support_grant_active')
        AND p.proname <> 'auth_invitation_lookup' AND has_function_privilege('cf_app', p.oid, 'EXECUTE')`);
    for (const f of fns.rows) problems.push(`cf_app can execute ${f.sig}`);
    // Every SECURITY DEFINER function that acts for a person must be owned by cf_auth or cf_ops (never a login role).
    const badOwners = await client.query<{ sig: string; owner: string }>(`
      SELECT p.oid::regprocedure::text AS sig, pg_get_userbyid(p.proowner) AS owner FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.prosecdef AND pg_get_userbyid(p.proowner) NOT IN ('cf_auth', 'cf_ops', 'cf_pilot')
        AND (p.proname LIKE 'auth\\_%' OR p.proname LIKE 'platform\\_%')`);
    for (const f of badOwners.rows) problems.push(`${f.sig} is owned by ${f.owner}; must be cf_auth, cf_ops or cf_pilot`);
    // The platform console role has NO direct table access except reading the plan catalogue and flags.
    const platformTables = await client.query<{ t: string }>(`
      SELECT c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
        AND c.relname NOT IN ('plans', 'plan_versions', 'plan_entitlements', 'feature_flags')
        AND (has_table_privilege('cf_platform', c.oid, 'SELECT,INSERT,UPDATE,DELETE') OR has_any_column_privilege('cf_platform', c.oid, 'SELECT,INSERT,UPDATE'))`);
    for (const r of platformTables.rows) problems.push(`cf_platform has direct access to ${r.t}; it must act only through token-bound functions`);
    // Platform functions must take the session token as proof of identity (no app.user_id trust).
    const unbound = await client.query<{ sig: string }>(`
      SELECT p.oid::regprocedure::text AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname LIKE 'platform\\_%' AND p.proname NOT IN ('platform_staff_role')
        AND has_function_privilege('cf_platform', p.oid, 'EXECUTE')
        AND NOT (p.proargtypes[0] = 'text'::regtype AND p.proargnames[1] = 'p_token')`);
    for (const f of unbound.rows) problems.push(`${f.sig} is callable by cf_platform without a session token as its first argument`);
    // Billing state: the business API may create a subscription (forced to a trial) but never update one,
    // and may not insert sessions or set their MFA state.
    // Two-step verification is decided only inside the database (migration 0010): no login role may write MFA data,
    // read secrets, recovery codes or the sealing key, or mark a session verified directly.
    for (const roleName of LOGIN_ROLES) {
      const { rows } = await client.query<{ w: boolean; secret: boolean; rec: boolean; key: boolean; mark: boolean }>(`
        SELECT has_table_privilege($1, 'mfa_factors', 'INSERT,UPDATE,DELETE') OR has_table_privilege($1, 'mfa_recovery_codes', 'INSERT,UPDATE,DELETE')
                 OR has_any_column_privilege($1, 'mfa_factors', 'INSERT,UPDATE') OR has_any_column_privilege($1, 'mfa_recovery_codes', 'INSERT,UPDATE') AS w,
               has_column_privilege($1, 'mfa_factors', 'secret_enc', 'SELECT') OR has_column_privilege($1, 'mfa_factors', 'secret_sealed', 'SELECT') AS secret,
               has_any_column_privilege($1, 'mfa_recovery_codes', 'SELECT') AS rec,
               has_any_column_privilege($1, 'auth_keys', 'SELECT') OR has_any_column_privilege($1, 'mfa_attempts', 'SELECT,INSERT') AS key,
               has_column_privilege($1, 'sessions', 'mfa_verified_at', 'UPDATE') OR has_table_privilege($1, 'sessions', 'UPDATE') AS mark`, [roleName]);
      const r = rows[0]!;
      if (r.w) problems.push(`${roleName} can write MFA factors or recovery codes directly`);
      if (r.secret) problems.push(`${roleName} can read TOTP secrets`);
      if (r.rec) problems.push(`${roleName} can read recovery codes`);
      if (r.key) problems.push(`${roleName} can read the MFA sealing key or attempt log`);
      if (r.mark) problems.push(`${roleName} can mark sessions as MFA-verified directly`);
    }
    const billing = await client.query<{ upd: boolean; sess: boolean }>(`
      SELECT has_table_privilege('cf_app', 'subscriptions', 'UPDATE') OR has_any_column_privilege('cf_app', 'subscriptions', 'UPDATE') AS upd,
             has_table_privilege('cf_identity', 'sessions', 'INSERT') AS sess`);
    if (billing.rows[0]!.upd) problems.push('cf_app can update subscriptions (billing state)');
    // Pilot enrolments and limit overrides are platform-owner decisions (migration 0011): no login role writes them.
    for (const roleName of LOGIN_ROLES) {
      const { rows } = await client.query<{ pilot: boolean; ovr: boolean }>(`
        SELECT has_table_privilege($1, 'pilot_enrolments', 'INSERT,UPDATE,DELETE,TRUNCATE') OR has_any_column_privilege($1, 'pilot_enrolments', 'INSERT,UPDATE') AS pilot,
               has_table_privilege($1, 'entitlement_overrides', 'INSERT,UPDATE,DELETE,TRUNCATE') OR has_any_column_privilege($1, 'entitlement_overrides', 'INSERT,UPDATE') AS ovr`, [roleName]);
      if (rows[0]!.pilot) problems.push(`${roleName} can write pilot enrolments`);
      if (rows[0]!.ovr) problems.push(`${roleName} can write limit overrides`);
    }
    // ...nor through a privileged function, however indirect (review of candidate 3, L-D). Writers = roles with write
    // rights on those tables, plus (repeatedly) owners of privileged functions that a writer-owned function lets
    // them run. Any privileged function a login role can run whose owner is a writer is flagged, unless it is one of
    // the two allowed signatures. No reading of function bodies, so helpers and dynamic SQL cannot hide a write.
    const writers = new Set((await client.query<{ r: string }>(
      // PostgreSQL's built-in pg_* roles are skipped: any account granted one shows up here as a writer itself.
      `SELECT r.rolname AS r FROM pg_roles r WHERE NOT r.rolsuper AND r.rolname NOT LIKE 'pg\\_%' AND (has_table_privilege(r.oid, 'pilot_enrolments', 'INSERT,UPDATE,DELETE,TRUNCATE')
         OR has_any_column_privilege(r.oid, 'pilot_enrolments', 'INSERT,UPDATE')
         OR has_table_privilege(r.oid, 'entitlement_overrides', 'INSERT,UPDATE,DELETE,TRUNCATE')
         OR has_any_column_privilege(r.oid, 'entitlement_overrides', 'INSERT,UPDATE'))`)).rows.map((x) => x.r));
    for (const w of writers) {
      if (!PILOT_TABLE_WRITERS.includes(w) && !LOGIN_ROLES.includes(w)) problems.push(`${w} can write pilot enrolments or seat overrides; only cf_pilot may`);
    }
    for (let grew = true; grew;) {
      grew = false;
      const { rows } = await client.query<{ r: string }>(`
        SELECT DISTINCT r.rolname AS r FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace CROSS JOIN pg_roles r
        WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND p.prosecdef AND p.prorettype <> 'trigger'::regtype AND NOT r.rolsuper
          AND pg_get_userbyid(p.proowner) = ANY($1::text[]) AND NOT (p.oid::regprocedure::text = ANY($2::text[]))
          AND has_function_privilege(r.oid, p.oid, 'EXECUTE')`, [[...writers], PILOT_WRITERS_ALLOWED]);
      for (const x of rows) if (!writers.has(x.r)) { writers.add(x.r); grew = true; }
    }
    const pilotWriters = await client.query<{ who: string; fn: string }>(`
      SELECT r.rolname AS who, p.oid::regprocedure::text AS fn
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace CROSS JOIN pg_roles r
      WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND p.prosecdef AND p.prorettype <> 'trigger'::regtype
        AND r.rolname = ANY($1::text[]) AND has_function_privilege(r.oid, p.oid, 'EXECUTE')
        AND pg_get_userbyid(p.proowner) = ANY($2::text[])
        AND NOT (p.oid::regprocedure::text = ANY($3::text[]))`, [LOGIN_ROLES, [...writers], PILOT_WRITERS_ALLOWED]);
    for (const w of pilotWriters.rows) problems.push(`${w.who} can run ${w.fn}, a privileged function able to write pilot or override records`);
    // Privileged trigger functions owned by a writer, on a table a login role can change (recheck of candidate 3, L-D).
    const pilotTriggers = await client.query<{ trg: string; tbl: string }>(`
      SELECT t.tgname AS trg, t.tgrelid::regclass::text AS tbl
      FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
      WHERE NOT t.tgisinternal AND p.prosecdef AND pg_get_userbyid(p.proowner) = ANY($1::text[])
        AND NOT (p.oid::regprocedure::text = ANY($3::text[]))
        AND EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname = ANY($2::text[])
                    AND (has_table_privilege(r.oid, t.tgrelid, 'INSERT,UPDATE,DELETE,TRUNCATE')
                         OR has_any_column_privilege(r.oid, t.tgrelid, 'INSERT,UPDATE')))`, [[...writers], LOGIN_ROLES, REVIEWED_TRIGGER_FUNCTIONS]);
    for (const x of pilotTriggers.rows) problems.push(`trigger ${x.trg} on ${x.tbl} runs as a role able to write pilot or override records`);
    // Rules run with the table owner's rights; none are used, so any rule is flagged. Views over the two tables too.
    const rules = await client.query<{ rule: string; tbl: string }>(`
      SELECT r.rulename AS rule, c.oid::regclass::text AS tbl FROM pg_rewrite r JOIN pg_class c ON c.oid = r.ev_class
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE r.rulename <> '_RETURN' AND n.nspname NOT IN ('pg_catalog', 'information_schema')`);
    for (const x of rules.rows) problems.push(`rule ${x.rule} on ${x.tbl}: rules are not allowed (they run with the table owner's rights)`);
    const views = await client.query<{ v: string }>(`
      SELECT DISTINCT v.oid::regclass::text AS v FROM pg_depend d JOIN pg_rewrite rw ON rw.oid = d.objid
      JOIN pg_class v ON v.oid = rw.ev_class
      WHERE d.classid = 'pg_rewrite'::regclass AND v.relkind IN ('v', 'm')
        AND d.refobjid IN ('pilot_enrolments'::regclass, 'entitlement_overrides'::regclass)`);
    for (const x of views.rows) problems.push(`view ${x.v} reads or writes pilot or override records; not allowed`);
    const allowedRunners = await client.query<{ who: string; fn: string }>(`
      SELECT r.rolname AS who, p.oid::regprocedure::text AS fn FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace CROSS JOIN pg_roles r
      WHERE n.nspname = 'public' AND p.oid::regprocedure::text = ANY($2::text[]) AND r.rolname = ANY($1::text[]) AND r.rolname <> 'cf_platform'
        AND has_function_privilege(r.oid, p.oid, 'EXECUTE')`, [LOGIN_ROLES, PILOT_WRITERS_ALLOWED]);
    for (const w of allowedRunners.rows) problems.push(`${w.who} can run ${w.fn}; only the platform console role may`);
    if (billing.rows[0]!.sess) problems.push('cf_identity can insert sessions directly; it must use auth_open_session');
    const minting = await client.query<{ who: string }>(`
      SELECT r.rolname AS who FROM pg_roles r
      WHERE r.rolname IN ('cf_app', 'cf_identity') AND has_function_privilege(r.oid, 'auth_issue_token(uuid,text,bytea,interval)', 'EXECUTE')`);
    for (const m of minting.rows) problems.push(`${m.who} can mint email tokens; only cf_notify may`);
    const codeMinting = await client.query<{ who: string }>(`
      SELECT r.rolname AS who FROM pg_roles r
      WHERE r.rolname = ANY($1::text[]) AND r.rolname <> 'cf_notify'
        AND has_function_privilege(r.oid, 'auth_mfa_issue_activation(uuid,bytea)', 'EXECUTE')`, [LOGIN_ROLES]);
    for (const m of codeMinting.rows) problems.push(`${m.who} can issue two-step confirmation codes; only cf_notify may`);
    const resetRunners = await client.query<{ who: string }>(`
      SELECT r.rolname AS who FROM pg_roles r
      WHERE r.rolname = ANY($1::text[]) AND has_function_privilege(r.oid, 'auth_mfa_reset_execute(uuid)', 'EXECUTE')`, [LOGIN_ROLES]);
    for (const m of resetRunners.rows) problems.push(`${m.who} can reset two-step sign-in directly; only the two-person console action may`);
    const notifyReads = await client.query<{ t: string }>(`
      SELECT c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname <> 'auth_email_requests'
        AND (has_table_privilege('cf_notify', c.oid, 'SELECT') OR has_any_column_privilege('cf_notify', c.oid, 'SELECT'))`);
    for (const r of notifyReads.rows) problems.push(`cf_notify can read ${r.t}; it must only see auth_email_requests`);

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
      console.log('Isolation check passed: every tenant table has forced RLS and a policy; no login role can bypass RLS; cf_app has no rights over credentials; only cf_notify can mint email tokens.');
    },
    (err) => {
      console.error(err.message);
      process.exit(1);
    },
  );
}
