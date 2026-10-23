import { createHash } from 'node:crypto';
import { withContext, type Db, type Tx } from '@conversaflow/database';
import { z } from 'zod';
import type { Deps, TenantActor } from '../core/context';
import { AppError, Errors } from '../core/errors';
import { parse } from '../core/validate';
import { AuditService } from './audit.service';
import { isUuid } from './members.service';
import { companyHours, isWithinBusinessHours } from './sla';
import { checkParamValue, renderTemplate } from './templates.service';
import { AutomationMetering } from './entitlements.service';
import { AiService, type AiResult } from './ai';

/**
 * Automations (Wave 2, W2.1: CF-EXT-007 visual flow builder, CF-EXT-019 rehearsal; FR-404–406, FR-206).
 *
 * A workflow is a trigger and a list of steps joined by "next" links (conditions have two). People edit a draft;
 * publishing validates it and stores an immutable numbered version. Runs are pinned to the version they started on,
 * so publishing again or rolling back never changes a run already under way (acceptance 4).
 *
 * Safety, built in from the first version:
 *  - no cycles (checked on publish) and at most MAX_STEPS steps per run, so a workflow cannot loop;
 *  - one run per workflow per trigger (unique key) and at most RUNS_PER_CONTACT_PER_DAY runs per customer per day;
 *  - triggers come only from customers' messages, never from messages an automation sent;
 *  - a person takes over (FR-206): runs stop as soon as someone on the team replies in the conversation or a
 *    supervisor pauses replies, and new runs do not start in a conversation a person answered in the last 24 hours;
 *  - every message an automation sends passes the same checks as a person's (opt-out, 24-hour window, approved
 *    template, marketing consent, channel) when queued and again when sent;
 *  - rehearsal (CF-EXT-019) evaluates the same steps against a sample message and records what would have happened.
 *    It never touches a conversation, and the database refuses any message linked to a rehearsal run (acceptance 10).
 *  - live runs count towards the plan's monthly automation allowance; rehearsals do not.
 */
export const AUTOMATION_LIMITS = { maxSteps: 40, maxDefinitionSteps: 30, runsPerContactPerDay: 5, maxWaitMinutes: 7 * 24 * 60, leaseSeconds: 60, maxAttempts: 3, humanQuietHours: 24 };

const StepId = z.string().regex(/^[a-z0-9_-]{1,40}$/);
const Next = StepId.nullable();
// A draft may be incomplete (an empty message, a step with nothing chosen yet); publishing lists what is missing.
const Text = z.object({ en: z.string().trim().max(1000).optional(), ar: z.string().trim().max(1000).optional() });
const Ref = z.union([z.string().uuid(), z.literal('')]);
const Condition = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('within_business_hours') }),
  z.object({ kind: z.literal('message_contains'), words: z.array(z.string().trim().min(1).max(60)).max(20) }),
  z.object({ kind: z.literal('has_tag'), tagId: Ref }),
  z.object({ kind: z.literal('contact_language'), language: z.enum(['en', 'ar']) }),
  z.object({ kind: z.literal('first_message') }),
]);
const Step = z.discriminatedUnion('kind', [
  z.object({ id: StepId, kind: z.literal('send_reply'), text: Text, next: Next }),
  z.object({ id: StepId, kind: z.literal('send_template'), templateId: Ref, params: z.array(z.object({ source: z.enum(['contact_name', 'text']), value: z.string().max(200).optional(), fallback: z.string().max(200).optional() })).max(10).default([]), next: Next }),
  z.object({ id: StepId, kind: z.literal('add_tag'), tagId: Ref, next: Next }),
  z.object({ id: StepId, kind: z.literal('remove_tag'), tagId: Ref, next: Next }),
  z.object({ id: StepId, kind: z.literal('assign'), membershipId: Ref, next: Next }),
  z.object({ id: StepId, kind: z.literal('wait'), minutes: z.number().int().min(1).max(AUTOMATION_LIMITS.maxWaitMinutes), next: Next }),
  z.object({ id: StepId, kind: z.literal('condition'), if: Condition, then: Next, else: Next }),
  z.object({ id: StepId, kind: z.literal('handoff'), note: z.string().trim().max(500), next: Next }),
  /** The company AI agent answers from the company's knowledge (W2.2); when it cannot, `ifHuman` is taken. */
  z.object({ id: StepId, kind: z.literal('ai_reply'), next: Next, ifHuman: Next }),
]);
export type StepDef = z.infer<typeof Step>;
const Trigger = z.object({
  kind: z.enum(['message_received', 'conversation_started']),
  /** Optional: start only when the message contains one of these words or phrases (any language, case-insensitive). */
  keywords: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
});
export const Definition = z.object({ trigger: Trigger, start: StepId.nullable(), steps: z.array(Step).max(AUTOMATION_LIMITS.maxDefinitionSteps) }).strict();
export type DefinitionT = z.infer<typeof Definition>;

const CreateInput = z.object({ name: z.string().trim().min(2).max(120), draft: Definition.optional() }).strict();
const DraftInput = z.object({ name: z.string().trim().min(2).max(120).optional(), draft: Definition, expectedVersion: z.number().int().min(0) }).strict();
const VersionInput = z.object({ expectedVersion: z.number().int().min(0) }).strict();
const RollbackInput = z.object({ toVersion: z.number().int().min(1), expectedVersion: z.number().int().min(0) }).strict();
const RehearseInput = z.object({
  text: z.string().trim().min(1).max(1000), language: z.enum(['en', 'ar']).default('en'), firstMessage: z.boolean().default(true),
  contactName: z.string().trim().max(100).optional(), tagIds: z.array(z.string().uuid()).max(20).default([]),
  /** Rehearse the draft (default) or the published version. */
  source: z.enum(['draft', 'published']).default('draft'),
}).strict();

const EMPTY: DefinitionT = { trigger: { kind: 'message_received', keywords: [] }, start: null, steps: [] };

