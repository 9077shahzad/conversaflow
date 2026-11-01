import { withContext, type Tx } from '@conversaflow/database';
import { z } from 'zod';
import type { Deps, TenantActor } from '../core/context';
import { Errors } from '../core/errors';
import { parse } from '../core/validate';
import { companyHours } from './sla';

/**
 * Company dashboard (owner request of 30 Oct 2026): message volumes, delivery, response times, agent performance,
 * message credit, and messaging activity by destination country and number. Everything is read in the company's own
 * context (row security), for a period of its own days, and compared with the period just before.
 *
 * Counts and times only; no message text and no customer numbers. The drill-down lists the underlying messages with
 * the same conversation visibility as the inbox: someone without "see all conversations" sees only the records of
 * conversations assigned to them or unassigned, and is told how many were left out.
 */
const MAX_RANGE_DAYS = 366;
/** A real calendar day (2026-02-30 is refused here rather than failing in the database). */
export const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => {
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}, 'Use a real calendar date (YYYY-MM-DD).');
const Query = z.object({ from: Day.optional(), to: Day.optional(), compare: z.enum(['previous', 'none']).optional() }).strict();
const RecordsQuery = z.object({
  from: Day.optional(), to: Day.optional(),
  day: Day.optional(),
  direction: z.enum(['in', 'out']).optional(),
  status: z.enum(['delivered', 'read', 'failed', 'sent', 'pending']).optional(),
  agent: z.string().uuid().optional(),
  // A country code, ZZ (numbers outside the calling-code list), or rest: every number not in the `exclude` countries
  // (the chart's "Other" group, which folds the smaller countries together; second review, finding 2).
  country: z.string().regex(/^[A-Z]{2}$|^rest$/).optional(),
  exclude: z.string().regex(/^[A-Z]{2}(,[A-Z]{2}){0,49}$/).optional(),
  channel: z.string().uuid().optional(),
  before: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
}).strict();

/** Calling codes to countries, longest prefix first. Numbers outside the list are "Other" (ZZ). */
const CALLING_CODES: Array<[string, string]> = ([
  ['966', 'SA'], ['971', 'AE'], ['965', 'KW'], ['974', 'QA'], ['973', 'BH'], ['968', 'OM'], ['962', 'JO'], ['961', 'LB'],
  ['964', 'IQ'], ['967', 'YE'], ['963', 'SY'], ['970', 'PS'], ['212', 'MA'], ['213', 'DZ'], ['216', 'TN'], ['218', 'LY'],
  ['249', 'SD'], ['371', 'LV'], ['880', 'BD'], ['977', 'NP'], ['20', 'EG'], ['92', 'PK'], ['91', 'IN'], ['94', 'LK'],
  ['63', 'PH'], ['62', 'ID'], ['90', 'TR'], ['98', 'IR'], ['44', 'GB'], ['49', 'DE'], ['33', 'FR'], ['39', 'IT'],
  ['34', 'ES'], ['31', 'NL'], ['1', 'US'],
] as Array<[string, string]>).sort((a, b) => b[0].length - a[0].length);
/** LIKE patterns for the numbers of one country; for Other (ZZ), the patterns of every listed country (negated). */
function countryPatterns(country: string, exclude: string[] = []): { patterns: string[]; negate: boolean } {
  if (country === 'rest') return { patterns: CALLING_CODES.filter(([, c]) => exclude.includes(c)).map(([p]) => `${p}%`), negate: true };
  if (country === 'ZZ') return { patterns: CALLING_CODES.map(([p]) => `${p}%`), negate: true };
  return { patterns: CALLING_CODES.filter(([, c]) => c === country).map(([p]) => `${p}%`), negate: false };
}
export function countryOf(number: string | null | undefined): string {
  if (!number) return 'ZZ';
  for (const [p, c] of CALLING_CODES) if (number.startsWith(p)) return c;
  return 'ZZ';
}

/** Statuses of outgoing messages handed to WhatsApp (the base of the delivery rate). */
const HANDED = `('sent', 'delivered', 'read', 'failed', 'uncertain')`;

/** A message that was later retried is counted once, through its retry (review, low findings). */
const NOT_RETRIED = `NOT EXISTS (SELECT 1 FROM messages r WHERE r.tenant_id = m.tenant_id AND r.retry_of = m.id)`;

type Range = { from: string; to: string; start: Date; end: Date; days: number };

