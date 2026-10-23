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
/**
 * Privileged trigger functions reviewed and allowed although their owner could write those tables. Each is pinned to
 * the md5 of its whole reviewed definition plus owner, so changing the body, search_path, security mode, language or
 * owner fails the check until it is reviewed again.
 * All four only read and raise an error; none writes.
 */
const REVIEWED_TRIGGER_FUNCTIONS: Record<string, string> = {
  'subscription_new_is_trial()': '163ea6cbdfa8f6081168bc31f0b289ba',
  'subscription_requires_published_version()': '91d8dcefb333593401818e36724de217',
  'plan_version_frozen()': 'd73bdba3ac8a68ba549b73a4f67572e0',
  'plan_entitlement_frozen()': '43b3204094b27f3fd863f73862cde1e0',
};

/**
 * Roles other than cf_app (company context, row-level security) and the table owner that may read company-owned
 * tables, and exactly which ones. Anything else is flagged: a new grant, a PUBLIC grant, or inherited membership
 * (open Low finding from the review of messaging slice 1, "M5-general").
 */
const COMPANY_TABLE_READERS: Record<string, string[]> = {
  cf_auth: ['invitations'],
  // customer_links: routing columns of links neither revoked nor expired (migration 0051, W2.4)
  cf_channel: ['channel_connections', 'provider_accounts', 'customer_links'],
  // import_batches: only unimported previews older than a day, so their rows can be emptied (migration 0041)
  // webhook_events: scheduling columns of events not yet applied, so the worker can lease them (migration 0042)
  // workflow_runs: scheduling columns of automation runs under way (migration 0045)
  cf_dispatch: ['send_jobs', 'media_jobs', 'campaigns', 'import_batches', 'webhook_events', 'workflow_runs'],
  cf_identity: ['memberships'],
  cf_ops: ['audit_events', 'files', 'memberships', 'subscriptions', 'support_access_grants', 'tenant_feature_flags'],
  cf_pilot: ['entitlement_overrides', 'invitations', 'pilot_enrolments'],
};
/**
 * Privileged (SECURITY DEFINER) functions that a login role may run although their owner can read company tables.
 * Each was reviewed and is pinned to md5(pg_get_functiondef || owner): a new function, or a changed body, setting,
 * security mode or owner, fails the check until it is reviewed again and its fingerprint updated here (review S2b).
 */
