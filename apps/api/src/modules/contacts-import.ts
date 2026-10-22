import { withContext, type Tx } from '@conversaflow/database';
import { z } from 'zod';
import type { Deps, TenantActor } from '../core/context';
import { AppError, Errors } from '../core/errors';
import { parse } from '../core/validate';
import { AuditService } from './audit.service';
import { isUuid } from './members.service';
import { parsePhoneNumberFromString } from 'libphonenumber-js';

/**
 * Contact import from CSV (BRD v1.2 Wave 1, CF-EXT-003 / FR-302, migration 0038).
 *
 * 1. Preview: the file is read and every row classified (new, already a contact, repeated in the file, or not usable,
 *    with the reason). Nothing changes yet; the preview is stored so the import applies exactly what was shown.
 * 2. Import: each row is checked again at that moment (a customer may have written in or opted out since).
 * 3. Undo: contacts the import created that have no conversation are removed, and marketing consent it recorded is
 *    withdrawn with a consent event. Contacts that have started a conversation are kept.
 *
 * Marketing consent: a "yes" is recorded only together with the company's statement of how the customers agreed
 * (required for the whole file when any row says yes), never for a customer who has opted out of all messages, and
 * an existing consent is never removed by a "no" in a file (withdrawal is the customer's or an agent's action).
 * Imports never send anything.
 */
export const IMPORT_LIMITS = { maxBytes: 2 * 1024 * 1024, maxRows: 5000, problemRowsShown: 100 };

type Field = 'phone' | 'name' | 'language' | 'consent';
const HEADERS: Record<string, Field> = {
  phone: 'phone', whatsapp: 'phone', 'whatsapp number': 'phone', mobile: 'phone', number: 'phone', 'phone number': 'phone',
  name: 'name', 'full name': 'name', 'customer name': 'name',
  language: 'language', lang: 'language',
  marketing_consent: 'consent', 'marketing consent': 'consent', consent: 'consent', marketing: 'consent',
  'الهاتف': 'phone', 'رقم الجوال': 'phone', 'رقم الواتساب': 'phone', 'واتساب': 'phone', 'الجوال': 'phone',
  'الاسم': 'name', 'اسم العميل': 'name', 'اللغة': 'language', 'موافقة تسويقية': 'consent', 'الموافقة': 'consent',
};
const YES = new Set(['yes', 'y', 'true', '1', 'نعم']);
const NO = new Set(['no', 'n', 'false', '0', 'لا']);

export type RowProblem = 'missing_phone' | 'local_number' | 'invalid_phone' | 'name_too_long' | 'bad_language' | 'bad_consent' | 'duplicate_in_file';
export interface ParsedRow { line: number; phone: string | null; name: string | null; language: 'en' | 'ar' | null; consent: boolean | null; problem: RowProblem | null }

/** RFC 4180 CSV: quoted fields, doubled quotes, commas and line breaks inside quotes; a byte-order mark is ignored. */
export function readCsv(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = []; let field = ''; let quoted = false;
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (quoted) {
      if (ch === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else quoted = false; } else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f.trim() !== '')) out.push(row);
      row = [];
    } else field += ch;
  }
  if (quoted) {
    // A quote that is never closed would silently swallow the rest of the file into one field (review L5).
    throw new AppError(400, 'unclosed_quote', `A quotation mark opened on line ${out.length + 1} is never closed. Check the file and try again.`);
  }
  row.push(field);
  if (row.some((f) => f.trim() !== '')) out.push(row);
  return out;
}

/**
 * A WhatsApp number in international form, digits only, checked against the numbering plan of its country
 * (libphonenumber: country code, length and number ranges). Accepts "+966 50 123 4567", "00966501234567",
 * "+966 (0)50 123 4567" (the trunk 0 is dropped) and international digits without "+" when they form a valid number.
 * A number starting with 0, or digits that only make sense with a missing country code (such as 501234567, a Saudi
 * mobile whose leading 0 a spreadsheet dropped), are refused rather than guessed, because a wrong guess would message
 * a stranger (review M5).
 */
