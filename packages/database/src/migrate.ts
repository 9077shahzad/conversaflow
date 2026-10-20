/**
 * Applies SQL migrations in order, as the owner role (DATABASE_URL).
 * Creates the restricted roles first (none owns tables, none can bypass row-level security):
 *   cf_app      — API business data (companies, members, files, …). No rights over credentials.
 *   cf_identity — sign-in, sessions and MFA, through a few narrow functions.
 *   cf_notify   — the notifier worker: the only role that can issue email verification / reset tokens.
 *   cf_platform — platform owner console: company metadata; content only under an approved support grant.
 *   cf_auth     — NOLOGIN; owns the authentication functions.
 *   cf_ops      — NOLOGIN; owns the platform functions.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';

const migrationsDir = join(__dirname, '..', 'migrations');

export async function migrate(ownerUrl: string, passwords: RolePasswords, log = console.log): Promise<string[]> {
  const client = new pg.Client({ connectionString: ownerUrl });
  await client.connect();
  const applied: string[] = [];
  try {
    await bootstrapRoles(client, passwords);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Map<string, string>(
      (await client.query<{ filename: string; checksum: string }>('SELECT filename, checksum FROM schema_migrations')).rows.map(
        (r) => [r.filename, r.checksum],
      ),
    );
    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      const sql = await readFile(join(migrationsDir, file), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const previous = done.get(file);
      if (previous) {
        if (previous !== checksum) throw new Error(`Migration ${file} was changed after it was applied. Add a new migration instead.`);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)', [file, checksum]);
        await client.query('COMMIT');
        applied.push(file);
        log(`applied ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
    }
    if (applied.length === 0) log('database is up to date');
    return applied;
  } finally {
    await client.end();
  }
}

export interface RolePasswords {
  app: string; // cf_app: API business data
  identity: string; // cf_identity: sign-in, sessions, MFA
  notify: string; // cf_notify: issues email tokens and sends account emails
  platform: string; // cf_platform: platform owner console (metadata; content only under an approved support grant)
}

async function bootstrapRoles(client: pg.Client, passwords: RolePasswords): Promise<void> {
  const exists = async (role: string) =>
    (await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role])).rowCount === 1;
  const loginRoles: Array<[string, string, string]> = [
    ['cf_app', passwords.app, 'CF_APP_DB_PASSWORD'],
    ['cf_identity', passwords.identity, 'CF_IDENTITY_DB_PASSWORD'],
    ['cf_notify', passwords.notify, 'CF_NOTIFY_DB_PASSWORD'],
    ['cf_platform', passwords.platform, 'CF_PLATFORM_DB_PASSWORD'],
  ];
  for (const [role, password, envName] of loginRoles) {
    if (!password || password.length < 12) throw new Error(`${envName} must be set (12+ characters).`);
    if (await exists(role)) continue;
    const { rows } = await client.query<{ sql: string }>(
      "SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD %L', $1::text, $2::text) AS sql",
      [role, password],
    );
    await client.query(rows[0]!.sql);
  }
  // cf_pilot (migration 0018) alone may write pilot enrolments and seat overrides, through two console functions.
  // cf_channel (migration 0022) owns the one lookup that routes an incoming webhook to its company; it can read
  // the channel routing columns and nothing else.
  for (const owner of ['cf_auth', 'cf_ops', 'cf_pilot', 'cf_channel']) {
    // eslint-disable-next-line no-restricted-syntax
    if (!(await exists(owner))) await client.query(`CREATE ROLE ${pg.escapeIdentifier(owner)} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
  }
  // The owner must be able to hand function ownership to cf_auth.
  const { rows: me } = await client.query<{ u: string; db: string }>('SELECT current_user AS u, current_database() AS db');
  // Identifiers come from the server itself and are escaped; GRANT cannot take bind parameters.
  // eslint-disable-next-line no-restricted-syntax
  await client.query(`GRANT cf_auth, cf_ops, cf_pilot, cf_channel TO ${pg.escapeIdentifier(me[0]!.u)}`);
  for (const [role] of loginRoles) {
    // eslint-disable-next-line no-restricted-syntax
    await client.query(`GRANT CONNECT ON DATABASE ${pg.escapeIdentifier(me[0]!.db)} TO ${pg.escapeIdentifier(role)}`);
  }
}

if (require.main === module) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set');
    process.exit(1);
  }
  migrate(url, {
    app: process.env.CF_APP_DB_PASSWORD ?? '',
    identity: process.env.CF_IDENTITY_DB_PASSWORD ?? '',
    notify: process.env.CF_NOTIFY_DB_PASSWORD ?? '',
    platform: process.env.CF_PLATFORM_DB_PASSWORD ?? '',
  }).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