const REVIEWED_DEFINERS: Record<string, string> = {
  // cf_auth: sign-in, sessions, two-step sign-in (ADR-018, ADR-027, M7)
  'auth_verify_email(bytea)': 'fba376647d794ccc1a6e46d6497e0eee',
  'auth_mfa_issue_activation(uuid,bytea)': '349aaf88e8d5a8951ff37b53b3d1707e',
  'auth_mfa_activate(bytea,bytea,bytea[])': '2f71e3429db7daeaed600503c15784e4',
  'auth_session_lookup(bytea,interval)': '5900a8b97a701c9a79ff13fd8cf98ef5',
  'auth_open_session(uuid,bytea,uuid,inet,text,integer)': '2b0d7510860af5262ee599de3db704fb',
  'auth_user_for_email(citext)': '3f6eda7e87db1958124199f0ece2f757',
  'auth_mfa_begin(bytea)': '1302c15bb8a72ceb5c28cd2089404ff5',
  'auth_mfa_verify(bytea,text,bytea)': 'f677e0b99f8f78369c0368aa959aa9d9',
  'auth_request_email(text,citext)': '67cd6499e436b77501b04d82670e9e09',
  'auth_issue_token(uuid,text,bytea,interval)': '23ef60aa60df3cde5b6b08fbb6b8f5ac',
  'auth_mfa_confirm_code(bytea,text)': '7874df0c51d552488181c35533eba72c',
  'auth_invitation_lookup(bytea)': 'd9388ceb82588097360d86f371feda98',
  'auth_reset_password(bytea,text)': 'f3b28604b33f291693b20a51daba280d',
  'auth_register_user(citext,text,text,text)': 'ddb234e8bed7d21f6f94c7f57e1a6de0',
  'auth_credentials_by_email(citext)': '1e4d86ed8eeaa294cbd6833d2a24ae8c',
  // cf_ops: token-bound platform console functions
  'platform_publish_plan_version(text,uuid)': 'c8dc325566e3323e5e9c3e57b3dc32e9',
  'platform_set_feature_flag(text,uuid,text,boolean)': 'd644f2d6ea9877f3af6bf1db690c9984',
  'platform_session_staff(text)': '40c37f4461174fd710e6272300c1b458',
  'platform_tenant_directory(text)': '0d48e18c89740b0d69e1d3021622a6a7',
  'platform_request_support(text,uuid,text,integer)': '0f7fe23e05998bcda60c251081a6b754',
  'platform_approve_support(text,uuid)': 'f75b34b0c0eba9efef3dc91aa4f2c8d8',
  'platform_revoke_support(text,uuid)': '4813c745f3e35d9540f2c1c43614c23d',
  'platform_support_view(text,uuid,text)': '550184596db8ae12c98afc345210866b',
  'platform_request_mfa_reset(text,citext,text,text,text)': '71df91e25aa0a5f7bd763cbbbc0e8089',
  'platform_reject_mfa_reset(text,uuid)': '84f902e85b14f150aa28bf3f3974b8fa',
  'platform_approve_mfa_reset(text,uuid)': '366d7f9c2dea44eb48383f20dbcfaf53',
  'platform_list_mfa_resets(text)': '445d72949f31ccfb0b54225f88914af0',
  // cf_pilot: pilot console functions (pinned separately as pilot writers)
  'platform_enrol_pilot(text,uuid,integer,integer,text)': '6d9de15d286d796bc0a3ce2cac3872b4',
  'platform_end_pilot(text,uuid)': '69b709e495681c1089cc0496251b5535',
  // cf_owner: billing and plan triggers (pinned by definition in REVIEWED_TRIGGER_FUNCTIONS)
  'subscription_requires_published_version()': '91d8dcefb333593401818e36724de217',
  'plan_version_frozen()': 'd73bdba3ac8a68ba549b73a4f67572e0',
  'subscription_new_is_trial()': '163ea6cbdfa8f6081168bc31f0b289ba',
  'plan_entitlement_frozen()': '43b3204094b27f3fd863f73862cde1e0',
  // cf_channel and cf_dispatch: webhook routing and send-job leasing (migrations 0022, 0024)
  'channel_route(text,text)': '1df6e4008edea1274471be11593aa226',
  'account_route(text,text)': '19be2ce700975b7c99cf8520ccb99891',
  // cf_channel: customer page links (migration 0051, W2.4)
  'customer_link_route(bytea)': '7cef33f7719ff13769f9e0fc3cdd16a2',
  'dispatch_claim(integer,integer)': '69cd1d0ac8475917c80b9676b32d79b4',
  'media_claim(integer,integer)': '60252793661bcad14021c70cf1292897',
  'campaign_claim(integer,integer)': '67d00d321cc9f4d3ad02f8ec88136888',
  // cf_dispatch: clears contact import previews older than a day, for every company (migration 0041)
  'import_previews_expire(integer)': '7555cd7701daf9603bf2345c4d5a1a5f',
  // cf_dispatch: leases incoming webhook events for the worker, at most 50 per company per lease (0042, 0044, 0046)
  'inbound_claim(integer,integer)': '9e7a118f3009f851b1736f0f62dd3658',
  // cf_dispatch: leases automation runs for the worker, at most 20 per company per lease (0045, 0048)
  'automation_claim(integer,integer)': 'e7941674d3d76974a0cf7e67e814cf90',
};
/** Company tables on which the table owner has its own policy (used by billing and audit triggers; reviewed). */
const OWNER_POLICY_TABLES = ['audit_events', 'entitlement_overrides', 'subscriptions'];
/**
 * Permissive policies for the business role (or PUBLIC) that are not the standard company rule
 * `tenant_id = app_tenant_id()`. PostgreSQL ORs permissive policies together, so one extra loose policy cancels
 * company isolation (review S2c). Each was reviewed and is pinned to md5(command | USING | WITH CHECK | roles); a new
 * one, or a changed expression, command or role list, fails the check until it is reviewed again.
 */
