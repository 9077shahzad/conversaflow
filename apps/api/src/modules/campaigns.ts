import { withContext, type Db, type Tx } from '@conversaflow/database';
import { z } from 'zod';
import type { Deps, TenantActor } from '../core/context';
import { AppError, Errors } from '../core/errors';
import { parse } from '../core/validate';
import { AuditService } from './audit.service';
import { isUuid } from './members.service';
import { providerRateOn } from './provider-rates';
import { campaignLimits, dailyRoom, type Limits } from './campaign-limits';
import { checkParamValue, renderTemplate } from './templates.service';

/**
 * Campaigns (BRD v1.2 Wave 1, CF-EXT-004). One approved template to contacts with RECORDED consent.
 *
 * Eligibility is decided three times: in the preview (an estimate), when each recipient's message is queued, and by
 * the sender immediately before it leaves. Only the last two decide anything. A contact who opts out after the
 * campaign was scheduled is skipped.
 *
 * No duplicate sending: one recipient row per contact (unique), one message per recipient (unique), and the message's
 * idempotency key is the recipient id, so queueing the same recipient twice fails on the existing key. Recipient and
 * message are written in one transaction.
 */
export const CAMPAIGN_LIMITS = { batchSize: 50, leaseSeconds: 120, idleRecheckSeconds: 30 };

const ParamSource = z.discriminatedUnion('source', [
  z.object({ source: z.literal('static'), value: z.string().trim().min(1).max(200) }),
  z.object({ source: z.literal('contact_name'), fallback: z.string().trim().min(1).max(100) }),
]);
const Audience = z.object({ recentDays: z.number().int().min(1).max(365).nullable().default(null) });
const CampaignInput = z.object({
  name: z.string().trim().min(2).max(120),
  templateId: z.string().uuid(),
  connectionId: z.string().uuid().optional(),
  params: z.array(ParamSource).max(20),
  audience: Audience.default({ recentDays: null }),
});
const PreviewInput = CampaignInput.omit({ name: true });
const ScheduleInput = z.object({ at: z.string().datetime({ offset: true }).nullable() });
const SuppressionInput = z.object({
  waNumber: z.string().regex(/^\+?[0-9]{6,20}$/, 'Use the full international number, digits only').transform((v) => v.replace(/^\+/, '')),
  reason: z.enum(['customer_request', 'complaint', 'legal', 'wrong_number', 'other']),
  note: z.string().trim().max(300).optional(),
});

export type SkipReason = 'opted_out' | 'no_consent' | 'suppressed' | 'frequency_limit' | 'no_whatsapp' | 'template_not_approved' | 'campaign_cancelled' | 'replies_paused';

const limits = campaignLimits;

/**
 * The audience as it stands right now: every contact with a WhatsApp number, with the first reason (if any) it would
 * be skipped. Used by the preview and, at start, to choose recipients.
 */
async function evaluateAudience(tx: Tx, audience: z.infer<typeof Audience>, lim: Limits) {
  return (await tx.query<{ contact_id: string; name: string | null; wa: string | null; reason: SkipReason | 'not_recent' | null }>(
    `SELECT ct.id AS contact_id, ct.display_name AS name, wa.value AS wa,
            CASE
              WHEN wa.value IS NULL THEN 'no_whatsapp'
              WHEN ct.opted_out_at IS NOT NULL THEN 'opted_out'
              WHEN ct.marketing_consent_at IS NULL THEN 'no_consent'
              WHEN EXISTS (SELECT 1 FROM suppressions s WHERE s.wa_number = wa.value) THEN 'suppressed'
              WHEN $1::int IS NOT NULL AND NOT EXISTS (SELECT 1 FROM conversations c WHERE c.contact_id = ct.id
                     AND c.last_inbound_at > now() - make_interval(days => $1::int)) THEN 'not_recent'
              WHEN campaign_contact_blocked(ct.id, $2::int, $3::int, true) THEN 'frequency_limit'
            END AS reason
     FROM contacts ct
     LEFT JOIN LATERAL (SELECT value FROM contact_identifiers ci WHERE ci.contact_id = ct.id AND ci.kind = 'whatsapp' LIMIT 1) wa ON true
     ORDER BY ct.created_at`, [audience.recentDays, lim.perContact7d, lim.minGapHours])).rows;
}

