import { randomBytes, randomUUID } from 'node:crypto';
import { withContext, type Db, type Tx } from '@conversaflow/database';
import { z } from 'zod';
import type { Deps, TenantActor } from '../core/context';
import { AppError, Errors } from '../core/errors';
import { RATE_RULES } from '../core/rate-limit';
import { parse } from '../core/validate';
import { AuditService } from './audit.service';
import { addressKey, hashToken } from './customer-links';
import { InboxService } from './inbox.service';
import { isUuid } from './members.service';
import { formatMoney, priceQuote, RateCard, type Priced } from './operator-pricing';
import { companyHours } from './sla';

/**
 * Conversa Operator, slice 1 (Operator addendum v1.0; migration 0059): from a customer's request to an accepted quote.
 *
 * - The module is off for every company until someone with operator.manage turns it on; the emergency pause stops
 *   every Operator action that reaches a customer (sending quotes now; bookings and dispatch in later slices).
 * - Prices come only from the published rate card through deterministic code (operator-pricing.ts). A quote version
 *   never changes after it is made: a change is a new version, and the previous one is superseded.
 * - The customer accepts one exact version through a single-use link tied to that version and that customer; opening
 *   the link never accepts anything. A person may record an acceptance given another way, with a note of how.
 * - Quote messages are fixed text filled from the quote, never AI wording; they go through the ordinary reply path,
 *   so every reply check applies (assignment, pause, opt-out, 24-hour window, channel).
 * Status words are kept honest: sent is not accepted, accepted is not booked.
 */
export const OPERATOR_FACTS = ['service', 'quantity', 'equipment', 'area', 'address', 'preferred_time', 'language', 'access', 'contact_preference'] as const;
const FactState = z.enum(['unknown', 'unavailable', 'not_applicable', 'stated', 'confirmed']);
const FactInput = z.object({ state: FactState, value: z.string().trim().max(300).optional(), original: z.string().trim().max(500).optional() }).strict()
  .refine((f) => !['stated', 'confirmed'].includes(f.state) || !!f.value, 'A stated or confirmed fact needs a value.');
const FactsPatch = z.object({ facts: z.partialRecord(z.enum(OPERATOR_FACTS), FactInput), expectedVersion: z.number().int().min(0) }).strict();
const SettingsInput = z.object({
  enabled: z.boolean().optional(),
  mode: z.enum(['off', 'assist', 'approval', 'limited']).optional(),
  termsEn: z.string().trim().max(4000).optional(),
  termsAr: z.string().trim().max(4000).optional(),
}).strict();
const QuoteInput = z.object({
  lines: z.array(z.object({ serviceKey: z.string().max(40), quantity: z.number().int().min(1).max(100) }).strict()).min(1).max(10),
  areaKey: z.string().max(60),
  manualDiscountBp: z.number().int().min(0).max(5000).optional(),
  note: z.string().trim().max(500).optional(),
}).strict();
const AcceptInput = z.object({ quoteNumber: z.number().int().min(1), agree: z.literal(true) }).strict();
const StaffAccept = z.object({ evidenceNote: z.string().trim().min(5).max(500), expectedVersion: z.number().int().min(0) }).strict();
export const QUOTE_LINK_HEADER = 'x-quote-link';
const tokenShape = /^[A-Za-z0-9_-]{43}$/;

type CaseRow = { id: string; conversation_id: string; contact_id: string; status: string; facts: Record<string, unknown>; version: number };
type QuoteRow = { id: string; case_id: string; number: number; status: string; needs_approval: string[]; created_by: string | null; total_minor: string;
  currency: string; valid_until: Date; terms_version: number; version: number; inspection_only: boolean; approved_at: Date | null };

const OPEN_QUOTE = ['draft', 'pending_approval', 'approved', 'sent'];

async function settingsOf(tx: Tx) {
  return (await tx.query<{ enabled: boolean; mode: string; paused: boolean; terms_version: number; terms_en: string; terms_ar: string }>(
    'SELECT enabled, mode, paused, terms_version, terms_en, terms_ar FROM op_settings')).rows[0]
    ?? { enabled: false, mode: 'off', paused: false, terms_version: 1, terms_en: '', terms_ar: '' };
}
async function caseEvent(tx: Tx, tenantId: string, caseId: string, kind: string, actor: { membershipId?: string | null; kind: 'person' | 'customer' | 'system' }, data: Record<string, unknown> = {}) {
  await tx.query(`INSERT INTO op_case_events (tenant_id, case_id, kind, actor_membership_id, actor_kind, data) VALUES ($1, $2, $3, $4, $5, $6)`,
    [tenantId, caseId, kind, actor.membershipId ?? null, actor.kind, JSON.stringify(data)]);
}
/** The published rate card's service names (for messages and the customer page). */
type Names = Record<string, { en: string; ar: string }>;

export class OperatorService {
  private readonly inbox: InboxService;
  constructor(private readonly deps: Deps) { this.inbox = new InboxService(deps); }

  // --- Settings, pause and rate cards (operator.manage) ------------------------------------------------------

  settings(actor: TenantActor) {
    return withContext(this.deps.db, actor, async (tx) => {
      const s = await settingsOf(tx);
      const card = (await tx.query<{ id: string; version: number; published_at: Date }>(`SELECT id, version, published_at FROM op_rate_cards WHERE status = 'published'`)).rows[0] ?? null;
      return { enabled: s.enabled, mode: s.mode, paused: s.paused, termsVersion: s.terms_version, termsEn: s.terms_en, termsAr: s.terms_ar,
        publishedRateCard: card ? { id: card.id, version: card.version, publishedAt: card.published_at } : null };
    });
  }

