import { withContext, type Tx } from '@conversaflow/database';
import { AcceptInvitationRequest, CreateRoleRequest, InviteRequest, SetMemberRolesRequest } from '@conversaflow/contracts';
import type { AuthSession, Deps, TenantActor } from '../core/context';
import { randomToken, sha256 } from '../core/crypto';
import { Errors } from '../core/errors';
import { parse } from '../core/validate';
import { AuditService } from './audit.service';
import { assertSeatAvailable } from './entitlements.service';

const INVITE_TTL_DAYS = 7;

export class MembersService {
  constructor(private readonly deps: Deps) {}

  async list(actor: TenantActor) {
    return withContext(this.deps.db, actor, async (tx) => {
      const { rows } = await tx.query(
        `SELECT m.id, u.full_name AS "fullName", u.email, m.status, m.created_at AS "joinedAt",
                coalesce(array_agg(r.key ORDER BY r.key) FILTER (WHERE r.key IS NOT NULL), '{}') AS roles
         FROM memberships m JOIN users u ON u.id = m.user_id
         LEFT JOIN membership_roles mr ON mr.membership_id = m.id
         LEFT JOIN roles r ON r.id = mr.role_id
         WHERE m.status <> 'removed'
         GROUP BY m.id, u.full_name, u.email ORDER BY u.full_name`,
      );
      return rows;
    });
  }

  async get(actor: TenantActor, membershipId: string) {
    if (!isUuid(membershipId)) throw Errors.notFound('Member');
    const rows = await this.list(actor);
    const found = rows.find((r) => r.id === membershipId);
    if (!found) throw Errors.notFound('Member');
    return found;
  }

  async invite(actor: TenantActor, input: unknown): Promise<{ invitationId: string; expiresAt: Date }> {
    const body = parse(InviteRequest, input);
    if (body.roleKey === 'owner' && !actor.roles.includes('owner')) throw Errors.forbidden('Only an Owner can invite another Owner.');
    const token = randomToken();
    const result = await withContext(this.deps.db, actor, async (tx) => {
      const role = await tx.query<{ id: string }>('SELECT id FROM roles WHERE key = $1', [body.roleKey]);
      if (!role.rows[0]) throw Errors.badRequest('Unknown role.');
      await assertWithinActor(tx, actor, [role.rows[0].id]);
      const existing = await tx.query(
        "SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = $1 AND m.status = 'active'",
        [body.email],
      );
      if (existing.rowCount) throw Errors.conflict('already_member', 'This person is already a member.');
      await tx.query('UPDATE invitations SET revoked_at = now() WHERE email = $1 AND accepted_at IS NULL AND revoked_at IS NULL', [body.email]);
      const { rows } = await tx.query<{ id: string; expires_at: Date }>(
        `INSERT INTO invitations (tenant_id, email, role_id, token_hash, invited_by, expires_at)
         VALUES ($1, $2, $3, $4, $5, now() + make_interval(days => $6)) RETURNING id, expires_at`,
        [actor.tenantId, body.email, role.rows[0].id, sha256(token), actor.userId, INVITE_TTL_DAYS],
      );
      await AuditService.record(tx, {
        tenantId: actor.tenantId, actorUserId: actor.userId, action: 'member.invited', targetType: 'invitation',
        targetId: rows[0]!.id, ip: actor.ip, metadata: { role: body.roleKey },
      });
      const company = await tx.query<{ legal_name: string }>('SELECT legal_name FROM tenants WHERE id = $1', [actor.tenantId]);
      return { invitationId: rows[0]!.id, expiresAt: rows[0]!.expires_at, company: company.rows[0]!.legal_name };
    });
    await this.deps.mailer.send({
      to: body.email,
      subject: `You are invited to ${result.company} on ConversaFlow`,
      text: `Accept the invitation within ${INVITE_TTL_DAYS} days: ${this.deps.config.APP_ORIGIN}/invite?token=${token}`,
    });
    return { invitationId: result.invitationId, expiresAt: result.expiresAt };
  }