/** Country of a WhatsApp number by calling code, for the cost estimate (markets used by Meta's rate card). */
export function marketOf(wa: string): string {
  if (wa.startsWith('966')) return 'SA';
  if (wa.startsWith('971')) return 'AE';
  if (wa.startsWith('973')) return 'BH';
  if (wa.startsWith('968')) return 'OM';
  if (wa.startsWith('974')) return 'QA';
  if (wa.startsWith('965')) return 'KW';
  return 'other';
}

/**
 * Cost estimate from VERIFIED rates only. A market without a verified rate on file is shown as "no verified rate",
 * and the total is left blank rather than guessed. The estimate assumes every eligible recipient receives the
 * message; free entry points and volume tiers are not applied.
 */
async function estimate(tx: Tx, category: string, numbers: string[]) {
  const today = new Date().toISOString().slice(0, 10);
  const byMarket = new Map<string, number>();
  for (const n of numbers) byMarket.set(marketOf(n), (byMarket.get(marketOf(n)) ?? 0) + 1);
  const lines = [];
  let total = 0;
  let complete = true;
  for (const [market, recipients] of byMarket) {
    const rate = market === 'other' ? null : await providerRateOn(tx, { market, category, currency: 'USD', on: today });
    if (!rate) complete = false; else total += rate.rate * recipients;
    lines.push({ market, recipients, rate: rate?.rate ?? null, currency: 'USD', source: rate?.sourceUrl ?? null, effectiveFrom: rate?.effectiveFrom ?? null });
  }
  // Three different answers, never confused: an estimate from verified rates; no estimate (a rate is not verified; this
  // is NOT a cost of zero); and no cost because nobody would receive the message.
  const state = numbers.length === 0 ? 'no_recipients' : complete ? 'estimated' : 'unavailable';
  return { category, lines, state, total: state === 'unavailable' ? null : Math.round(total * 100) / 100, currency: 'USD', complete,
    missingMarkets: lines.filter((l) => l.rate === null).map((l) => l.market),
    note: state === 'estimated' ? 'Verified Meta rates; assumes every eligible recipient receives the message.'
      : state === 'unavailable' ? 'No verified Meta rate is on file for at least one market, so no estimate is shown. This is not a cost of zero.'
      : 'Nobody would receive this campaign now, so it would cost nothing.' };
}

function resolveParams(params: z.infer<typeof ParamSource>[], contactName: string | null): string[] {
  return params.map((p) => (p.source === 'static' ? p.value : (contactName?.trim() || p.fallback)).replace(/[\n\r\t]/g, ' ').replace(/ {5,}/g, '    ').slice(0, 1024));
}

type Tpl = { id: string; status: string; category: string; param_count: number; account_ref: string; header_text: string | null; body_text: string; footer_text: string | null };

export class CampaignsService {
  constructor(private readonly deps: Deps) {}

  private async loadTemplateAndConnection(tx: Tx, input: { templateId: string; connectionId?: string }) {
    const tpl = (await tx.query<Tpl>(
      'SELECT id, status, category, param_count, account_ref, header_text, body_text, footer_text FROM message_templates WHERE id = $1', [input.templateId])).rows[0];
    if (!tpl) throw Errors.notFound('Template');
    const conns = (await tx.query<{ id: string; account_ref: string }>(
      `SELECT id, account_ref FROM channel_connections WHERE status = 'active' AND account_ref = $1 AND ($2::uuid IS NULL OR id = $2::uuid)`,
      [tpl.account_ref, input.connectionId ?? null])).rows;
    if (conns.length === 0) throw Errors.conflict('no_connection', 'No active number belongs to this template\'s WhatsApp account.');
    if (conns.length > 1 && !input.connectionId) throw Errors.badRequest('Choose which number sends this campaign.');
    return { tpl, connectionId: conns[0]!.id };
  }