  async saveSettings(actor: TenantActor, input: unknown) {
    const body = parse(SettingsInput, input);
    return withContext(this.deps.db, actor, async (tx) => {
      await tx.query('INSERT INTO op_settings (tenant_id) VALUES ($1) ON CONFLICT DO NOTHING', [actor.tenantId]);
      const s = (await tx.query<{ enabled: boolean; terms_en: string; terms_ar: string }>('SELECT enabled, terms_en, terms_ar FROM op_settings FOR UPDATE')).rows[0]!;
      if (body.enabled === true && !s.enabled) {
        const card = (await tx.query(`SELECT 1 FROM op_rate_cards WHERE status = 'published'`)).rowCount;
        const terms = (body.termsEn ?? s.terms_en).length > 0 && (body.termsAr ?? s.terms_ar).length > 0;
        if (!card || !terms) throw Errors.conflict('operator_not_ready', 'Publish a price list and write the customer terms in English and Arabic before turning this on.');
      }
      const termsChanged = (body.termsEn !== undefined && body.termsEn !== s.terms_en) || (body.termsAr !== undefined && body.termsAr !== s.terms_ar);
      await tx.query(`UPDATE op_settings SET enabled = coalesce($1, enabled), mode = coalesce($2, mode), terms_en = coalesce($3, terms_en), terms_ar = coalesce($4, terms_ar),
                        terms_version = terms_version + CASE WHEN $5 THEN 1 ELSE 0 END, updated_at = now(), updated_by = $6`,
        [body.enabled ?? null, body.mode ?? null, body.termsEn ?? null, body.termsAr ?? null, termsChanged, actor.userId]);
      await AuditService.record(tx, { tenantId: actor.tenantId, actorUserId: actor.userId, action: 'operator.settings_changed', ip: actor.ip, targetType: 'tenant', targetId: actor.tenantId,
        metadata: { enabled: body.enabled, mode: body.mode, termsChanged } });
      return { ok: true };
    });
  }

  /** Emergency pause: no Operator action reaches a customer until it is lifted. */
  async setPause(actor: TenantActor, paused: boolean, reason?: string) {
    return withContext(this.deps.db, actor, async (tx) => {
      await tx.query('INSERT INTO op_settings (tenant_id) VALUES ($1) ON CONFLICT DO NOTHING', [actor.tenantId]);
      await tx.query(`UPDATE op_settings SET paused = $1, paused_at = CASE WHEN $1 THEN now() END, paused_by = CASE WHEN $1 THEN $2::uuid END, updated_at = now(), updated_by = $2`,
        [paused, actor.userId]);
      await AuditService.record(tx, { tenantId: actor.tenantId, actorUserId: actor.userId, action: paused ? 'operator.paused' : 'operator.resumed', ip: actor.ip,
        targetType: 'tenant', targetId: actor.tenantId, metadata: { reason: reason?.slice(0, 300) ?? null } });
      return { paused };
    });
  }

  rateCards(actor: TenantActor) {
    return withContext(this.deps.db, actor, async (tx) => (await tx.query(
      `SELECT id, version, status, card, note, created_at AS "createdAt", published_at AS "publishedAt", retired_at AS "retiredAt" FROM op_rate_cards ORDER BY version DESC LIMIT 50`)).rows);
  }

