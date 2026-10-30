'use client';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, type ActivityRow, type Channel } from '@/components/dashboard/Activity';
import { BarList, Card, Kpi, Legend, LineChart, setTableLabels, useFormat } from '@/components/dashboard/Charts';
import { Records, type Drill } from '@/components/dashboard/Records';
import { api, ApiError } from '@/lib/api';
import { fill, isLocale, type Locale } from '@/lib/i18n';
import { insightsText } from '@/lib/i18n-insights';

/** Company dashboard (owner request of 30 Oct 2026). Data from GET /v1/reports/dashboard; drill-down from /records. */
interface Totals {
  inbound: number; outbound: number; templates: number; delivered: number; read: number; failed: number;
  deliveryRate: number | null; readRate: number | null; failureRate: number | null;
  conversationsStarted: number; conversationsReplied: number; medianFirstReplyMinutes: number | null; resolved: number;
}
interface Dash {
  period: { from: string; to: string; timeZone: string; days: number };
  previousDaily: Array<{ day: string; inbound: number; outbound: number }> | null;
  dataSource: 'none' | 'sandbox' | 'mixed' | 'live';
  totals: Totals; previous: (Totals & { period: { from: string; to: string } }) | null;
  daily: Array<{ day: string; inbound: number; outbound: number; delivered: number; read: number; failed: number; deliveryRate: number | null; medianFirstReplyMinutes: number | null }>;
  responseBuckets: Array<{ bucket: string; conversations: number }>;
  agents: Array<{ membershipId: string; name: string | null; label: string; replies: number; conversations: number; medianFirstReplyMinutes: number | null; resolved: number }>;
  channels: Channel[]; activity: ActivityRow[];
  credits: { state: 'no_permission' | 'direct' } | { state: 'prepaid'; currency: string; balanceMinor: number; reservedMinor: number; availableMinor: number;
    spentMinor: number; previousSpentMinor: number | null; toppedUpMinor: number; daily: Array<{ day: string; spentMinor: number; toppedUpMinor: number; messages: number }>;
    byCategory: Array<{ category: string; spentMinor: number; messages: number }> };
  unavailable: string[];
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const daysAgo = (to: string, n: number) => iso(new Date(Date.parse(`${to}T00:00:00Z`) - n * 86_400_000));

export default function Insights() {
  const params = useParams<{ locale: string }>();
  const locale: Locale = isLocale(params.locale) ? params.locale : 'en';
  const d = insightsText(locale);
  const f = useFormat(locale);
  setTableLabels(d.asTable, d.asChart);
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [preset, setPreset] = useState<'7' | '30' | '90' | 'custom'>('30');
  const [compare, setCompare] = useState(true);
  const [data, setData] = useState<Dash | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drill, setDrill] = useState<Drill | null>(null);

  const load = useCallback(async (q: { from?: string; to?: string; compare: boolean }) => {
    setError(null);
    const qs = new URLSearchParams();
    if (q.from) qs.set('from', q.from);
    if (q.to) qs.set('to', q.to);
    if (!q.compare) qs.set('compare', 'none');
    try {
      const x = await api<Dash>(`/v1/reports/dashboard?${qs}`);
      setData(x); setFrom(x.period.from); setTo(x.period.to);
    } catch (e) { setError(e instanceof ApiError && e.status === 400 ? d.badPeriod : d.error); }
  }, [d.badPeriod, d.error]);

  useEffect(() => {
    api<{ permissions: string[] }>('/v1/me/access').then((a) => setAllowed(a.permissions.includes('reports.read'))).catch(() => setAllowed(false));
  }, []);
  useEffect(() => { if (allowed) void load({ compare: true }); }, [allowed, load]);

