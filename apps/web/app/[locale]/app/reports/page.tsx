'use client';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { fill, isLocale, t, type Locale } from '@/lib/i18n';

/**
 * Reports (Wave 1): Click-to-WhatsApp ads (W1.9). Counts only, never customer names or numbers. The attribution rule
 * and window are stated on the page, and the page says plainly that it shows association, not effect.
 */
interface AdRow {
  sourceType: string; sourceId: string | null; headline: string | null; sourceUrl: string | null; conversations: number;
  newContacts: number; replied: number; resolved: number; optedOut: number; medianFirstReplyMinutes: number | null;
}
interface AdReport {
  period: { from: string; to: string; timeZone: string };
  model: { rule: string; windowDays: number };
  totals: { conversationsStarted: number; fromAds: number; notFromAds: number };
  ads: AdRow[];
}
interface Access { permissions: string[] }

export default function Reports() {
  const params = useParams<{ locale: string }>();
  const locale: Locale = isLocale(params.locale) ? params.locale : 'en';
  const d = t(locale).reports;
  const [access, setAccess] = useState<Access | null>(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [r, setR] = useState<AdReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sandbox, setSandbox] = useState(false);
  const allowed = !!access?.permissions.includes('reports.read');

  const load = useCallback(async (f?: string, tt?: string) => {
    setError(null);
    const qs = new URLSearchParams();
    if (f) qs.set('from', f);
    if (tt) qs.set('to', tt);
    try {
      const x = await api<AdReport>(`/v1/reports/ads${qs.size ? `?${qs}` : ''}`);
      setR(x); setFrom(x.period.from); setTo(x.period.to);
    } catch (e) { setError(e instanceof ApiError && e.status === 400 ? d.badPeriod : t(locale).common.error); }
  }, [d.badPeriod, locale]);

  useEffect(() => { api<Access>('/v1/me/access').then(setAccess).catch(() => undefined); }, []);
  useEffect(() => { api<{ whatsapp: { sandbox: boolean } }>('/v1/me/environment').then((e) => setSandbox(e.whatsapp.sandbox)).catch(() => undefined); }, []);
  useEffect(() => { if (allowed) void load(); }, [allowed, load]);

  const n = (v: number) => new Intl.NumberFormat(locale === 'ar' ? 'ar-SA-u-nu-latn' : 'en-GB').format(v);
  const pct = (part: number, whole: number) => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : '—');

  return (
    <div className="mx-auto max-w-6xl">
      <h1 className="text-2xl font-bold text-navy sm:text-3xl">{d.title}</h1>
      <p className="mt-1 text-sm text-slate-700">{d.intro}</p>
      {access && !allowed && <p className="mt-4 text-sm text-slate-700">{d.noAccess}</p>}
      {allowed && (
        <section className="mt-5 rounded-xl border border-slate-200 bg-white p-4" aria-labelledby="ads-h">
          <h2 id="ads-h" className="text-lg font-semibold text-navy">{d.adsTitle}</h2>
          {sandbox && <p className="mt-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-800">{d.sandboxNote}</p>}
          <form className="mt-3 flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); void load(from, to); }}>
            <div>
              <label htmlFor="r-from" className="block text-sm font-medium text-slate-900">{d.from}</label>
              <input id="r-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="mt-1 rounded-lg border border-slate-300 px-3 py-2 text-base" />
            </div>
            <div>
              <label htmlFor="r-to" className="block text-sm font-medium text-slate-900">{d.to}</label>
              <input id="r-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} className="mt-1 rounded-lg border border-slate-300 px-3 py-2 text-base" />
            </div>
            <button type="submit" className="btn-secondary">{d.show}</button>
          </form>
          {error && <p role="alert" className="mt-3 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
          {r && (
            <>
              <p className="mt-3 text-sm text-slate-700">{fill(d.periodNote, { from: r.period.from, to: r.period.to, tz: r.period.timeZone })}</p>
              <dl className="mt-3 grid gap-3 sm:grid-cols-3">
                <Stat label={d.started} value={n(r.totals.conversationsStarted)} />
                <Stat label={d.fromAds} value={n(r.totals.fromAds)} />
                <Stat label={d.notFromAds} value={n(r.totals.notFromAds)} />
              </dl>
              {r.ads.length === 0 ? <p className="mt-4 text-sm text-slate-700">{d.none}</p> : (
                <div className="mt-4 overflow-x-auto rounded-xl border border-slate-200" tabIndex={0} role="region" aria-label={d.adsTitle}>
                  <table className="min-w-full text-sm">
                    <thead className="bg-slate-50 text-slate-900">
                      <tr>
                        <th scope="col" className="px-3 py-2 text-start font-semibold">{d.ad}</th>
                        <th scope="col" className="px-3 py-2 text-end font-semibold">{d.conversations}</th>
                        <th scope="col" className="px-3 py-2 text-end font-semibold">{d.newContacts}</th>
                        <th scope="col" className="px-3 py-2 text-end font-semibold">{d.replied}</th>
                        <th scope="col" className="px-3 py-2 text-end font-semibold">{d.medianReply}</th>
                        <th scope="col" className="px-3 py-2 text-end font-semibold">{d.resolved}</th>
                        <th scope="col" className="px-3 py-2 text-end font-semibold">{d.optedOut}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {r.ads.map((a) => (
                        <tr key={`${a.sourceType}:${a.sourceId}`} className="border-t border-slate-100">
                          <td className="px-3 py-2">
                            <span className="font-medium text-navy" dir="auto">{a.headline ?? d.untitled}</span>
                            <span className="block text-xs text-slate-700">
                              {d.sourceTypes[a.sourceType] ?? a.sourceType}{a.sourceId ? <> · <bdi dir="ltr">{a.sourceId}</bdi></> : null}
                            </span>
                          </td>
                          <td className="px-3 py-2 text-end tabular-nums">{n(a.conversations)}</td>
                          <td className="px-3 py-2 text-end tabular-nums">{n(a.newContacts)}</td>
                          <td className="px-3 py-2 text-end tabular-nums">{n(a.replied)} <span className="text-slate-700">({pct(a.replied, a.conversations)})</span></td>
                          <td className="px-3 py-2 text-end tabular-nums">{a.medianFirstReplyMinutes === null ? '—' : fill(d.minutes, { n: String(a.medianFirstReplyMinutes) })}</td>
                          <td className="px-3 py-2 text-end tabular-nums">{n(a.resolved)}</td>
                          <td className="px-3 py-2 text-end tabular-nums">{n(a.optedOut)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-800">
                <h3 className="font-semibold">{d.howTitle}</h3>
                <p className="mt-1">{fill(d.how, { days: String(r.model.windowDays) })}</p>
                <p className="mt-1">{d.association}</p>
              </div>
            </>
          )}
        </section>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-slate-200 px-3 py-2">
      <dt className="text-sm text-slate-700">{label}</dt>
      <dd className="text-2xl font-semibold tabular-nums text-navy">{value}</dd>
    </div>
  );
}