  /**
   * The signed-in user accepts an invitation addressed to their own verified email.
   * Seat limit is enforced in the same transaction as the membership insert.
   */
  async accept(session: AuthSession, input: unknown): Promise<{ tenantId: string }> {
    const { token } = parse(AcceptInvitationRequest, input);
    const invite = await withContext(this.deps.db, { tenantId: null, userId: null }, async (tx) => {
      const { rows } = await tx.query<{
        invitation_id: string; tenant_id: string; email: string; role_id: string; expires_at: Date;
        accepted_at: Date | null; revoked_at: Date | null;
      }>('SELECT * FROM auth_invitation_lookup($1)', [sha256(token)]);
      return rows[0];
    });
    if (!invite || invite.accepted_at || invite.revoked_at || invite.expires_at < new Date()) throw Errors.invalidLink();

    const me = await withContext(this.deps.db, { tenantId: null, userId: session.userId }, async (tx) => {
      const { rows } = await tx.query<{ email: string; verified: boolean }>(
        'SELECT email, email_verified_at IS NOT NULL AS verified FROM users WHERE id = $1', [session.userId]);
      return rows[0]!;
    });
    if (!me.verified) throw Errors.emailNotVerified();
    if (me.email.toLowerCase() !== invite.email.toLowerCase()) throw Errors.forbidden('This invitation was sent to a different email address.');

    await withContext(this.deps.db, { tenantId: invite.tenant_id, userId: session.userId }, async (tx) => {
      await assertSeatAvailable(tx);
      const claimed = await tx.query(
        'UPDATE invitations SET accepted_at = now() WHERE id = $1 AND accepted_at IS NULL AND revoked_at IS NULL',
        [invite.invitation_id],
      );
      if (claimed.rowCount !== 1) throw Errors.invalidLink();
      const m = await tx.query<{ id: string }>(
        `INSERT INTO memberships (tenant_id, user_id, invited_by) VALUES ($1, $2, NULL)
         ON CONFLICT (tenant_id, user_id) DO UPDATE SET status = 'active' WHERE memberships.status <> 'active'
         RETURNING id`,
        [invite.tenant_id, session.userId],
      );
      if (!m.rows[0]) throw Errors.conflict('already_member', 'You are already a member of this company.');
      await tx.query('DELETE FROM membership_roles WHERE membership_id = $1', [m.rows[0].id]);
      await tx.query('INSERT INTO membership_roles (tenant_id, membership_id, role_id) VALUES ($1, $2, $3)', [
        invite.tenant_id, m.rows[0].id, invite.role_id,
      ]);
      await AuditService.record(tx, {
        tenantId: invite.tenant_id, actorUserId: session.userId, action: 'member.joined', targetType: 'membership',
        targetId: m.rows[0].id,
      });
    });
    // A person with no workspace selected yet lands in the company they just joined.
    await withContext(this.deps.db, { tenantId: null, userId: session.userId }, (tx) =>
      tx.query('UPDATE sessions SET active_tenant_id = coalesce(active_tenant_id, $1) WHERE id = $2', [
        invite.tenant_id, session.sessionId,
      ]),
    );
    return { tenantId: invite.tenant_id };
  }

  async setRoles(actor: TenantActor, membershipId: string, input: unknown) {
    const { roleKeys } = parse(SetMemberRolesRequest, input);
    if (!isUuid(membershipId)) throw Errors.notFound('Member');
    if (roleKeys.includes('owner') && !actor.roles.includes('owner')) throw Errors.forbidden('Only an Owner can grant the Owner role.');
    if (membershipId === actor.membershipId) throw Errors.forbidden('You cannot change your own roles. Ask another Owner or Admin.');
    await withContext(this.deps.db, actor, async (tx) => {
      const target = await this.lockMember(tx, membershipId);
      if (target.roles.includes('owner') && !actor.roles.includes('owner')) throw Errors.forbidden('Only an Owner can change another Owner.');
      await assertTargetWithinActor(tx, actor, membershipId);
      const roles = await tx.query<{ id: string; key: string }>('SELECT id, key FROM roles WHERE key = ANY($1::text[])', [roleKeys]);
      if (roles.rowCount !== new Set(roleKeys).size) throw Errors.badRequest('Unknown role.');
      await assertWithinActor(tx, actor, roles.rows.map((r) => r.id));
      await tx.query('DELETE FROM membership_roles WHERE membership_id = $1', [membershipId]);
      for (const r of roles.rows) {
        await tx.query('INSERT INTO membership_roles (tenant_id, membership_id, role_id) VALUES ($1, $2, $3)', [actor.tenantId, membershipId, r.id]);
      }
      await this.assertOwnerRemains(tx);
      await AuditService.record(tx, {
        tenantId: actor.tenantId, actorUserId: actor.userId, action: 'member.roles_changed', targetType: 'membership',
        targetId: membershipId, ip: actor.ip, metadata: { from: target.roles, to: roleKeys },
      });
    });
  }

  async remove(actor: TenantActor, membershipId: string) {
    if (!isUuid(membershipId)) throw Errors.notFound('Member');
    await withContext(this.deps.db, actor, async (tx) => {
      const target = await this.lockMember(tx, membershipId);
      if (target.roles.includes('owner') && !actor.roles.includes('owner')) throw Errors.forbidden('Only an Owner can remove an Owner.');
      if (membershipId !== actor.membershipId) await assertTargetWithinActor(tx, actor, membershipId);
      await tx.query("UPDATE memberships SET status = 'removed' WHERE id = $1", [membershipId]);
      await tx.query('DELETE FROM membership_roles WHERE membership_id = $1', [membershipId]);
      await this.assertOwnerRemains(tx);
      // Their sessions in this company lose access immediately: every request re-checks membership.
      await AuditService.record(tx, {
        tenantId: actor.tenantId, actorUserId: actor.userId, action: 'member.removed', targetType: 'membership',
        targetId: membershipId, ip: actor.ip,
      });
    });
  }

