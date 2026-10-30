'use client';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Card, ColumnPairs, Kpi, Legend, setTableLabels, useFormat } from '@/components/dashboard/Charts';
import { api, ApiError } from '@/lib/api';
import { fill, isLocale, type Locale } from '@/lib/i18n';
import { insightsText } from '@/lib/i18n-insights';

/**
 * Platform owner dashboard (owner request of 30 Oct 2026). Financial figures stay in plain charts and tables.
 * Data from GET /v1/platform/dashboard (platform owners only, checked by the database through the session).
 */
type Money = { currency: string };
interface PDash {
  period: { from: string; to: string; timeZone: string };
  companies: { total: number; byStatus: Record<string, number>; subscriptions: Record<string, number>; newInPeriod: number; onPartnerRoute: number; withCreditAccount: number };
  subscriptionValue: Array<Money & { plan: string; companies: number; monthlyMinor: number }>;
  trialing: number;
  messaging: Array<Money & { revenueMinor: number; costMinor: number; marginMinor: number; messages: number }>;
  messagingByDay: Array<Money & { day: string; revenueMinor: number; costMinor: number }>;
  messagingByCompany: Array<Money & { tenantId: string; name: string; revenueMinor: number; costMinor: number; marginMinor: number; messages: number; balanceMinor: number }>;
  customerPayments: Array<Money & { toppedUpMinor: number; refundedMinor: number; reversedMinor: number }>;
  customerLiability: Array<Money & { unspentMinor: number }>;
  alerts: Array<{ kind: string; subject: string; raisedAt: string }>;
  unmatchedPayments: number;
  partner: { fundedMinor: number | null; invoicedMinor: number | null; monitor: null | { currency: string; balanceMinor: number | null; balanceObservedAt: string | null;
    daysCover: number | null; requiredBufferMinor: number | null; dailyCostMinor: number | null } };
}
interface Recon { month: string; rows: Array<{ tenantId: string; currency: string; charges: number; priceMinor: number; costMinor: number; marginMinor: number;
  partnerCostMinor: number | null; differenceMinor: number | null; status: string }> }

const iso = (d: Date) => d.toISOString().slice(0, 10);

