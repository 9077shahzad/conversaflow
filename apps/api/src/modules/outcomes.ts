import { withContext } from '@conversaflow/database';
import { z } from 'zod';
import type { Deps, TenantActor } from '../core/context';
import { Errors } from '../core/errors';
import { parse } from '../core/validate';
import { companyHours } from './sla';

/**
 * Outcome and cost dashboard, first version (BRD v1.2 Wave 2, W2.9, CF-EXT-022).
 *
 * Counts only what the system records today, for a period in the company's own days, and says plainly what it
 * cannot measure yet and why:
 *  - conversations started and resolved, time to resolution, repeat contacts (a customer back within 30 days);
 *  - who answered: people, automations, the AI, the public API; conversations resolved without a person writing;
 *  - promises due in the period: kept on time, kept late, missed, put right;
 *  - customer requests from the customer page; AI decisions and AI spend (actual cost; simulated AI costs nothing);
 *  - cost per resolved conversation, from the costs that are known (AI only until WhatsApp costs are read live).
 * Not measured yet: bookings, orders, payments and refunds (no booking or payment system connected), customer
 * satisfaction (no survey yet), WhatsApp message costs (need live pricing from Meta, W1.11).
 */
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Query = z.object({ from: Day.optional(), to: Day.optional() }).strict();
const MAX_RANGE_DAYS = 366;

export class OutcomesService {
  constructor(private readonly deps: Deps) {}

