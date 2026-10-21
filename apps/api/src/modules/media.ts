import { withContext, type Db } from '@conversaflow/database';
import { sha256 } from '../core/crypto';
import { scanWithBasis, storageKeyFor, type FileScanner, type ObjectStorage, type ScanBasis } from '../core/storage';
import { ChannelSendError, type ChannelAdapter, type MediaType, type Provider } from './channels';
import { sanitiseName } from './files.service';

/**
 * Media types and size limits from Meta's media page (read 21 Oct 2026, page undated). Our own storage limit
 * (MAX_UPLOAD_BYTES, 16 MB by default) can be lower than Meta's for documents (100 MB); larger files are recorded as
 * "too large" and not downloaded.
 */
export const WHATSAPP_MEDIA: Record<MediaType, { types: string[]; maxBytes: number }> = {
  image: { types: ['image/jpeg', 'image/png'], maxBytes: 5 * 1024 * 1024 },
  audio: { types: ['audio/aac', 'audio/amr', 'audio/mpeg', 'audio/mp4', 'audio/ogg'], maxBytes: 16 * 1024 * 1024 },
  video: { types: ['video/mp4', 'video/3gpp'], maxBytes: 16 * 1024 * 1024 },
  document: {
    types: ['text/plain', 'application/pdf', 'application/vnd.ms-excel', 'application/msword', 'application/vnd.ms-powerpoint',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
    maxBytes: 100 * 1024 * 1024,
  },
  sticker: { types: ['image/webp'], maxBytes: 500 * 1024 },
};

const EXT: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'audio/aac': 'aac', 'audio/amr': 'amr', 'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a', 'audio/ogg': 'ogg', 'video/mp4': 'mp4', 'video/3gpp': '3gp', 'text/plain': 'txt', 'application/pdf': 'pdf',
  'application/vnd.ms-excel': 'xls', 'application/msword': 'doc', 'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
};

/** The provider's MIME type without parameters ("audio/ogg; codecs=opus" → "audio/ogg"). */
export const baseMime = (mime: string | null | undefined) => (mime ?? '').split(';')[0]!.trim().toLowerCase();

export function acceptsInbound(type: MediaType, mime: string | null): boolean {
  return WHATSAPP_MEDIA[type].types.includes(baseMime(mime));
}

/** Which WhatsApp media type an outbound file is sent as, or null if WhatsApp does not accept it. */
export function outboundTypeFor(contentType: string, size: number): Exclude<MediaType, 'sticker'> | null {
  const mime = baseMime(contentType);
  for (const t of ['image', 'audio', 'video', 'document'] as const) {
    if (WHATSAPP_MEDIA[t].types.includes(mime) && size <= WHATSAPP_MEDIA[t].maxBytes) return t;
  }
  return null;
}

export const MEDIA_LIMITS = { maxAttempts: 5, leaseSeconds: 120, baseBackoffSeconds: 10, fetchTimeoutMs: 60_000 };

type MediaRow = { job_id: string; job_state: string; lease_live: boolean; attempts: number; message_id: string; media_type: MediaType;
  provider_media_id: string; media_mime: string | null; media_status: string; number: string; provider: Provider; filename: string | null };

/**
 * Downloads inbound media in the background, checks it for malware and stores it in the company's own folder.
 * Safe to repeat: downloading has no effect on the customer, and the message moves out of `pending` only once.
 * A scanner without a clear answer means "try again later", never "accept".
 */
export class MediaFetcher {
  constructor(
    private readonly db: Db,
    private readonly channels: Partial<Record<Provider, ChannelAdapter>>,
    private readonly storage: ObjectStorage,
    private readonly scanner: FileScanner,
    private readonly maxStoredBytes: number,
  ) {}

  async dispatchDue(limit = 10): Promise<number> {
    const jobs = await withContext(this.db, { tenantId: null, userId: null }, async (tx) =>
      (await tx.query<{ job_id: string; tenant_id: string }>('SELECT * FROM media_claim($1, $2)', [limit, MEDIA_LIMITS.leaseSeconds])).rows);
    for (const j of jobs) {
      try { await this.processJob(j.tenant_id, j.job_id); } catch (err) {
        console.error('media job error', j.job_id, err instanceof Error ? err.message : err);
      }
    }
    return jobs.length;
  }