export function normalisePhone(raw: string): { phone: string } | { problem: 'local_number' | 'invalid_phone' } {
  let v = raw.replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)));
  v = v.replace(/[\s\-.\u200e\u200f\u202a-\u202e]/g, '').replace(/\(0\)/g, '').replace(/[()]/g, '');
  let explicit = false;
  if (v.startsWith('+')) { v = v.slice(1); explicit = true; } else if (v.startsWith('00')) { v = v.slice(2); explicit = true; }
  if (!/^[0-9]{6,20}$/.test(v)) return { problem: 'invalid_phone' };
  if (!explicit && v.startsWith('0')) return { problem: 'local_number' };
  const parsed = parsePhoneNumberFromString(`+${v}`);
  if (!parsed || !parsed.isValid()) return { problem: explicit ? 'invalid_phone' : 'local_number' };
  return { phone: parsed.number.slice(1) };
}

export function parseContactsCsv(text: string): { rows: ParsedRow[]; ignoredColumns: string[] } {
  const table = readCsv(text);
  if (table.length === 0) throw Errors.badRequest('The file is empty.');
  const header = table[0]!.map((h) => h.trim().toLowerCase().replace(/\s+/g, ' '));
  const map = header.map((h) => HEADERS[h] ?? null);
  if (!map.includes('phone')) {
    throw new AppError(400, 'missing_phone_column', 'The first line must name the columns, including one for the WhatsApp number (for example "phone").');
  }
  if (table.length - 1 > IMPORT_LIMITS.maxRows) {
    throw new AppError(400, 'too_many_rows', `A file can have up to ${IMPORT_LIMITS.maxRows} contacts. Split it into smaller files.`);
  }
  const twice = (['phone', 'name', 'language', 'consent'] as Field[]).filter((f) => map.filter((m) => m === f).length > 1);
  if (twice.length) {
    // Two number columns (say "mobile" and "phone") would otherwise use one and silently ignore the other (review L5).
    throw new AppError(400, 'duplicate_columns', `More than one column means the same thing (${twice.join(', ')}). Keep one of each and try again.`);
  }
  const ignoredColumns = table[0]!.filter((_, i) => map[i] === null).map((h) => h.trim()).filter(Boolean);
  const seen = new Set<string>();
  const rows: ParsedRow[] = [];
  table.slice(1).forEach((cells, i) => {
    const get = (f: Field) => { const idx = map.indexOf(f); return idx >= 0 ? (cells[idx] ?? '').trim() : ''; };
    const r: ParsedRow = { line: i + 2, phone: null, name: null, language: null, consent: null, problem: null };
    const rawPhone = get('phone');
    const name = Array.from(get('name'), (c) => (c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? ' ' : c)).join('').replace(/ {2,}/g, ' ').trim();
    const lang = get('language').toLowerCase();
    const consent = get('consent').toLowerCase();
    if (!rawPhone) r.problem = 'missing_phone';
    else {
      const p = normalisePhone(rawPhone);
      if ('problem' in p) r.problem = p.problem; else r.phone = p.phone;
    }
    if (name.length > 200) r.problem ??= 'name_too_long'; else if (name) r.name = name;
    if (lang) {
      if (['en', 'english', 'الإنجليزية', 'انجليزي'].includes(lang)) r.language = 'en';
      else if (['ar', 'arabic', 'العربية', 'عربي'].includes(lang)) r.language = 'ar';
      else r.problem ??= 'bad_language';
    }
    if (consent) {
      if (YES.has(consent)) r.consent = true; else if (NO.has(consent)) r.consent = false; else r.problem ??= 'bad_consent';
    }
    if (!r.problem && r.phone) {
      if (seen.has(r.phone)) r.problem = 'duplicate_in_file'; else seen.add(r.phone);
    }
    rows.push(r);
  });
  return { rows, ignoredColumns };
}

const PreviewInput = z.object({
  fileName: z.string().trim().min(1).max(200),
  csv: z.string().min(1).max(IMPORT_LIMITS.maxBytes),
  consentEvidence: z.string().trim().min(10).max(500).nullable().optional(),
});