  async createRateCard(actor: TenantActor, input: unknown) {
    const body = parse(z.object({ card: z.unknown(), note: z.string().trim().max(500).optional() }).strict(), input);
    const card = parse(RateCard, body.card);
    return withContext(this.deps.db, actor, async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 59))', [actor.tenantId]);
      const drafts = (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM op_rate_cards WHERE status = 'draft'`)).rows[0]!.n;
      if (drafts >= 10) throw Errors.conflict('too_many_drafts', 'Publish or discard a draft price list first (up to 10 drafts).');
      const v = (await tx.query<{ v: number }>('SELECT coalesce(max(version), 0) + 1 AS v FROM op_rate_cards')).rows[0]!.v;
      const id = (await tx.query<{ id: string }>('INSERT INTO op_rate_cards (tenant_id, version, card, note, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id',
        [actor.tenantId, v, JSON.stringify(card), body.note ?? null, actor.userId])).rows[0]!.id;
      await AuditService.record(tx, { tenantId: actor.tenantId, actorUserId: actor.userId, action: 'operator.rate_card_drafted', ip: actor.ip, targetType: 'op_rate_card', targetId: id, metadata: { version: v } });
      return { id, version: v };
    });
  }

  /** Publishing a draft retires the current price list. Quotes already made keep the list they were priced on. */
  async publishRateCard(actor: TenantActor, id: string) {
    if (!isUuid(id)) throw Errors.notFound('Price list');
    return withContext(this.deps.db, actor, async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 59))', [actor.tenantId]);
      const r = (await tx.query<{ status: string; card: unknown; version: number }>('SELECT status, card, version FROM op_rate_cards WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!r) throw Errors.notFound('Price list');
      if (r.status !== 'draft') throw Errors.conflict('rate_card_not_draft', 'Only a draft price list can be published.');
      parse(RateCard, r.card);
      await tx.query(`UPDATE op_rate_cards SET status = 'retired', retired_at = now() WHERE status = 'published'`);
      await tx.query(`UPDATE op_rate_cards SET status = 'published', published_at = now(), published_by = $2 WHERE id = $1`, [id, actor.userId]);
      await AuditService.record(tx, { tenantId: actor.tenantId, actorUserId: actor.userId, action: 'operator.rate_card_published', ip: actor.ip, targetType: 'op_rate_card', targetId: id, metadata: { version: r.version } });
      return { id, version: r.version, status: 'published' };
    });
  }

  // --- Cases and facts (operator.quote) ------------------------------------------------------------------------

  private async visibleConversation(tx: Tx, actor: TenantActor, id: string) {
    if (!isUuid(id)) throw Errors.notFound('Conversation');
    const c = (await tx.query<{ id: string; contact_id: string }>(
      `SELECT id, contact_id FROM conversations c WHERE c.id = $1 AND ($2::boolean OR c.assigned_membership_id IS NULL OR c.assigned_membership_id = $3::uuid)`,
      [id, actor.permissions.has('inbox.read_all'), actor.membershipId])).rows[0];
    if (!c) throw Errors.notFound('Conversation');
    return c;
  }
  private async visibleCase(tx: Tx, actor: TenantActor, id: string, lock = false): Promise<CaseRow> {
    if (!isUuid(id)) throw Errors.notFound('Case');
    const sql = `SELECT k.id, k.conversation_id, k.contact_id, k.status, k.facts, k.version FROM op_cases k JOIN conversations c ON c.id = k.conversation_id
       WHERE k.id = $1 AND ($2::boolean OR c.assigned_membership_id IS NULL OR c.assigned_membership_id = $3::uuid)`;
    const c = (await tx.query<CaseRow>(lock ? sql + ' FOR UPDATE OF k' : sql, [id, actor.permissions.has('inbox.read_all'), actor.membershipId])).rows[0];
    if (!c) throw Errors.notFound('Case');
    return c;
  }

  async openCase(actor: TenantActor, conversationId: string) {
    return withContext(this.deps.db, actor, async (tx) => {
      const s = await settingsOf(tx);
      if (!s.enabled) throw Errors.conflict('operator_off', 'Conversa Operator is not turned on for this company.');
      const c = await this.visibleConversation(tx, actor, conversationId);
      await tx.query('SELECT 1 FROM conversations WHERE id = $1 FOR UPDATE', [c.id]);
      const open = (await tx.query<{ id: string }>(`SELECT id FROM op_cases WHERE conversation_id = $1 AND status <> 'closed' ORDER BY created_at DESC LIMIT 1`, [c.id])).rows[0];
      if (open) return { id: open.id, existing: true };
      const facts = Object.fromEntries(OPERATOR_FACTS.map((f) => [f, { state: 'unknown' }]));
      const id = (await tx.query<{ id: string }>(`INSERT INTO op_cases (tenant_id, conversation_id, contact_id, facts, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [actor.tenantId, c.id, c.contact_id, JSON.stringify(facts), actor.userId])).rows[0]!.id;
      await caseEvent(tx, actor.tenantId, id, 'case_opened', { membershipId: actor.membershipId, kind: 'person' });
      await AuditService.record(tx, { tenantId: actor.tenantId, actorUserId: actor.userId, action: 'operator.case_opened', ip: actor.ip, targetType: 'op_case', targetId: id, metadata: { conversationId: c.id } });
      return { id, existing: false };
    });
  }

  /** Records what is known; unknown stays unknown (never a default). Each fact keeps its source and time. */
  async updateFacts(actor: TenantActor, caseId: string, input: unknown) {
    const body = parse(FactsPatch, input);
    return withContext(this.deps.db, actor, async (tx) => {
      const k = await this.visibleCase(tx, actor, caseId, true);
      if (k.status === 'closed') throw Errors.conflict('case_closed', 'This case is closed.');
      if (k.version !== body.expectedVersion) throw new AppError(409, 'case_changed', 'Someone else changed this case. Reload and try again.');
      const at = new Date().toISOString();
      const next = { ...k.facts };
      for (const [key, f] of Object.entries(body.facts)) next[key] = { ...f, source: 'person', by: actor.membershipId, at };
      await tx.query('UPDATE op_cases SET facts = $2, updated_at = now(), version = version + 1 WHERE id = $1', [k.id, JSON.stringify(next)]);
      await caseEvent(tx, actor.tenantId, k.id, 'facts_updated', { membershipId: actor.membershipId, kind: 'person' }, { fields: Object.keys(body.facts) });
      return { id: k.id, version: k.version + 1 };
    });
  }

  async getCase(actor: TenantActor, caseId: string) {
    return withContext(this.deps.db, actor, async (tx) => {
      const k = await this.visibleCase(tx, actor, caseId);
      const quotes = (await tx.query(`SELECT id, number, status, currency, total_minor::text AS "totalMinor", tax_minor::text AS "taxMinor", deposit_minor::text AS "depositMinor",
          inspection_only AS "inspectionOnly", priced, request, scope_en AS "scopeEn", scope_ar AS "scopeAr", valid_until AS "validUntil", needs_approval AS "needsApproval",
          approved_at AS "approvedAt", sent_at AS "sentAt", closed_at AS "closedAt", close_reason AS "closeReason", terms_version AS "termsVersion", version, created_at AS "createdAt",
          (SELECT row_to_json(a) FROM (SELECT channel, accepted_at AS "acceptedAt", evidence_note AS "evidenceNote" FROM op_acceptances x WHERE x.quote_id = q.id) a) AS acceptance
        FROM op_quotes q WHERE q.case_id = $1 ORDER BY number DESC`, [k.id])).rows;
      const events = (await tx.query(`SELECT kind, actor_kind AS "actorKind", actor_membership_id AS "actorMembershipId", data, created_at AS "createdAt"
        FROM op_case_events WHERE case_id = $1 ORDER BY created_at, id`, [k.id])).rows;
      return { id: k.id, conversationId: k.conversation_id, status: k.status, facts: k.facts, version: k.version, quotes, events };
    });
  }

  casesForConversation(actor: TenantActor, conversationId: string) {
    return withContext(this.deps.db, actor, async (tx) => {
      const c = await this.visibleConversation(tx, actor, conversationId);
      return (await tx.query(`SELECT id, status, created_at AS "createdAt", version FROM op_cases WHERE conversation_id = $1 ORDER BY created_at DESC`, [c.id])).rows;
    });
  }

  // --- Quotes -----------------------------------------------------------------------------------------------------

  /** Prices a new quote version from the published list; the case's open version (if any) is superseded. */
  async createQuote(actor: TenantActor, caseId: string, input: unknown) {
    const body = parse(QuoteInput, input);
    return withContext(this.deps.db, actor, async (tx) => {
      const s = await settingsOf(tx);
      if (!s.enabled) throw Errors.conflict('operator_off', 'Conversa Operator is not turned on for this company.');
      if (!s.terms_en || !s.terms_ar) throw Errors.conflict('operator_not_ready', 'Write the customer terms in English and Arabic first.');
      const k = await this.visibleCase(tx, actor, caseId, true);
      if (k.status === 'closed') throw Errors.conflict('case_closed', 'This case is closed.');
      await this.ensureHandler(tx, actor, k.conversation_id);
      const rc = (await tx.query<{ id: string; card: unknown }>(`SELECT id, card FROM op_rate_cards WHERE status = 'published'`)).rows[0];
      if (!rc) throw Errors.conflict('no_price_list', 'There is no published price list.');
      const card = parse(RateCard, rc.card);
      const priced = priceQuote(card, { lines: body.lines, areaKey: body.areaKey, manualDiscountBp: body.manualDiscountBp });
      if (!priced.ok) {
        const why: Record<string, string> = { unknown_service: 'This service is not on the price list.', outside_area: 'This area is outside the service area.',
          quantity: 'The quantity is outside what the price list allows.', mixed_inspection: 'A visit that needs an inspection cannot be priced together with fixed-price work.',
          discount_too_large: 'That discount is not allowed.', empty: 'Add at least one service.', duplicate_line: 'Each service can be listed once; set its quantity instead.',
          too_large: 'This quote is larger than the system accepts. Split it or contact support.' };
        throw new AppError(400, 'cannot_price', why[priced.reason] ?? 'This cannot be priced.', { reason: priced.reason, detail: priced.detail ?? null });
      }
      const names = Object.fromEntries(card.services.map((x) => [x.serviceKey, { en: x.nameEn, ar: x.nameAr }])) as Names;
      const scope = describeScope(priced, names);
      const prev = (await tx.query<{ id: string; status: string }>(`SELECT id, status FROM op_quotes WHERE case_id = $1 AND status = ANY($2::text[]) FOR UPDATE`, [k.id, OPEN_QUOTE])).rows[0];
      if (prev) {
        await tx.query(`UPDATE op_quotes SET status = 'superseded', closed_at = now(), close_reason = 'new_version', version = version + 1 WHERE id = $1`, [prev.id]);
        await tx.query('UPDATE op_quote_links SET revoked_at = now() WHERE quote_id = $1 AND revoked_at IS NULL', [prev.id]);
      }
      const number = (await tx.query<{ n: number }>('SELECT coalesce(max(number), 0) + 1 AS n FROM op_quotes WHERE case_id = $1', [k.id])).rows[0]!.n;
      const status = priced.needsApproval.length ? 'pending_approval' : 'draft';
      const q = (await tx.query<{ id: string }>(
        `INSERT INTO op_quotes (tenant_id, case_id, number, rate_card_id, status, request, priced, currency, total_minor, tax_minor, deposit_minor, inspection_only,
                                scope_en, scope_ar, terms_version, terms_en, terms_ar, valid_until, needs_approval, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, now() + make_interval(hours => $18), $19, $20) RETURNING id`,
        [actor.tenantId, k.id, number, rc.id, status, JSON.stringify(body), JSON.stringify({ ...priced, names }), priced.currency, priced.total, priced.tax, priced.deposit,
          priced.inspectionOnly, scope.en, scope.ar, s.terms_version, s.terms_en, s.terms_ar, card.validityHours, priced.needsApproval, actor.userId])).rows[0]!;
      // The case follows its open quote (review M6): waiting for approval, or open for the person to send.
      await tx.query(`UPDATE op_cases SET status = $2, updated_at = now(), version = version + 1 WHERE id = $1`, [k.id, status === 'pending_approval' ? 'waiting_approval' : 'open']);
      await caseEvent(tx, actor.tenantId, k.id, 'quote_created', { membershipId: actor.membershipId, kind: 'person' },
        { quoteId: q.id, number, total: priced.total, currency: priced.currency, needsApproval: priced.needsApproval, supersedes: prev?.id ?? null });
      await AuditService.record(tx, { tenantId: actor.tenantId, actorUserId: actor.userId, action: 'operator.quote_created', ip: actor.ip, targetType: 'op_quote', targetId: q.id,
        metadata: { number, total: priced.total, currency: priced.currency, rateCardId: rc.id, needsApproval: priced.needsApproval, manualDiscountBp: body.manualDiscountBp ?? 0 } });
      return { id: q.id, number, status, priced };
    });
  }

  /** Locks in one order everywhere: the case, then the quote (review M3). */
  private async loadQuote(tx: Tx, actor: TenantActor, id: string): Promise<QuoteRow & { k: CaseRow }> {
    if (!isUuid(id)) throw Errors.notFound('Quote');
    const ref = (await tx.query<{ case_id: string }>('SELECT case_id FROM op_quotes WHERE id = $1', [id])).rows[0];
    if (!ref) throw Errors.notFound('Quote');
    const k = await this.visibleCase(tx, actor, ref.case_id, true);
    const q = (await tx.query<QuoteRow>(`SELECT id, case_id, number, status, needs_approval, created_by, total_minor::text, currency, valid_until, terms_version, version, inspection_only, approved_at
                                          FROM op_quotes WHERE id = $1 FOR UPDATE`, [id])).rows[0]!;
    return { ...q, k };
  }

  /** Changing a customer's quotes is for the person handling the conversation (or anyone while it is unassigned): review L7. */
  private async ensureHandler(tx: Tx, actor: TenantActor, conversationId: string) {
    const a = (await tx.query<{ assigned: string | null }>('SELECT assigned_membership_id AS assigned FROM conversations WHERE id = $1', [conversationId])).rows[0];
    if (a?.assigned && a.assigned !== actor.membershipId) throw new AppError(409, 'assigned_to_other', 'Another person is handling this conversation.', { assignedMembershipId: a.assigned });
  }

  /**
   * Approval of a quote that needs it. Someone other than its author approves, unless the author is the only
   * active member who may approve.
   */
  async approve(actor: TenantActor, id: string, input: unknown) {
    const body = parse(z.object({ expectedVersion: z.number().int().min(0) }).strict(), input);
    return withContext(this.deps.db, actor, async (tx) => {
      const q = await this.loadQuote(tx, actor, id);
      if (q.version !== body.expectedVersion) throw new AppError(409, 'quote_changed', 'This quote changed. Reload and try again.');
      if (q.status !== 'pending_approval') throw Errors.conflict('not_pending', 'This quote is not waiting for approval.');
      if (q.created_by === actor.userId) {
        const others = (await tx.query<{ n: number }>(`SELECT count(DISTINCT m.id)::int AS n FROM memberships m JOIN membership_roles mr ON mr.membership_id = m.id
            JOIN role_permissions rp ON rp.role_id = mr.role_id JOIN conversations c ON c.id = $2
            WHERE m.status = 'active' AND rp.permission_key = 'operator.approve' AND m.user_id <> $1
              AND (c.assigned_membership_id IS NULL OR c.assigned_membership_id = m.id
                   OR EXISTS (SELECT 1 FROM membership_roles r2 JOIN role_permissions p2 ON p2.role_id = r2.role_id WHERE r2.membership_id = m.id AND p2.permission_key = 'inbox.read_all'))`,
          [actor.userId, q.k.conversation_id])).rows[0]!.n;
        if (others > 0) throw Errors.forbidden('Someone other than the person who prepared this quote must approve it.');
      }
      await tx.query(`UPDATE op_quotes SET status = 'approved', approved_by = $2, approved_at = now(), version = version + 1 WHERE id = $1`, [q.id, actor.userId]);
      await tx.query(`UPDATE op_cases SET status = 'open', updated_at = now(), version = version + 1 WHERE id = $1 AND status = 'waiting_approval'`, [q.case_id]);
      await caseEvent(tx, actor.tenantId, q.case_id, 'quote_approved', { membershipId: actor.membershipId, kind: 'person' }, { quoteId: q.id, reasons: q.needs_approval });
      await AuditService.record(tx, { tenantId: actor.tenantId, actorUserId: actor.userId, action: 'operator.quote_approved', ip: actor.ip, targetType: 'op_quote', targetId: q.id,
        metadata: { reasons: q.needs_approval, total: Number(q.total_minor), selfApproved: q.created_by === actor.userId } });
      return { id: q.id, status: 'approved' };
    });
  }

  approvals(actor: TenantActor) {
    return withContext(this.deps.db, actor, async (tx) => (await tx.query(
      `SELECT q.id, q.case_id AS "caseId", k.conversation_id AS "conversationId", q.number, q.currency, q.total_minor::text AS "totalMinor", q.needs_approval AS "needsApproval",
              q.scope_en AS "scopeEn", q.scope_ar AS "scopeAr", q.created_at AS "createdAt", q.valid_until AS "validUntil", q.version
       FROM op_quotes q JOIN op_cases k ON k.id = q.case_id JOIN conversations c ON c.id = k.conversation_id
       WHERE q.status = 'pending_approval' AND ($1::boolean OR c.assigned_membership_id IS NULL OR c.assigned_membership_id = $2::uuid)
       ORDER BY q.created_at LIMIT 200`, [actor.permissions.has('inbox.read_all'), actor.membershipId])).rows);
  }

  /**
   * Sends the quote to the customer: a fixed message with the amounts and a single-use link to review and accept this
   * version. The message goes through the ordinary reply path. Validity runs from the moment it is sent.
   */
  async send(actor: TenantActor, id: string, input: unknown) {
    const body = parse(z.object({ expectedVersion: z.number().int().min(0), seenActivity: z.number().int().min(0), locale: z.enum(['en', 'ar']).optional() }).strict(), input);
    let job: string | null = null;
    const out = await withContext(this.deps.db, actor, async (tx) => {
      const q = await this.loadQuote(tx, actor, id);
      const s = await settingsOf(tx);
      if (!s.enabled) throw Errors.conflict('operator_off', 'Conversa Operator is not turned on for this company.');
      if (s.paused) throw Errors.conflict('operator_paused', 'Conversa Operator is paused for this company. Nothing is sent to customers until it is resumed.');
      if (q.version !== body.expectedVersion) throw new AppError(409, 'quote_changed', 'This quote changed. Reload and try again.');
      if (q.status === 'pending_approval') throw Errors.conflict('needs_approval', 'This quote needs approval before it is sent.');
      if (q.status !== 'draft' && q.status !== 'approved') throw Errors.conflict('quote_not_sendable', 'Only a new or approved quote can be sent.');
      if (q.terms_version !== s.terms_version) throw Errors.conflict('terms_changed', 'The customer terms changed after this quote was made. Make a new version.');
      const priced = (await tx.query<{ priced: Priced & { names: Names }; valid: number }>(
        `SELECT q.priced, (SELECT (r.card->>'validityHours')::int FROM op_rate_cards r WHERE r.id = q.rate_card_id) AS valid FROM op_quotes q WHERE q.id = $1`, [q.id])).rows[0]!;
      const contact = (await tx.query<{ locale: string | null }>('SELECT locale FROM contacts WHERE id = $1', [q.k.contact_id])).rows[0];
      const locale = body.locale ?? (contact?.locale === 'ar' ? 'ar' : 'en');
      const token = randomBytes(32).toString('base64url');
      const validUntil = (await tx.query<{ v: Date }>(`SELECT now() + make_interval(hours => $1) AS v`, [priced.valid])).rows[0]!.v;
      await tx.query(`INSERT INTO op_quote_links (tenant_id, quote_id, contact_id, token_hash, expires_at) VALUES ($1, $2, $3, $4, $5)`,
        [actor.tenantId, q.id, q.k.contact_id, hashToken(token), validUntil]);
      const url = `${this.deps.config.APP_ORIGIN}/${locale}/q#${token}`;
      const { tz } = await companyHours(tx);
      const text = quoteMessage(locale, q.number, priced.priced, validUntil, url, tz);
      const queued = await this.inbox.queueReplyInTx(tx, actor, q.k.conversation_id, text, randomUUID(), body.seenActivity, q.id);
      job = queued.jobId;
      await tx.query(`UPDATE op_quotes SET status = 'sent', sent_at = now(), valid_until = $2, sent_message_id = $3, version = version + 1 WHERE id = $1`, [q.id, validUntil, queued.messageId]);
      await tx.query(`UPDATE op_cases SET status = 'waiting_customer', updated_at = now(), version = version + 1 WHERE id = $1`, [q.case_id]);
      await caseEvent(tx, actor.tenantId, q.case_id, 'quote_sent', { membershipId: actor.membershipId, kind: 'person' }, { quoteId: q.id, messageId: queued.messageId, validUntil });
      await AuditService.record(tx, { tenantId: actor.tenantId, actorUserId: actor.userId, action: 'operator.quote_sent', ip: actor.ip, targetType: 'op_quote', targetId: q.id,
        metadata: { messageId: queued.messageId, validUntil } });
      return { id: q.id, status: 'sent', validUntil, messageId: queued.messageId };
    });
    if (job) await this.inbox.sendQueued(actor, job);
    return out;
  }

  async withdraw(actor: TenantActor, id: string, input: unknown) {
    const body = parse(z.object({ expectedVersion: z.number().int().min(0), reason: z.string().trim().max(300).optional() }).strict(), input);
    return withContext(this.deps.db, actor, async (tx) => {
      const q = await this.loadQuote(tx, actor, id);
      if (q.version !== body.expectedVersion) throw new AppError(409, 'quote_changed', 'This quote changed. Reload and try again.');
      if (!OPEN_QUOTE.includes(q.status)) throw Errors.conflict('quote_closed', 'This quote is already closed.');
      await this.ensureHandler(tx, actor, q.k.conversation_id);
      await tx.query(`UPDATE op_quotes SET status = 'withdrawn', closed_at = now(), close_reason = $2, version = version + 1 WHERE id = $1`, [q.id, body.reason ?? 'withdrawn']);
      await tx.query('UPDATE op_quote_links SET revoked_at = now() WHERE quote_id = $1 AND revoked_at IS NULL', [q.id]);
      await tx.query(`UPDATE op_cases SET status = 'open', updated_at = now(), version = version + 1 WHERE id = $1 AND status IN ('waiting_customer', 'waiting_approval')`, [q.case_id]);
      await caseEvent(tx, actor.tenantId, q.case_id, 'quote_withdrawn', { membershipId: actor.membershipId, kind: 'person' }, { quoteId: q.id, reason: body.reason ?? null });
      await AuditService.record(tx, { tenantId: actor.tenantId, actorUserId: actor.userId, action: 'operator.quote_withdrawn', ip: actor.ip, targetType: 'op_quote', targetId: q.id, metadata: {} });
      return { id: q.id, status: 'withdrawn' };
    });
  }

  /** The customer agreed another way (a call, in person): a person records it, saying how. Same validity rules. */
  async recordAcceptance(actor: TenantActor, id: string, input: unknown) {
    const body = parse(StaffAccept, input);
    return withContext(this.deps.db, actor, async (tx) => {
      const q = await this.loadQuote(tx, actor, id);
      if (q.version !== body.expectedVersion) throw new AppError(409, 'quote_changed', 'This quote changed. Reload and try again.');
      const s = await settingsOf(tx);
      if (!s.enabled) throw Errors.conflict('operator_off', 'Conversa Operator is not turned on for this company.');
      await acceptChecks(tx, q);
      await tx.query(`INSERT INTO op_acceptances (tenant_id, quote_id, contact_id, channel, recorded_by, evidence_note, terms_version, total_minor, currency)
                      VALUES ($1, $2, $3, 'staff_recorded', $4, $5, $6, $7, $8)`,
        [actor.tenantId, q.id, q.k.contact_id, actor.userId, body.evidenceNote, q.terms_version, q.total_minor, q.currency]);
      await markAccepted(tx, actor.tenantId, q, { membershipId: actor.membershipId, kind: 'person' }, 'staff_recorded');
      await AuditService.record(tx, { tenantId: actor.tenantId, actorUserId: actor.userId, action: 'operator.quote_acceptance_recorded', ip: actor.ip, targetType: 'op_quote', targetId: q.id,
        metadata: { evidenceNote: body.evidenceNote } });
      return { id: q.id, status: 'accepted' };
    });
  }
}

