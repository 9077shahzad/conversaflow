/**
 * Upgrade with data present (review of slice 3, finding 1): a database at migration 0024 that already holds a failed
 * message, an uncertain message with its retry, and a channel connection must migrate to the latest schema, with the
 * new columns backfilled. The migration owner is subject to forced row-level security, so a backfill that forgot this
 * would silently see no rows and then fail its constraint.
 *
 * Needs a superuser to create a scratch database (local harness: DATABASE_SUPERUSER_URL). Skipped elsewhere.
 */
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { migrate } from '@conversaflow/database/dist/migrate';
import { SYSTEM_ROLES } from '../src/modules/rbac';
import { firstReleasePermissions } from './permission-history';


const superUrl = process.env.DATABASE_SUPERUSER_URL;
const passwords = {
  app: process.env.CF_APP_DB_PASSWORD ?? '', identity: process.env.CF_IDENTITY_DB_PASSWORD ?? '',
  notify: process.env.CF_NOTIFY_DB_PASSWORD ?? '', platform: process.env.CF_PLATFORM_DB_PASSWORD ?? '',
};

describe.skipIf(!superUrl)('upgrading a database that already has data', () => {
  it('0024 → latest with a failed message, an uncertain message and its retry, and a connection', async () => {
    const name = `cf_upgrade_${randomUUID().slice(0, 8)}`;
    const admin = new pg.Client({ connectionString: superUrl });
    await admin.connect();
    const ownerRole = new URL(process.env.DATABASE_URL!).username;
    await admin.query(`CREATE DATABASE ${name} OWNER ${ownerRole}`);
    const ownerUrl = (() => { const u = new URL(process.env.DATABASE_URL!); u.pathname = `/${name}`; return u.toString(); })();
    const suUrl = (() => { const u = new URL(superUrl!); u.pathname = `/${name}`; return u.toString(); })();
    try {
      await migrate(ownerUrl, passwords, () => undefined, { upTo: '0024' });
      const su = new pg.Client({ connectionString: suUrl });
      await su.connect();
      const ids = { tenant: randomUUID(), conv: randomUUID(), failed: randomUUID(), uncertain: randomUUID(), retry: randomUUID() };
      // Rows as they existed under 0024: a company, a connection, a contact, a conversation and three messages.
      await su.query(`INSERT INTO tenants (id, slug, legal_name, country, timezone, currency) VALUES ($1, $2, 'Upgrade Test Co', 'SA', 'Asia/Riyadh', 'SAR')`,
        [ids.tenant, `upgrade-${ids.tenant.slice(0, 8)}`]);
      const conn = (await su.query<{ id: string }>(`INSERT INTO channel_connections (tenant_id, provider, provider_number_id, display_phone, label)
                      VALUES ($1, 'sandbox', 'pnupgrade1', '+966500000000', 'Old') RETURNING id`, [ids.tenant])).rows[0]!.id;
      const contact = (await su.query<{ id: string }>('INSERT INTO contacts (tenant_id) VALUES ($1) RETURNING id', [ids.tenant])).rows[0]!.id;
      const user = (await su.query<{ id: string }>(`INSERT INTO users (email, full_name) VALUES ($1, 'Upgrade Agent') RETURNING id`,
        [`agent-${ids.tenant.slice(0, 8)}@example.test`])).rows[0]!.id;
      const author = (await su.query<{ id: string }>('INSERT INTO memberships (tenant_id, user_id) VALUES ($1, $2) RETURNING id', [ids.tenant, user])).rows[0]!.id;
      await su.query('INSERT INTO conversations (id, tenant_id, contact_id, connection_id) VALUES ($1, $2, $3, $4)', [ids.conv, ids.tenant, contact, conn]);
      await su.query(
        `INSERT INTO messages (id, tenant_id, conversation_id, direction, kind, body, client_message_id, occurred_at, status, error_code, sent_by_membership_id) VALUES
           ($1, $3, $4, 'out', 'text', 'refused', gen_random_uuid(), now(), 'failed', '131026', $5),
           ($2, $3, $4, 'out', 'text', 'unknown', gen_random_uuid(), now(), 'uncertain', 'timeout', $5)`,
        [ids.failed, ids.uncertain, ids.tenant, ids.conv, author]);
      await su.query(
        `INSERT INTO messages (id, tenant_id, conversation_id, direction, kind, body, client_message_id, occurred_at, status, retry_of, sent_by_membership_id)
         VALUES ($1, $2, $3, 'out', 'text', 'unknown', gen_random_uuid(), now(), 'sent', $4, $5)`, [ids.retry, ids.tenant, ids.conv, ids.uncertain, author]);

      const applied = await migrate(ownerUrl, passwords, () => undefined);
      expect(applied[0]).toMatch(/^0025_/);

      const m = (await su.query<{ id: string; failure_kind: string | null; retry_root: string | null; retry_number: number }>(
        'SELECT id, failure_kind, retry_root, retry_number FROM messages')).rows;
      expect(m.find((x) => x.id === ids.failed)).toMatchObject({ failure_kind: 'rejected', retry_number: 0 });
      expect(m.find((x) => x.id === ids.uncertain)).toMatchObject({ failure_kind: null });
      expect(m.find((x) => x.id === ids.retry)).toMatchObject({ retry_root: ids.uncertain, retry_number: 1 });
      const authors = (await su.query<{ n: number }>('SELECT count(*)::int AS n FROM messages WHERE original_author_membership_id = $1', [author])).rows[0]!.n;
      expect(authors).toBe(3);
      const c = (await su.query<{ account_ref: string | null; account_id: string }>(
        'SELECT c.account_ref, a.account_id FROM channel_connections c JOIN provider_accounts a ON a.id = c.account_ref')).rows;
      expect(c).toEqual([expect.objectContaining({ account_id: 'acct-pnupgrade1' })]);
      // Row-level security is forced again on every table the backfills touched.
      const forced = (await su.query<{ relname: string; f: boolean }>(
        `SELECT relname, relforcerowsecurity AS f FROM pg_class WHERE relname IN ('messages', 'memberships', 'channel_connections', 'provider_accounts')`)).rows;
      expect(forced.every((r) => r.f)).toBe(true);
      await su.end();
    } finally {
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.end();
    }
  }, 120_000);

  it('SR-1: built-in roles of a company created before 0022 gain exactly the intended permissions; custom roles are untouched', async () => {
    const name = `cf_roles_${randomUUID().slice(0, 8)}`;
    const admin = new pg.Client({ connectionString: superUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${name} OWNER ${new URL(process.env.DATABASE_URL!).username}`);
    const ownerUrl = (() => { const u = new URL(process.env.DATABASE_URL!); u.pathname = `/${name}`; return u.toString(); })();
    const suUrl = (() => { const u = new URL(superUrl!); u.pathname = `/${name}`; return u.toString(); })();
    try {
      await migrate(ownerUrl, passwords, () => undefined, { upTo: '0021' });
      const su = new pg.Client({ connectionString: suUrl });
      await su.connect();
      const base = firstReleasePermissions();
      const tenant = randomUUID();
      await su.query(`INSERT INTO tenants (id, slug, legal_name, country, timezone, currency) VALUES ($1, $2, 'Old Co', 'SA', 'Asia/Riyadh', 'SAR')`,
        [tenant, `old-${tenant.slice(0, 8)}`]);
      // The built-in roles as a company created at 0021 had them: today's definitions minus later permissions.
      for (const [key, role] of Object.entries(SYSTEM_ROLES)) {
        const id = (await su.query<{ id: string }>('INSERT INTO roles (tenant_id, key, name, is_system) VALUES ($1, $2, $3, true) RETURNING id', [tenant, key, role.name])).rows[0]!.id;
        for (const p of role.permissions.filter((x) => base.has(x))) await su.query('INSERT INTO role_permissions (tenant_id, role_id, permission_key) VALUES ($1, $2, $3)', [tenant, id, p]);
      }
      // Two custom roles, one deliberately narrow and one named like a built-in purpose; neither may change.
      const custom: Record<string, string[]> = { qa: ['contacts.read'], night_shift: ['inbox.reply', 'contacts.read'] };
      for (const [key, perms] of Object.entries(custom)) {
        const id = (await su.query<{ id: string }>('INSERT INTO roles (tenant_id, key, name, is_system) VALUES ($1, $2, $2, false) RETURNING id', [tenant, key])).rows[0]!.id;
        for (const p of perms) await su.query('INSERT INTO role_permissions (tenant_id, role_id, permission_key) VALUES ($1, $2, $3)', [tenant, id, p]);
      }

      await migrate(ownerUrl, passwords, () => undefined);
      const rows = (await su.query<{ key: string; is_system: boolean; perms: string[] }>(
        `SELECT r.key, r.is_system, coalesce(array_agg(rp.permission_key ORDER BY rp.permission_key) FILTER (WHERE rp.permission_key IS NOT NULL), '{}') AS perms
         FROM roles r LEFT JOIN role_permissions rp ON rp.role_id = r.id WHERE r.tenant_id = $1 GROUP BY r.key, r.is_system`, [tenant])).rows;
      for (const [key, role] of Object.entries(SYSTEM_ROLES)) {
        expect(rows.find((r) => r.key === key)!.perms, key).toEqual([...role.permissions].sort());
      }
      for (const [key, perms] of Object.entries(custom)) expect(rows.find((r) => r.key === key)!.perms, key).toEqual([...perms].sort());
      // Running the step again (as later migrations will) changes nothing.
      const before = (await su.query('SELECT count(*)::int AS n FROM role_permissions')).rows[0].n;
      await su.query(`INSERT INTO role_permissions (tenant_id, role_id, permission_key)
        SELECT r.tenant_id, r.id, g.permission_key FROM roles r JOIN system_role_grants g ON g.role_key = r.key WHERE r.is_system ON CONFLICT DO NOTHING`);
      expect((await su.query('SELECT count(*)::int AS n FROM role_permissions')).rows[0].n).toBe(before);
      await su.end();
    } finally {
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.end();
    }
  }, 120_000);
});
