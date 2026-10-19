import { withContext } from '@conversaflow/database';
import { CreateTenantRequest, SwitchTenantRequest, UpdateTenantRequest } from '@conversaflow/contracts';
import type { AuthSession, Deps, TenantActor } from '../core/context';
import { Errors } from '../core/errors';
import { parse } from '../core/validate';
import { AuditService } from './audit.service';
import { createSystemRoles } from './rbac';

const TENANT_COLUMNS = `id, slug, legal_name AS "legalName", country, timezone, currency, locale, status,
  data_region AS "dataRegion", created_at AS "createdAt"`;

export class TenantsService {
  constructor(private readonly deps: Deps) {}

  /**
   * Creates a company workspace with the caller as Owner, the five system roles and a trial subscription,
   * then makes it the active company for the session.
   */
  async create(session: AuthSession, input: unknown) {
    const body = parse(CreateTenantRequest, input);
    const db = this.deps.db;

    const verified = await withContext(db, { tenantId: null, userId: session.userId }, async (tx) => {
      const { rows } = await tx.query('SELECT 1 FROM users WHERE id = $1 AND email_verified_at IS NOT NULL', [session.userId]);
      return rows.length === 1;
    });
    if (!verified) throw Errors.emailNotVerified();

    const tenantId = await withContext(db, { tenantId: null, userId: null }, async (tx) =>
      (await tx.query<{ id: string }>('SELECT uuid_generate_v7() AS id')).rows[0]!.id,
    );

    const tenant = await withContext(db, { tenantId, userId: session.userId }, async (tx) => {
      // Latest PUBLISHED version only (drafts, such as the annual-price draft, are never offered).
      // Trial length comes from the configurable trial policy.
      const plan = await tx.query<{ id: string; trial_days: number }>(
        `SELECT v.id, (SELECT trial_days FROM trial_policy) AS trial_days FROM plan_versions v JOIN plans p ON p.id = v.plan_id
         WHERE p.code = $1 AND p.is_public AND v.published_at IS NOT NULL AND v.effective_from <= now()
         ORDER BY v.version DESC LIMIT 1`,
        [body.planCode],
      );
      if (!plan.rows[0]) throw Errors.badRequest('Unknown plan.');
      try {
        await tx.query(
          `INSERT INTO tenants (id, slug, legal_name, country, timezone, currency, locale)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [tenantId, body.slug, body.legalName, body.country, body.timezone, body.currency, body.locale],
        );
      } catch (err) {
        if ((err as { code?: string }).code === '23505') throw Errors.conflict('slug_taken', 'That workspace address is taken.');
        throw err;
      }
      const roleIds = await createSystemRoles(tx, tenantId);
      const m = await tx.query<{ id: string }>('INSERT INTO memberships (tenant_id, user_id) VALUES ($1, $2) RETURNING id', [
        tenantId, session.userId,
      ]);
      await tx.query('INSERT INTO membership_roles (tenant_id, membership_id, role_id) VALUES ($1, $2, $3)', [
        tenantId, m.rows[0]!.id, roleIds.owner,
      ]);
      await tx.query(
        `INSERT INTO subscriptions (tenant_id, plan_version_id, status, trial_ends_at, current_period_end)
         VALUES ($1, $2, 'trialing', now() + make_interval(days => $3), now() + make_interval(days => $3))`,
        [tenantId, plan.rows[0].id, plan.rows[0].trial_days],
      );
      await AuditService.record(tx, {
        tenantId, actorUserId: session.userId, action: 'tenant.created', targetType: 'tenant', targetId: tenantId,
        metadata: { plan: body.planCode },
      });
      return (await tx.query(`SELECT ${TENANT_COLUMNS} FROM tenants WHERE id = $1`, [tenantId])).rows[0];
    });

    await this.setActive(session, tenantId);
    return tenant;
  }

  /** The companies this user belongs to (for the workspace switcher). */
  async listMine(session: AuthSession) {
    return withContext(this.deps.db, { tenantId: null, userId: session.userId }, async (tx) => {
      const { rows } = await tx.query(
        `SELECT t.id, t.slug, t.legal_name AS "legalName", t.id = $2 AS active
         FROM tenants t JOIN memberships m ON m.tenant_id = t.id
         WHERE m.user_id = $1 AND m.status = 'active' ORDER BY t.legal_name`,
        [session.userId, session.activeTenantId],
      );
      return rows;
    });
  }

  /** Switching requires an active membership in the target company; otherwise it looks like it does not exist. */
  async switchTo(session: AuthSession, input: unknown): Promise<void> {
    const { tenantId } = parse(SwitchTenantRequest, input);
    const isMember = await withContext(this.deps.db, { tenantId, userId: session.userId }, async (tx) => {
      const { rows } = await tx.query(
        "SELECT 1 FROM memberships WHERE tenant_id = $1 AND user_id = $2 AND status = 'active'", [tenantId, session.userId]);
      return rows.length === 1;
    });
    if (!isMember) throw Errors.notFound('Company');
    await this.setActive(session, tenantId);
  }

  private async setActive(session: AuthSession, tenantId: string): Promise<void> {
    await withContext(this.deps.db, { tenantId: null, userId: session.userId }, (tx) =>
      tx.query('UPDATE sessions SET active_tenant_id = $1 WHERE id = $2', [tenantId, session.sessionId]),
    );
  }

  async get(actor: TenantActor) {
    return withContext(this.deps.db, actor, async (tx) => {
      const { rows } = await tx.query(`SELECT ${TENANT_COLUMNS} FROM tenants WHERE id = $1`, [actor.tenantId]);
      return rows[0];
    });
  }

  async update(actor: TenantActor, input: unknown) {
    const body = parse(UpdateTenantRequest, input);
    return withContext(this.deps.db, actor, async (tx) => {
      const { rows } = await tx.query(
        `UPDATE tenants SET legal_name = coalesce($1, legal_name), timezone = coalesce($2, timezone),
                locale = coalesce($3, locale)
         WHERE id = $4 RETURNING ${TENANT_COLUMNS}`,
        [body.legalName ?? null, body.timezone ?? null, body.locale ?? null, actor.tenantId],
      );
      await AuditService.record(tx, {
        tenantId: actor.tenantId, actorUserId: actor.userId, action: 'tenant.updated', targetType: 'tenant',
        targetId: actor.tenantId, ip: actor.ip, metadata: { fields: Object.keys(body) },
      });
      return rows[0];
    });
  }
}