async function acceptChecks(tx: Tx, q: QuoteRow) {
  if (q.status === 'accepted') throw Errors.conflict('already_accepted', 'This quote has already been accepted.');
  if (q.status === 'superseded') throw Errors.conflict('quote_superseded', 'This quote was replaced by a newer version.');
  if (q.status !== 'sent') throw Errors.conflict('quote_not_open', 'This quote is not open for acceptance.');
  const live = (await tx.query<{ ok: boolean }>('SELECT $1::timestamptz > clock_timestamp() AS ok', [q.valid_until])).rows[0]!.ok;
  if (!live) throw Errors.conflict('quote_expired', 'This quote has expired. Ask for a new quote.');
}
async function markAccepted(tx: Tx, tenantId: string, q: QuoteRow, actor: { membershipId?: string | null; kind: 'person' | 'customer' }, channel: string) {
  await tx.query(`UPDATE op_quotes SET status = 'accepted', closed_at = now(), close_reason = 'accepted', version = version + 1 WHERE id = $1`, [q.id]);
  await tx.query('UPDATE op_quote_links SET revoked_at = now() WHERE quote_id = $1 AND revoked_at IS NULL AND used_at IS NULL', [q.id]);
  await tx.query(`UPDATE op_cases SET status = 'open', updated_at = now(), version = version + 1 WHERE id = $1 AND status <> 'closed'`, [q.case_id]);
  await caseEvent(tx, tenantId, q.case_id, 'quote_accepted', actor, { quoteId: q.id, number: q.number, channel, total: Number(q.total_minor), currency: q.currency });
}