  async processJob(tenantId: string, jobId: string): Promise<'available' | 'rejected' | 'too_large' | 'unsupported' | 'failed' | 'retry_later' | 'nothing_to_do'> {
    const row = await withContext(this.db, { tenantId, userId: null }, async (tx) => (await tx.query<MediaRow>(
      `SELECT j.id AS job_id, j.state AS job_state, (j.state = 'leased' AND j.lease_until > now()) AS lease_live, j.attempts,
              m.id AS message_id, m.media_type, m.provider_media_id, m.media_mime, m.media_status,
              ch.provider_number_id AS number, ch.provider, m.media_filename AS filename
       FROM media_jobs j JOIN messages m ON m.id = j.message_id
       JOIN conversations c ON c.id = m.conversation_id JOIN channel_connections ch ON ch.id = c.connection_id
       WHERE j.id = $1`, [jobId])).rows[0]);
    if (!row || !row.lease_live || row.media_status !== 'pending') {
      if (row && row.media_status !== 'pending') await this.close(tenantId, jobId, 'done', null);
      return 'nothing_to_do';
    }
    await withContext(this.db, { tenantId, userId: null }, (tx) =>
      tx.query('UPDATE media_jobs SET attempts = attempts + 1, updated_at = now() WHERE id = $1', [jobId]));

    let data: Buffer; let contentType: string;
    try {
      const adapter = this.channels[row.provider];
      if (!adapter) throw new ChannelSendError('provider_not_available', 'Provider not available.', 'not_accepted');
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), MEDIA_LIMITS.fetchTimeoutMs);
      try {
        ({ data, contentType } = await adapter.fetchMedia({ providerNumberId: row.number, mediaId: row.provider_media_id, signal: abort.signal }));
      } finally { clearTimeout(timer); }
    } catch (err) {
      const e = err instanceof ChannelSendError ? err : new ChannelSendError('download_error', 'Download failed.', 'not_accepted');
      if (e.kind === 'rejected') return this.settle(tenantId, row, 'failed', e.code);
      return this.later(tenantId, row, e.code);
    }

    const mime = baseMime(contentType) || baseMime(row.media_mime);
    if (!acceptsInbound(row.media_type, mime)) return this.settle(tenantId, row, 'unsupported', `type:${mime}`);
    if (data.length > Math.min(WHATSAPP_MEDIA[row.media_type].maxBytes, this.maxStoredBytes)) return this.settle(tenantId, row, 'too_large', 'too_large');

    let verdict: 'clean' | 'infected';
    let basis: ScanBasis;
    try { ({ verdict, ...basis } = await scanWithBasis(this.scanner, data)); } catch {
      return this.later(tenantId, row, 'scanner_unavailable');
    }

    return withContext(this.db, { tenantId, userId: null }, async (tx) => {
      const live = (await tx.query<{ media_status: string }>('SELECT media_status FROM messages WHERE id = $1 FOR UPDATE', [row.message_id])).rows[0]!;
      if (live.media_status !== 'pending') return 'nothing_to_do' as const;
      const fileId = (await tx.query<{ id: string }>('SELECT uuid_generate_v7() AS id')).rows[0]!.id;
      const key = storageKeyFor(tenantId, fileId);
      const status = verdict === 'clean' ? 'available' : 'rejected';
      const name = sanitiseName(row.filename ?? `whatsapp-${row.media_type}-${row.message_id.slice(0, 8)}.${EXT[mime] ?? 'bin'}`);
      await tx.query(
        `INSERT INTO files (id, tenant_id, storage_key, original_name, content_type, size_bytes, sha256, status, uploaded_by, source,
                            scan_basis, scan_signature_version, scanned_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL, 'whatsapp_inbound', $9, $10, now())`,
        [fileId, tenantId, key, name, mime, data.length, sha256(data), status, basis.basis, basis.signatureVersion]);
      await tx.query(`UPDATE messages SET media_status = $2, file_id = $3, media_mime = $4 WHERE id = $1`,
        [row.message_id, status, status === 'available' ? fileId : null, mime]);
      await tx.query(`UPDATE media_jobs SET state = 'done', lease_until = NULL, last_error = $2, updated_at = now() WHERE id = $1`,
        [jobId, status === 'rejected' ? 'infected' : null]);
      if (status === 'available') await this.storage.put(key, data); // inside the transaction: a failed write rolls back
      return status;
    });
  }

  private async settle(tenantId: string, row: MediaRow, status: 'failed' | 'unsupported' | 'too_large', code: string) {
    await withContext(this.db, { tenantId, userId: null }, async (tx) => {
      await tx.query(`UPDATE messages SET media_status = $2 WHERE id = $1 AND media_status = 'pending'`, [row.message_id, status]);
      await tx.query(`UPDATE media_jobs SET state = 'done', lease_until = NULL, last_error = $2, updated_at = now() WHERE id = $1`, [row.job_id, code.slice(0, 200)]);
    });
    return status;
  }

  private async later(tenantId: string, row: MediaRow, code: string) {
    const attempts = row.attempts + 1;
    if (attempts >= MEDIA_LIMITS.maxAttempts) {
      await withContext(this.db, { tenantId, userId: null }, async (tx) => {
        await tx.query(`UPDATE messages SET media_status = 'failed' WHERE id = $1 AND media_status = 'pending'`, [row.message_id]);
        await tx.query(`UPDATE media_jobs SET state = 'dead', lease_until = NULL, last_error = $2, updated_at = now() WHERE id = $1`,
          [row.job_id, `retries_exhausted:${code}`.slice(0, 200)]);
      });
      return 'failed' as const;
    }
    await withContext(this.db, { tenantId, userId: null }, (tx) => tx.query(
      `UPDATE media_jobs SET state = 'pending', lease_until = NULL, last_error = $2,
              next_attempt_at = now() + make_interval(secs => $3), updated_at = now() WHERE id = $1`,
      [row.job_id, code.slice(0, 200), MEDIA_LIMITS.baseBackoffSeconds * 2 ** (attempts - 1)]));
    return 'retry_later' as const;
  }

  private async close(tenantId: string, jobId: string, state: 'done', code: string | null) {
    await withContext(this.db, { tenantId, userId: null }, (tx) =>
      tx.query(`UPDATE media_jobs SET state = $2, lease_until = NULL, last_error = $3, updated_at = now() WHERE id = $1`, [jobId, state, code]));
  }
}