  private checkParams(tpl: Tpl, params: z.infer<typeof ParamSource>[]) {
    if (params.length !== tpl.param_count) throw Errors.badRequest(`Give a value for each of the template's ${tpl.param_count} parameters.`);
    if (!resolveParams(params, null).every(checkParamValue)) throw Errors.badRequest('Each value must be one line.');
  }

  /** What would happen if the campaign started now. An estimate only: everything is checked again at send time. */
  async preview(actor: TenantActor, input: unknown) {
    const body = parse(PreviewInput, input);
    return withContext(this.deps.db, actor, async (tx) => {
      const { tpl } = await this.loadTemplateAndConnection(tx, body);
      this.checkParams(tpl, body.params);
      const rows = await evaluateAudience(tx, body.audience, await limits(tx));
      const eligible = rows.filter((r) => r.reason === null);
      const excluded: Record<string, number> = {};
      for (const r of rows) if (r.reason) excluded[r.reason] = (excluded[r.reason] ?? 0) + 1;
      const lim = await limits(tx);
      return {
        templateStatus: tpl.status,
        contacts: rows.length,
        eligible: eligible.length,
        excluded,
        sample: eligible.slice(0, 5).map((r) => ({ name: r.name, text: renderTemplate(tpl, resolveParams(body.params, r.name)) })),
        dailyLimit: lim.daily,
        daysNeeded: Math.max(1, Math.ceil(eligible.length / lim.daily)),
        cost: await estimate(tx, tpl.category, eligible.map((r) => r.wa!)),
      };
    });
  }