/** Plain reasons a definition cannot be published, as codes with the step they concern. */
export function validateDefinition(d: DefinitionT): Array<{ code: string; step?: string }> {
  const problems: Array<{ code: string; step?: string }> = [];
  const ids = new Map<string, StepDef>();
  for (const s of d.steps) {
    if (ids.has(s.id)) problems.push({ code: 'duplicate_step_id', step: s.id });
    ids.set(s.id, s);
  }
  if (d.steps.length === 0) problems.push({ code: 'no_steps' });
  if (d.start === null || !ids.has(d.start)) problems.push({ code: 'missing_start' });
  const nexts = (s: StepDef): Array<string | null> => (s.kind === 'condition' ? [s.then, s.else] : s.kind === 'ai_reply' ? [s.next, s.ifHuman] : [s.next]);
  for (const s of d.steps) for (const n of nexts(s)) if (n !== null && !ids.has(n)) problems.push({ code: 'unknown_next', step: s.id });
  for (const s of d.steps) {
    if (s.kind === 'send_reply' && !s.text.en && !s.text.ar) problems.push({ code: 'empty_message', step: s.id });
    if (s.kind === 'send_template' && !s.templateId) problems.push({ code: 'unknown_template', step: s.id });
    if ((s.kind === 'add_tag' || s.kind === 'remove_tag') && !s.tagId) problems.push({ code: 'unknown_tag', step: s.id });
    if (s.kind === 'assign' && !s.membershipId) problems.push({ code: 'unknown_member', step: s.id });
    if (s.kind === 'handoff' && !s.note) problems.push({ code: 'empty_note', step: s.id });
    if (s.kind === 'condition' && s.if.kind === 'message_contains' && s.if.words.length === 0) problems.push({ code: 'no_words', step: s.id });
    if (s.kind === 'condition' && s.if.kind === 'has_tag' && !s.if.tagId) problems.push({ code: 'unknown_tag', step: s.id });
  }
  if (problems.length) return problems;
  // No cycles: a workflow always moves forward and ends (loop protection, FR-406).
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (id: string): boolean => {
    if (state.get(id) === 'done') return true;
    if (state.get(id) === 'visiting') return false;
    state.set(id, 'visiting');
    for (const n of nexts(ids.get(id)!)) if (n !== null && !visit(n)) return false;
    state.set(id, 'done');
    return true;
  };
  if (!visit(d.start!)) problems.push({ code: 'cycle' });
  const unreachable = d.steps.filter((s) => !state.has(s.id)).map((s) => s.id);
  for (const id of unreachable) problems.push({ code: 'unreachable_step', step: id });
  return problems;
}

/** Checks that everything a definition refers to exists in this company (tags, members, approved templates). */
async function referenceProblems(tx: Tx, d: DefinitionT): Promise<Array<{ code: string; step?: string }>> {
  const out: Array<{ code: string; step?: string }> = [];
  for (const s of d.steps) {
    if (s.kind === 'add_tag' || s.kind === 'remove_tag' || (s.kind === 'condition' && s.if.kind === 'has_tag')) {
      const tagId = s.kind === 'condition' ? (s.if as { tagId: string }).tagId : s.tagId;
      if (!tagId) continue;
      if (!(await tx.query('SELECT 1 FROM tags WHERE id = $1', [tagId])).rowCount) out.push({ code: 'unknown_tag', step: s.id });
    }
    if (s.kind === 'assign' && s.membershipId) {
      const ok = await tx.query(
        `SELECT 1 FROM memberships m JOIN membership_roles mr ON mr.membership_id = m.id
         JOIN role_permissions rp ON rp.role_id = mr.role_id AND rp.permission_key = 'inbox.reply' WHERE m.id = $1 AND m.status = 'active'`, [s.membershipId]);
      if (!ok.rowCount) out.push({ code: 'unknown_member', step: s.id });
    }
    if (s.kind === 'send_template' && s.templateId) {
      const t = (await tx.query<{ status: string; param_count: number }>('SELECT status, param_count FROM message_templates WHERE id = $1', [s.templateId])).rows[0];
      if (!t) out.push({ code: 'unknown_template', step: s.id });
      else if (t.status !== 'approved') out.push({ code: 'template_not_approved', step: s.id });
      // Every placeholder needs a value (review of W2.1, L7).
      else if (s.params.length !== t.param_count) out.push({ code: 'template_params_mismatch', step: s.id });
    }
  }
  return out;
}

const WF_COLUMNS = `w.id, w.name, w.status, w.draft, w.version, w.trigger_kind AS "triggerKind", w.created_at AS "createdAt", w.updated_at AS "updatedAt",
  v.number AS "publishedVersion", v.published_at AS "publishedAt"`;

export class AutomationsService {
  constructor(private readonly deps: Deps) {}

  list(actor: TenantActor) {
    return withContext(this.deps.db, actor, async (tx) => (await tx.query(
      `SELECT ${WF_COLUMNS},
              (SELECT count(*)::int FROM workflow_runs r WHERE r.workflow_id = w.id AND r.mode = 'live' AND r.started_at > now() - interval '7 days') AS "runs7d",
              (SELECT count(*)::int FROM workflow_runs r WHERE r.workflow_id = w.id AND r.mode = 'live' AND r.status = 'failed' AND r.started_at > now() - interval '7 days') AS "failed7d"
       FROM workflows w LEFT JOIN workflow_versions v ON v.id = w.current_version_id
       WHERE w.status <> 'archived' ORDER BY lower(w.name)`)).rows);
  }

  async get(actor: TenantActor, id: string) {
    if (!isUuid(id)) throw Errors.notFound('Automation');
    return withContext(this.deps.db, actor, async (tx) => {
      const w = (await tx.query(`SELECT ${WF_COLUMNS} FROM workflows w LEFT JOIN workflow_versions v ON v.id = w.current_version_id WHERE w.id = $1`, [id])).rows[0];
      if (!w) throw Errors.notFound('Automation');
      const versions = (await tx.query(
        `SELECT number, published_at AS "publishedAt", rolled_back_from AS "rolledBackFrom", definition FROM workflow_versions WHERE workflow_id = $1 ORDER BY number DESC LIMIT 50`, [id])).rows;
      const runs = (await tx.query(
        `SELECT r.id, r.mode, r.status, r.reason, r.started_at AS "startedAt", r.finished_at AS "finishedAt", r.conversation_id AS "conversationId",
                v.number AS version, r.steps_taken AS "stepsTaken"
         FROM workflow_runs r LEFT JOIN workflow_versions v ON v.id = r.version_id WHERE r.workflow_id = $1 ORDER BY r.started_at DESC LIMIT 50`, [id])).rows;
      return { ...w, problems: validateDefinition(w.draft as DefinitionT), versions, runs };
    });
  }