// --- The customer's quote page --------------------------------------------------------------------------------

export interface QuoteLink { linkId: string; tenantId: string; quoteId: string; contactId: string; used: boolean }

export class QuotePortalService {
  constructor(private readonly deps: Deps) {}

  /** Never says whether a link existed, expired or was revoked. */
  async open(token: string | undefined, ip: string | null): Promise<QuoteLink> {
    const subject = addressKey(ip);
    await this.deps.rateLimiter.hit(RATE_RULES.customerLinkPerIp, subject);
    if (!token || !tokenShape.test(token)) { await this.deps.rateLimiter.hit(RATE_RULES.customerLinkFailPerIp, subject); throw Errors.invalidLink(); }
    const row = await withContext(this.deps.db, { tenantId: null, userId: null }, async (tx) =>
      (await tx.query<{ link_id: string; tenant_id: string; quote_id: string; contact_id: string; used: boolean }>('SELECT * FROM op_quote_link_route($1)', [hashToken(token)])).rows[0]);
    if (!row) { await this.deps.rateLimiter.hit(RATE_RULES.customerLinkFailPerIp, subject); throw Errors.invalidLink(); }
    await this.deps.rateLimiter.hit(RATE_RULES.customerLinkPerLink, row.link_id);
    const live = await withContext(this.deps.db, { tenantId: row.tenant_id, userId: null }, async (tx) => {
      const t = (await tx.query<{ status: string }>('SELECT status FROM tenants WHERE id = $1', [row.tenant_id])).rows[0];
      return !!t && t.status !== 'suspended' && t.status !== 'closed';
    });
    if (!live) throw Errors.invalidLink();
    return { linkId: row.link_id, tenantId: row.tenant_id, quoteId: row.quote_id, contactId: row.contact_id, used: row.used };
  }

