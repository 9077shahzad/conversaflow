import { withContext, type Tx } from '@conversaflow/database';
import { z } from 'zod';
import type { Deps, TenantActor } from '../core/context';
import { AppError, Errors } from '../core/errors';
import { parse } from '../core/validate';
import { AuditService } from './audit.service';
import { ChannelSendError, TEMPLATE_EVENT_STATUS, type ParsedEvent, type Provider } from './channels';
import { isUuid } from './members.service';

/**
 * Message templates (BRD v1.2 Wave 1; FR-107). Outside the 24-hour window only an approved template may be sent.
 *
 * Rules from Meta's template review page (read 21 Oct 2026, page undated): positional parameters {{1}}, {{2}} ... in
 * order; the body may not start or end with a parameter; every parameter needs a sample value. Names are lowercase
 * letters, digits and underscores. Review takes up to 24 hours; the decision arrives by webhook.
 */
const PARAM = /\{\{(\d+)\}\}/g;

export function templateParams(body: string): number[] {
  return [...body.matchAll(PARAM)].map((m) => Number(m[1]));
}

/** Checks a template body the way Meta's review does, so obvious rejections are caught before submission. */
export function checkTemplateBody(body: string, examples: string[]): string | null {
  if (/\{\{(?!\d+\}\})|(?<!\{\{\d+)\}\}/.test(body)) return 'Use parameters in the form {{1}}, {{2}} …';
  const nums = templateParams(body);
  const distinct = [...new Set(nums)];
  if (distinct.some((n, i) => n !== i + 1)) return 'Number the parameters in order, starting at {{1}}.';
  const trimmed = body.trim();
  if (/^\{\{\d+\}\}/.test(trimmed) || /\{\{\d+\}\}$/.test(trimmed)) return 'The text cannot start or end with a parameter.';
  if (examples.length !== distinct.length) return `Give one sample value for each parameter (${distinct.length}).`;
  return null;
}

/**
 * Parameter values sent to a customer. Our own conservative rule (not a Meta-stated limit we verified): one line, no
 * tabs, no runs of more than four spaces, at most 1,024 characters each.
 */
export function checkParamValue(v: string): boolean {
  return v.trim().length > 0 && v.length <= 1024 && !/[\n\r\t]/.test(v) && !/ {5,}/.test(v);
}

export function renderTemplate(t: { header_text: string | null; body_text: string; footer_text: string | null }, params: string[]): string {
  const body = t.body_text.replace(PARAM, (_, n: string) => params[Number(n) - 1] ?? '');
  return [t.header_text, body, t.footer_text].filter(Boolean).join('\n\n');
}

const CreateRequest = z.object({
  accountRef: z.string().uuid().optional(),
  name: z.string().regex(/^[a-z0-9_]{1,512}$/, 'Use lowercase letters, digits and underscores'),
  language: z.string().regex(/^[a-z]{2,3}(_[A-Z]{2})?$/, 'Use a language code such as en, ar or en_US'),
  category: z.enum(['marketing', 'utility', 'authentication']),
  headerText: z.string().trim().min(1).max(60).nullable().optional(),
  bodyText: z.string().trim().min(1).max(1024),
  footerText: z.string().trim().min(1).max(60).nullable().optional(),
  examples: z.array(z.string().trim().min(1).max(200)).max(20).default([]),
});

const TEMPLATE_COLUMNS = `t.id, t.name, t.language, t.category, t.status, t.last_event AS "lastEvent", t.status_reason AS "statusReason",
  t.quality, t.header_text AS "headerText", t.body_text AS "bodyText", t.footer_text AS "footerText", t.param_count AS "paramCount",
  t.examples, t.provider_template_id AS "providerTemplateId", t.account_ref AS "accountRef", t.created_at AS "createdAt",
  t.status_changed_at AS "statusChangedAt"`;

export class TemplatesService {
  constructor(private readonly deps: Deps) {}

  async list(actor: TenantActor) {
    return withContext(this.deps.db, actor, async (tx) =>
      (await tx.query(`SELECT ${TEMPLATE_COLUMNS} FROM message_templates t ORDER BY t.name, t.language`)).rows);
  }