type ConsentAction = 'grant' | 'already' | 'refused_opted_out' | 'refused_withdrawn' | null;
type Classified = ParsedRow & { outcome: 'new' | 'existing' | 'problem'; contactId?: string; consentAction?: ConsentAction };

/**
 * What an import "yes" does for one contact. Refused when the customer opted out of all messages, or when their latest
 * marketing decision is a withdrawal: the company's evidence may well predate it (review M2).
 */
function consentFor(wantsYes: boolean, e: { opted_out: boolean; consent: boolean; latest: string | null } | undefined): ConsentAction {
  if (!wantsYes) return null;
  if (e?.opted_out) return 'refused_opted_out';
  if (e?.latest === 'marketing_opt_out') return 'refused_withdrawn';
  return e?.consent ? 'already' : 'grant';
}

/** What would happen to each row right now. */
async function classify(tx: Tx, rows: ParsedRow[]): Promise<Classified[]> {
  const phones = rows.filter((r) => r.phone && !r.problem).map((r) => r.phone!);
  const existing = new Map<string, { contact_id: string; opted_out: boolean; consent: boolean; latest: string | null }>();
  for (let i = 0; i < phones.length; i += 1000) {
    const chunk = phones.slice(i, i + 1000);
    for (const e of (await tx.query<{ value: string; contact_id: string; opted_out: boolean; consent: boolean; latest: string | null }>(
      `SELECT ci.value, ci.contact_id, (ct.opted_out_at IS NOT NULL) AS opted_out, (ct.marketing_consent_at IS NOT NULL) AS consent,
              (SELECT e.kind FROM consent_events e WHERE e.contact_id = ct.id AND e.kind IN ('marketing_opt_in', 'marketing_opt_out') ORDER BY e.created_at DESC, e.id DESC LIMIT 1) AS latest
       FROM contact_identifiers ci JOIN contacts ct ON ct.id = ci.contact_id WHERE ci.kind = 'whatsapp' AND ci.value = ANY($1)`, [chunk])).rows) {
      existing.set(e.value, e);
    }
  }
  return rows.map((r) => {
    if (r.problem || !r.phone) return { ...r, outcome: 'problem' as const };
    const e = existing.get(r.phone);
    const consentAction = consentFor(r.consent === true, e);
    return e ? { ...r, outcome: 'existing' as const, contactId: e.contact_id, consentAction } : { ...r, outcome: 'new' as const, consentAction };
  });
}

function summarise(rows: Classified[], ignoredColumns: string[] = []) {
  const count = (f: (r: Classified) => boolean) => rows.filter(f).length;
  const problems: Record<string, number> = {};
  for (const r of rows) if (r.problem) problems[r.problem] = (problems[r.problem] ?? 0) + 1;
  return {
    rows: rows.length, new: count((r) => r.outcome === 'new'), existing: count((r) => r.outcome === 'existing'),
    problems, problemCount: count((r) => r.outcome === 'problem'),
    consentToRecord: count((r) => r.consentAction === 'grant'), consentAlready: count((r) => r.consentAction === 'already'),
    consentRefusedOptedOut: count((r) => r.consentAction === 'refused_opted_out'),
    consentRefusedWithdrawn: count((r) => r.consentAction === 'refused_withdrawn'), ignoredColumns,
  };
}

const BATCH_COLUMNS = `id, file_name AS "fileName", status, consent_evidence AS "consentEvidence", summary, created_at AS "createdAt",
  imported_at AS "importedAt", undone_at AS "undoneAt"`;

export class ContactImportService {
  constructor(private readonly deps: Deps) {}