  /** What the customer sees: exactly the version they were sent, its honest status, and the terms. */
  view(l: QuoteLink) {
    return withContext(this.deps.db, { tenantId: l.tenantId, userId: null }, async (tx) => {
      const q = (await tx.query<{ number: number; status: string; currency: string; priced: Priced & { names: Names }; scope_en: string; scope_ar: string; terms_en: string; terms_ar: string;
        valid_until: Date; expired: boolean; company: string; accepted_at: Date | null }>(
        `SELECT q.number, q.status, q.currency, q.priced, q.scope_en, q.scope_ar, q.terms_en, q.terms_ar, q.valid_until, (q.valid_until <= now()) AS expired,
                t.legal_name AS company, (SELECT accepted_at FROM op_acceptances a WHERE a.quote_id = q.id) AS accepted_at
         FROM op_quotes q JOIN tenants t ON t.id = q.tenant_id WHERE q.id = $1`, [l.quoteId])).rows[0];
      if (!q) throw Errors.invalidLink();
      const status = q.status === 'sent' && q.expired ? 'expired' : q.status;
      const p = q.priced;
      return {
        company: q.company, number: q.number, status, currency: q.currency, validUntil: q.valid_until, acceptedAt: q.accepted_at,
        lines: p.lines.map((x) => ({ name: p.names[x.serviceKey] ?? { en: x.serviceKey, ar: x.serviceKey }, kind: x.kind, quantity: x.quantity, unitPrice: x.unitPrice, discount: x.tierDiscount, amount: x.net })),
        callout: p.callout, travel: p.travel, minimumTopUp: p.minimumTopUp, manualDiscount: p.manualDiscount, taxable: p.taxable, taxRateBp: p.taxRateBp, tax: p.tax, total: p.total,
        deposit: p.deposit, inspectionOnly: p.inspectionOnly, scope: { en: q.scope_en, ar: q.scope_ar }, terms: { en: q.terms_en, ar: q.terms_ar },
        canAccept: status === 'sent' && !l.used,
      };
    });
  }

