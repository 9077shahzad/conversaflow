import { withContext } from '@conversaflow/database';
import { z } from 'zod';
import type { Deps, TenantActor } from '../core/context';
import { Errors } from '../core/errors';
import { parse } from '../core/validate';
import { companyHours } from './sla';

/**
 * Click-to-WhatsApp ad report (W1.9, CF-EXT-005, FR-305).
 *
 * Attribution model, shown with the report:
 *  - a conversation is credited to the first ad (or post) tapped within it: WhatsApp attaches the ad's details to the
 *    first message a customer sends after tapping it (`conversation_attributions`, written when that message is applied);
 *  - outcomes are counted for ATTRIBUTION_WINDOW_DAYS after that message: the team's first reply, the conversation
 *    being resolved, the customer opting out;
 *  - conversations that started in the period without an ad are shown as "not from an ad".
 * The report shows association, not effect: it never says an ad caused a conversation, a booking or revenue.
 * Counts only; no customer names or numbers. Days are the company's own days (its time zone).
 */
export const ATTRIBUTION_WINDOW_DAYS = 28;
const MAX_RANGE_DAYS = 366;
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Query = z.object({ from: Day.optional(), to: Day.optional() }).strict();

export class ReportsService {
  constructor(private readonly deps: Deps) {}

  async ads(actor: TenantActor, query: unknown) {
    const q = parse(Query, query);
    return withContext(this.deps.db, actor, async (tx) => {
      const { tz } = await companyHours(tx);
      // The period in the company's days: [from 00:00, to + 1 day 00:00). Default: the last 30 days including today.
      const range = (await tx.query<{ from: string; to: string; start: Date; end: Date; days: number }>(
        `WITH d AS (SELECT coalesce($1::date, (now() AT TIME ZONE $3)::date - 29) AS f, coalesce($2::date, (now() AT TIME ZONE $3)::date) AS t)
         SELECT to_char(f, 'YYYY-MM-DD') AS "from", to_char(t, 'YYYY-MM-DD') AS "to",
                f::timestamp AT TIME ZONE $3 AS start, (t + 1)::timestamp AT TIME ZONE $3 AS "end", (t - f + 1) AS days FROM d`,
        [q.from ?? null, q.to ?? null, tz])).rows[0]!;
      if (range.days < 1 || range.days > MAX_RANGE_DAYS) throw Errors.badRequest(`Choose a period of 1 to ${MAX_RANGE_DAYS} days.`);
      const params = [range.start, range.end, ATTRIBUTION_WINDOW_DAYS];
      const ads = (await tx.query<{
        sourceType: string; sourceId: string | null; headline: string | null; sourceUrl: string | null; conversations: number;
        newContacts: number; replied: number; resolved: number; optedOut: number; medianFirstReplyMinutes: number | null;
      }>(
        `WITH a AS (
           SELECT a.*, a.first_message_at + make_interval(days => $3) AS window_end FROM conversation_attributions a
           JOIN conversations c ON c.id = a.conversation_id
           -- The same population as the totals: conversations whose customer first wrote in the period (second recheck W2).
           WHERE c.first_inbound_at >= $1 AND c.first_inbound_at < $2),
         s AS (
           SELECT a.*,
             (SELECT min(m.created_at) FROM messages m WHERE m.conversation_id = a.conversation_id AND m.direction = 'out'
                AND m.sent_by_membership_id IS NOT NULL AND m.campaign_id IS NULL AND m.created_at >= a.first_message_at AND m.created_at < a.window_end) AS first_reply_at,
             EXISTS (SELECT 1 FROM conversation_events e WHERE e.conversation_id = a.conversation_id AND e.kind = 'status_changed'
                AND e.data->>'to' = 'resolved' AND e.created_at >= a.first_message_at AND e.created_at < a.window_end) AS resolved,
             EXISTS (SELECT 1 FROM consent_events c WHERE c.contact_id = a.contact_id AND c.kind = 'opt_out'
                AND c.created_at >= a.first_message_at AND c.created_at < a.window_end) AS opted_out
           FROM a)
         SELECT source_type AS "sourceType", source_id AS "sourceId", max(headline) AS headline, max(source_url) AS "sourceUrl",
                count(*)::int AS conversations, count(*) FILTER (WHERE new_contact)::int AS "newContacts",
                count(first_reply_at)::int AS replied, count(*) FILTER (WHERE resolved)::int AS resolved,
                count(*) FILTER (WHERE opted_out)::int AS "optedOut",
                round((percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM first_reply_at - first_message_at)) / 60)::numeric, 1)::float AS "medianFirstReplyMinutes"
         FROM s GROUP BY source_type, source_id ORDER BY conversations DESC, source_id NULLS LAST LIMIT 200`, params)).rows;
      // Totals use one rule (recheck W2): conversations whose customer first wrote in the period, and how many of
      // those were credited to an ad or post.
      const totals = (await tx.query<{ started: number; from_ads: number }>(
        `SELECT count(*)::int AS started, count(a.conversation_id)::int AS from_ads
         FROM conversations c LEFT JOIN conversation_attributions a ON a.conversation_id = c.id
         WHERE c.first_inbound_at >= $1 AND c.first_inbound_at < $2`, [range.start, range.end])).rows[0]!;
      return {
        period: { from: range.from, to: range.to, timeZone: tz },
        model: { rule: 'first_ad_tap_in_conversation', windowDays: ATTRIBUTION_WINDOW_DAYS },
        totals: { conversationsStarted: totals.started, fromAds: totals.from_ads, notFromAds: totals.started - totals.from_ads },
        ads,
      };
    });
  }
}