  async preview(actor: TenantActor, input: unknown) {
    const body = parse(PreviewInput, input);
    const { rows, ignoredColumns } = parseContactsCsv(body.csv);
    return withContext(this.deps.db, actor, async (tx) => {
      // Previews that were never imported expire after a day: their names and numbers are not kept (review L5).
      await tx.query(`UPDATE import_batches SET rows = '[]'::jsonb WHERE status = 'previewed' AND created_at < now() - interval '24 hours' AND rows <> '[]'::jsonb`);
      const classified = await classify(tx, rows);
      const summary = summarise(classified, ignoredColumns);
      const needsEvidence = summary.consentToRecord > 0 && !body.consentEvidence;
      const batch = (await tx.query<{ id: string }>(
        `INSERT INTO import_batches (tenant_id, file_name, consent_evidence, rows, summary, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [actor.tenantId, body.fileName, body.consentEvidence ?? null, JSON.stringify(rows), JSON.stringify({ ...summary, needsEvidence }), actor.membershipId])).rows[0]!;
      return {
        id: batch.id, summary: { ...summary, needsEvidence },
        problemRows: classified.filter((r) => r.problem).slice(0, IMPORT_LIMITS.problemRowsShown).map((r) => ({ line: r.line, problem: r.problem })),
        sample: classified.filter((r) => !r.problem).slice(0, 20).map((r) => ({ line: r.line, phone: r.phone, name: r.name, language: r.language, consent: r.consent, outcome: r.outcome, consentAction: r.consentAction })),
      };
    });
  }

  list(actor: TenantActor) {
    return withContext(this.deps.db, actor, async (tx) =>
      (await tx.query(`SELECT ${BATCH_COLUMNS} FROM import_batches WHERE status <> 'previewed' ORDER BY created_at DESC LIMIT 50`)).rows);
  }

  /** Applies a preview. Every row is checked again now; repeating the call changes nothing. */
  async commit(actor: TenantActor, id: string) {
    if (!isUuid(id)) throw Errors.notFound('Import');
    return withContext(this.deps.db, actor, async (tx) => {
      const b = (await tx.query<{ status: string; rows: ParsedRow[]; consent_evidence: string | null; created_at: Date }>(
        'SELECT status, rows, consent_evidence, created_at FROM import_batches WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!b) throw Errors.notFound('Import');
      if (b.status !== 'previewed') throw Errors.conflict('import_done', 'This import has already been applied or undone.');
      if (Date.now() - b.created_at.getTime() > 24 * 3600_000) throw Errors.conflict('preview_expired', 'This preview is more than a day old. Preview the file again.');
      const outcomes: Array<{ contactId: string; created: boolean; consentGranted: boolean }> = [];
      let created = 0; let updated = 0; let consentGranted = 0; let consentRefused = 0; let consentWithdrawnBefore = 0; let skipped = 0;
      // Numbers in ascending order: the webhook takes its per-number locks in the same order, so the two never deadlock
      // (review M1).
      const ordered = [...b.rows].sort((x, y) => (x.phone ?? '').localeCompare(y.phone ?? ''));
      for (const r of ordered) {
        if (r.problem || !r.phone) { skipped++; continue; }
        // The same lock as an incoming message from this number, so an import and a first message cannot create two contacts.
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${actor.tenantId}:wa:${r.phone}`]);
        const e = (await tx.query<{ contact_id: string; opted_out: boolean; consent: boolean; latest: string | null }>(
          `SELECT ci.contact_id, (ct.opted_out_at IS NOT NULL) AS opted_out, (ct.marketing_consent_at IS NOT NULL) AS consent,
                  (SELECT e.kind FROM consent_events e WHERE e.contact_id = ct.id AND e.kind IN ('marketing_opt_in', 'marketing_opt_out') ORDER BY e.created_at DESC, e.id DESC LIMIT 1) AS latest
           FROM contact_identifiers ci JOIN contacts ct ON ct.id = ci.contact_id WHERE ci.kind = 'whatsapp' AND ci.value = $1 FOR UPDATE OF ct`, [r.phone])).rows[0];
        let contactId: string; let isNew = false;
        if (e) {
          contactId = e.contact_id;
          // Only fills what is missing; never overwrites a name or language already known.
          const fill = (await tx.query(`UPDATE contacts SET display_name = coalesce(display_name, $2), locale = coalesce(locale, $3), updated_at = now()
                                        WHERE id = $1 AND ((display_name IS NULL AND $2::text IS NOT NULL) OR (locale IS NULL AND $3::text IS NOT NULL))`,
            [contactId, r.name, r.language])).rowCount;
          if (fill) updated++;
        } else {
          contactId = (await tx.query<{ id: string }>('INSERT INTO contacts (tenant_id, display_name, locale, created_by_import) VALUES ($1, $2, $3, $4) RETURNING id',
            [actor.tenantId, r.name, r.language, id])).rows[0]!.id;
          await tx.query(`INSERT INTO contact_identifiers (tenant_id, contact_id, kind, value) VALUES ($1, $2, 'whatsapp', $3)`, [actor.tenantId, contactId, r.phone]);
          created++; isNew = true;
        }
        let granted = false;
        const action = consentFor(r.consent === true, e);
        if (action === 'refused_opted_out') consentRefused++;
        else if (action === 'refused_withdrawn') consentWithdrawnBefore++;
        else if (action === 'grant') {
          // Evidence is needed only when a consent is actually about to be recorded (review L2).
          if (!b.consent_evidence) {
            throw new AppError(409, 'consent_evidence_required', 'Some rows say the customer agreed to marketing messages. Describe how they agreed, then preview again.');
          }
          // Guarded again in the statement itself, in case an opt-out arrived by another route (review L4).
          const upd = await tx.query('UPDATE contacts SET marketing_consent_at = now(), updated_at = now() WHERE id = $1 AND opted_out_at IS NULL', [contactId]);
          if (upd.rowCount) {
            await tx.query(`INSERT INTO consent_events (tenant_id, contact_id, kind, channel, source, evidence, recorded_by)
                            VALUES ($1, $2, 'marketing_opt_in', 'whatsapp', 'import', $3, $4)`,
              [actor.tenantId, contactId, `Import ${id}: ${b.consent_evidence}`.slice(0, 300), actor.userId]);
            consentGranted++; granted = true;
          } else consentRefused++;
        }
        outcomes.push({ contactId, created: isNew, consentGranted: granted });
      }
      const result = { created, updated, consentGranted, consentRefusedOptedOut: consentRefused, consentRefusedWithdrawn: consentWithdrawnBefore, skipped };
      await tx.query(`UPDATE import_batches SET status = 'imported', imported_by = $2, imported_at = now(), rows = $3, summary = summary || $4 WHERE id = $1`,
        [id, actor.membershipId, JSON.stringify(outcomes), JSON.stringify({ result })]);
      await AuditService.record(tx, { tenantId: actor.tenantId, actorUserId: actor.userId, action: 'contacts.imported', ip: actor.ip,
        targetType: 'import_batch', targetId: id, metadata: result });
      return (await tx.query(`SELECT ${BATCH_COLUMNS} FROM import_batches WHERE id = $1`, [id])).rows[0];
    });
  }

  /**
   * Undoes an import: removes contacts it created that have no conversation, and withdraws marketing consent it
   * recorded (if that consent is still the latest decision for the contact). Contacts that started a conversation
   * are kept. Nothing is sent.
   */
  async undo(actor: TenantActor, id: string) {
    if (!isUuid(id)) throw Errors.notFound('Import');
    return withContext(this.deps.db, actor, async (tx) => {
      const b = (await tx.query<{ status: string; rows: Array<{ contactId: string; created: boolean; consentGranted: boolean }> }>(
        'SELECT status, rows FROM import_batches WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!b) throw Errors.notFound('Import');
      if (b.status !== 'imported') throw Errors.conflict('import_not_applied', 'Only an applied import can be undone.');
      let removed = 0; let kept = 0; let consentWithdrawn = 0;
      for (const o of b.rows) {
        if (o.created) {
          // Kept if anything else has happened to the contact: a conversation, a consent decision not made by this
          // import (for example the customer withdrawing), or a campaign recipient record. Deleting would erase that
          // history with the contact (review M3); the database trigger enforces the same rule.
          const del = await tx.query(`DELETE FROM contacts c WHERE c.id = $1 AND c.created_by_import = $2
                                        AND NOT EXISTS (SELECT 1 FROM conversations v WHERE v.contact_id = c.id)
                                        AND NOT EXISTS (SELECT 1 FROM consent_events e WHERE e.contact_id = c.id AND coalesce(e.evidence, '') NOT LIKE 'Import ' || $2 || ':%')
                                        AND NOT EXISTS (SELECT 1 FROM campaign_recipients cr WHERE cr.contact_id = c.id)`, [o.contactId, id]);
          if (del.rowCount) { removed++; continue; }
          kept++;
        }
        if (o.consentGranted) {
          // Withdrawn only if this import's consent is still the latest decision recorded for the contact.
          const latest = (await tx.query<{ source: string; kind: string; evidence: string | null }>(
            `SELECT source, kind, evidence FROM consent_events WHERE contact_id = $1 AND kind IN ('marketing_opt_in', 'marketing_opt_out')
             ORDER BY created_at DESC, id DESC LIMIT 1`, [o.contactId])).rows[0];
          if (latest && latest.kind === 'marketing_opt_in' && latest.source === 'import' && latest.evidence?.startsWith(`Import ${id}:`)) {
            await tx.query('UPDATE contacts SET marketing_consent_at = NULL, updated_at = now() WHERE id = $1', [o.contactId]);
            await tx.query(`INSERT INTO consent_events (tenant_id, contact_id, kind, channel, source, evidence, recorded_by)
                            VALUES ($1, $2, 'marketing_opt_out', 'whatsapp', 'import', $3, $4)`,
              [actor.tenantId, o.contactId, `Undo of import ${id}`, actor.userId]);
            consentWithdrawn++;
          }
        }
      }
      const undo = { removed, kept, consentWithdrawn };
      await tx.query(`UPDATE import_batches SET status = 'undone', undone_by = $2, undone_at = now(), summary = summary || $3 WHERE id = $1`,
        [id, actor.membershipId, JSON.stringify({ undo })]);
      await AuditService.record(tx, { tenantId: actor.tenantId, actorUserId: actor.userId, action: 'contacts.import_undone', ip: actor.ip,
        targetType: 'import_batch', targetId: id, metadata: undo });
      return (await tx.query(`SELECT ${BATCH_COLUMNS} FROM import_batches WHERE id = $1`, [id])).rows[0];
    });
  }
}

const ContactsQuery = z.object({ q: z.string().trim().max(100).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) });