  async create(actor: TenantActor, input: unknown) {
    const body = parse(CampaignInput, input);
    return withContext(this.deps.db, actor, async (tx) => {
      const { tpl, connectionId } = await this.loadTemplateAndConnection(tx, body);
      this.checkParams(tpl, body.params);
      const row = (await tx.query<{ id: string }>(
        `INSERT INTO campaigns (tenant_id, name, connection_id, template_id, params, audience, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [actor.tenantId, body.name, connectionId, tpl.id, JSON.stringify(body.params), JSON.stringify(body.audience), actor.membershipId])).rows[0]!;
      await AuditService.record(tx, { tenantId: actor.tenantId, actorUserId: actor.userId, action: 'campaign.created', ip: actor.ip,
        targetType: 'campaign', targetId: row.id, metadata: { name: body.name, templateId: tpl.id } });
      return this.load(tx, row.id);
    });
  }

  async list(actor: TenantActor) {
    return withContext(this.deps.db, actor, async (tx) => {
      const ids = (await tx.query<{ id: string }>('SELECT id FROM campaigns ORDER BY created_at DESC LIMIT 100')).rows;
      const out = [];
      for (const r of ids) out.push(await this.load(tx, r.id));
      return out;
    });
  }

  async get(actor: TenantActor, id: string) {
    if (!isUuid(id)) throw Errors.notFound('Campaign');
    return withContext(this.deps.db, actor, (tx) => this.load(tx, id));
  }

  private async load(tx: Tx, id: string) {
    const c = (await tx.query(
      `SELECT c.id, c.name, c.status, c.scheduled_at AS "scheduledAt", c.started_at AS "startedAt", c.finished_at AS "finishedAt",
              c.params, c.audience, c.created_at AS "createdAt", c.template_id AS "templateId", t.name AS "templateName",
              t.language AS "templateLanguage", t.category AS "templateCategory", t.status AS "templateStatus",
              c.connection_id AS "connectionId", ch.provider
       FROM campaigns c JOIN message_templates t ON t.id = c.template_id JOIN channel_connections ch ON ch.id = c.connection_id
       WHERE c.id = $1`, [id])).rows[0];
    if (!c) throw Errors.notFound('Campaign');
    // Progress from the recipients and their messages' honest delivery states. A recipient stopped by our own checks
    // just before sending (for example over the frequency limits, owner decision P2-3) is reported as skipped at send
    // time with its reason, separately from messages WhatsApp refused or failed to deliver (W1.14). Skipped recipients
    // are never sent this campaign's message later; a later campaign checks them afresh.
    const counts = (await tx.query<{ k: string; n: number }>(
      `SELECT CASE WHEN r.state <> 'queued' THEN r.state || coalesce(':' || r.skip_reason, '')
                   WHEN m.status = 'failed' AND m.failure_kind = 'blocked' THEN 'skipped_at_send:' ||
                     CASE m.error_code WHEN 'contact_opted_out' THEN 'opted_out' WHEN 'marketing_consent_required' THEN 'no_consent'
                                       WHEN 'no_whatsapp_identifier' THEN 'no_whatsapp' ELSE coalesce(m.error_code, 'other') END
                   WHEN m.status = 'failed' THEN 'failed:' || m.failure_kind ELSE m.status END AS k, count(*)::int AS n
       FROM campaign_recipients r LEFT JOIN messages m ON m.id = r.message_id WHERE r.campaign_id = $1 GROUP BY 1`, [id])).rows;
    const progress = Object.fromEntries(counts.map((x) => [x.k, x.n]));
    const sum = (prefix: string) => counts.filter((x) => x.k.startsWith(prefix)).reduce((t, x) => t + x.n, 0);
    return { ...c, progress, skipped: { whenQueueing: sum('skipped:'), whenSending: sum('skipped_at_send:') } };
  }

  /** Schedules a draft campaign (null = now). The template must be approved now; it is checked again at send. */
  async schedule(actor: TenantActor, id: string, input: unknown) {
    const body = parse(ScheduleInput, input);
    return this.transition(actor, id, ['draft'], 'scheduled', 'campaign.scheduled', async (tx) => {
      const t = (await tx.query<{ status: string }>(
        'SELECT t.status FROM campaigns c JOIN message_templates t ON t.id = c.template_id WHERE c.id = $1', [id])).rows[0]!;
      if (t.status !== 'approved') throw Errors.conflict('template_not_approved', 'This template is not approved for sending.');
      const at = body.at ? new Date(body.at) : new Date();
      if (at.getTime() > Date.now() + 90 * 86_400_000) throw Errors.badRequest('Schedule within 90 days.');
      await tx.query('UPDATE campaigns SET scheduled_at = $2 WHERE id = $1', [id, at]);
    });
  }

  /** Stops queueing new messages; messages already queued are held back by the sender until resumed. */
  pause(actor: TenantActor, id: string) {
    return this.transition(actor, id, ['scheduled', 'running'], 'paused', 'campaign.paused');
  }

  /** A campaign paused before it started goes back to "scheduled", so its recipients are still chosen when it starts
   *  (review finding S4-3); one paused while running continues where it stopped. */
  resume(actor: TenantActor, id: string) {
    return this.transition(actor, id, ['paused'], async (tx) =>
      (await tx.query<{ started: boolean }>('SELECT started_at IS NOT NULL AS started FROM campaigns WHERE id = $1', [id])).rows[0]!.started
        ? 'running' : 'scheduled',
    'campaign.resumed', async (tx) => {
      await tx.query('UPDATE campaigns SET scheduled_at = coalesce(scheduled_at, now()), lease_until = NULL WHERE id = $1', [id]);
    });
  }

  /** Final: nothing more is queued, and queued messages not yet sent are stopped by the sender. */
  cancel(actor: TenantActor, id: string) {
    return this.transition(actor, id, ['draft', 'scheduled', 'running', 'paused'], 'cancelled', 'campaign.cancelled', async (tx) => {
      await tx.query('UPDATE campaigns SET finished_at = now() WHERE id = $1', [id]);
      await tx.query(`UPDATE campaign_recipients SET state = 'skipped', skip_reason = 'campaign_cancelled', updated_at = now()
                      WHERE campaign_id = $1 AND state = 'pending'`, [id]);
    });
  }

  private async transition(actor: TenantActor, id: string, from: string[], target: string | ((tx: Tx) => Promise<string>), action: string,
    extra?: (tx: Tx) => Promise<void>) {
    if (!isUuid(id)) throw Errors.notFound('Campaign');
    return withContext(this.deps.db, actor, async (tx) => {
      const c = (await tx.query<{ status: string }>('SELECT status FROM campaigns WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!c) throw Errors.notFound('Campaign');
      if (!from.includes(c.status)) {
        throw new AppError(409, 'campaign_state', `A ${c.status} campaign cannot be changed this way.`, { status: c.status });
      }
      const to = typeof target === 'string' ? target : await target(tx);
      if (extra) await extra(tx); // first: e.g. the scheduled time a scheduled campaign must have
      await tx.query(`UPDATE campaigns SET status = $2, status_changed_by = $3, status_changed_at = now(), updated_at = now() WHERE id = $1`,
        [id, to, actor.membershipId]);
      await AuditService.record(tx, { tenantId: actor.tenantId, actorUserId: actor.userId, action, ip: actor.ip, targetType: 'campaign', targetId: id,
        metadata: { from: c.status, to } });
      return this.load(tx, id);
    });
  }

  // --- Suppression list ------------------------------------------------------------------------------------------------
  async listSuppressions(actor: TenantActor) {
    return withContext(this.deps.db, actor, async (tx) => (await tx.query(
      `SELECT id, wa_number AS "waNumber", reason, note, created_at AS "createdAt" FROM suppressions ORDER BY created_at DESC LIMIT 500`)).rows);
  }

  async addSuppression(actor: TenantActor, input: unknown) {
    const body = parse(SuppressionInput, input);
    return withContext(this.deps.db, actor, async (tx) => {
      const row = (await tx.query(
        `INSERT INTO suppressions (tenant_id, wa_number, reason, note, created_by) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (tenant_id, wa_number) DO UPDATE SET reason = EXCLUDED.reason, note = coalesce(EXCLUDED.note, suppressions.note)
         RETURNING id, wa_number AS "waNumber", reason, note, created_at AS "createdAt"`,
        [actor.tenantId, body.waNumber, body.reason, body.note ?? null, actor.membershipId])).rows[0];
      await AuditService.record(tx, { tenantId: actor.tenantId, actorUserId: actor.userId, action: 'suppression.added', ip: actor.ip,
        targetType: 'suppression', targetId: row.id, metadata: { reason: body.reason } });
      return row;
    });
  }

  async removeSuppression(actor: TenantActor, id: string) {
    if (!isUuid(id)) throw Errors.notFound('Suppression');
    await withContext(this.deps.db, actor, async (tx) => {
      const n = (await tx.query('DELETE FROM suppressions WHERE id = $1', [id])).rowCount;
      if (!n) throw Errors.notFound('Suppression');
      await AuditService.record(tx, { tenantId: actor.tenantId, actorUserId: actor.userId, action: 'suppression.removed', ip: actor.ip,
        targetType: 'suppression', targetId: id });
    });
  }
}

/**
 * Worker side: starts due campaigns (choosing recipients at that moment) and queues messages in batches. Each batch
 * is one transaction: recipients are locked, checked, and their messages and send jobs created together.
 */
export class CampaignBatchCrash extends Error { constructor() { super('simulated crash during a campaign batch'); } }

export class CampaignRunner {
  /** faults: test hook that stops the process after N messages were queued in a batch (never set in production). */
  constructor(private readonly db: Db, private readonly faults: { crashAfterQueued?: number } = {}) {}

  async dispatchDue(limit = 5): Promise<number> {
    const due = await withContext(this.db, { tenantId: null, userId: null }, async (tx) =>
      (await tx.query<{ campaign_id: string; tenant_id: string }>('SELECT * FROM campaign_claim($1, $2)', [limit, CAMPAIGN_LIMITS.leaseSeconds])).rows);
    for (const c of due) {
      try { await this.runBatch(c.tenant_id, c.campaign_id); } catch (err) {
        if (err instanceof CampaignBatchCrash) throw err;
        console.error('campaign batch error', c.campaign_id, err instanceof Error ? err.message : err);
      }
    }
    return due.length;
  }

  /** Processes one batch. Returns how many messages it queued. Safe to repeat and to run twice at once. */
  async runBatch(tenantId: string, campaignId: string): Promise<{ queued: number; skipped: number; status: string }> {
    return withContext(this.db, { tenantId, userId: null }, async (tx) => {
      // One batch at a time per company, so two workers on different campaigns cannot both use the same room under the
      // daily limit or both message one contact inside the frequency limits (review finding S4-4). Taken before the
      // campaign row lock, always in this order.
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${tenantId}:campaign-batch`]);
      const c = (await tx.query<{ id: string; status: string; scheduled_at: Date | null; connection_id: string; template_id: string;
        params: z.infer<typeof ParamSource>[]; audience: z.infer<typeof Audience>; created_by: string }>(
        'SELECT id, status, scheduled_at, connection_id, template_id, params, audience, created_by FROM campaigns WHERE id = $1 FOR UPDATE',
        [campaignId])).rows[0];
      const release = () => tx.query('UPDATE campaigns SET lease_until = NULL, updated_at = now() WHERE id = $1', [campaignId]);
      if (!c || !['scheduled', 'running'].includes(c.status) || !c.scheduled_at || c.scheduled_at.getTime() > Date.now()) {
        if (c) await release();
        return { queued: 0, skipped: 0, status: c?.status ?? 'missing' };
      }
      const lim = await limits(tx);
      if (c.status === 'scheduled') {
        // Recipients are chosen now, not when the campaign was scheduled. Contacts excluded at this moment are not
        // added; everyone added is checked again below and by the sender.
        const audience = (await evaluateAudience(tx, c.audience, lim)).filter((r) => r.reason === null || r.reason === 'frequency_limit');
        for (const r of audience) {
          await tx.query(`INSERT INTO campaign_recipients (tenant_id, campaign_id, contact_id) VALUES ($1, $2, $3) ON CONFLICT (campaign_id, contact_id) DO NOTHING`,
            [tenantId, campaignId, r.contact_id]);
        }
        await tx.query(`UPDATE campaigns SET status = 'running', started_at = now(), updated_at = now() WHERE id = $1`, [campaignId]);
      }
      // The number's rolling 24-hour limit across all campaigns of this connection (see campaign-limits.ts for what
      // counts). This is planning only; the sender checks again, atomically, just before each message leaves.
      const room = Math.min(CAMPAIGN_LIMITS.batchSize, await dailyRoom(tx, c.connection_id, lim, true));
      const tpl = (await tx.query<Tpl>(
        'SELECT id, status, category, param_count, account_ref, header_text, body_text, footer_text FROM message_templates WHERE id = $1', [c.template_id])).rows[0]!;
      const batch = room === 0 ? [] : (await tx.query<{ id: string; contact_id: string }>(
        `SELECT id, contact_id FROM campaign_recipients WHERE campaign_id = $1 AND state = 'pending' ORDER BY created_at LIMIT $2 FOR UPDATE SKIP LOCKED`,
        [campaignId, room])).rows;
      let queued = 0; let skipped = 0;
      for (const r of batch) {
        const reason = await recipientRefusal(tx, r.contact_id, tpl, lim);
        if (reason) {
          await tx.query(`UPDATE campaign_recipients SET state = 'skipped', skip_reason = $2, updated_at = now() WHERE id = $1`, [r.id, reason]);
          skipped++;
          continue;
        }
        const contact = (await tx.query<{ name: string | null }>('SELECT display_name AS name FROM contacts WHERE id = $1', [r.contact_id])).rows[0]!;
        const conv = await openConversation(tx, tenantId, r.contact_id, c.connection_id);
        const params = resolveParams(c.params, contact.name);
        const msg = (await tx.query<{ id: string }>(
          `INSERT INTO messages (tenant_id, conversation_id, direction, kind, body, client_message_id, sent_by_membership_id, occurred_at, status,
                                 template_id, template_params, pricing_category, campaign_id)
           VALUES ($1, $2, 'out', 'template', $3, $4, $5, clock_timestamp(), 'queued', $6, $7, $8, $9) RETURNING id`,
          [tenantId, conv, renderTemplate(tpl, params), r.id, c.created_by, tpl.id, JSON.stringify(params), tpl.category, campaignId])).rows[0]!;
        await tx.query('INSERT INTO send_jobs (tenant_id, message_id) VALUES ($1, $2)', [tenantId, msg.id]);
        await tx.query(`UPDATE campaign_recipients SET state = 'queued', message_id = $2, updated_at = now() WHERE id = $1`, [r.id, msg.id]);
        await tx.query('UPDATE conversations SET last_message_id = $2, last_message_at = now(), activity_seq = activity_seq + 1, version = version + 1 WHERE id = $1', [conv, msg.id]);
        queued++;
        if (this.faults.crashAfterQueued !== undefined && queued >= this.faults.crashAfterQueued) throw new CampaignBatchCrash();
      }
      // Completed only when nobody is left to queue AND none of its messages is still waiting to be sent, so the campaign
      // can be paused or cancelled for as long as anything can still be stopped (review finding S4-2).
      const left = (await tx.query<{ n: number }>(
        `SELECT (SELECT count(*) FROM campaign_recipients WHERE campaign_id = $1 AND state = 'pending')
              + (SELECT count(*) FROM messages WHERE campaign_id = $1 AND status = 'queued') AS n`, [campaignId])).rows[0]!.n;
      const done = Number(left) === 0;
      if (done) await tx.query(`UPDATE campaigns SET status = 'completed', finished_at = now(), updated_at = now() WHERE id = $1`, [campaignId]);
      // A batch that changed nothing (waiting for room under the daily limit, or for its queued messages to leave) keeps
      // its lease for a while, so the worker does not pick the same campaign again at once and spin (recheck N1).
      if (!done && queued + skipped === 0) {
        await tx.query(`UPDATE campaigns SET lease_until = now() + make_interval(secs => $2), updated_at = now() WHERE id = $1`,
          [campaignId, CAMPAIGN_LIMITS.idleRecheckSeconds]);
      } else await release();
      return { queued, skipped, status: done ? 'completed' : 'running' };
    });
  }
}