const REVIEWED_APP_POLICIES: Record<string, string> = {
  'memberships.memberships_read': '9f18ae1b8f8e795aabcf4eb23503d27b',
  'mfa_factors.mfa_self': 'bae3235b9f650c7a6ef556a5b2ed4887',
  'mfa_recovery_codes.recovery_self': 'bae3235b9f650c7a6ef556a5b2ed4887',
  'sessions.sessions_self': 'bae3235b9f650c7a6ef556a5b2ed4887',
  'tenants.tenants_insert': 'e811d7fae216074e8bb3e52699234e11',
  'tenants.tenants_read': 'dd63bf50e45075bdc49b1473d4fae305',
  'tenants.tenants_update': '380986229f8fbae8b289b299746132ab',
  'user_credentials.credentials_self': 'bae3235b9f650c7a6ef556a5b2ed4887',
  'users.users_read': '6efcc22321ab3bd8ec41d2ea38a58ee3',
  'users.users_self_update': '843978d964e680ac6bf8348a5ea6f7b6',
};
const STANDARD_COMPANY_RULE = '(tenant_id = app_tenant_id())';
/**
 * Tables without a tenant_id column, reviewed as shared or identity tables (rule 8). Any other table without that
 * column is flagged, so company data copied into a new untagged table (CREATE TABLE ... AS SELECT) cannot hide from
 * the company-table rules (slice 2 recheck note, identifier S2-N2).
 */
const SHARED_TABLES = [
  'auth_email_requests', 'auth_keys', 'auth_tokens', 'feature_flags', 'mfa_activation_codes', 'mfa_attempts', 'mfa_factors',
  'mfa_recovery_codes', 'mfa_reset_requests', 'permissions', 'plan_entitlements', 'plan_versions', 'plans', 'platform_audit_events',
  'platform_staff', 'provider_allowances', 'provider_rates', 'retention_policies', 'schema_migrations', 'sessions', 'tenants',
  'trial_caps', 'trial_policy', 'user_credentials', 'users', 'system_role_grants',
];
/**
 * Non-built-in functions called by any row-security policy, pinned to md5(pg_get_functiondef || owner). Replacing
 * app_tenant_id() would change what every company policy means without changing its text (review S2d).
 */
const REVIEWED_POLICY_FUNCTIONS: Record<string, string> = {
  'app_tenant_id()': 'a95dafefef52596f5626256da15e70a6',
  'app_user_id()': '105e6a33eb37c1cb5d012bcaa8223a86',
};
/** The only columns cf_channel may read: numbers (migration 0022) and business accounts (migration 0026). */
const CHANNEL_ROUTING_COLUMNS: Record<string, string[]> = {
  channel_connections: ['id', 'tenant_id', 'provider', 'provider_number_id', 'status'],
  provider_accounts: ['id', 'tenant_id', 'provider', 'account_id', 'status'],
  customer_links: ['id', 'tenant_id', 'contact_id', 'conversation_id', 'token_hash', 'expires_at', 'revoked_at'],
};
/** The only functions cf_channel may own, pinned to the md5 of their reviewed definitions. */
const CHANNEL_FUNCTIONS: Record<string, string> = {
  'channel_route(text,text)': '36b3b2385d8d3b07fd294ab6aa8033b7',
  'account_route(text,text)': '771c221d8b88a73a47dee069b8430bd5',
  'customer_link_route(bytea)': 'acd109038d1099b623bb9298abae02ee',
};