  const choose = (p: '7' | '30' | '90') => {
    setPreset(p);
    const end = to || iso(new Date());
    void load({ from: daysAgo(end, Number(p) - 1), to: end, compare });
  };
  const period: Record<string, string> = data ? { from: data.period.from, to: data.period.to } : {};
  const t = data?.totals; const p = data?.previous;
  const delta = (cur: number | null | undefined, prev: number | null | undefined, fmt: (v: number) => string, lowerIsBetter = false) => {
    if (!p) return undefined;
    if (prev === null || prev === undefined) return { note: d.noPrevious, tone: 'neutral' as const };
    const tone = cur === null || cur === undefined || cur === prev ? 'neutral' as const : (cur > prev) !== lowerIsBetter ? 'good' as const : 'bad' as const;
    return { note: fill(d.vsPrevious, { v: fmt(prev) }), tone };
  };
  const mins = (v: number | null) => f.minutes(v, d.minutes, d.hours);
  const labels = useMemo(() => data?.daily.map((x) => f.day(x.day)) ?? [], [data, f]);

  if (allowed === false) return <Shell d={d}><p className="mt-4 text-sm text-slate-700">{d.noAccess}</p></Shell>;
  return (
    <Shell d={d}>
      <form className="mt-4 flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white p-3" onSubmit={(e) => { e.preventDefault(); setPreset('custom'); void load({ from, to, compare }); }}>
        <div role="group" aria-label={d.period} className="inline-flex rounded-lg border border-slate-300 p-0.5">
          {(['7', '30', '90'] as const).map((x) => (
            <button key={x} type="button" aria-pressed={preset === x} onClick={() => choose(x)}
              className={`rounded-md px-3 py-1.5 text-sm font-medium ${preset === x ? 'bg-teal text-white' : 'text-slate-800 hover:bg-slate-100'}`}>
              {x === '7' ? d.last7 : x === '30' ? d.last30 : d.last90}
            </button>
          ))}
        </div>
        <div>
          <label htmlFor="i-from" className="block text-sm font-medium text-slate-900">{d.from}</label>
          <input id="i-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="mt-1 rounded-lg border border-slate-300 px-3 py-2 text-base" />
        </div>
        <div>
          <label htmlFor="i-to" className="block text-sm font-medium text-slate-900">{d.to}</label>
          <input id="i-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} className="mt-1 rounded-lg border border-slate-300 px-3 py-2 text-base" />
        </div>
        <label className="flex items-center gap-2 pb-2 text-sm text-slate-900">
          <input type="checkbox" checked={compare} onChange={(e) => { setCompare(e.target.checked); void load({ from, to, compare: e.target.checked }); }} className="h-4 w-4" />
          {d.compare}
        </label>
        <button type="submit" className="btn-secondary">{d.apply}</button>
      </form>
      {error && <p role="alert" className="mt-3 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
      {!data && !error && <p className="mt-4 text-sm text-slate-700" role="status">{d.loading}</p>}
      {data && t && (
        <>
          <p className="mt-3 text-sm text-slate-700">
            {p ? fill(d.periodNote, { from: data.period.from, to: data.period.to, tz: data.period.timeZone, pfrom: p.period.from, pto: p.period.to })
              : fill(d.periodNoCompare, { from: data.period.from, to: data.period.to, tz: data.period.timeZone })}
          </p>
          {d.sources[data.dataSource] && (
            <p className="mt-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm font-medium text-slate-900" role="note">{d.sources[data.dataSource]}</p>
          )}
          <dl className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Kpi label={d.kpi.inbound} value={f.n(t.inbound)} {...delta(t.inbound, p?.inbound, f.n)} />
            <Kpi label={d.kpi.outbound} value={f.n(t.outbound)} {...delta(t.outbound, p?.outbound, f.n)} />
            <Kpi label={d.kpi.deliveryRate} value={f.pct(t.deliveryRate)} {...delta(t.deliveryRate, p?.deliveryRate, (v) => f.pct(v))} />
            <Kpi label={d.kpi.failureRate} value={f.pct(t.failureRate)} {...delta(t.failureRate, p?.failureRate, (v) => f.pct(v), true)} />
            <Kpi label={d.kpi.firstReply} value={mins(t.medianFirstReplyMinutes)} {...delta(t.medianFirstReplyMinutes, p?.medianFirstReplyMinutes, (v) => mins(v), true)} />
            <Kpi label={d.kpi.started} value={f.n(t.conversationsStarted)} {...delta(t.conversationsStarted, p?.conversationsStarted, f.n)} />
            <Kpi label={d.kpi.resolved} value={f.n(t.resolved)} {...delta(t.resolved, p?.resolved, f.n)} />
            <Kpi label={d.kpi.readRate} value={f.pct(t.readRate)} {...delta(t.readRate, p?.readRate, (v) => f.pct(v))} />
          </dl>

          <div className="mt-5 grid gap-5 xl:grid-cols-2">
            <Card title={d.volumeTitle} hint={d.volumeHint}>
              <Legend items={[{ label: d.inbound, tone: 'teal' }, { label: d.outbound, tone: 'emerald' }, ...(data.previousDaily ? [{ label: d.previousPeriod, tone: 'slate' as const, dashed: true }] : [])]} />
              <LineChart label={d.volumeTitle} tableHeader={d.day} labels={labels} format={(v) => (v === null ? '—' : f.n(Math.round(v)))}
                series={[
                  { key: 'in', label: d.inbound, tone: 'teal', values: data.daily.map((x) => x.inbound) },
                  { key: 'out', label: d.outbound, tone: 'emerald', values: data.daily.map((x) => x.outbound) },
                  ...(data.previousDaily ? [{ key: 'prev', label: d.previousPeriod, tone: 'slate' as const, dashed: true, values: data.previousDaily.map((x) => x.inbound + x.outbound) }] : []),
                ]}
                onSelect={(i) => setDrill({ what: labels[i]!, query: { day: data.daily[i]!.day } })} />
            </Card>
            <Card title={d.deliveryTitle} hint={d.deliveryHint}>
              <LineChart label={d.deliveryTitle} tableHeader={d.day} labels={labels} maxValue={100} format={(v) => f.pct(v)}
                series={[{ key: 'rate', label: d.kpi.deliveryRate, tone: 'teal', values: data.daily.map((x) => x.deliveryRate) }]}
                onSelect={(i) => setDrill({ what: `${labels[i]} · ${d.outbound}`, query: { day: data.daily[i]!.day, direction: 'out' } })} />
            </Card>
            <Card title={d.responseTitle} hint={d.responseHint}>
              <BarList label={d.responseTitle} format={f.n} items={data.responseBuckets.map((b) => ({ key: b.bucket, label: d.buckets[b.bucket] ?? b.bucket, value: b.conversations }))} />
            </Card>
            <Card title={d.agentsTitle} hint={d.agentsHint}>
              {data.agents.length === 0 ? <p className="mt-3 text-sm text-slate-700">{d.noAgents}</p> : (
                <div className="mt-3 overflow-x-auto rounded-lg border border-slate-200" tabIndex={0} role="region" aria-label={d.agentsTitle}>
                  <table className="min-w-full text-sm">
                    <thead className="bg-slate-50"><tr>
                      <th scope="col" className="px-3 py-2 text-start font-semibold">{d.agent}</th>
                      <th scope="col" className="px-3 py-2 text-end font-semibold">{d.replies}</th>
                      <th scope="col" className="px-3 py-2 text-end font-semibold">{d.conversations}</th>
                      <th scope="col" className="px-3 py-2 text-end font-semibold">{d.medianFirst}</th>
                      <th scope="col" className="px-3 py-2 text-end font-semibold">{d.resolvedBy}</th>
                    </tr></thead>
                    <tbody>{data.agents.map((a) => (
                      <tr key={a.membershipId} className="border-t border-slate-100">
                        <th scope="row" className="px-3 py-1.5 text-start font-normal">
                          <button type="button" className="font-medium text-teal hover:underline" dir="auto"
                            onClick={() => setDrill({ what: a.name ?? a.label, query: { ...period, agent: a.membershipId, direction: 'out' } })}>{a.name ?? a.label}</button>
                        </th>
                        <td className="px-3 py-1.5 text-end tabular-nums">{f.n(a.replies)}</td>
                        <td className="px-3 py-1.5 text-end tabular-nums">{f.n(a.conversations)}</td>
                        <td className="px-3 py-1.5 text-end tabular-nums">{mins(a.medianFirstReplyMinutes)}</td>
                        <td className="px-3 py-1.5 text-end tabular-nums">{f.n(a.resolved)}</td>
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
              )}
            </Card>
          </div>

          <Card title={d.creditsTitle} className="mt-5">
            {data.credits.state === 'no_permission' && <p className="mt-2 text-sm text-slate-700">{d.creditNoPermission}</p>}
            {data.credits.state === 'direct' && <p className="mt-2 text-sm text-slate-700">{d.creditDirect}</p>}
            {data.credits.state === 'prepaid' && (() => {
              const c = data.credits;
              const byDay = new Map(c.daily.map((x) => [x.day, x]));
              return (
                <>
                  <dl className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
                    <Kpi label={d.balance} value={f.money(c.availableMinor, c.currency)} />
                    <Kpi label={d.reserved} value={f.money(c.reservedMinor, c.currency)} />
                    <Kpi label={d.spent} value={f.money(c.spentMinor, c.currency)} {...delta(c.spentMinor, c.previousSpentMinor, (v) => f.money(v, c.currency), true)} />
                    <Kpi label={d.toppedUp} value={f.money(c.toppedUpMinor, c.currency)} />
                  </dl>
                  <h3 className="mt-4 text-sm font-semibold text-navy">{d.spentPerDay}</h3>
                  <LineChart label={d.spentPerDay} tableHeader={d.day} labels={labels} format={(v) => (v === null ? '—' : f.money(v, c.currency))}
                    series={[{ key: 'spent', label: d.spent, tone: 'accent', values: data.daily.map((x) => byDay.get(x.day)?.spentMinor ?? 0) }]} />
                  {c.byCategory.length > 0 && (
                    <>
                      <h3 className="mt-4 text-sm font-semibold text-navy">{d.byCategory}</h3>
                      <BarList label={d.byCategory} tone="accent" format={(v) => f.money(v, c.currency)}
                        items={c.byCategory.map((x) => ({ key: x.category, label: d.categories[x.category] ?? x.category, value: x.spentMinor, note: `${f.n(x.messages)} ${d.messages}` }))} />
                    </>
                  )}
                </>
              );
            })()}
          </Card>

          <Card title={d.activityTitle} hint={d.activityHint} className="mt-5">
            <Activity locale={locale} d={d} rows={data.activity} channels={data.channels}
              onSelect={(country, channel, metric) => setDrill({
                what: `${f.country(country, d.other)} · ${data.channels.find((c) => c.id === channel)?.label ?? ''}`,
                query: { ...period, country, channel, ...(metric === 'inbound' ? { direction: 'in' } : metric === 'outbound' ? { direction: 'out' } : metric === 'failed' ? { direction: 'out', status: 'failed' } : {}) },
              })} />
          </Card>

          {drill && <Records locale={locale} d={d} drill={drill} onClose={() => setDrill(null)} />}

          <section className="mt-5 rounded-xl border border-slate-200 bg-slate-50 p-4" aria-labelledby="na-h">
            <h2 id="na-h" className="text-base font-semibold text-navy">{d.unavailableTitle}</h2>
            <ul className="mt-2 list-disc space-y-1 ps-5 text-sm text-slate-800">
              {data.unavailable.map((u) => <li key={u}>{d.unavailable[u] ?? u}</li>)}
            </ul>
          </section>
        </>
      )}
    </Shell>
  );
}

function Shell({ d, children }: { d: ReturnType<typeof insightsText>; children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-7xl">
      <h1 className="text-2xl font-bold text-navy sm:text-3xl">{d.title}</h1>
      <p className="mt-1 text-sm text-slate-700">{d.intro}</p>
      {children}
    </div>
  );
}