/** Why a recipient may not be sent this campaign message right now (null = eligible). Shared with the sender. */
export async function recipientRefusal(tx: Tx, contactId: string, tpl: { status: string }, lim?: Limits): Promise<SkipReason | null> {
  const l = lim ?? (await limits(tx));
  const r = (await tx.query<{ reason: SkipReason | null }>(
    `SELECT CASE
              WHEN wa.value IS NULL THEN 'no_whatsapp'
              WHEN ct.opted_out_at IS NOT NULL THEN 'opted_out'
              WHEN ct.marketing_consent_at IS NULL THEN 'no_consent'
              WHEN EXISTS (SELECT 1 FROM suppressions s WHERE s.wa_number = wa.value) THEN 'suppressed'
              WHEN $2 <> 'approved' THEN 'template_not_approved'
              WHEN campaign_contact_blocked(ct.id, $3::int, $4::int, true) THEN 'frequency_limit'
            END AS reason
     FROM contacts ct
     LEFT JOIN LATERAL (SELECT value FROM contact_identifiers ci WHERE ci.contact_id = ct.id AND ci.kind = 'whatsapp' LIMIT 1) wa ON true
     WHERE ct.id = $1`, [contactId, tpl.status, l.perContact7d, l.minGapHours])).rows[0];
  if (!r) return 'no_whatsapp'; // the contact no longer exists
  return r.reason;
}

async function openConversation(tx: Tx, tenantId: string, contactId: string, connectionId: string): Promise<string> {
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${tenantId}:conv:${contactId}:${connectionId}`]);
  const existing = (await tx.query<{ id: string }>(
    `SELECT id FROM conversations WHERE contact_id = $1 AND connection_id = $2 AND status <> 'resolved'`, [contactId, connectionId])).rows[0];
  if (existing) return existing.id;
  return (await tx.query<{ id: string }>(
    `INSERT INTO conversations (tenant_id, contact_id, connection_id, status) VALUES ($1, $2, $3, 'pending') RETURNING id`,
    [tenantId, contactId, connectionId])).rows[0]!.id;
}