/**
 * The company's contacts, newest first, with an optional search by name or number. Someone who can see every
 * conversation (`inbox.read_all`) sees every contact; anyone else sees only customers whose conversation they could
 * open in the inbox (unassigned, or assigned to them), the same rule as the inbox itself (slice 5 review M4).
 */
export async function listContacts(deps: Deps, actor: TenantActor, query: unknown) {
  const q = parse(ContactsQuery, query);
  const term = q.q ? q.q.replace(/[%_\\]/g, (c) => `\\${c}`) : null;
  const digits = q.q ? q.q.replace(/[^0-9]/g, '') : '';
  return withContext(deps.db, actor, async (tx) => (await tx.query(
    `SELECT ct.id, ct.display_name AS name, ct.locale AS language, wa.value AS whatsapp,
            (ct.opted_out_at IS NOT NULL) AS "optedOut", ct.marketing_consent_at AS "marketingConsentAt",
            ct.created_by_import AS "importId", ct.created_at AS "createdAt"
     FROM contacts ct
     LEFT JOIN LATERAL (SELECT value FROM contact_identifiers ci WHERE ci.contact_id = ct.id AND ci.kind = 'whatsapp' LIMIT 1) wa ON true
     WHERE ($1::text IS NULL OR ct.display_name ILIKE '%' || $1 || '%' OR ($3 <> '' AND wa.value LIKE '%' || $3 || '%'))
       AND ($4::boolean OR EXISTS (SELECT 1 FROM conversations v WHERE v.contact_id = ct.id
                                    AND (v.assigned_membership_id IS NULL OR v.assigned_membership_id = $5::uuid)))
     ORDER BY ct.created_at DESC LIMIT $2`,
    [term, q.limit, digits, actor.permissions.has('inbox.read_all'), actor.membershipId])).rows);
}
