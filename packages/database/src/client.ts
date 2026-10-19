import pg from 'pg';

export type Db = pg.Pool;
export type Tx = pg.PoolClient;

export interface RequestContext {
  tenantId: string | null;
  userId: string | null;
}

export function createPool(connectionString: string, max = 10): Db {
  return new pg.Pool({ connectionString, max, application_name: 'conversaflow' });
}

/**
 * Runs `fn` inside one transaction with the company and user context set.
 * The settings are transaction-local (set_config(..., true)), so they vanish at COMMIT or ROLLBACK and
 * cannot leak to the next request that borrows the same pooled connection.
 * Every database access from the API and worker goes through this function.
 */
export async function withContext<T>(db: Db, ctx: RequestContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)",
      [ctx.tenantId ?? '', ctx.userId ?? ''],
    );
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Anonymous access: no company, no user. Only the narrow authentication functions work here. */
export function withAnonymous<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withContext(db, { tenantId: null, userId: null }, fn);
}
