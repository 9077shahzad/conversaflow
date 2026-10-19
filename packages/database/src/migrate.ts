/**
 * Applies SQL migrations in order, as the owner role (DATABASE_URL).
 * Creates the two restricted roles first:
 *   cf_app  — used by the API and worker; owns nothing, cannot bypass row-level security.
 *   cf_auth — NOLOGIN; owns the few authentication functions that run before a user is known.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';

const migrationsDir = join(__dirname, '..', 'migrations');

export async function migrate(ownerUrl: string, appPassword: string, log = console.log): Promise<string[]> {
  const client = new pg.Client({ connectionString: ownerUrl });
  await client.connect();
  const applied: string[] = [];
  try {
    await bootstrapRoles(client, appPassword);
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

async function bootstrapRoles(client: pg.Client, appPassword: string): Promise<void> {
  if (!appPassword || appPassword.length < 12) throw new Error('CF_APP_DB_PASSWORD must be set (12+ characters).');
  const exists = async (role: string) =>
    (await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role])).rowCount === 1;

  if (!(await exists('cf_app'))) {
    const { rows } = await client.query<{ sql: string }>(
      "SELECT format('CREATE ROLE cf_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD %L', $1::text) AS sql",
      [appPassword],
    );
    await client.query(rows[0]!.sql);
  }
  if (!(await exists('cf_auth'))) {
    await client.query('CREATE ROLE cf_auth NOLOGIN NOSUPERUSER NOBYPASSRLS');
  }
  // The owner must be able to hand function ownership to cf_auth.
  const { rows: me } = await client.query<{ u: string; db: string }>('SELECT current_user AS u, current_database() AS db');
  // Identifiers come from the server itself and are escaped; GRANT cannot take bind parameters.
  // eslint-disable-next-line no-restricted-syntax
  await client.query(`GRANT cf_auth TO ${pg.escapeIdentifier(me[0]!.u)}`);
  // eslint-disable-next-line no-restricted-syntax
  await client.query(`GRANT CONNECT ON DATABASE ${pg.escapeIdentifier(me[0]!.db)} TO cf_app`);
}

if (require.main === module) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set');
    process.exit(1);
  }
  migrate(url, process.env.CF_APP_DB_PASSWORD ?? '').catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