  private async lockMember(tx: Tx, membershipId: string): Promise<{ roles: string[] }> {
    const { rows } = await tx.query<{ roles: string[] }>(
      `SELECT coalesce((SELECT array_agg(r.key) FROM membership_roles mr JOIN roles r ON r.id = mr.role_id
                        WHERE mr.membership_id = m.id), '{}') AS roles
       FROM memberships m WHERE m.id = $1 AND m.status <> 'removed' FOR UPDATE`,
      [membershipId],
    );
    if (!rows[0]) throw Errors.notFound('Member');
    return rows[0];
  }

  private async assertOwnerRemains(tx: Tx): Promise<void> {
    const { rows } = await tx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM memberships m JOIN membership_roles mr ON mr.membership_id = m.id
       JOIN roles r ON r.id = mr.role_id WHERE r.key = 'owner' AND m.status = 'active'`,
    );
    if (rows[0]!.n < 1) throw Errors.conflict('last_owner', 'A company must keep at least one Owner.');
  }

  async listRoles(actor: TenantActor) {
    return withContext(this.deps.db, actor, async (tx) => {
      const { rows } = await tx.query(
        `SELECT r.key, r.name, r.is_system AS "isSystem", array_agg(rp.permission_key ORDER BY rp.permission_key) AS permissions
         FROM roles r JOIN role_permissions rp ON rp.role_id = r.id GROUP BY r.id ORDER BY r.is_system DESC, r.name`,
      );
      return rows;
    });
  }

  /** Custom roles can only contain permissions the creator already has (no privilege escalation). */
  async createRole(actor: TenantActor, input: unknown) {
    const body = parse(CreateRoleRequest, input);
    const missing = body.permissions.filter((p) => !actor.permissions.has(p));
    if (missing.length) throw Errors.forbidden(`You cannot grant permissions you do not have: ${missing.join(', ')}`);
    return withContext(this.deps.db, actor, async (tx) => {
      const valid = await tx.query('SELECT key FROM permissions WHERE key = ANY($1::text[])', [body.permissions]);
      if (valid.rowCount !== new Set(body.permissions).size) throw Errors.badRequest('Unknown permission.');
      let roleId: string;
      try {
        const { rows } = await tx.query<{ id: string }>('INSERT INTO roles (tenant_id, key, name) VALUES ($1, $2, $3) RETURNING id', [
          actor.tenantId, body.key, body.name,
        ]);
        roleId = rows[0]!.id;
      } catch (err) {
        if ((err as { code?: string }).code === '23505') throw Errors.conflict('role_exists', 'A role with that key exists.');
        throw err;
      }
      await tx.query('INSERT INTO role_permissions (tenant_id, role_id, permission_key) SELECT $1, $2, unnest($3::text[])', [
        actor.tenantId, roleId, body.permissions,
      ]);
      await AuditService.record(tx, {
        tenantId: actor.tenantId, actorUserId: actor.userId, action: 'role.created', targetType: 'role', targetId: roleId,
        ip: actor.ip, metadata: { key: body.key, permissions: body.permissions },
      });
      return { key: body.key, name: body.name, permissions: body.permissions };
    });
  }
}

/**
 * No privilege escalation: you can only hand out roles whose permissions you hold yourself.
 * (The Owner holds every permission, so Owners are never blocked.)
 */
async function assertWithinActor(tx: Tx, actor: TenantActor, roleIds: string[]): Promise<void> {
  const { rows } = await tx.query<{ permission_key: string }>(
    'SELECT DISTINCT permission_key FROM role_permissions WHERE role_id = ANY($1::uuid[])', [roleIds]);
  const missing = rows.map((r) => r.permission_key).filter((p) => !actor.permissions.has(p));
  if (missing.length) throw Errors.forbidden(`You cannot grant permissions you do not have: ${missing.sort().join(', ')}`);
}

/** You can only change or remove people whose current permissions you also hold. */
async function assertTargetWithinActor(tx: Tx, actor: TenantActor, membershipId: string): Promise<void> {
  const { rows } = await tx.query<{ permission_key: string }>(
    `SELECT DISTINCT rp.permission_key FROM membership_roles mr JOIN role_permissions rp ON rp.role_id = mr.role_id
     WHERE mr.membership_id = $1`, [membershipId]);
  if (rows.some((r) => !actor.permissions.has(r.permission_key))) {
    throw Errors.forbidden('This person has permissions you do not have, so you cannot change them.');
  }
}

export const isUuid = (v: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