  async create(actor: TenantActor, input: unknown) {
    const body = parse(CreateInput, input);
    return withContext(this.deps.db, actor, async (tx) => {
      const n = (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM workflows WHERE status <> 'archived'`)).rows[0]!.n;
      if (n >= 100) throw Errors.conflict('too_many_automations', 'A company can have up to 100 automations.');
      const w = (await tx.query<{ id: string }>(
        `INSERT INTO workflows (tenant_id, name, draft, created_by) VALUES ($1, $2, $3, $4) RETURNING id`,
        [actor.tenantId, body.name, JSON.stringify(body.draft ?? EMPTY), actor.membershipId])).rows[0]!;
      await AuditService.record(tx, { tenantId: actor.tenantId, actorUserId: actor.userId, action: 'automation.created', ip: actor.ip, targetType: 'workflow', targetId: w.id, metadata: { name: body.name } });
      return { id: w.id };
    });
  }

  async saveDraft(actor: TenantActor, id: string, input: unknown) {
    const body = parse(DraftInput, input);
    if (!isUuid(id)) throw Errors.notFound('Automation');
    return withContext(this.deps.db, actor, async (tx) => {
      const upd = await tx.query<{ version: number }>(
        `UPDATE workflows SET draft = $2, name = coalesce($3, name), version = version + 1, updated_at = now()
         WHERE id = $1 AND version = $4 AND status <> 'archived' RETURNING version`, [id, JSON.stringify(body.draft), body.name ?? null, body.expectedVersion]);
      if (!upd.rowCount) await this.changed(tx, id);
      await AuditService.record(tx, { tenantId: actor.tenantId, actorUserId: actor.userId, action: 'automation.draft_saved', ip: actor.ip, targetType: 'workflow', targetId: id, metadata: {} });
      return { version: upd.rows[0]!.version, problems: validateDefinition(body.draft) };
    });
  }

  /** Validates the draft and publishes it as the next version; the automation becomes active. */
  async publish(actor: TenantActor, id: string, input: unknown) {
    const body = parse(VersionInput, input);
    if (!isUuid(id)) throw Errors.notFound('Automation');
    return withContext(this.deps.db, actor, async (tx) => {
      // FOR NO KEY UPDATE: does not block runs being started (they hold a key-share lock on the workflow). Review M2.
      const w = (await tx.query<{ draft: DefinitionT; version: number; status: string }>('SELECT draft, version, status FROM workflows WHERE id = $1 FOR NO KEY UPDATE', [id])).rows[0];
      if (!w || w.status === 'archived') throw Errors.notFound('Automation');
      if (w.version !== body.expectedVersion) await this.changed(tx, id);
      const draft = Definition.parse(w.draft);
      const problems = [...validateDefinition(draft), ...(await referenceProblems(tx, draft))];
      if (problems.length) throw new AppError(422, 'automation_invalid', 'Fix the problems listed before publishing.', { problems });
      return this.storeVersion(tx, actor, id, draft, null);
    });
  }

  /** Publishes an earlier version again as a new version (history is kept); runs under way keep their version. */
  async rollback(actor: TenantActor, id: string, input: unknown) {
    const body = parse(RollbackInput, input);
    if (!isUuid(id)) throw Errors.notFound('Automation');
    return withContext(this.deps.db, actor, async (tx) => {
      const w = (await tx.query<{ version: number; status: string }>('SELECT version, status FROM workflows WHERE id = $1 FOR NO KEY UPDATE', [id])).rows[0];
      if (!w || w.status === 'archived') throw Errors.notFound('Automation');
      if (w.version !== body.expectedVersion) await this.changed(tx, id);
      const old = (await tx.query<{ definition: DefinitionT }>('SELECT definition FROM workflow_versions WHERE workflow_id = $1 AND number = $2', [id, body.toVersion])).rows[0];
      if (!old) throw Errors.notFound('Version');
      const problems = await referenceProblems(tx, old.definition);
      if (problems.length) throw new AppError(422, 'automation_invalid', 'That version refers to something that no longer exists.', { problems });
      const res = await this.storeVersion(tx, actor, id, old.definition, body.toVersion);
      await tx.query(`UPDATE workflows SET draft = $2 WHERE id = $1`, [id, JSON.stringify(old.definition)]);
      return res;
    });
  }

  private async storeVersion(tx: Tx, actor: TenantActor, id: string, def: DefinitionT, rolledBackFrom: number | null) {
    const number = (await tx.query<{ n: number }>('SELECT coalesce(max(number), 0) + 1 AS n FROM workflow_versions WHERE workflow_id = $1', [id])).rows[0]!.n;
    const v = (await tx.query<{ id: string }>(
      `INSERT INTO workflow_versions (tenant_id, workflow_id, number, definition, rolled_back_from, published_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [actor.tenantId, id, number, JSON.stringify(def), rolledBackFrom, actor.membershipId])).rows[0]!;
    const upd = await tx.query<{ version: number }>(
      `UPDATE workflows SET current_version_id = $2, trigger_kind = $3, status = 'active', version = version + 1, updated_at = now() WHERE id = $1 RETURNING version`,
      [id, v.id, def.trigger.kind]);
    await AuditService.record(tx, { tenantId: actor.tenantId, actorUserId: actor.userId, action: rolledBackFrom ? 'automation.rolled_back' : 'automation.published', ip: actor.ip,
      targetType: 'workflow', targetId: id, metadata: { version: number, rolledBackFrom } });
    return { publishedVersion: number, version: upd.rows[0]!.version, status: 'active' };
  }

  /** Pauses (no new runs; runs under way are stopped) or resumes an automation; archive hides it. */
  async setStatus(actor: TenantActor, id: string, status: 'paused' | 'active' | 'archived', input: unknown) {
    const body = parse(VersionInput, input);
    if (!isUuid(id)) throw Errors.notFound('Automation');
    return withContext(this.deps.db, actor, async (tx) => {
      const w = (await tx.query<{ current_version_id: string | null; status: string; version: number }>('SELECT current_version_id, status, version FROM workflows WHERE id = $1 FOR NO KEY UPDATE', [id])).rows[0];
      if (!w || w.status === 'archived') throw Errors.notFound('Automation');
      if (w.version !== body.expectedVersion) await this.changed(tx, id);
      if (status === 'active' && !w.current_version_id) throw Errors.conflict('not_published', 'Publish the automation first.');
      const upd = await tx.query<{ version: number }>(`UPDATE workflows SET status = $2, version = version + 1, updated_at = now() WHERE id = $1 RETURNING version`, [id, status]);
      if (status !== 'active') {
        await tx.query(`UPDATE workflow_runs SET status = 'stopped', reason = $2, finished_at = now(), lease_until = NULL
                        WHERE workflow_id = $1 AND status IN ('running', 'waiting')`, [id, status === 'paused' ? 'automation_paused' : 'automation_archived']);
      }
      await AuditService.record(tx, { tenantId: actor.tenantId, actorUserId: actor.userId, action: `automation.${status}`, ip: actor.ip, targetType: 'workflow', targetId: id, metadata: {} });
      return { status, version: upd.rows[0]!.version };
    });
  }

  /** Rehearsal (CF-EXT-019): runs the draft or published version against a sample message; nothing is sent or changed. */
  async rehearse(actor: TenantActor, id: string, input: unknown) {
    const body = parse(RehearseInput, input);
    if (!isUuid(id)) throw Errors.notFound('Automation');
    const runId = await withContext(this.deps.db, actor, async (tx) => {
      const w = (await tx.query<{ draft: DefinitionT; current_version_id: string | null }>('SELECT draft, current_version_id FROM workflows WHERE id = $1', [id])).rows[0];
      if (!w) throw Errors.notFound('Automation');
      // A rehearsal of the draft keeps a copy of the draft with the run, so its log can always be read against it.
      let snapshot: DefinitionT | null = null;
      if (body.source === 'draft') {
        snapshot = Definition.parse(w.draft);
        const problems = validateDefinition(snapshot);
        if (problems.length) throw new AppError(422, 'automation_invalid', 'Fix the problems listed before rehearsing.', { problems });
      } else if (!w.current_version_id) throw Errors.conflict('not_published', 'Publish the automation first.');
      const r = (await tx.query<{ id: string }>(
        `INSERT INTO workflow_runs (tenant_id, workflow_id, version_id, definition, mode, trigger_key, sample, status, next_at)
         VALUES ($1, $2, $3, $4, 'rehearsal', $5, $6, 'running', 'infinity') RETURNING id`,
        [actor.tenantId, id, snapshot ? null : w.current_version_id, snapshot ? JSON.stringify(snapshot) : null,
          `rehearsal:${crypto.randomUUID()}`, JSON.stringify(body)])).rows[0];
      return r!.id;
    });
    try {
      await new AutomationRunner(this.deps.db, undefined, new AiService(this.deps, this.deps.ai)).runToEnd(actor.tenantId, runId);
    } catch (err) {
      await withContext(this.deps.db, actor, (tx) => tx.query(`UPDATE workflow_runs SET status = 'failed', reason = 'rehearsal_error', finished_at = now() WHERE id = $1 AND status = 'running'`, [runId]));
      throw err;
    }
    return this.run(actor, runId);
  }

  async run(actor: TenantActor, runId: string) {
    if (!isUuid(runId)) throw Errors.notFound('Run');
    return withContext(this.deps.db, actor, async (tx) => {
      const r = (await tx.query(
        `SELECT r.id, r.workflow_id AS "workflowId", r.mode, r.status, r.reason, r.started_at AS "startedAt", r.finished_at AS "finishedAt",
                r.conversation_id AS "conversationId", v.number AS version, r.steps_taken AS "stepsTaken"
         FROM workflow_runs r LEFT JOIN workflow_versions v ON v.id = r.version_id WHERE r.id = $1`, [runId])).rows[0];
      if (!r) throw Errors.notFound('Run');
      const steps = (await tx.query(`SELECT seq, step_id AS "stepId", kind, outcome, detail, at FROM workflow_run_steps WHERE run_id = $1 ORDER BY seq`, [runId])).rows;
      return { ...r, steps };
    });
  }

  private async changed(tx: Tx, id: string): Promise<never> {
    const cur = (await tx.query<{ version: number }>('SELECT version FROM workflows WHERE id = $1', [id])).rows[0];
    if (!cur) throw Errors.notFound('Automation');
    throw new AppError(409, 'automation_changed', 'Someone else changed this automation. Reload it and try again.', { version: cur.version });
  }
}

// --- Triggers ---------------------------------------------------------------------------------------------------

/**
 * Words, for matching keywords: lower case, Arabic diacritics and tatweel removed, and the common spelling variants
 * folded (أ إ آ → ا, ى → ي, ة → ه). Review of W2.1, L1.
 */
const tokens = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[\u064B-\u0652\u0640]/g, '').replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
  .split(/[^\p{L}\p{N}]+/u).filter(Boolean);
/** Arabic words often carry a prefix (و، ب، ال، بال، وال، لل): "بالسعر" still matches "سعر". */
const base = (w: string) => { for (const p of ['وال', 'بال', 'لل', 'ال', 'و', 'ب']) if (w.startsWith(p) && w.length - p.length >= 3) return w.slice(p.length); return w; };
/** A keyword (one or more words) matches whole words in the text, in order, never parts of words ("hi" ≠ "ship"). */
function contains(text: string | null, words: string[]): boolean {
  if (!text) return false;
  // Prefixes are stripped from the customer's words only, and each word is compared with and without its prefix, so
  // a keyword is never shortened into another word ("بطاقة" card ≠ "طاقة" energy). A keyword may be written with the
  // article "ال" (recheck of W2.1, N3).
  const t = tokens(text).map((w) => [w, base(w)]);
  const article = (w: string) => (w.startsWith('ال') && w.length >= 5 ? w.slice(2) : w);
  return words.some((k) => {
    const kw = tokens(k);
    if (kw.length === 0) return false;
    for (let i = 0; i + kw.length <= t.length; i++) {
      if (kw.every((w, j) => t[i + j]!.includes(w) || t[i + j]!.includes(article(w)))) return true;
    }
    return false;
  });
}

/**
 * Called in the transaction that records a customer's message (so a run starts exactly once per message). Starts a
 * run for each active automation whose trigger matches, unless a person is handling the conversation (FR-206) or
 * the customer already had RUNS_PER_CONTACT_PER_DAY runs of it today; those are recorded as skipped, with the reason.
 */
export async function startAutomationRuns(tx: Tx, tenantId: string, c: { conversationId: string; contactId: string; messageId: string; body: string | null; firstInbound: boolean }) {
  const flows = (await tx.query<{ id: string; version_id: string; definition: DefinitionT }>(
    `SELECT w.id, v.id AS version_id, v.definition FROM workflows w JOIN workflow_versions v ON v.id = w.current_version_id
     WHERE w.status = 'active' AND (w.trigger_kind = 'message_received' OR (w.trigger_kind = 'conversation_started' AND $1))`, [c.firstInbound])).rows;
  if (flows.length === 0) return 0;
  // A person on the team answered in this conversation recently, or replies are paused: automations stay out of it.
  const human = (await tx.query<{ busy: boolean }>(
    `SELECT (c.paused_at IS NOT NULL AND (c.paused_until IS NULL OR c.paused_until > now()))
            OR EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.direction = 'out' AND m.sent_by_membership_id IS NOT NULL
                       AND m.created_at > now() - make_interval(hours => $2)) AS busy
     FROM conversations c WHERE c.id = $1`, [c.conversationId, AUTOMATION_LIMITS.humanQuietHours])).rows[0]?.busy ?? false;
  let started = 0;
  for (const f of flows) {
    if (f.definition.trigger.keywords.length && !contains(c.body, f.definition.trigger.keywords)) continue;
    const today = (await tx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM workflow_runs WHERE workflow_id = $1 AND contact_id = $2 AND mode = 'live' AND status <> 'skipped' AND started_at > now() - interval '24 hours'`,
      [f.id, c.contactId])).rows[0]!.n;
    const skip = human ? 'person_handling' : today >= AUTOMATION_LIMITS.runsPerContactPerDay ? 'daily_limit' : null;
    const r = await tx.query(
      `INSERT INTO workflow_runs (tenant_id, workflow_id, version_id, mode, trigger_key, conversation_id, contact_id, sample, status, reason, finished_at)
       VALUES ($1, $2, $3, 'live', $4, $5, $6, $7, $8, $9, CASE WHEN $8 = 'skipped' THEN now() END) ON CONFLICT (workflow_id, trigger_key) DO NOTHING`,
      [tenantId, f.id, f.version_id, `message:${c.messageId}`, c.conversationId, c.contactId,
        JSON.stringify({ text: c.body, firstMessage: c.firstInbound }), skip ? 'skipped' : 'running', skip]);
    if (r.rowCount && !skip) started++;
  }
  return started;
}

/** A person replied or paused replies: automation runs in this conversation stop at once (FR-206). */
export async function stopAutomationRuns(tx: Tx, conversationId: string, reason: 'person_replied' | 'replies_paused' | 'conversation_resolved' | 'person_assigned' | 'person_requested') {
  await tx.query(`UPDATE workflow_runs SET status = 'stopped', reason = $2, finished_at = now(), lease_until = NULL
                  WHERE conversation_id = $1 AND status IN ('running', 'waiting') AND mode = 'live'`, [conversationId, reason]);
}

/** The worker acts for the company, not for a person. */
const system = (tenantId: string) => ({ tenantId, userId: null }) as unknown as Pick<TenantActor, 'tenantId' | 'userId'>;

// --- Running ----------------------------------------------------------------------------------------------------

type RunRow = {
  id: string; workflow_id: string; mode: 'live' | 'rehearsal'; status: string; current_step: string | null; steps_taken: number;
  conversation_id: string | null; contact_id: string | null; sample: Record<string, unknown> | null; attempts: number;
  definition: DefinitionT; workflow_status: string; started_at: Date; due: boolean;
};
/** An AI decision made for a step, outside the step's transaction (review of W2.2/W2.3, M3). */
type AiForStep = { stepId: string; result: AiResult };
type Ctx = { tenantId: string; run: RunRow; def: DefinitionT; tx: Tx; ai?: AiForStep };
/**
 * Thrown by the "AI reply" step when it has no AI decision yet. The step's transaction is rolled back (nothing has
 * been written), the AI is asked with no transaction or lock held, and the step runs again with the decision; all
 * checks are made again then, under the usual locks.
 */
class NeedsAi extends Error {
  constructor(readonly stepId: string, readonly input: Parameters<AiService['agentDecision']>[1]) { super('needs_ai'); }
}
type StepResult = { next: string | null; outcome: 'done' | 'would_do' | 'skipped' | 'blocked' | 'waiting'; detail: Record<string, unknown>; waitMinutes?: number };

export class AutomationRunner {
  constructor(private readonly db: Db, private readonly entitlements?: AutomationMetering, private readonly ai?: AiService) {}

  /** Worker: leases due runs across companies and advances each until it waits, ends or fails. */
  async dispatchDue(limit = 50): Promise<number> {
    const due = await withContext(this.db, { tenantId: null, userId: null }, async (tx) =>
      (await tx.query<{ run_id: string; tenant_id: string }>('SELECT * FROM automation_claim($1, $2)', [limit, AUTOMATION_LIMITS.leaseSeconds])).rows);
    for (const d of due) {
      try { await this.advance(d.tenant_id, d.run_id); } catch (err) {
        console.error('automation run error', d.run_id, err instanceof Error ? err.message : err);
      }
    }
    return due.length;
  }

  /** Rehearsal: carries the run to its end at once (waits are recorded, not waited for). */
  async runToEnd(tenantId: string, runId: string) {
    let ai: AiForStep | undefined;
    for (let i = 0; i <= 2 * AUTOMATION_LIMITS.maxSteps + 2; i++) {
      let more: boolean;
      try { more = await this.step(tenantId, runId, true, ai); ai = undefined; } catch (err) {
        if (!(err instanceof NeedsAi) || ai) throw err;
        ai = { stepId: err.stepId, result: await this.ai!.agentDecision(tenantId, err.input) };
        continue;
      }
      if (!more) return;
    }
  }

  /** Advances a live run until it waits, ends, or a step fails. */
  async advance(tenantId: string, runId: string) {
    // The plan's monthly allowance: a run is reserved (counted) before its first step, so many runs started at once
    // cannot all pass the check (review of W2.1, M3). Rehearsals are not counted.
    const first = await withContext(this.db, { tenantId, userId: null }, async (tx) =>
      (await tx.query<{ first: boolean }>(`SELECT steps_taken = 0 AND mode = 'live' AND status = 'running' AND next_at <= now() AS first FROM workflow_runs WHERE id = $1`, [runId])).rows[0]?.first);
    if (first && this.entitlements) {
      try { await this.entitlements.startRun(system(tenantId), runId); } catch (err) {
        if ((err as { code?: string }).code !== 'limit_reached') throw err;
        await withContext(this.db, { tenantId, userId: null }, (tx) => tx.query(
          `UPDATE workflow_runs SET status = 'skipped', reason = 'plan_limit', finished_at = now(), lease_until = NULL WHERE id = $1 AND status = 'running'`, [runId]));
        return;
      }
    }
    let ai: AiForStep | undefined;
    for (let i = 0; i <= 2 * AUTOMATION_LIMITS.maxSteps + 2; i++) {
      let more: boolean;
      try {
        try { more = await this.step(tenantId, runId, false, ai); ai = undefined; } catch (err) {
          if (!(err instanceof NeedsAi) || ai) throw err;
          // Asked with no transaction open: nothing is locked while waiting for the AI.
          ai = { stepId: err.stepId, result: await this.ai!.agentDecision(tenantId, err.input) };
          continue;
        }
      } catch (err) {
        await this.failedAttempt(tenantId, runId, err);
        return;
      }
      if (!more) break;
    }
    await this.recordOutcome(tenantId, runId);
  }

  /** Runs one step in its own transaction. Returns true when the run should continue now. */
  private async step(tenantId: string, runId: string, rehearsal: boolean, ai?: AiForStep): Promise<boolean> {
    return withContext(this.db, { tenantId, userId: null }, async (tx) => {
      // Lock order as everywhere else: the conversation first, then the run (review of W2.1, M2).
      const conv = (await tx.query<{ c: string | null }>('SELECT conversation_id AS c FROM workflow_runs WHERE id = $1', [runId])).rows[0]?.c;
      if (conv) await tx.query('SELECT 1 FROM conversations WHERE id = $1 FOR UPDATE', [conv]);
      const run = (await tx.query<RunRow>(
        `SELECT r.id, r.workflow_id, r.mode, r.status, r.current_step, r.steps_taken, r.conversation_id, r.contact_id, r.sample, r.attempts,
                coalesce(v.definition, r.definition) AS definition, w.status AS workflow_status, r.started_at, (r.next_at <= now()) AS due
         FROM workflow_runs r JOIN workflows w ON w.id = r.workflow_id LEFT JOIN workflow_versions v ON v.id = r.version_id
         WHERE r.id = $1 FOR UPDATE OF r`, [runId])).rows[0];
      if (!run || (run.status !== 'running' && run.status !== 'waiting')) return false;
      // A live run moves only when it is due: a worker holding an old lease can never skip a wait or a back-off (M1).
      if (run.mode === 'live' && !run.due) return false;
      if ((run.mode === 'rehearsal') !== rehearsal) return false;
      const def = run.definition;
      // Where the run is: a waiting run resumes at the step after its wait (stored as current_step).
      const stepId = run.steps_taken === 0 && run.current_step === null ? def.start : run.current_step;
      if (stepId === null) return this.finish(tx, run, 'completed', null);
      if (run.mode === 'live' && run.workflow_status !== 'active') return this.finish(tx, run, 'stopped', 'automation_paused');
      if (run.steps_taken >= AUTOMATION_LIMITS.maxSteps) return this.finish(tx, run, 'failed', 'step_limit');
      const s = def.steps.find((x) => x.id === stepId);
      if (!s) return this.finish(tx, run, 'failed', 'unknown_step');
      const res = await this.execute({ tenantId, run, def, tx, ai }, s);
      await tx.query(`INSERT INTO workflow_run_steps (tenant_id, run_id, seq, step_id, kind, outcome, detail) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [tenantId, run.id, run.steps_taken + 1, s.id, s.kind, res.outcome, JSON.stringify(res.detail)]);
      if (res.waitMinutes && !rehearsal) {
        await tx.query(`UPDATE workflow_runs SET status = 'waiting', current_step = $2, steps_taken = steps_taken + 1, next_at = now() + make_interval(mins => $3), lease_until = NULL, attempts = 0 WHERE id = $1`,
          [run.id, res.next, res.waitMinutes]);
        return false;
      }
      await tx.query(`UPDATE workflow_runs SET status = 'running', current_step = $2, steps_taken = steps_taken + 1, attempts = 0 WHERE id = $1`, [run.id, res.next]);
      if (res.next === null) return this.finish(tx, { ...run, steps_taken: run.steps_taken + 1 }, 'completed', null);
      return true;
    });
  }

  private async finish(tx: Tx, run: RunRow, status: 'completed' | 'failed' | 'stopped', reason: string | null): Promise<false> {
    await tx.query(`UPDATE workflow_runs SET status = $2, reason = $3, finished_at = now(), lease_until = NULL WHERE id = $1`, [run.id, status, reason]);
    return false;
  }

  private async failedAttempt(tenantId: string, runId: string, err: unknown) {
    const code = String((err as { code?: unknown })?.code ?? (err instanceof Error ? err.name : 'error')).slice(0, 100);
    console.error('automation step failed; will retry', runId, code, err instanceof Error ? err.message : '');
    await withContext(this.db, { tenantId, userId: null }, (tx) => tx.query(
      `UPDATE workflow_runs SET attempts = attempts + 1, lease_until = NULL, next_at = now() + make_interval(secs => 30 * (attempts + 1)),
              status = CASE WHEN attempts + 1 >= $2 THEN 'failed' ELSE status END,
              reason = CASE WHEN attempts + 1 >= $2 THEN $3 ELSE reason END,
              finished_at = CASE WHEN attempts + 1 >= $2 THEN now() END
       WHERE id = $1 AND status IN ('running', 'waiting')`, [runId, AUTOMATION_LIMITS.maxAttempts, `step_error:${code}`]));
    await this.recordOutcome(tenantId, runId);
  }

  /** Live runs that ended count towards the plan (completed or failed; stopped and skipped runs do not). */
  private async recordOutcome(tenantId: string, runId: string) {
    if (!this.entitlements) return;
    const r = (await withContext(this.db, { tenantId, userId: null }, (tx) =>
      tx.query<{ status: string; mode: string }>('SELECT status, mode FROM workflow_runs WHERE id = $1', [runId]))).rows[0];
    if (r?.mode === 'live' && (r.status === 'completed' || r.status === 'failed')) {
      await this.entitlements.recordRunOutcome(system(tenantId), runId, r.status);
    }
  }

  // --- Steps ------------------------------------------------------------------------------------------------------

  private async execute(ctx: Ctx, s: StepDef): Promise<StepResult> {
    const live = ctx.run.mode === 'live';
    const next = s.kind === 'condition' ? null : s.next;
    switch (s.kind) {
      case 'condition': {
        const result = await this.evaluate(ctx, s.if);
        return { next: result ? s.then : s.else, outcome: 'done', detail: { result } };
      }
      case 'wait':
        return { next, outcome: live ? 'waiting' : 'would_do', detail: { minutes: s.minutes }, waitMinutes: s.minutes };
      case 'send_reply': {
        const lang = await this.language(ctx);
        const text = (lang === 'ar' ? s.text.ar || s.text.en : s.text.en || s.text.ar)!;
        const filled = text.replaceAll('{name}', (await this.contactName(ctx)) ?? '').replace(/\s+([,،.!?؟])/g, '$1').trim();
        if (!live) return { next, outcome: 'would_do', detail: { text: filled, language: lang } };
        const blocked = await this.sendBlocked(ctx, false);
        if (blocked) return { next, outcome: 'blocked', detail: { reason: blocked } };
        await this.enqueue(ctx, s.id, { kind: 'text', body: filled });
        return { next, outcome: 'done', detail: { language: lang } };
      }
      case 'send_template': {
        const t = (await ctx.tx.query<{ status: string; category: string; header_text: string | null; body_text: string; footer_text: string | null; name: string }>(
          'SELECT status, category, header_text, body_text, footer_text, name FROM message_templates WHERE id = $1', [s.templateId])).rows[0];
        if (!t) return { next, outcome: 'blocked', detail: { reason: 'unknown_template' } };
        const name = await this.contactName(ctx);
        const params = s.params.map((p) => (p.source === 'contact_name' ? name || p.fallback || '' : p.value || ''));
        if (params.some((p) => !checkParamValue(p))) return { next, outcome: 'blocked', detail: { reason: 'template_param_missing' } };
        const count = (await ctx.tx.query<{ n: number }>('SELECT param_count AS n FROM message_templates WHERE id = $1', [s.templateId])).rows[0]!.n;
        if (params.length !== count) return { next, outcome: 'blocked', detail: { reason: 'template_param_missing' } };
        if (!live) return { next, outcome: 'would_do', detail: { template: t.name, text: renderTemplate(t, params), approved: t.status === 'approved' } };
        if (t.status !== 'approved') return { next, outcome: 'blocked', detail: { reason: 'template_not_approved' } };
        const blocked = await this.sendBlocked(ctx, true, t.category === 'marketing');
        if (blocked) return { next, outcome: 'blocked', detail: { reason: blocked } };
        await this.enqueue(ctx, s.id, { kind: 'template', body: renderTemplate(t, params), templateId: s.templateId, params, category: t.category });
        return { next, outcome: 'done', detail: { template: t.name } };
      }
      case 'add_tag':
      case 'remove_tag': {
        const tag = (await ctx.tx.query<{ name: string }>('SELECT name FROM tags WHERE id = $1', [s.tagId])).rows[0];
        if (!tag) return { next, outcome: 'skipped', detail: { reason: 'unknown_tag' } };
        if (!live) return { next, outcome: 'would_do', detail: { tag: tag.name } };
        const on = s.kind === 'add_tag';
        const changed = on
          ? (await ctx.tx.query(`INSERT INTO conversation_tags (tenant_id, conversation_id, tag_id, added_by) VALUES ($1, $2, $3, NULL) ON CONFLICT DO NOTHING`, [ctx.tenantId, ctx.run.conversation_id, s.tagId])).rowCount
          : (await ctx.tx.query('DELETE FROM conversation_tags WHERE conversation_id = $1 AND tag_id = $2', [ctx.run.conversation_id, s.tagId])).rowCount;
        if (changed) await this.event(ctx, on ? 'tagged' : 'untagged', { tagId: s.tagId, name: tag.name, automation: ctx.run.workflow_id });
        return { next, outcome: changed ? 'done' : 'skipped', detail: { tag: tag.name } };
      }
      case 'assign': {
        const m = (await ctx.tx.query<{ ok: boolean }>(
          `SELECT EXISTS (SELECT 1 FROM memberships m JOIN membership_roles mr ON mr.membership_id = m.id JOIN role_permissions rp ON rp.role_id = mr.role_id AND rp.permission_key = 'inbox.reply'
                          WHERE m.id = $1 AND m.status = 'active') AS ok`, [s.membershipId])).rows[0]!;
        if (!m.ok) return { next, outcome: 'skipped', detail: { reason: 'member_unavailable' } };
        if (!live) return { next, outcome: 'would_do', detail: { membershipId: s.membershipId } };
        const c = (await ctx.tx.query<{ assigned: string | null }>('SELECT assigned_membership_id AS assigned FROM conversations WHERE id = $1 FOR UPDATE', [ctx.run.conversation_id])).rows[0]!;
        // An automation never takes a conversation away from a person who already has it.
        if (c.assigned) return { next, outcome: 'skipped', detail: { reason: 'already_assigned' } };
        await ctx.tx.query('UPDATE conversations SET assigned_membership_id = $2, version = version + 1 WHERE id = $1', [ctx.run.conversation_id, s.membershipId]);
        await this.event(ctx, 'auto_assigned', { to: s.membershipId, automation: ctx.run.workflow_id });
        return { next, outcome: 'done', detail: { membershipId: s.membershipId } };
      }
      case 'ai_reply': {
        if (!this.ai) return { next: s.ifHuman, outcome: live ? 'blocked' : 'would_do', detail: { decision: 'human_needed', reason: 'ai_unavailable' } };
        // The send checks come first: the AI is not asked (and the conversation is not sent to it) when nothing could
        // be sent anyway — opted out, paused, resolved, outside the 24-hour window (review of W2.2/W2.3, M1).
        if (live) {
          const blocked = await this.sendBlocked(ctx, false);
          if (blocked) return { next: s.ifHuman, outcome: 'blocked', detail: { decision: 'not_asked', reason: blocked } };
        }
        const sample = ctx.run.sample as { text?: string; language?: 'en' | 'ar' } | null;
        if (!ctx.ai || ctx.ai.stepId !== s.id) {
          throw new NeedsAi(s.id, live
            ? { conversationId: ctx.run.conversation_id, runId: ctx.run.id, live: true }
            : { conversationId: null, runId: ctx.run.id, sample: { text: sample?.text ?? '', language: sample?.language ?? 'en' } });
        }
        const r = ctx.ai.result;
        const detail = { decision: r.decision, text: r.text, reason: r.reason, citations: r.citations.map((c) => c.title), simulated: r.simulated, interactionId: r.interactionId };
        if (!live) return { next: r.decision === 'answer' ? s.next : s.ifHuman, outcome: 'would_do', detail };
        if (r.decision === 'answer' && r.text) {
          const now = (await ctx.tx.query<{ enabled: boolean; mode: string; version: number }>('SELECT enabled, mode, version FROM ai_settings')).rows[0];
          const latest = (await ctx.tx.query<{ id: string }>(`SELECT id FROM messages WHERE conversation_id = $1 AND direction = 'in' ORDER BY occurred_at DESC, id DESC LIMIT 1`,
            [ctx.run.conversation_id])).rows[0]?.id ?? null;
          if (!now?.enabled || now.mode !== 'answer' || (r.settingsVersion !== undefined && now.version !== r.settingsVersion) || (r.lastInboundId !== undefined && latest !== r.lastInboundId)) {
            await this.event(ctx, 'ai_handoff', { reason: 'changed_during_ai', decision: r.decision, interactionId: r.interactionId, automation: ctx.run.workflow_id });
            return { next: s.ifHuman, outcome: 'blocked', detail: { ...detail, reason: 'changed_during_ai' } };
          }
          // Customers are told the reply is automated unless the company turned that off (review H4).
          const disclose = (await ctx.tx.query<{ disclose: boolean }>('SELECT disclose FROM ai_settings')).rows[0]?.disclose ?? true;
          const lang = /[\u0600-\u06FF]/.test(r.text) ? 'ar' : 'en';
          const body = disclose ? `${r.text}\n\n${lang === 'ar' ? '(رد آلي)' : '(Automated reply)'}` : r.text;
          await this.enqueue(ctx, s.id, { kind: 'text', body, aiInteractionId: r.interactionId });
          return { next: s.next, outcome: 'done', detail };
        }
        // A suggestion or "a person is needed": nothing is sent; the team sees why in the conversation.
        await this.event(ctx, 'ai_handoff', { reason: r.reason, decision: r.decision, interactionId: r.interactionId, automation: ctx.run.workflow_id });
        return { next: s.ifHuman, outcome: 'done', detail };
      }
      case 'handoff': {
        if (!live) return { next, outcome: 'would_do', detail: { note: s.note } };
        await this.event(ctx, 'handed_off', { note: s.note, automation: ctx.run.workflow_id });
        return { next, outcome: 'done', detail: { note: s.note } };
      }
    }
  }

  private async evaluate(ctx: Ctx, c: z.infer<typeof Condition>): Promise<boolean> {
    const sample = (ctx.run.sample ?? {}) as { text?: string; language?: string; firstMessage?: boolean; tagIds?: string[] };
    switch (c.kind) {
      case 'message_contains': return contains(sample.text ?? null, c.words);
      case 'first_message': return !!sample.firstMessage;
      case 'contact_language': return (await this.language(ctx)) === c.language;
      case 'has_tag':
        if (ctx.run.mode === 'rehearsal') return (sample.tagIds ?? []).includes(c.tagId);
        return !!(await ctx.tx.query('SELECT 1 FROM conversation_tags WHERE conversation_id = $1 AND tag_id = $2', [ctx.run.conversation_id, c.tagId])).rowCount;
      case 'within_business_hours': {
        const { hours, tz, holidays } = await companyHours(ctx.tx);
        return isWithinBusinessHours(new Date(), hours, tz, holidays);
      }
    }
  }

  private async language(ctx: Ctx): Promise<'en' | 'ar'> {
    if (ctx.run.mode === 'rehearsal') return ((ctx.run.sample as { language?: string })?.language === 'ar' ? 'ar' : 'en');
    const l = (await ctx.tx.query<{ locale: string | null }>('SELECT locale FROM contacts WHERE id = $1', [ctx.run.contact_id])).rows[0]?.locale;
    if (l === 'ar' || l === 'en') return l;
    // No language recorded: the customer's own message decides (Arabic letters mean Arabic).
    return /[؀-ۿ]/.test(String((ctx.run.sample as { text?: string })?.text ?? '')) ? 'ar' : 'en';
  }

  private async contactName(ctx: Ctx): Promise<string | null> {
    if (ctx.run.mode === 'rehearsal') return ((ctx.run.sample as { contactName?: string })?.contactName ?? null) || null;
    return (await ctx.tx.query<{ n: string | null }>('SELECT display_name AS n FROM contacts WHERE id = $1', [ctx.run.contact_id])).rows[0]?.n ?? null;
  }

  /** The same checks as a person's message (they are made again when the message is actually sent). */
  private async sendBlocked(ctx: Ctx, template: boolean, marketing = false): Promise<string | null> {
    const c = (await ctx.tx.query<{ status: string; last_inbound_at: Date | null; paused: boolean; opted_out: boolean; consent: boolean; channel: string; wa: string | null }>(
      `SELECT c.status, c.last_inbound_at, (c.paused_at IS NOT NULL AND (c.paused_until IS NULL OR c.paused_until > now())) AS paused,
              (ct.opted_out_at IS NOT NULL) AS opted_out, (ct.marketing_consent_at IS NOT NULL) AS consent, ch.status AS channel,
              (SELECT value FROM contact_identifiers ci WHERE ci.contact_id = ct.id AND ci.kind = 'whatsapp' LIMIT 1) AS wa
       FROM conversations c JOIN contacts ct ON ct.id = c.contact_id JOIN channel_connections ch ON ch.id = c.connection_id WHERE c.id = $1`,
      [ctx.run.conversation_id])).rows[0]!;
    if (c.status === 'resolved') return 'conversation_resolved';
    if (c.paused) return 'replies_paused';
    if (c.opted_out) return 'contact_opted_out';
    if (c.channel !== 'active') return 'channel_disabled';
    if (!c.wa) return 'no_whatsapp_identifier';
    if (!template && (!c.last_inbound_at || Date.now() - c.last_inbound_at.getTime() >= 24 * 3600_000)) return 'template_required';
    if (marketing && !c.consent) return 'marketing_consent_required';
    return null;
  }

  private async enqueue(ctx: Ctx, stepId: string, m: { kind: 'text' | 'template'; body: string; templateId?: string; params?: string[]; category?: string; aiInteractionId?: string }) {
    const msg = (await ctx.tx.query<{ id: string; occurred_at: Date }>(
      `INSERT INTO messages (tenant_id, conversation_id, direction, kind, body, occurred_at, status, template_id, template_params, pricing_category, automation_run_id, automation_step, client_message_id, automation_run_mode, ai_interaction_id)
       VALUES ($1, $2, 'out', $3, $4, clock_timestamp(), 'queued', $5, $6, $7, $8, $9, $10, 'live', $11) RETURNING id, occurred_at`,
      [ctx.tenantId, ctx.run.conversation_id, m.kind, m.body, m.templateId ?? null, m.params ? JSON.stringify(m.params) : null,
        m.category ?? 'service', ctx.run.id, stepId, stepUuid(ctx.run.id, stepId), m.aiInteractionId ?? null])).rows[0]!;
    await ctx.tx.query('INSERT INTO send_jobs (tenant_id, message_id) VALUES ($1, $2)', [ctx.tenantId, msg.id]);
    await ctx.tx.query(`UPDATE conversations SET last_message_id = $2, last_message_at = $3, activity_seq = activity_seq + 1, version = version + 1 WHERE id = $1`,
      [ctx.run.conversation_id, msg.id, msg.occurred_at]);
  }

  private async event(ctx: Ctx, kind: string, data: Record<string, unknown>) {
    await ctx.tx.query(`INSERT INTO conversation_events (tenant_id, conversation_id, kind, actor_membership_id, data) VALUES ($1, $2, $3, NULL, $4)`,
      [ctx.tenantId, ctx.run.conversation_id, kind, JSON.stringify(data)]);
  }
}

/** A stable id for the message a step of a run sends (messages need one; the same step always gives the same id). */
function stepUuid(runId: string, stepId: string): string {
  const h = createHash('sha256').update(`automation:${runId}:${stepId}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