  /** Acceptance of this exact version: an explicit request with the version number, once. Opening is not accepting. */
  async accept(l: QuoteLink, input: unknown) {
    const body = parse(AcceptInput, input);
    return withContext(this.deps.db, { tenantId: l.tenantId, userId: null }, async (tx) => {
      const ref = (await tx.query<{ case_id: string }>('SELECT case_id FROM op_quotes WHERE id = $1', [l.quoteId])).rows[0];
      if (!ref) throw Errors.invalidLink();
      await tx.query('SELECT 1 FROM op_cases WHERE id = $1 FOR UPDATE', [ref.case_id]);
      const link = (await tx.query<{ used_at: Date | null; revoked_at: Date | null; live: boolean }>(
        'SELECT used_at, revoked_at, (expires_at > now()) AS live FROM op_quote_links WHERE id = $1 FOR UPDATE', [l.linkId])).rows[0];
      if (!link || link.revoked_at || !link.live) throw Errors.invalidLink();
      const q = (await tx.query<QuoteRow & { contact_id: string }>(
        `SELECT q.id, q.case_id, q.number, q.status, q.needs_approval, q.created_by, q.total_minor::text, q.currency, q.valid_until, q.terms_version, q.version, q.inspection_only, q.approved_at, k.contact_id
         FROM op_quotes q JOIN op_cases k ON k.id = q.case_id WHERE q.id = $1 FOR UPDATE OF q`, [l.quoteId])).rows[0];
      if (!q || q.contact_id !== l.contactId) throw Errors.invalidLink();
      if (link.used_at) {
        // The same customer pressing again after a success: show the result, never accept twice.
        if (q.status === 'accepted') return { status: 'accepted', number: q.number };
        throw Errors.invalidLink();
      }
      if (body.quoteNumber !== q.number) throw Errors.conflict('quote_superseded', 'This is not the latest version of your quote. Open the newest link you received.');
      await acceptChecks(tx, q);
      await tx.query('UPDATE op_quote_links SET used_at = now() WHERE id = $1', [l.linkId]);
      await tx.query(`INSERT INTO op_acceptances (tenant_id, quote_id, contact_id, channel, link_id, terms_version, total_minor, currency)
                      VALUES ($1, $2, $3, 'customer_link', $4, $5, $6, $7)`, [l.tenantId, q.id, l.contactId, l.linkId, q.terms_version, q.total_minor, q.currency]);
      await markAccepted(tx, l.tenantId, q, { kind: 'customer' }, 'customer_link');
      await AuditService.record(tx, { tenantId: l.tenantId, actorUserId: null, action: 'operator.quote_accepted_by_customer', ip: undefined, targetType: 'op_quote', targetId: q.id,
        metadata: { number: q.number, total: Number(q.total_minor), currency: q.currency, termsVersion: q.terms_version } });
      return { status: 'accepted', number: q.number };
    });
  }
}