  /** Validates, submits to the provider for review, then records the template as pending. */
  async create(actor: TenantActor, input: unknown) {
    const body = parse(CreateRequest, input);
    const problem = checkTemplateBody(body.bodyText, body.examples);
    if (problem) throw Errors.badRequest(problem);
    const account = await withContext(this.deps.db, actor, async (tx) => {
      const rows = (await tx.query<{ id: string; provider: Provider; account_id: string }>(
        `SELECT id, provider, account_id FROM provider_accounts WHERE status = 'active' AND ($1::uuid IS NULL OR id = $1::uuid)`,
        [body.accountRef ?? null])).rows;
      if (rows.length === 0) throw Errors.conflict('no_account', 'Connect a WhatsApp number first.');
      if (rows.length > 1) throw Errors.badRequest('Choose which business account this template belongs to.');
      const dup = await tx.query('SELECT 1 FROM message_templates WHERE account_ref = $1 AND name = $2 AND language = $3',
        [rows[0]!.id, body.name, body.language]);
      if (dup.rowCount) throw Errors.conflict('template_exists', 'A template with this name and language already exists.');
      return rows[0]!;
    });
    const adapter = this.deps.channels[account.provider];
    if (!adapter) throw Errors.conflict('provider_not_available', 'This channel is not available here.');
    let providerTemplateId: string;
    try {
      ({ providerTemplateId } = await adapter.submitTemplate({
        accountId: account.account_id, name: body.name, language: body.language, category: body.category,
        headerText: body.headerText ?? null, bodyText: body.bodyText, footerText: body.footerText ?? null, examples: body.examples,
      }));
    } catch (err) {
      if (err instanceof ChannelSendError) {
        throw new AppError(502, 'template_submission_failed', 'WhatsApp did not accept the template for review. Please try again.', { code: err.code });
      }
      throw err;
    }
    return withContext(this.deps.db, actor, async (tx) => {
      const row = (await tx.query(
        `INSERT INTO message_templates (tenant_id, account_ref, name, language, category, header_text, body_text, footer_text,
                                        param_count, examples, provider_template_id, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING id`,
        [actor.tenantId, account.id, body.name, body.language, body.category, body.headerText ?? null, body.bodyText,
          body.footerText ?? null, new Set(templateParams(body.bodyText)).size, JSON.stringify(body.examples), providerTemplateId,
          actor.membershipId])).rows[0];
      await AuditService.record(tx, {
        tenantId: actor.tenantId, actorUserId: actor.userId, action: 'template.submitted', ip: actor.ip,
        targetType: 'message_template', targetId: row.id, metadata: { name: body.name, language: body.language, category: body.category },
      });
      return (await tx.query(`SELECT ${TEMPLATE_COLUMNS} FROM message_templates t WHERE t.id = $1`, [row.id])).rows[0];
    });
  }

  /**
   * Recovery: reads every template from the provider and updates our records. Used when a review webhook may have
   * been missed (provider health screen). Templates the provider no longer lists are left as they are and counted.
   */
  async sync(actor: TenantActor) {
    const accounts = await withContext(this.deps.db, actor, async (tx) =>
      (await tx.query<{ id: string; provider: Provider; account_id: string }>(
        `SELECT id, provider, account_id FROM provider_accounts WHERE status = 'active'`)).rows);
    const result = { updated: 0, unchanged: 0, notOnProvider: 0, unknownOnProvider: 0 };
    for (const a of accounts) {
      const adapter = this.deps.channels[a.provider];
      if (!adapter) continue;
      const remote = await adapter.listTemplates(a.account_id);
      await withContext(this.deps.db, actor, async (tx) => {
        const local = (await tx.query<{ id: string; provider_template_id: string | null; status: string; quality: string; category: string }>(
          'SELECT id, provider_template_id, status, quality, category FROM message_templates WHERE account_ref = $1', [a.id])).rows;
        for (const l of local) {
          const r = remote.find((x) => x.providerTemplateId === l.provider_template_id);
          if (!r) { result.notOnProvider++; continue; }
          if (r.status === l.status && r.quality === l.quality && r.category === l.category) { result.unchanged++; continue; }
          await tx.query(
            `UPDATE message_templates SET status = $2, quality = $3, category = $4, status_reason = $5, last_event = 'SYNC',
                    status_changed_at = CASE WHEN status <> $2 THEN now() ELSE status_changed_at END WHERE id = $1`,
            [l.id, r.status, r.quality, r.category, r.reason]);
          result.updated++;
        }
        result.unknownOnProvider += remote.filter((r) => !local.some((l) => l.provider_template_id === r.providerTemplateId)).length;
        await AuditService.record(tx, {
          tenantId: actor.tenantId, actorUserId: actor.userId, action: 'templates.synced', ip: actor.ip,
          targetType: 'provider_account', targetId: a.id, metadata: result,
        });
      });
    }
    return result;
  }
}

/** Applies one template webhook event inside the company's context. */
export async function applyTemplateEvent(tx: Tx, accountRef: string, e: Extract<ParsedEvent, { kind: 'template' }>): Promise<'applied' | 'unknown_template'> {
  const t = (await tx.query<{ id: string }>(
    'SELECT id FROM message_templates WHERE account_ref = $1 AND provider_template_id = $2 FOR UPDATE', [accountRef, e.providerTemplateId])).rows[0];
  if (!t) return 'unknown_template';
  if (e.change.type === 'status') {
    const status = TEMPLATE_EVENT_STATUS[e.change.event];
    await tx.query(
      `UPDATE message_templates SET last_event = $2, status_reason = $3,
              status = coalesce($4, status), status_changed_at = CASE WHEN $4::text IS NOT NULL AND $4 <> status THEN now() ELSE status_changed_at END
       WHERE id = $1`, [t.id, e.change.event.slice(0, 40), e.change.reason, status ?? null]);
  } else if (e.change.type === 'quality') {
    await tx.query(`UPDATE message_templates SET quality = $2, last_event = 'QUALITY_' || upper($2) WHERE id = $1`, [t.id, e.change.quality]);
  } else if (['marketing', 'utility', 'authentication'].includes(e.change.category)) {
    // Meta announces a category change in advance and then completes it; only a completed change applies.
    if (e.change.completed) await tx.query(`UPDATE message_templates SET category = $2, last_event = 'CATEGORY_CHANGED' WHERE id = $1`, [t.id, e.change.category]);
    else await tx.query(`UPDATE message_templates SET last_event = 'CATEGORY_CHANGE_PENDING', status_reason = $2 WHERE id = $1`,
      [t.id, `Will become ${e.change.category}`]);
  }
  return 'applied';
}

export function assertTemplateId(id: string) {
  if (!isUuid(id)) throw Errors.notFound('Template');
}