export default function PlatformDashboard() {
  const params = useParams<{ locale: string }>();
  const locale: Locale = isLocale(params.locale) ? params.locale : 'en';
  const d = insightsText(locale);
  const f = useFormat(locale);
  setTableLabels(d.asTable, d.asChart);
  const [role, setRole] = useState<string | null | undefined>(undefined);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [data, setData] = useState<PDash | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [currency, setCurrency] = useState<string>('');
  const [company, setCompany] = useState<{ id: string; name: string } | null>(null);
  const [month, setMonth] = useState(iso(new Date()).slice(0, 7));
  const [recon, setRecon] = useState<Recon | null>(null);

  const load = useCallback(async (q: { from?: string; to?: string }) => {
    setError(null);
    const qs = new URLSearchParams(Object.entries(q).filter(([, v]) => !!v) as Array<[string, string]>);
    try {
      const x = await api<PDash>(`/v1/platform/dashboard?${qs}`);
      setData(x); setFrom(x.period.from); setTo(x.period.to);
      setCurrency((c) => c || x.messaging[0]?.currency || x.messagingByDay[0]?.currency || 'SAR');
    } catch (e) { setError(e instanceof ApiError && (e.status === 400 || e.status === 409) ? d.badPeriod : d.error); }
  }, [d.badPeriod, d.error]);
  useEffect(() => { api<{ role: string | null }>('/v1/platform/me').then((r) => setRole(r.role)).catch(() => setRole(null)); }, []);
  useEffect(() => { if (role === 'platform_owner') void load({}); }, [role, load]);
  useEffect(() => {
    if (!company) return;
    setRecon(null);
    api<Recon>(`/v1/platform/credits/reconciliation/${month}`).then(setRecon).catch(() => setRecon({ month, rows: [] }));
  }, [company, month]);

  const days = useMemo(() => {
    if (!data) return [];
    const out: string[] = [];
    for (let t = Date.parse(`${data.period.from}T00:00:00Z`); t <= Date.parse(`${data.period.to}T00:00:00Z`); t += 86_400_000) out.push(iso(new Date(t)));
    return out;
  }, [data]);
  const currencies = useMemo(() => [...new Set([...(data?.messagingByDay ?? []).map((x) => x.currency), ...(data?.messaging ?? []).map((x) => x.currency)])], [data]);

  if (role === undefined) return <Shell d={d}><p className="mt-4 text-sm text-slate-700" role="status">{d.loading}</p></Shell>;
  if (role !== 'platform_owner') return <Shell d={d}><p className="mt-4 text-sm text-slate-700">{d.pNoAccess}</p></Shell>;
  const mon = data?.partner.monitor;
  const byDay = new Map((data?.messagingByDay ?? []).filter((x) => x.currency === currency).map((x) => [x.day, x]));
  return (
    <Shell d={d}>
      <p className="mt-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm font-medium text-slate-900" role="note">{d.pTestMode}</p>
      <form className="mt-4 flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white p-3" onSubmit={(e) => { e.preventDefault(); void load({ from, to }); }}>
        <div>
          <label htmlFor="p-from" className="block text-sm font-medium text-slate-900">{d.from}</label>
          <input id="p-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="mt-1 rounded-lg border border-slate-300 px-3 py-2 text-base" />
        </div>
        <div>
          <label htmlFor="p-to" className="block text-sm font-medium text-slate-900">{d.to}</label>
          <input id="p-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} className="mt-1 rounded-lg border border-slate-300 px-3 py-2 text-base" />
        </div>
        <button type="submit" className="btn-secondary">{d.apply}</button>
      </form>
      {error && <p role="alert" className="mt-3 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
      {!data && !error && <p className="mt-4 text-sm text-slate-700" role="status">{d.loading}</p>}
      {data && (
        <>
          <p className="mt-3 text-sm text-slate-700">{fill(d.periodNoCompare, { from: data.period.from, to: data.period.to, tz: data.period.timeZone })}</p>
          <Card title={d.pCompanies} className="mt-4">
            <dl className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-6">
              <Kpi label={d.pCompanies} value={f.n(data.companies.total)} />
              <Kpi label={d.pActive} value={f.n(data.companies.subscriptions.active ?? 0)} />
              <Kpi label={d.pTrialing} value={f.n(data.trialing)} />
              <Kpi label={d.pNew} value={f.n(data.companies.newInPeriod)} />
              <Kpi label={d.pPartner} value={f.n(data.companies.onPartnerRoute)} />
              <Kpi label={d.pCredit} value={f.n(data.companies.withCreditAccount)} />
            </dl>
          </Card>

          <div className="mt-5 grid gap-5 xl:grid-cols-2">
            <Card title={d.pSubValue} hint={d.pSubNote}>
              <MoneyTable headers={[d.pCurrency, d.pPlan, d.pCompanies, d.pSubValue]} rows={data.subscriptionValue.map((s) => [s.currency, s.plan, f.n(s.companies), f.money(s.monthlyMinor, s.currency)])} />
            </Card>
            <Card title={d.pMessaging}>
              {data.messaging.length === 0 ? <p className="mt-3 text-sm text-slate-700">{d.pMessagingNone}</p>
                : <MoneyTable headers={[d.pCurrency, d.pRevenue, d.pCost, d.pMargin, d.pMessages]}
                  rows={data.messaging.map((m) => [m.currency, f.money(m.revenueMinor, m.currency), f.money(m.costMinor, m.currency), f.money(m.marginMinor, m.currency), f.n(m.messages)])} />}
            </Card>
          </div>

          <Card title={d.pByDay} className="mt-5">
            {currencies.length > 1 && (
              <label className="mt-2 inline-flex items-center gap-2 text-sm">{d.pCurrency}
                <select value={currency} onChange={(e) => setCurrency(e.target.value)} className="rounded-lg border border-slate-300 px-2 py-1.5">
                  {currencies.map((c) => <option key={c}>{c}</option>)}
                </select>
              </label>
            )}
            <div className="mt-2"><Legend items={[{ label: d.pRevenue, tone: 'teal' }, { label: d.pCost, tone: 'warn' }]} /></div>
            <ColumnPairs label={d.pByDay} tableHeader={d.day} labels={days.map((x) => f.day(x))} format={(v) => f.money(v ?? 0, currency || 'SAR')}
              a={{ key: 'rev', label: d.pRevenue, tone: 'teal', values: days.map((x) => byDay.get(x)?.revenueMinor ?? 0) }}
              b={{ key: 'cost', label: d.pCost, tone: 'warn', values: days.map((x) => byDay.get(x)?.costMinor ?? 0) }} />
          </Card>

          <div className="mt-5 grid gap-5 xl:grid-cols-2">
            <Card title={d.pPayments} hint={d.pPaymentsNote}>
              <MoneyTable headers={[d.pCurrency, d.pTopped, d.pRefunded, d.pReversed]}
                rows={data.customerPayments.map((p) => [p.currency, f.money(p.toppedUpMinor, p.currency), f.money(p.refundedMinor, p.currency), f.money(p.reversedMinor, p.currency)])} />
              <h3 className="mt-4 text-sm font-semibold text-navy">{d.pLiability}</h3>
              <MoneyTable headers={[d.pCurrency, d.pLiability]} rows={data.customerLiability.map((l) => [l.currency, f.money(l.unspentMinor, l.currency)])} />
            </Card>
            <Card title={d.pPartnerTitle}>
              {!mon || mon.balanceMinor === null ? <p className="mt-3 text-sm text-slate-700">{d.pNoBalance}</p> : (
                <dl className="mt-3 grid grid-cols-2 gap-3">
                  <Kpi label={d.pPartnerBalance} value={f.money(mon.balanceMinor, mon.currency)} note={mon.balanceObservedAt ? `${d.pObserved}: ${new Date(mon.balanceObservedAt).toISOString().slice(0, 16).replace('T', ' ')} UTC` : undefined} />
                  <Kpi label={d.pDaysCover} value={mon.daysCover === null ? '—' : f.n(mon.daysCover)} />
                  <Kpi label={d.pRequired} value={mon.requiredBufferMinor === null ? '—' : f.money(mon.requiredBufferMinor, mon.currency)}
                    tone={mon.requiredBufferMinor !== null && mon.balanceMinor < mon.requiredBufferMinor ? 'bad' : 'good'} />
                  <Kpi label={d.pFunded} value={data.partner.fundedMinor === null ? '—' : f.money(data.partner.fundedMinor, mon.currency)} />
                </dl>
              )}
              <h3 className="mt-4 text-sm font-semibold text-navy">{d.pAlerts}</h3>
              {data.alerts.length === 0 ? <p className="mt-1 text-sm text-slate-700">{d.pNoAlerts}</p> : (
                <ul className="mt-2 space-y-1.5">
                  {data.alerts.map((a) => (
                    <li key={`${a.kind}${a.subject}`} className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-slate-900">
                      <span className="font-medium">{d.alertKinds[a.kind] ?? a.kind}</span>
                      <span className="block text-xs text-slate-700">{a.subject} · {new Date(a.raisedAt).toISOString().slice(0, 16).replace('T', ' ')} UTC</span>
                    </li>
                  ))}
                </ul>
              )}
              {data.unmatchedPayments > 0 && <p className="mt-2 text-sm font-medium text-danger">{fill(d.pUnmatched, { n: f.n(data.unmatchedPayments) })}</p>}
            </Card>
          </div>

          <Card title={d.pCompaniesTable} hint={d.pSelectCompany} className="mt-5">
            {data.messagingByCompany.length === 0 ? <p className="mt-3 text-sm text-slate-700">{d.pMessagingNone}</p> : (
              <div className="mt-3 overflow-x-auto rounded-lg border border-slate-200" tabIndex={0} role="region" aria-label={d.pCompaniesTable}>
                <table className="min-w-full text-sm">
                  <thead className="bg-slate-50"><tr>
                    {[d.pCompany, d.pRevenue, d.pCost, d.pMargin, d.pMessages, d.pBalanceNow].map((h, i) => (
                      <th key={h} scope="col" className={`whitespace-nowrap px-3 py-2 font-semibold ${i === 0 ? 'text-start' : 'text-end'}`}>{h}</th>
                    ))}
                  </tr></thead>
                  <tbody>{data.messagingByCompany.map((c) => (
                    <tr key={c.tenantId} className={`border-t border-slate-100 ${company?.id === c.tenantId ? 'bg-teal-soft' : ''}`}>
                      <th scope="row" className="px-3 py-1.5 text-start font-normal">
                        <button type="button" className="font-medium text-teal hover:underline" dir="auto" aria-pressed={company?.id === c.tenantId}
                          onClick={() => setCompany({ id: c.tenantId, name: c.name })}>{c.name}</button>
                      </th>
                      <td className="px-3 py-1.5 text-end tabular-nums">{f.money(c.revenueMinor, c.currency)}</td>
                      <td className="px-3 py-1.5 text-end tabular-nums">{f.money(c.costMinor, c.currency)}</td>
                      <td className="px-3 py-1.5 text-end tabular-nums">{f.money(c.marginMinor, c.currency)}</td>
                      <td className="px-3 py-1.5 text-end tabular-nums">{f.n(c.messages)}</td>
                      <td className="px-3 py-1.5 text-end tabular-nums">{f.money(c.balanceMinor, c.currency)}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            )}
            {company && (
              <section className="mt-4 rounded-lg border border-teal/40 p-3" aria-labelledby="recon-h">
                <div className="flex flex-wrap items-end justify-between gap-3">
                  <h3 id="recon-h" className="text-base font-semibold text-navy" dir="auto">{company.name} · {fill(d.pRecon, { month })}</h3>
                  <label className="text-sm">{d.pMonth}{' '}
                    <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="ms-1 rounded-lg border border-slate-300 px-2 py-1" />
                  </label>
                </div>
                {!recon ? <p className="mt-2 text-sm text-slate-700" role="status">{d.loading}</p> : (() => {
                  const rows = recon.rows.filter((r) => r.tenantId === company.id);
                  if (rows.length === 0) return <p className="mt-2 text-sm text-slate-700">{d.pNoRecon}</p>;
                  return <MoneyTable headers={[d.pReconCols.charges, d.pReconCols.price, d.pReconCols.cost, d.pReconCols.margin, d.pReconCols.partner, d.pReconCols.difference, d.pReconCols.status]}
                    rows={rows.map((r) => [f.n(r.charges), f.money(r.priceMinor, r.currency), f.money(r.costMinor, r.currency), f.money(r.marginMinor, r.currency),
                      r.partnerCostMinor === null ? '—' : f.money(r.partnerCostMinor, r.currency), r.differenceMinor === null ? '—' : f.money(r.differenceMinor, r.currency), d.pReconStatus[r.status] ?? r.status])} />;
                })()}
              </section>
            )}
          </Card>
        </>
      )}
    </Shell>
  );
}

function Shell({ d, children }: { d: ReturnType<typeof insightsText>; children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-7xl">
      <h1 className="text-2xl font-bold text-navy sm:text-3xl">{d.pTitle}</h1>
      <p className="mt-1 text-sm text-slate-700">{d.pIntro}</p>
      {children}
    </div>
  );
}

function MoneyTable({ headers, rows }: { headers: string[]; rows: string[][] }) {
  if (rows.length === 0) return <p className="mt-3 text-sm text-slate-700">—</p>;
  return (
    <div className="mt-3 overflow-x-auto rounded-lg border border-slate-200" tabIndex={0} role="region" aria-label={headers[headers.length - 1]}>
      <table className="min-w-full text-sm">
        <thead className="bg-slate-50"><tr>{headers.map((h, i) => <th key={h} scope="col" className={`whitespace-nowrap px-3 py-2 font-semibold ${i === 0 ? 'text-start' : 'text-end'}`}>{h}</th>)}</tr></thead>
        <tbody>{rows.map((r, k) => (
          <tr key={k} className="border-t border-slate-100">{r.map((c, i) => i === 0
            ? <th key={i} scope="row" className="px-3 py-1.5 text-start font-normal">{c}</th>
            : <td key={i} className="px-3 py-1.5 text-end tabular-nums">{c}</td>)}</tr>
        ))}</tbody>
      </table>
    </div>
  );
}
