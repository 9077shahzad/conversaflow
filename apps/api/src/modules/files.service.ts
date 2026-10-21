import { withContext } from '@conversaflow/database';
import type { AuthSession, Deps, TenantActor } from '../core/context';
import { hmac, safeEqual, sha256 } from '../core/crypto';
import { AppError, Errors } from '../core/errors';
import { scanWithBasis, storageKeyFor, type ScanBasis } from '../core/storage';
import { AuditService } from './audit.service';
import { isUuid } from './members.service';

const ALLOWED_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'application/pdf', 'text/csv', 'text/plain',
  'audio/ogg', 'audio/mpeg', 'video/mp4',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);
const LINK_TTL_SECONDS = 300;

const FILE_COLUMNS = `id, original_name AS "name", content_type AS "contentType", size_bytes AS "sizeBytes", status,
  created_at AS "createdAt", scan_basis AS "scanBasis", scanned_at AS "scannedAt"`;

export interface UploadInput {
  originalName: string;
  contentType: string;
  data: Buffer;
}

interface LinkClaims {
  f: string; // file id
  t: string; // company id
  u: string; // user the link was issued to
  e: number; // expiry, unix seconds
}

/**
 * Files belong to one company. Access checks happen three times:
 * the row must be visible under that company's RLS, the storage key must sit in that company's folder,
 * and a download link only works for the same user, in the same company, before it expires.
 */
export class FilesService {
  constructor(private readonly deps: Deps) {}

  async upload(actor: TenantActor, input: UploadInput) {
    if (input.data.length === 0) throw Errors.badRequest('The file is empty.');
    if (input.data.length > this.deps.config.MAX_UPLOAD_BYTES) throw Errors.badRequest('The file is too large.');
    if (!ALLOWED_TYPES.has(input.contentType)) throw Errors.badRequest('This file type is not allowed.');
    const name = sanitiseName(input.originalName);
    let verdict: 'clean' | 'infected';
    let basis: ScanBasis;
    try {
      ({ verdict, ...basis } = await scanWithBasis(this.deps.scanner, input.data));
    } catch {
      // Fail closed: no clear answer from the scanner means the file is not accepted or stored.
      throw new AppError(503, 'scanner_unavailable', 'Files cannot be checked for viruses right now. Please try again shortly.');
    }

    return withContext(this.deps.db, actor, async (tx) => {
      const fileId = (await tx.query<{ id: string }>('SELECT uuid_generate_v7() AS id')).rows[0]!.id;
      const key = storageKeyFor(actor.tenantId, fileId);
      const status = verdict === 'clean' ? 'available' : 'rejected';
      const { rows } = await tx.query(
        `INSERT INTO files (id, tenant_id, storage_key, original_name, content_type, size_bytes, sha256, status, uploaded_by,
                            scan_basis, scan_signature_version, scanned_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now()) RETURNING ${FILE_COLUMNS}`,
        [fileId, actor.tenantId, key, name, input.contentType, input.data.length, sha256(input.data), status, actor.userId,
          basis.basis, basis.signatureVersion],
      );
      await AuditService.record(tx, {
        tenantId: actor.tenantId, actorUserId: actor.userId, action: status === 'available' ? 'file.uploaded' : 'file.rejected',
        targetType: 'file', targetId: fileId, ip: actor.ip, metadata: { sizeBytes: input.data.length, contentType: input.contentType },
      });
      if (status === 'rejected') return rows[0];
      await this.deps.storage.put(key, input.data); // inside the transaction: a failed write rolls the row back
      return rows[0];
    });
  }

  async list(actor: TenantActor) {
    return withContext(this.deps.db, actor, async (tx) =>
      (await tx.query(`SELECT ${FILE_COLUMNS} FROM files ORDER BY created_at DESC LIMIT 200`)).rows,
    );
  }

  async get(actor: TenantActor, fileId: string) {
    if (!isUuid(fileId)) throw Errors.notFound('File');
    const row = await withContext(this.deps.db, actor, async (tx) =>
      (await tx.query(`SELECT ${FILE_COLUMNS} FROM files WHERE id = $1`, [fileId])).rows[0],
    );
    if (!row) throw Errors.notFound('File');
    return row;
  }

  /** A short-lived link for one user in one company. */
  async createLink(actor: TenantActor, fileId: string): Promise<{ url: string; expiresAt: string }> {
    const file = await this.get(actor, fileId);
    if (file.status !== 'available') throw Errors.notFound('File');
    const claims: LinkClaims = { f: fileId, t: actor.tenantId, u: actor.userId, e: Math.floor(Date.now() / 1000) + LINK_TTL_SECONDS };
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const sig = hmac(this.deps.keys.fileLinks, payload).toString('base64url');
    return { url: `/v1/files/download?token=${payload}.${sig}`, expiresAt: new Date(claims.e * 1000).toISOString() };
  }

  async download(session: AuthSession, token: string): Promise<{ data: Buffer; name: string; contentType: string }> {
    const claims = this.verifyLink(token);
    // The link is bound to the user and company it was issued for.
    if (claims.u !== session.userId || claims.t !== session.activeTenantId) throw Errors.invalidLink();
    return withContext(this.deps.db, { tenantId: claims.t, userId: session.userId }, async (tx) => {
      // Re-check the person is still a member AND still allowed to read files (roles may have changed).
      const allowed = await tx.query(
        `SELECT 1 FROM memberships m JOIN membership_roles mr ON mr.membership_id = m.id
         JOIN role_permissions rp ON rp.role_id = mr.role_id
         WHERE m.tenant_id = $1 AND m.user_id = $2 AND m.status = 'active' AND rp.permission_key = 'files.read' LIMIT 1`,
        [claims.t, session.userId]);
      if (allowed.rowCount !== 1) throw Errors.invalidLink();
      // Pilot companies require verified two-step sign-in for downloads too (this route sits outside the guard's
      // permission check because the link carries its own company and user).
      const pilot = await tx.query<{ r: boolean }>('SELECT tenant_requires_mfa() AS r');
      if (pilot.rows[0]!.r && !(session.userHasMfa && session.mfaVerified)) throw Errors.companyRequiresMfa();
      const { rows } = await tx.query<{ storage_key: string; original_name: string; content_type: string; status: string }>(
        'SELECT storage_key, original_name, content_type, status FROM files WHERE id = $1', [claims.f]);
      const file = rows[0];
      if (!file || file.status !== 'available') throw Errors.notFound('File');
      if (!file.storage_key.startsWith(`tenants/${claims.t}/`)) throw Errors.notFound('File');
      return { data: await this.deps.storage.get(file.storage_key), name: file.original_name, contentType: file.content_type };
    });
  }

  private verifyLink(token: string): LinkClaims {
    const [payload, sig] = String(token ?? '').split('.');
    if (!payload || !sig) throw Errors.invalidLink();
    const expected = hmac(this.deps.keys.fileLinks, payload);
    if (!safeEqual(expected, Buffer.from(sig, 'base64url'))) throw Errors.invalidLink();
    let claims: LinkClaims;
    try {
      claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as LinkClaims;
    } catch {
      throw Errors.invalidLink();
    }
    if (typeof claims.e !== 'number' || claims.e < Math.floor(Date.now() / 1000)) throw Errors.invalidLink();
    if (!isUuid(claims.f) || !isUuid(claims.t) || !isUuid(claims.u)) throw Errors.invalidLink();
    return claims;
  }
}

/** Keeps a display name only; the name never becomes part of a storage path. */
export function sanitiseName(name: string): string {
  const base = String(name ?? '').split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '').replace(/^\.+/, '').trim().slice(0, 200);
  return cleaned || 'file';
}