export async function checkIsolation(ownerUrl: string): Promise<string[]> {
  const client = new pg.Client({ connectionString: ownerUrl });
  await client.connect();
  // Fixed search path, so a function or operator planted in an earlier schema (e.g. "$user") cannot make a policy
  // print as the standard rule while calling something else (review S2d).
  await client.query('SET search_path = pg_catalog, public');
  const problems: string[] = [];
  try {
    // Every table holding company rows (a tenant_id column), in ANY schema, ordinary or partitioned, must have forced
    // row-level security and a policy; company data may live only in schema public, and never in a foreign table
    // (review of slice 3, finding 4: the rule used to look at ordinary tables in public only).
    const tenantTables = await client.query<{ table: string; schema: string; kind: string; rls: boolean; forced: boolean; policies: number }>(`
      SELECT c.oid::regclass::text AS table, n.nspname AS schema, c.relkind::text AS kind, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
             (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname <> 'information_schema' AND n.nspname NOT LIKE 'pg\\_%' AND c.relkind IN ('r', 'p', 'f')
        AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)`);
    for (const t of tenantTables.rows) {
      if (t.kind === 'f') { problems.push(`${t.table}: a foreign table with tenant_id; company data may not live outside this database`); continue; }
      if (t.schema !== 'public') problems.push(`${t.table}: has tenant_id outside schema public; company data may live only in public`);
      if (!t.rls) problems.push(`${t.table}: has tenant_id but row-level security is not enabled`);
      if (!t.forced) problems.push(`${t.table}: row-level security is not FORCED`);
      if (t.policies === 0) problems.push(`${t.table}: no RLS policy defined`);
    }

    const unforced = await client.query<{ table: string }>(`
      SELECT c.oid::regclass::text AS table FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname <> 'information_schema' AND n.nspname NOT LIKE 'pg\\_%' AND c.relkind IN ('r', 'p') AND c.relrowsecurity AND NOT c.relforcerowsecurity`);
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
    // Privileged trigger functions owned by a writer, on any table, unless reviewed (recheck of candidate 3, L-D and G2).
    const pilotTriggers = await client.query<{ trg: string; tbl: string }>(`
      SELECT t.tgname AS trg, t.tgrelid::regclass::text AS tbl
      FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
      -- on ANY table: a privileged function may write a table no login role can (final recheck of candidate 3, G2)
      WHERE NOT t.tgisinternal AND p.prosecdef AND pg_get_userbyid(p.proowner) = ANY($1::text[])
        -- pinned to the whole definition (body, settings such as search_path, SECURITY DEFINER, language) and the
        -- owner, so changing any of them fails the check (targeted recheck of 6f78a89)
        AND coalesce($2::jsonb ->> (p.oid::regprocedure::text), '') <> md5(pg_get_functiondef(p.oid) || pg_get_userbyid(p.proowner))`, [[...writers], JSON.stringify(REVIEWED_TRIGGER_FUNCTIONS)]);
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

    // cf_channel (migration 0022) routes webhooks to a company. It may read exactly the routing columns of
    // channel_connections and own exactly the reviewed channel_route() function; anything wider is flagged
    // (review of messaging slice 1, M5).
    const chanTables = await client.query<{ t: string }>(`
      SELECT c.oid::regclass::text AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND c.relkind IN ('r', 'v', 'm', 'p', 'f')
        AND (has_table_privilege('cf_channel', c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
             OR (NOT (c.relname = ANY($1::name[])) AND has_any_column_privilege('cf_channel', c.oid, 'SELECT, INSERT, UPDATE, REFERENCES')))`,
      [Object.keys(CHANNEL_ROUTING_COLUMNS)]);
    for (const r of chanTables.rows) problems.push(`cf_channel has privileges on ${r.t}; it may only read the routing columns of channel_connections and provider_accounts`);
    for (const [table, cols] of Object.entries(CHANNEL_ROUTING_COLUMNS)) {
      const chanCols = await client.query<{ col: string }>(`
        SELECT a.attname AS col FROM pg_attribute a
        WHERE a.attrelid = to_regclass($2) AND a.attnum > 0 AND NOT a.attisdropped
          AND (has_column_privilege('cf_channel', a.attrelid, a.attnum, 'INSERT, UPDATE, REFERENCES')
               OR (NOT (a.attname = ANY($1::name[])) AND has_column_privilege('cf_channel', a.attrelid, a.attnum, 'SELECT')))`,
        [cols, `public.${table}`]);
      for (const r of chanCols.rows) problems.push(`cf_channel has more than read access on ${table}.${r.col}`);
    }
    const chanOwned = await client.query<{ what: string; ok: boolean }>(`
      SELECT p.oid::regprocedure::text AS what,
             coalesce($1::jsonb ->> (p.oid::regprocedure::text), '') = md5(pg_get_functiondef(p.oid)) AS ok
      FROM pg_proc p WHERE pg_get_userbyid(p.proowner) = 'cf_channel'
      UNION ALL
      SELECT c.oid::regclass::text, false FROM pg_class c WHERE pg_get_userbyid(c.relowner) = 'cf_channel'`,
      [JSON.stringify(CHANNEL_FUNCTIONS)]);
    for (const o of chanOwned.rows) if (!o.ok) problems.push(`cf_channel owns ${o.what}, which is not a reviewed routing function`);
    const chanMember = await client.query(
      `SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member WHERE r.rolname = 'cf_channel'`);
    if ((chanMember.rowCount ?? 0) > 0) problems.push('cf_channel is a member of another role; it must not inherit privileges');

    // General rule 1: who may read company tables at all.
    const readers = await client.query<{ who: string; t: string }>(`
      WITH company_tables AS (
        SELECT c.oid, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
          AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped))
      SELECT r.rolname AS who, t.relname AS t FROM pg_roles r CROSS JOIN company_tables t
      WHERE NOT r.rolsuper AND r.rolname NOT LIKE 'pg\\_%' AND r.rolname NOT IN ('cf_app', current_user)
        AND (has_table_privilege(r.oid, t.oid, 'SELECT') OR has_any_column_privilege(r.oid, t.oid, 'SELECT'))`);
    for (const r of readers.rows) {
      if (!(COMPANY_TABLE_READERS[r.who] ?? []).includes(r.t)) problems.push(`${r.who} can read company table ${r.t}; it is not on the reviewed list`);
    }
    // General rule 2: privileged functions a login role can run, whose owner can read company tables.
    const exposed = await client.query<{ fn: string; owner: string; hash: string }>(`
      SELECT DISTINCT p.oid::regprocedure::text AS fn, pg_get_userbyid(p.proowner) AS owner,
             md5(pg_get_functiondef(p.oid) || pg_get_userbyid(p.proowner)) AS hash
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND p.prosecdef
        AND (pg_get_userbyid(p.proowner) = ANY($1::text[]) OR pg_get_userbyid(p.proowner) = current_user)
        AND EXISTS (SELECT 1 FROM pg_roles l WHERE l.rolname = ANY($2::text[]) AND has_function_privilege(l.oid, p.oid, 'EXECUTE'))`,
      [Object.keys(COMPANY_TABLE_READERS), LOGIN_ROLES]);
    for (const f of exposed.rows) {
      if (!(f.fn in REVIEWED_DEFINERS)) problems.push(`${f.fn} (owned by ${f.owner}) is a privileged function a login role can run; it is not on the reviewed list`);
      else if (REVIEWED_DEFINERS[f.fn] !== f.hash) problems.push(`${f.fn} has changed since it was reviewed (definition or owner)`);
    }
    // General rule 3: policies on company tables may only target the business role, listed readers on their listed
    // tables, or the reviewed owner policies used by triggers (review S2a: an owner policy is the gateway for a view).
    const policies = await client.query<{ t: string; pol: string; who: string }>(`
      SELECT c.relname AS t, p.polname AS pol,
             CASE WHEN r.r = 0 THEN 'PUBLIC' WHEN pg_get_userbyid(r.r) = current_user THEN '<owner>' ELSE pg_get_userbyid(r.r) END AS who
      FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid CROSS JOIN LATERAL unnest(p.polroles) AS r(r)
      WHERE EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)`);
    for (const p of policies.rows) {
      const ok = p.who === 'cf_app'
        || (COMPANY_TABLE_READERS[p.who] ?? []).includes(p.t)
        || (p.who === '<owner>' && OWNER_POLICY_TABLES.includes(p.t));
      if (!ok) problems.push(`policy ${p.pol} on company table ${p.t} applies to ${p.who}; it is not on the reviewed list`);
    }
    // General rule 5 (review S2c): every permissive policy the business role is subject to (directly or via PUBLIC)
    // must be the standard company rule or a reviewed, pinned exception. Restrictive policies only narrow access.
    const appPolicies = await client.query<{ key: string; std: boolean; hash: string }>(`
      SELECT c.relname || '.' || p.polname AS key,
             (coalesce(pg_get_expr(p.polqual, p.polrelid), $1) = $1 AND coalesce(pg_get_expr(p.polwithcheck, p.polrelid), $1) = $1) AS std,
             md5(p.polcmd::text || '|' || coalesce(pg_get_expr(p.polqual, p.polrelid), '') || '|' || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')
                 || '|' || (SELECT string_agg(CASE WHEN r = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(r) END, ',' ORDER BY 1) FROM unnest(p.polroles) AS u(r))) AS hash
      FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE p.polpermissive AND (0 = ANY(p.polroles) OR 'cf_app'::regrole = ANY(p.polroles))`, [STANDARD_COMPANY_RULE]);
    for (const p of appPolicies.rows) {
      if (p.std) continue;
      if (!(p.key in REVIEWED_APP_POLICIES)) problems.push(`policy ${p.key} widens what the business role can see; it is not the standard company rule and not on the reviewed list`);
      else if (REVIEWED_APP_POLICIES[p.key] !== p.hash) problems.push(`policy ${p.key} has changed since it was reviewed`);
    }
    // General rule 6 (review S2d): functions and operators used inside policies must be reviewed built-ins or pinned.
    const policyFns = await client.query<{ fn: string; hash: string }>(`
      SELECT DISTINCT pr.oid::regprocedure::text AS fn, md5(pg_get_functiondef(pr.oid) || pg_get_userbyid(pr.proowner)) AS hash
      FROM pg_policy p JOIN pg_depend d ON d.classid = 'pg_policy'::regclass AND d.objid = p.oid AND d.refclassid = 'pg_proc'::regclass
      JOIN pg_proc pr ON pr.oid = d.refobjid WHERE pr.pronamespace <> 'pg_catalog'::regnamespace`);
    for (const f of policyFns.rows) {
      if (!(f.fn in REVIEWED_POLICY_FUNCTIONS)) problems.push(`function ${f.fn} is used by a row-security policy; it is not on the reviewed list`);
      else if (REVIEWED_POLICY_FUNCTIONS[f.fn] !== f.hash) problems.push(`function ${f.fn} used by row-security policies has changed since it was reviewed (definition or owner)`);
    }
    for (const [fn, hash] of Object.entries(REVIEWED_POLICY_FUNCTIONS)) {
      const r = await client.query<{ hash: string | null }>(
        `SELECT (SELECT md5(pg_get_functiondef(p.oid) || pg_get_userbyid(p.proowner)) FROM pg_proc p WHERE p.oid = to_regprocedure($1)) AS hash`, [fn]);
      if (r.rows[0]!.hash !== hash) problems.push(`function ${fn} used by row-security policies has changed since it was reviewed (definition or owner)`);
    }
    const policyOps = await client.query<{ op: string }>(`
      SELECT DISTINCT o.oid::regoperator::text AS op
      FROM pg_policy p JOIN pg_depend d ON d.classid = 'pg_policy'::regclass AND d.objid = p.oid AND d.refclassid = 'pg_operator'::regclass
      JOIN pg_operator o ON o.oid = d.refobjid WHERE o.oprnamespace <> 'pg_catalog'::regnamespace`);
    for (const o of policyOps.rows) problems.push(`operator ${o.op} used by a row-security policy is not built in; not allowed`);
    // General rule 7 (slice 2 recheck note, identifier S2-N1): no role-level or database-level default for the
    // settings that carry the company and user context (app.*). The API sets them at the start of every transaction,
    // but a default would apply to any connection that forgot to.
    const contextDefaults = await client.query<{ who: string; setting: string }>(`
      SELECT coalesce(r.rolname, '(all roles)') || ' in ' || coalesce(d.datname, '(all databases)') AS who, cfg AS setting
      FROM pg_db_role_setting s LEFT JOIN pg_roles r ON r.oid = s.setrole LEFT JOIN pg_database d ON d.oid = s.setdatabase
      CROSS JOIN LATERAL unnest(s.setconfig) AS cfg
      WHERE cfg ILIKE 'app.%'`);
    for (const x of contextDefaults.rows) problems.push(`a default for ${x.setting.split('=')[0]} is set for ${x.who}; company context settings must never have defaults`);

    // General rule 8 (S2-N2): every table without tenant_id must be a reviewed shared table.
    const untagged = await client.query<{ t: string }>(`
      SELECT c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname <> 'information_schema' AND n.nspname NOT LIKE 'pg\\_%'
        AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
        AND NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)
        AND NOT (n.nspname = 'public' AND c.relname = ANY($1::name[]))`, [SHARED_TABLES]);
    for (const x of untagged.rows) problems.push(`table ${x.t} has no tenant_id and is not on the reviewed list of shared tables`);

    // General rule 4: no view or materialised view may be built over a company table (views run with their owner's
    // rights and would bypass company row security for whoever can read the view).
    const companyViews = await client.query<{ v: string; t: string }>(`
      SELECT DISTINCT v.oid::regclass::text AS v, t.relname AS t
      FROM pg_class v JOIN pg_rewrite rw ON rw.ev_class = v.oid JOIN pg_depend d ON d.objid = rw.oid JOIN pg_class t ON t.oid = d.refobjid
      WHERE v.relkind IN ('v', 'm') AND t.oid <> v.oid AND t.relkind IN ('r', 'p')
        AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = t.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)`);
    for (const v of companyViews.rows) problems.push(`view ${v.v} reads company table ${v.t}; views over company tables are not allowed`);

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