async function rangeOf(tx: Tx, tz: string, from?: string, to?: string): Promise<Range> {
  const r = (await tx.query<Range>(
    `WITH d AS (SELECT coalesce($1::date, (now() AT TIME ZONE $3)::date - 29) AS f, coalesce($2::date, (now() AT TIME ZONE $3)::date) AS t)
     SELECT to_char(f, 'YYYY-MM-DD') AS "from", to_char(t, 'YYYY-MM-DD') AS "to",
            f::timestamp AT TIME ZONE $3 AS start, (t + 1)::timestamp AT TIME ZONE $3 AS "end", (t - f + 1) AS days FROM d`,
    [from ?? null, to ?? null, tz])).rows[0]!;
  if (r.days < 1 || r.days > MAX_RANGE_DAYS) throw Errors.badRequest(`Choose a period of 1 to ${MAX_RANGE_DAYS} days.`);
  return r;
}

// Fixed filter text for the records list; every value is a parameter ($1-$8).
const RECORDS_WHERE = `m.created_at >= $1 AND m.created_at < $2 AND ($3::text IS NULL OR m.direction = $3) AND ($4::text[] IS NULL OR m.status = ANY($4))
        AND ($5::uuid IS NULL OR m.sent_by_membership_id = $5) AND ($6::uuid IS NULL OR c.connection_id = $6)
        AND NOT EXISTS (SELECT 1 FROM messages r WHERE r.tenant_id = m.tenant_id AND r.retry_of = m.id)`;
const RECORDS_VISIBLE = `($7::boolean OR c.assigned_membership_id IS NULL OR c.assigned_membership_id = $8::uuid)`;
// Country is filtered in the database, before the page limit, from the customer's number ($9 patterns, $10 negate for Other).
const RECORDS_FROM = `messages m JOIN conversations c ON c.id = m.conversation_id
         LEFT JOIN LATERAL (SELECT value FROM contact_identifiers x WHERE x.tenant_id = c.tenant_id AND x.contact_id = c.contact_id AND x.kind = 'whatsapp' ORDER BY x.created_at LIMIT 1) ci ON true`;
const RECORDS_COUNTRY = `($9::text[] IS NULL OR CASE WHEN $10::boolean THEN ci.value IS NULL OR NOT (ci.value LIKE ANY($9)) ELSE coalesce(ci.value LIKE ANY($9), false) END)`;

export class DashboardService {
  constructor(private readonly deps: Deps) {}