// --- Worker: quotes past their validity -------------------------------------------------------------------------

export class QuoteExpiryWorker {
  constructor(private readonly db: Db) {}
  async dispatchDue(limit = 200): Promise<number> {
    const due = await withContext(this.db, { tenantId: null, userId: null }, async (tx) =>
      (await tx.query<{ quote_id: string; tenant_id: string }>('SELECT * FROM op_quotes_expiring($1)', [limit])).rows);
    let n = 0;
    for (const d of due) {
      try {
        n += await withContext(this.db, { tenantId: d.tenant_id, userId: null }, async (tx) => {
          const ref = (await tx.query<{ case_id: string }>('SELECT case_id FROM op_quotes WHERE id = $1', [d.quote_id])).rows[0];
          if (!ref) return 0;
          await tx.query('SELECT 1 FROM op_cases WHERE id = $1 FOR UPDATE', [ref.case_id]);
          const q = (await tx.query<{ case_id: string }>(`UPDATE op_quotes SET status = 'expired', closed_at = now(), close_reason = 'validity_ended', version = version + 1
                                                          WHERE id = $1 AND status = 'sent' AND valid_until <= now() RETURNING case_id`, [d.quote_id])).rows[0];
          if (!q) return 0;
          await AuditService.record(tx, { tenantId: d.tenant_id, actorUserId: null, action: 'operator.quote_expired', ip: undefined, targetType: 'op_quote', targetId: d.quote_id, metadata: {} });
          await tx.query(`UPDATE op_cases SET status = 'open', updated_at = now(), version = version + 1 WHERE id = $1 AND status = 'waiting_customer'`, [q.case_id]);
          await caseEvent(tx, d.tenant_id, q.case_id, 'quote_expired', { kind: 'system' }, { quoteId: d.quote_id });
          return 1;
        });
      } catch (err) { console.error('quote expiry failed', d.quote_id, err instanceof Error ? err.message : err); }
    }
    return n;
  }
}

// --- Fixed wording --------------------------------------------------------------------------------------------

function describeScope(p: Priced, names: Names) {
  const en = p.lines.map((l) => `${names[l.serviceKey]?.en ?? l.serviceKey}${l.kind === 'inspection' ? ' (inspection visit)' : ` × ${l.quantity}`}`).join('; ');
  const ar = p.lines.map((l) => `${names[l.serviceKey]?.ar ?? l.serviceKey}${l.kind === 'inspection' ? ' (زيارة معاينة)' : ` × ${l.quantity}`}`).join('؛ ');
  return {
    en: p.inspectionOnly ? `${en}. The repair price is given after the inspection.` : en,
    ar: p.inspectionOnly ? `${ar}. يُحدد سعر الإصلاح بعد المعاينة.` : ar,
  };
}

/** The message that carries a quote. Plain, fixed and filled only from the quote; the company's own assistant name is not invented. */
export function quoteMessage(locale: 'en' | 'ar', number: number, p: Priced, validUntil: Date, url: string, timeZone: string): string {
  const money = (v: number) => formatMoney(v, p.currency, locale);
  const until = new Intl.DateTimeFormat(locale === 'ar' ? 'ar-SA-u-nu-latn-ca-gregory' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(validUntil);
  if (locale === 'ar') {
    return [`عرض السعر رقم ${number}${p.inspectionOnly ? ' (زيارة معاينة)' : ''}`,
      `الإجمالي: ${money(p.total)} شامل الضريبة (${money(p.tax)})`,
      p.deposit > 0 ? `العربون: ${money(p.deposit)}` : null,
      `صالح حتى: ${until}`,
      `لمراجعة التفاصيل والشروط والموافقة: ${url}`,
      'الموافقة على العرض لا تعني تأكيد الموعد؛ سنؤكد الموعد بعد التحقق من التوفر.'].filter(Boolean).join('\n');
  }
  return [`Quote no. ${number}${p.inspectionOnly ? ' (inspection visit)' : ''}`,
    `Total: ${money(p.total)} including tax (${money(p.tax)})`,
    p.deposit > 0 ? `Deposit: ${money(p.deposit)}` : null,
    `Valid until: ${until}`,
    `Review the details and terms, and accept here: ${url}`,
    'Accepting the quote does not book a time yet; we confirm the appointment after checking availability.'].filter(Boolean).join('\n');
}
