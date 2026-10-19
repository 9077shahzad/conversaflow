import { withContext, type Tx } from '@conversaflow/database';
import type { Deps, TenantActor } from '../core/context';

export interface AuditEntry {
  tenantId: string;
  actorUserId: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  ip?: string;
  metadata?: Record<string, unknown>;
}

export class AuditService {
  constructor(private readonly deps: Deps) {}

  /** Writes inside the caller's transaction, so the audit row and the change commit or fail together. */
  static async record(tx: Tx, e: AuditEntry): Promise<void> {
    await tx.query(
      `INSERT INTO audit_events (tenant_id, actor_user_id, action, target_type, target_id, ip, metadata, hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, ''::bytea)`,
      [e.tenantId, e.actorUserId, e.action, e.targetType ?? null, e.targetId ?? null, e.ip ?? null, JSON.stringify(e.metadata ?? {})],
    );
  }

  async list(actor: TenantActor, limit = 50, beforeSeq?: number) {
    return withContext(this.deps.db, actor, async (tx) => {
      const { rows } = await tx.query(
        `SELECT seq, actor_user_id AS "actorUserId", action, target_type AS "targetType", target_id AS "targetId",
                metadata, created_at AS "createdAt"
         FROM audit_events WHERE ($1::bigint IS NULL OR seq < $1) ORDER BY seq DESC LIMIT $2`,
        [beforeSeq ?? null, Math.min(Math.max(limit, 1), 200)],
      );
      return rows;
    });
  }

  /** Returns the first broken sequence number, or null when the chain is intact. */
  async verify(actor: TenantActor): Promise<{ intact: boolean; firstBrokenSeq: number | null }> {
    return withContext(this.deps.db, actor, async (tx) => {
      const { rows } = await tx.query<{ broken: string | null }>('SELECT audit_verify_chain() AS broken');
      const broken = rows[0]?.broken;
      return { intact: broken == null, firstBrokenSeq: broken == null ? null : Number(broken) };
    });
  }
}