  async company(actor: TenantActor, query: unknown) {
    const q = parse(Query, query ?? {});
    return withContext(this.deps.db, actor, async (tx) => {
      const { tz } = await companyHours(tx);
      const range = await rangeOf(tx, tz, q.from, q.to);
      const prev = q.compare === 'none' ? null : (await tx.query<{ start: Date; end: Date; from: string; to: string }>(
        `SELECT $1::timestamptz - ($2::timestamptz - $1::timestamptz) AS start, $1::timestamptz AS "end",
                to_char($3::date - $4::int, 'YYYY-MM-DD') AS "from", to_char($3::date - 1, 'YYYY-MM-DD') AS "to"`,
        [range.start, range.end, range.from, range.days])).rows[0]!;

      const totals = await this.totals(tx, range.start, range.end);
      const previous = prev ? { period: { from: prev.from, to: prev.to }, ...(await this.totals(tx, prev.start, prev.end)) } : null;

      const daily = (await tx.query<{ day: string; inbound: number; outbound: number; delivered: number; read: number; failed: number; handed: number }>(
        `SELECT to_char((m.created_at AT TIME ZONE $3)::date, 'YYYY-MM-DD') AS day,
                count(*) FILTER (WHERE m.direction = 'in')::int AS inbound,
                count(*) FILTER (WHERE m.direction = 'out')::int AS outbound,
                count(*) FILTER (WHERE m.direction = 'out' AND m.status = 'delivered')::int AS delivered,
                count(*) FILTER (WHERE m.direction = 'out' AND m.status = 'read')::int AS read,
                count(*) FILTER (WHERE m.direction = 'out' AND m.status = 'failed')::int AS failed,
                count(*) FILTER (WHERE m.direction = 'out' AND m.status IN ${HANDED})::int AS handed
         FROM messages m WHERE m.created_at >= $1 AND m.created_at < $2 AND ${NOT_RETRIED} GROUP BY 1 ORDER BY 1`,
        [range.start, range.end, tz])).rows;
      const replyDaily = (await tx.query<{ day: string; median: number | null }>(
        `SELECT to_char((c.first_inbound_at AT TIME ZONE $3)::date, 'YYYY-MM-DD') AS day,
                round((percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM fr.at - c.first_inbound_at)) / 60)::numeric, 1)::float AS median
         FROM conversations c LEFT JOIN LATERAL (${FIRST_REPLY}) fr ON true
         WHERE c.first_inbound_at >= $1 AND c.first_inbound_at < $2 AND fr.at IS NOT NULL GROUP BY 1`,
        [range.start, range.end, tz])).rows;
      const medianByDay = new Map(replyDaily.map((r) => [r.day, r.median]));
      // Every day of the period, including quiet ones, so charts and comparisons line up.
      const days = (await tx.query<{ day: string }>(
        `SELECT to_char(d, 'YYYY-MM-DD') AS day FROM generate_series($1::date, $2::date, interval '1 day') d`, [range.from, range.to])).rows;
      const byDay = new Map(daily.map((r) => [r.day, r]));
      const series = days.map(({ day }) => {
        const r = byDay.get(day);
        return {
          day, inbound: r?.inbound ?? 0, outbound: r?.outbound ?? 0, delivered: r?.delivered ?? 0, read: r?.read ?? 0, failed: r?.failed ?? 0,
          deliveryRate: r && r.handed > 0 ? Math.round(((r.delivered + r.read) / r.handed) * 1000) / 10 : null,
          medianFirstReplyMinutes: medianByDay.get(day) ?? null,
        };
      });

      const buckets = (await tx.query<{ bucket: string; n: number }>(
        `SELECT CASE WHEN fr.at IS NULL THEN 'none'
                     WHEN fr.at - c.first_inbound_at < interval '5 minutes' THEN 'lt5m'
                     WHEN fr.at - c.first_inbound_at < interval '15 minutes' THEN 'lt15m'
                     WHEN fr.at - c.first_inbound_at < interval '1 hour' THEN 'lt1h'
                     WHEN fr.at - c.first_inbound_at < interval '4 hours' THEN 'lt4h' ELSE 'gte4h' END AS bucket, count(*)::int AS n
         FROM conversations c LEFT JOIN LATERAL (${FIRST_REPLY}) fr ON true
         WHERE c.first_inbound_at >= $1 AND c.first_inbound_at < $2 GROUP BY 1`, [range.start, range.end])).rows;
      const responseBuckets = ['lt5m', 'lt15m', 'lt1h', 'lt4h', 'gte4h', 'none'].map((b) => ({ bucket: b, conversations: buckets.find((x) => x.bucket === b)?.n ?? 0 }));

      const showNames = actor.permissions.has('members.read');
      const agents = (await tx.query<{ membership_id: string; name: string | null; replies: number; conversations: number; median: number | null; resolved: number }>(
        `WITH s AS (
           SELECT m.sent_by_membership_id AS mid, count(*)::int AS replies, count(DISTINCT m.conversation_id)::int AS conversations
           FROM messages m WHERE m.direction = 'out' AND m.sent_by_membership_id IS NOT NULL AND m.campaign_id IS NULL
             AND m.created_at >= $1 AND m.created_at < $2 AND ${NOT_RETRIED} GROUP BY 1),
         f AS (
           SELECT fr.mid, round((percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM fr.at - c.first_inbound_at)) / 60)::numeric, 1)::float AS median
           FROM conversations c LEFT JOIN LATERAL (${FIRST_REPLY}) fr ON true
           WHERE c.first_inbound_at >= $1 AND c.first_inbound_at < $2 AND fr.mid IS NOT NULL GROUP BY 1),
         r AS (
           SELECT e.actor_membership_id AS mid, count(DISTINCT e.conversation_id)::int AS resolved FROM conversation_events e
           WHERE e.kind = 'status_changed' AND e.data->>'to' = 'resolved' AND e.actor_membership_id IS NOT NULL
             AND e.created_at >= $1 AND e.created_at < $2 GROUP BY 1)
         SELECT ms.id AS membership_id, CASE WHEN $3 THEN u.full_name END AS name,
                coalesce(s.replies, 0) AS replies, coalesce(s.conversations, 0) AS conversations, f.median, coalesce(r.resolved, 0) AS resolved
         FROM memberships ms JOIN users u ON u.id = ms.user_id
         LEFT JOIN s ON s.mid = ms.id LEFT JOIN f ON f.mid = ms.id LEFT JOIN r ON r.mid = ms.id
         WHERE s.mid IS NOT NULL OR r.mid IS NOT NULL
         ORDER BY coalesce(s.replies, 0) DESC, ms.id LIMIT 50`, [range.start, range.end, showNames])).rows;

      const channels = (await tx.query<{ id: string; label: string; provider: string; status: string }>(
        `SELECT id, label, provider, status FROM channel_connections ORDER BY created_at`)).rows;
      const act = (await tx.query<{ prefix: string | null; channel: string; inbound: number; outbound: number; failed: number }>(
        // Counted per conversation first, so the customer's number is looked up once per conversation (review finding 1).
        `WITH per AS (
           SELECT m.conversation_id, count(*) FILTER (WHERE m.direction = 'in') AS inbound, count(*) FILTER (WHERE m.direction = 'out') AS outbound,
                  count(*) FILTER (WHERE m.direction = 'out' AND m.status = 'failed') AS failed
           FROM messages m WHERE m.created_at >= $1 AND m.created_at < $2 AND ${NOT_RETRIED} GROUP BY 1)
         SELECT left(ci.value, 3) AS prefix, c.connection_id AS channel,
                sum(per.inbound)::int AS inbound, sum(per.outbound)::int AS outbound, sum(per.failed)::int AS failed
         FROM per JOIN conversations c ON c.id = per.conversation_id
         LEFT JOIN LATERAL (SELECT value FROM contact_identifiers x WHERE x.tenant_id = c.tenant_id AND x.contact_id = c.contact_id AND x.kind = 'whatsapp' ORDER BY x.created_at LIMIT 1) ci ON true
         GROUP BY 1, 2`, [range.start, range.end])).rows;
      const merged = new Map<string, { country: string; channel: string; inbound: number; outbound: number; failed: number }>();
      for (const a of act) {
        const key = `${countryOf(a.prefix)}|${a.channel}`;
        const m = merged.get(key) ?? { country: countryOf(a.prefix), channel: a.channel, inbound: 0, outbound: 0, failed: 0 };
        m.inbound += a.inbound; m.outbound += a.outbound; m.failed += a.failed;
        merged.set(key, m);
      }

      const credits = await this.credits(tx, actor, range, prev, tz);
      // Test or live is judged by the numbers the period's messages went through, not by what is connected today
      // (sample history stays labelled as sample once a real number is added).
      const used = new Set([...merged.values()].map((a) => a.channel));
      const basis = used.size > 0 ? channels.filter((c) => used.has(c.id)) : channels;
      const sandbox = basis.length > 0 && basis.every((c) => c.provider === 'sandbox');
      // The period before, day by day, for drawing it alongside (day 1 against day 1).
      const previousDaily = prev ? (await tx.query<{ day: string; inbound: number; outbound: number }>(
        `SELECT to_char(d, 'YYYY-MM-DD') AS day, coalesce(x.inbound, 0)::int AS inbound, coalesce(x.outbound, 0)::int AS outbound
         FROM generate_series($1::date, $2::date, interval '1 day') d
         LEFT JOIN (SELECT (m.created_at AT TIME ZONE $5)::date AS day, count(*) FILTER (WHERE m.direction = 'in') AS inbound,
                           count(*) FILTER (WHERE m.direction = 'out') AS outbound
                    FROM messages m WHERE m.created_at >= $3 AND m.created_at < $4 AND ${NOT_RETRIED} GROUP BY 1) x ON x.day = d::date
         ORDER BY d`, [prev.from, prev.to, prev.start, prev.end, tz])).rows : null;
      return {
        period: { from: range.from, to: range.to, timeZone: tz, days: range.days },
        previousDaily,
        // Messages through the sandbox are test traffic, not real customers: the page labels them as such.
        dataSource: basis.length === 0 ? 'none' : sandbox ? 'sandbox' : basis.some((c) => c.provider === 'sandbox') ? 'mixed' : 'live',
        totals, previous, daily: series, responseBuckets,
        agents: agents.map((a, i) => ({ membershipId: a.membership_id, name: a.name, label: a.name ?? `#${i + 1}`, replies: a.replies,
          conversations: a.conversations, medianFirstReplyMinutes: a.median, resolved: a.resolved })),
        channels: channels.map((c) => ({ id: c.id, label: c.label, provider: c.provider, active: c.status === 'active' })),
        activity: [...merged.values()].sort((a, b) => b.inbound + b.outbound - (a.inbound + a.outbound)),
        credits,
        // Said plainly on the page rather than shown as zero.
        unavailable: [
          ...(credits.state === 'direct' ? ['whatsapp_cost_direct'] : []),
          'customer_satisfaction',
          'revenue_from_conversations',
        ],
      };
    });
  }