  async report(actor: TenantActor, query: unknown) {
    const q = parse(Query, query ?? {});
    return withContext(this.deps.db, actor, async (tx) => {
      const { tz } = await companyHours(tx);
      const range = (await tx.query<{ from: string; to: string; start: Date; end: Date; days: number }>(
        `WITH d AS (SELECT coalesce($1::date, (now() AT TIME ZONE $3)::date - 29) AS f, coalesce($2::date, (now() AT TIME ZONE $3)::date) AS t)
         SELECT to_char(f, 'YYYY-MM-DD') AS "from", to_char(t, 'YYYY-MM-DD') AS "to",
                f::timestamp AT TIME ZONE $3 AS start, (t + 1)::timestamp AT TIME ZONE $3 AS "end", (t - f + 1) AS days FROM d`,
        [q.from ?? null, q.to ?? null, tz])).rows[0]!;
      if (range.days < 1 || range.days > MAX_RANGE_DAYS) throw Errors.badRequest(`Choose a period of 1 to ${MAX_RANGE_DAYS} days.`);
      const p = [range.start, range.end];

      const conv = (await tx.query<{ started: number; repeat: number }>(
        `SELECT count(*)::int AS started,
                count(*) FILTER (WHERE EXISTS (SELECT 1 FROM conversations e WHERE e.contact_id = c.contact_id AND e.id <> c.id
                                 AND (e.first_inbound_at, e.created_at, e.id) < (c.first_inbound_at, c.created_at, c.id) AND e.first_inbound_at >= c.first_inbound_at - interval '30 days'))::int AS repeat
         FROM conversations c WHERE c.first_inbound_at >= $1 AND c.first_inbound_at < $2`, p)).rows[0]!;

      // An earlier conversation is decided by arrival time, then creation order (provider times are whole seconds).
      // Resolved in the period: the last time each conversation was resolved within it.
      const res = (await tx.query<{ resolved: number; without_person: number; median_hours: number | null }>(
        `WITH r AS (
           SELECT DISTINCT ON (e.conversation_id) e.conversation_id, e.created_at AS at FROM conversation_events e
           WHERE e.kind = 'status_changed' AND e.data->>'to' = 'resolved' AND e.created_at >= $1 AND e.created_at < $2
           ORDER BY e.conversation_id, e.created_at DESC)
         SELECT count(*)::int AS resolved,
                count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = r.conversation_id AND m.direction = 'out'
                                 AND m.sent_by_membership_id IS NOT NULL AND m.api_key_id IS NULL AND m.campaign_id IS NULL AND m.automation_run_id IS NULL
                                 AND m.created_at <= r.at))::int AS without_person,
                round((percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM r.at - c.first_inbound_at)) / 3600)::numeric, 1)::float AS median_hours
         FROM r JOIN conversations c ON c.id = r.conversation_id`, p)).rows[0]!;

      const out = (await tx.query<{ person: number; automation: number; ai: number; api: number; campaign: number }>(
        // One bucket per message, in this order: campaigns carry their creator's membership, so they come first.
        `WITH m AS (SELECT CASE WHEN campaign_id IS NOT NULL THEN 'campaign' WHEN api_key_id IS NOT NULL THEN 'api'
                                WHEN ai_interaction_id IS NOT NULL THEN 'ai' WHEN automation_run_id IS NOT NULL THEN 'automation'
                                WHEN sent_by_membership_id IS NOT NULL THEN 'person' ELSE 'campaign' END AS who
                    FROM messages WHERE direction = 'out' AND created_at >= $1 AND created_at < $2 AND status IN ('sent', 'delivered', 'read'))
         SELECT count(*) FILTER (WHERE who = 'person')::int AS person, count(*) FILTER (WHERE who = 'automation')::int AS automation,
                count(*) FILTER (WHERE who = 'ai')::int AS ai, count(*) FILTER (WHERE who = 'api')::int AS api, count(*) FILTER (WHERE who = 'campaign')::int AS campaign
         FROM m`, p)).rows[0]!;

      const prom = (await tx.query<{ due: number; kept_on_time: number; kept_late: number; missed: number; recovered: number; open: number }>(
        `SELECT count(*)::int AS due,
                count(*) FILTER (WHERE status = 'kept' AND missed_at IS NULL AND closed_at <= due_at)::int AS kept_on_time,
                count(*) FILTER (WHERE status = 'kept' AND (missed_at IS NOT NULL OR closed_at > due_at))::int AS kept_late,
                count(*) FILTER (WHERE status = 'missed')::int AS missed,
                count(*) FILTER (WHERE status = 'recovered')::int AS recovered,
                count(*) FILTER (WHERE status = 'confirmed')::int AS open
         FROM promises WHERE due_at >= $1 AND due_at < $2 AND status IN ('confirmed', 'kept', 'missed', 'recovered')`, p)).rows[0]!;

      const requests = (await tx.query<{ talk: number; complaints: number }>(
        `SELECT count(*) FILTER (WHERE kind = 'talk_to_person')::int AS talk, count(*) FILTER (WHERE kind = 'complaint')::int AS complaints
         FROM customer_requests WHERE created_at >= $1 AND created_at < $2`, p)).rows[0]!;

      // Cost is what settled calls were charged. Calls that failed or are still running are held at their maximum
      // against the budget and may or may not be charged: shown apart, never added to the known cost.
      const ai = (await tx.query<{ answers: number; suggestions: number; handed: number; cost: string; uncertain: string; simulated: boolean | null }>(
        `SELECT count(*) FILTER (WHERE decision = 'answer')::int AS answers, count(*) FILTER (WHERE decision = 'suggestion')::int AS suggestions,
                count(*) FILTER (WHERE decision = 'human_needed')::int AS handed,
                coalesce((SELECT sum(cost_usd) FROM ai_usage u WHERE u.created_at >= $1 AND u.created_at < $2 AND u.status = 'settled'), 0) AS cost,
                coalesce((SELECT sum(cost_usd) FROM ai_usage u WHERE u.created_at >= $1 AND u.created_at < $2 AND u.status <> 'settled'), 0) AS uncertain,
                (SELECT bool_and(simulated) FROM ai_usage u WHERE u.created_at >= $1 AND u.created_at < $2) AS simulated
         FROM ai_interactions WHERE created_at >= $1 AND created_at < $2`, p)).rows[0]!;
      const aiCost = Number(ai.cost);

      return {
        period: { from: range.from, to: range.to, timeZone: tz },
        conversations: { started: conv.started, repeatWithin30Days: conv.repeat, resolved: res.resolved, resolvedWithoutPerson: res.without_person,
          medianHoursToResolve: res.median_hours },
        replies: { byPeople: out.person, byAutomations: out.automation, byAi: out.ai, viaApi: out.api, campaignsAndTemplates: out.campaign },
        promises: { due: prom.due, keptOnTime: prom.kept_on_time, keptLate: prom.kept_late, missed: prom.missed, putRight: prom.recovered, stillOpen: prom.open },
        customerRequests: { askedForPerson: requests.talk, complaints: requests.complaints },
        ai: { answered: ai.answers, suggested: ai.suggestions, handedToPerson: ai.handed, costUsd: aiCost, uncertainUsd: Number(ai.uncertain), simulated: ai.simulated },
        costs: {
          knownUsd: aiCost,
          perResolvedConversationUsd: res.resolved > 0 ? Math.round((aiCost / res.resolved) * 10_000) / 10_000 : null,
          includes: ['ai'],
          missing: ['whatsapp_messages', 'team_time'],
        },
        notMeasuredYet: [
          { what: 'bookings_and_orders', why: 'no_booking_or_order_system' },
          { what: 'payments_and_refunds', why: 'no_payment_system' },
          { what: 'satisfaction', why: 'no_survey' },
          { what: 'whatsapp_costs', why: 'needs_live_pricing' },
        ],
        assumptions: ['resolved_last_in_period', 'repeat_within_30_days', 'without_person_means_no_person_wrote_before_resolving', 'promises_by_due_date', 'ai_cost_actual_simulated_zero',
          'replies_sent_only', 'whole_company_counts'],
      };
    });
  }
}
