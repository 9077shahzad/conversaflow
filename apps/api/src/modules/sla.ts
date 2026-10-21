import type { Tx } from '@conversaflow/database';

/**
 * Response-time targets (SLA timers). Pure time arithmetic here; the database writes are below.
 *
 * Business hours are stored per weekday as local "HH:MM" intervals, e.g. {"sun":[["08:00","17:00"]]}, in the
 * company's IANA time zone. Holidays are local dates. With no business hours set, minutes are calendar minutes.
 */
export type BusinessHours = Partial<Record<'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun', Array<[string, string]>>>;
const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

/** The UTC offset of `tz` at instant `at`, in minutes (positive east of UTC). */
function offsetMinutes(at: Date, tz: string): number {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(at).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  return Math.round((asUtc - Math.floor(at.getTime() / 1000) * 1000) / 60_000);
}

/** The instant at local date `ymd` and time `hhmm` in `tz` (handles DST by re-checking the offset). */
function localToUtc(ymd: string, hhmm: string, tz: string): Date {
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  const [hh, mm] = hhmm.split(':').map(Number) as [number, number];
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let t = guess - offsetMinutes(new Date(guess), tz) * 60_000;
  t = guess - offsetMinutes(new Date(t), tz) * 60_000;
  return new Date(t);
}

function localDate(at: Date, tz: string): { ymd: string; dow: number } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' })
    .formatToParts(at).map((p) => [p.type, p.value]));
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday!);
  return { ymd: `${parts.year}-${parts.month}-${parts.day}`, dow };
}

function nextYmd(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

/**
 * Adds `minutes` of working time to `start`. Returns null if the business hours contain no working time at all
 * (nothing could ever be due), and gives up after a year of days, which only happens with a misconfiguration.
 */
export function addBusinessMinutes(start: Date, minutes: number, hours: BusinessHours, tz: string, holidays: Set<string>): Date | null {
  const hasHours = DAY_KEYS.some((k) => (hours[k] ?? []).length > 0);
  if (!hasHours) return new Date(start.getTime() + minutes * 60_000);
  let remaining = minutes * 60_000;
  let { ymd, dow } = localDate(start, tz);
  for (let i = 0; i < 400; i++) {
    if (!holidays.has(ymd)) {
      const intervals = [...(hours[DAY_KEYS[dow]!] ?? [])].sort((a, b) => a[0].localeCompare(b[0]));
      for (const [open, close] of intervals) {
        const from = Math.max(localToUtc(ymd, open, tz).getTime(), start.getTime());
        const to = localToUtc(ymd, close, tz).getTime();
        if (to <= from) continue;
        if (to - from >= remaining) return new Date(from + remaining);
        remaining -= to - from;
      }
    }
    ymd = nextYmd(ymd);
    dow = (dow + 1) % 7;
  }
  return null;
}

type SlaSettings = { first: number | null; next: number | null; hours: BusinessHours; tz: string; holidays: Set<string> };

async function settings(tx: Tx): Promise<SlaSettings> {
  const s = (await tx.query<{ first: number | null; next: number | null; hours: BusinessHours | null; tz: string }>(
    `SELECT s.sla_first_response_minutes AS first, s.sla_next_response_minutes AS next, s.business_hours AS hours, t.timezone AS tz
     FROM tenants t LEFT JOIN tenant_settings s ON s.tenant_id = t.id WHERE t.id = app_tenant_id()`)).rows[0];
  const h = (await tx.query<{ day: string }>('SELECT day::text AS day FROM tenant_holidays')).rows;
  return { first: s?.first ?? null, next: s?.next ?? null, hours: s?.hours ?? {}, tz: s?.tz ?? 'UTC', holidays: new Set(h.map((r) => r.day)) };
}

/** A customer wrote: start a timer if none is running and a target is set. */
export async function startTimerOnInbound(tx: Tx, conversationId: string, at: Date) {
  const c = (await tx.query<{ sla_kind: string | null; first_response_at: Date | null }>(
    'SELECT sla_kind, first_response_at FROM conversations WHERE id = $1', [conversationId])).rows[0]!;
  if (c.sla_kind) return;
  const s = await settings(tx);
  const kind = c.first_response_at ? 'next_response' : 'first_response';
  const minutes = kind === 'first_response' ? s.first : (s.next ?? s.first);
  if (!minutes) return;
  let tz = s.tz;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); } catch { tz = 'UTC'; }
  const due = addBusinessMinutes(at, minutes, s.hours, tz, s.holidays);
  if (!due) return;
  await tx.query('UPDATE conversations SET sla_kind = $2, sla_started_at = $3, sla_due_at = $4 WHERE id = $1', [conversationId, kind, at, due]);
}

/** A reply from the team was accepted by the provider: stop the timer and record whether the target was met. */
export async function stopTimerOnReply(tx: Tx, tenantId: string, conversationId: string, membershipId: string | null, at: Date) {
  const c = (await tx.query<{ sla_kind: string | null; sla_due_at: Date | null; sla_started_at: Date | null }>(
    'SELECT sla_kind, sla_due_at, sla_started_at FROM conversations WHERE id = $1 FOR UPDATE', [conversationId])).rows[0];
  if (!c) return;
  await tx.query('UPDATE conversations SET first_response_at = coalesce(first_response_at, $2) WHERE id = $1', [conversationId, at]);
  if (!c.sla_kind || !c.sla_due_at) return;
  const met = at.getTime() <= c.sla_due_at.getTime();
  await tx.query('UPDATE conversations SET sla_kind = NULL, sla_started_at = NULL, sla_due_at = NULL WHERE id = $1', [conversationId]);
  await tx.query(
    `INSERT INTO conversation_events (tenant_id, conversation_id, kind, actor_membership_id, data) VALUES ($1, $2, $3, $4, $5)`,
    [tenantId, conversationId, met ? 'sla_met' : 'sla_missed', membershipId, JSON.stringify({
      target: c.sla_kind, startedAt: c.sla_started_at, dueAt: c.sla_due_at, answeredAt: at,
      minutesLate: met ? 0 : Math.ceil((at.getTime() - c.sla_due_at.getTime()) / 60_000),
    })]);
}