  private async totals(tx: Tx, start: Date, end: Date) {
    const m = (await tx.query<{ inbound: number; outbound: number; templates: number; handed: number; delivered: number; read: number; failed: number }>(
      `SELECT count(*) FILTER (WHERE direction = 'in')::int AS inbound, count(*) FILTER (WHERE direction = 'out')::int AS outbound,
              count(*) FILTER (WHERE direction = 'out' AND kind = 'template')::int AS templates,
              count(*) FILTER (WHERE direction = 'out' AND status IN ${HANDED})::int AS handed,
              count(*) FILTER (WHERE direction = 'out' AND status = 'delivered')::int AS delivered,
              count(*) FILTER (WHERE direction = 'out' AND status = 'read')::int AS read,
              count(*) FILTER (WHERE direction = 'out' AND status = 'failed')::int AS failed
       FROM messages m WHERE m.created_at >= $1 AND m.created_at < $2 AND ${NOT_RETRIED}`, [start, end])).rows[0]!;
    const c = (await tx.query<{ started: number; replied: number; median: number | null; resolved: number }>(
      `SELECT count(*)::int AS started, count(fr.at)::int AS replied,
              round((percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM fr.at - c.first_inbound_at)) / 60)::numeric, 1)::float AS median,
              (SELECT count(DISTINCT e.conversation_id)::int FROM conversation_events e WHERE e.kind = 'status_changed' AND e.data->>'to' = 'resolved'
                 AND e.created_at >= $1 AND e.created_at < $2) AS resolved
       FROM conversations c LEFT JOIN LATERAL (${FIRST_REPLY}) fr ON true
       WHERE c.first_inbound_at >= $1 AND c.first_inbound_at < $2`, [start, end])).rows[0]!;
    const rate = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);
    return {
      inbound: m.inbound, outbound: m.outbound, templates: m.templates, delivered: m.delivered, read: m.read, failed: m.failed,
      deliveryRate: rate(m.delivered + m.read, m.handed), readRate: rate(m.read, m.handed), failureRate: rate(m.failed, m.handed),
      conversationsStarted: c.started, conversationsReplied: c.replied, medianFirstReplyMinutes: c.median, resolved: c.resolved,
    };
  }

  /** Message credit: only for people who may see billing, and only for companies on prepaid credit. */
  private async credits(tx: Tx, actor: TenantActor, range: Range, prev: { start: Date; end: Date } | null, tz: string) {
    if (!actor.permissions.has('billing.read')) return { state: 'no_permission' as const };
    const a = (await tx.query<{ currency: string; balance_minor: string; reserved_minor: string; status: string }>(
      `SELECT currency, balance_minor, reserved_minor, status FROM credit_accounts`)).rows[0];
    if (!a || a.status !== 'active') return { state: 'direct' as const };
    const daily = (await tx.query<{ day: string; spent: string; topped: string; messages: number }>(
      `SELECT to_char((created_at AT TIME ZONE $3)::date, 'YYYY-MM-DD') AS day,
              coalesce(-sum(amount_minor) FILTER (WHERE kind = 'charge'), 0) AS spent,
              coalesce(sum(amount_minor) FILTER (WHERE kind = 'topup'), 0) AS topped,
              count(*) FILTER (WHERE kind = 'charge')::int AS messages
       FROM credit_entries WHERE created_at >= $1 AND created_at < $2 GROUP BY 1 ORDER BY 1`, [range.start, range.end, tz])).rows;
    const byCat = (await tx.query<{ category: string; spent: string; messages: number }>(
      `SELECT coalesce(category, 'other') AS category, -sum(amount_minor) AS spent, count(*)::int AS messages
       FROM credit_entries WHERE kind = 'charge' AND created_at >= $1 AND created_at < $2 GROUP BY 1 ORDER BY 2 DESC`, [range.start, range.end])).rows;
    const spentPrev = prev ? Number((await tx.query<{ s: string }>(
      `SELECT coalesce(-sum(amount_minor), 0) AS s FROM credit_entries WHERE kind = 'charge' AND created_at >= $1 AND created_at < $2`, [prev.start, prev.end])).rows[0]!.s) : null;
    const spent = daily.reduce((s, d) => s + Number(d.spent), 0);
    return {
      state: 'prepaid' as const, currency: a.currency, balanceMinor: Number(a.balance_minor), reservedMinor: Number(a.reserved_minor),
      availableMinor: Number(a.balance_minor) - Number(a.reserved_minor), spentMinor: spent, previousSpentMinor: spentPrev,
      toppedUpMinor: daily.reduce((s, d) => s + Number(d.topped), 0),
      daily: daily.map((d) => ({ day: d.day, spentMinor: Number(d.spent), toppedUpMinor: Number(d.topped), messages: d.messages })),
      byCategory: byCat.map((c) => ({ category: c.category, spentMinor: Number(c.spent), messages: c.messages })),
    };
  }

  /**
   * The messages behind a chart point: metadata only (time, direction, status, kind, destination country, number,
   * sender), newest first, with the inbox's conversation visibility. Records outside it are counted, not shown.
   */
  async records(actor: TenantActor, query: unknown) {
    const q = parse(RecordsQuery, query ?? {});
    return withContext(this.deps.db, actor, async (tx) => {
      const { tz } = await companyHours(tx);
      const range = q.day ? await rangeOf(tx, tz, q.day, q.day) : await rangeOf(tx, tz, q.from, q.to);
      const statusSet = q.status === 'pending' ? ['queued', 'submitting', 'uncertain'] : q.status ? [q.status] : null;
      const seeAll = actor.permissions.has('inbox.read_all');
      const showNames = actor.permissions.has('members.read');
      const cp = q.country ? countryPatterns(q.country, q.exclude?.split(',')) : null;
      const params: unknown[] = [range.start, range.end, q.direction ?? null, statusSet, q.agent ?? null, q.channel ?? null, seeAll, actor.membershipId,
        cp?.patterns ?? null, cp?.negate ?? false];
      const limit = q.limit ?? 50;
      const rows = (await tx.query<{ id: string; conversation_id: string; created_at: Date; direction: string; status: string; kind: string;
        pricing_category: string | null; failure_kind: string | null; prefix: string | null; channel: string; channel_label: string; sender: string | null; sender_id: string | null }>(
        `SELECT m.id, m.conversation_id, m.created_at, m.direction, m.status, m.kind, m.pricing_category, m.failure_kind,
                left(ci.value, 3) AS prefix, c.connection_id AS channel, cc.label AS channel_label,
                CASE WHEN $11 THEN u.full_name END AS sender, m.sent_by_membership_id AS sender_id
         FROM ${RECORDS_FROM} JOIN channel_connections cc ON cc.id = c.connection_id
         LEFT JOIN memberships ms ON ms.id = m.sent_by_membership_id LEFT JOIN users u ON u.id = ms.user_id
         WHERE ${RECORDS_WHERE} AND ${RECORDS_VISIBLE} AND ${RECORDS_COUNTRY}
           AND ($12::uuid IS NULL OR (m.created_at, m.id) < (SELECT b.created_at, b.id FROM messages b WHERE b.id = $12))
         ORDER BY m.created_at DESC, m.id DESC LIMIT $13`, [...params, showNames, q.before ?? null, limit + 1])).rows;
      const page = rows.slice(0, limit);
      const hidden = seeAll ? 0 : Number((await tx.query<{ n: string }>(
        `SELECT count(*) AS n FROM ${RECORDS_FROM} WHERE ${RECORDS_WHERE} AND NOT ${RECORDS_VISIBLE} AND ${RECORDS_COUNTRY}`, params)).rows[0]!.n);
      return {
        period: { from: range.from, to: range.to, timeZone: tz },
        records: page.map((r) => ({
          id: r.id, conversationId: r.conversation_id, at: r.created_at, direction: r.direction, status: r.status, kind: r.kind,
          category: r.pricing_category, failure: r.failure_kind, country: countryOf(r.prefix), channelId: r.channel, channelLabel: r.channel_label,
          sender: r.sender_id ? (r.sender ?? 'member') : null,
        })),
        next: rows.length > limit ? page[page.length - 1]!.id : null,
        hiddenOutsideYourConversations: hidden,
      };
    });
  }
}

/**
 * The first reply to a conversation's first customer message, with the same rule as the Outcomes report: the first
 * message a team member sent after it, not a campaign, and not one that failed. Automations, the AI and away messages
 * do not count (review of the dashboards, finding 4). `mid` is the team member who sent it.
 */
const FIRST_REPLY = `SELECT m.created_at AS at, m.sent_by_membership_id AS mid FROM messages m
  WHERE m.conversation_id = c.id AND m.direction = 'out' AND m.campaign_id IS NULL AND m.sent_by_membership_id IS NOT NULL
    AND m.status <> 'failed' AND m.created_at >= c.first_inbound_at
  ORDER BY m.created_at LIMIT 1`;
