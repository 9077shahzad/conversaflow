/**
 * Worker process — scaffold only (Milestone 1).
 * From Phase 2 it consumes the job queue (BullMQ on Redis, fed by a transactional outbox).
 * Rule for every job: it carries tenant_id, and all database work runs inside
 * withContext({ tenantId, userId: null }) so row-level security applies exactly as in the API.
 */
import { createPool, withContext } from '@conversaflow/database';

export async function runTenantJob<T>(databaseUrl: string, tenantId: string, job: Parameters<typeof withContext<T>>[2]): Promise<T> {
  const db = createPool(databaseUrl, 2);
  try {
    return await withContext(db, { tenantId, userId: null }, job);
  } finally {
    await db.end();
  }
}

if (require.main === module) {
  console.log('ConversaFlow worker: no job types are enabled in Milestone 1.');
}
