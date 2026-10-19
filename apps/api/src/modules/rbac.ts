import { withContext, type Db, type Tx } from '@conversaflow/database';
import type { TenantActor } from '../core/context';

export const ALL_PERMISSIONS = [
  'tenant.read', 'tenant.update', 'members.read', 'members.invite', 'members.manage', 'roles.read', 'roles.manage',
  'billing.read', 'billing.manage', 'audit.read', 'files.read', 'files.write', 'contacts.read', 'contacts.write',
  'inbox.read_all', 'inbox.reply', 'reports.read',
] as const;
export type Permission = (typeof ALL_PERMISSIONS)[number];

/** The five built-in roles from BRD section 3. Companies can add custom roles on top. */
export const SYSTEM_ROLES: Record<string, { name: string; permissions: readonly Permission[] }> = {
  owner: { name: 'Owner', permissions: ALL_PERMISSIONS },
  admin: { name: 'Admin', permissions: ALL_PERMISSIONS.filter((p) => p !== 'billing.manage') },
  supervisor: {
    name: 'Supervisor',
    permissions: ['tenant.read', 'members.read', 'roles.read', 'reports.read', 'contacts.read', 'contacts.write',
      'inbox.read_all', 'inbox.reply', 'files.read', 'files.write'],
  },
  agent: { name: 'Agent', permissions: ['tenant.read', 'contacts.read', 'contacts.write', 'inbox.reply', 'files.read', 'files.write'] },
  analyst: { name: 'Analyst', permissions: ['tenant.read', 'members.read', 'reports.read', 'contacts.read'] },
};

export async function createSystemRoles(tx: Tx, tenantId: string): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};
  for (const [key, role] of Object.entries(SYSTEM_ROLES)) {
    const { rows } = await tx.query<{ id: string }>(
      'INSERT INTO roles (tenant_id, key, name, is_system) VALUES ($1, $2, $3, true) RETURNING id',
      [tenantId, key, role.name],
    );
    ids[key] = rows[0]!.id;
    await tx.query(
      `INSERT INTO role_permissions (tenant_id, role_id, permission_key) SELECT $1, $2, unnest($3::text[])`,
      [tenantId, ids[key], role.permissions],
    );
  }
  return ids;
}

/**
 * Resolves what a user may do in a company. Returns null when they are not an active member,
 * which callers turn into a refusal. Runs inside that company's context, so RLS applies.
 */
export async function loadActor(db: Db, tenantId: string, userId: string, ip?: string): Promise<TenantActor | null> {
  return withContext(db, { tenantId, userId }, async (tx) => {
    const { rows } = await tx.query<{ membership_id: string; roles: string[] | null; permissions: string[] | null; requires_mfa: boolean }>(
      `SELECT m.id AS membership_id, tenant_requires_mfa() AS requires_mfa,
              array_agg(DISTINCT r.key) FILTER (WHERE r.key IS NOT NULL) AS roles,
              array_agg(DISTINCT rp.permission_key) FILTER (WHERE rp.permission_key IS NOT NULL) AS permissions
       FROM memberships m
       LEFT JOIN membership_roles mr ON mr.membership_id = m.id
       LEFT JOIN roles r ON r.id = mr.role_id
       LEFT JOIN role_permissions rp ON rp.role_id = r.id
       WHERE m.tenant_id = $1 AND m.user_id = $2 AND m.status = 'active'
       GROUP BY m.id`,
      [tenantId, userId],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      tenantId, userId, membershipId: row.membership_id, roles: row.roles ?? [],
      permissions: new Set(row.permissions ?? []), requiresMfa: row.requires_mfa, ip,
    };
  });
}

let mfaPermissions: Promise<Set<string>> | undefined;
/** Permissions flagged requires_mfa in the catalogue (loaded once). */
export function permissionsRequiringMfa(db: Db): Promise<Set<string>> {
  mfaPermissions ??= withContext(db, { tenantId: null, userId: null }, async (tx) => {
    const { rows } = await tx.query<{ key: string }>('SELECT key FROM permissions WHERE requires_mfa');
    return new Set(rows.map((r) => r.key));
  });
  return mfaPermissions;
}
