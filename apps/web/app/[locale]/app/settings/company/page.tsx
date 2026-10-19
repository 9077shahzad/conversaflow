'use client';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { formatDate, isLocale, t, type Locale } from '@/lib/i18n';

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
interface Settings {
  businessHours: Record<string, [string, string][]>;
  languages: string[];
  slaFirstResponseMinutes: number | null;
  slaResolutionMinutes: number | null;
  holidays: { id: string; day: string; name: string }[];
}

export default function CompanySettings() {
  const params = useParams<{ locale: string }>();
  const locale: Locale = isLocale(params.locale) ? params.locale : 'en';
  const d = t(locale);
  const [s, setS] = useState<Settings | null>(null);
  const [status, setStatus] = useState<'idle' | 'saved' | 'error'>('idle');
  useEffect(() => { api<Settings>('/v1/settings').then(setS).catch(() => setStatus('error')); }, []);
  if (!s) return <p className="text-slate-600">{d.common.loading}</p>;

  const setDay = (day: string, i: 0 | 1, v: string) => {
    const cur = s.businessHours[day]?.[0] ?? ['09:00', '17:00'];
    const next: [string, string] = [...cur] as [string, string];
    next[i] = v;
    setS({ ...s, businessHours: { ...s.businessHours, [day]: [next] } });
  };
  const toggleDay = (day: string, open: boolean) =>
    setS({ ...s, businessHours: { ...s.businessHours, [day]: open ? [['09:00', '17:00']] : [] } });

  async function save() {
    try {
      await api('/v1/settings', { method: 'PATCH', body: {
        businessHours: s!.businessHours, languages: s!.languages,
        slaFirstResponseMinutes: s!.slaFirstResponseMinutes, slaResolutionMinutes: s!.slaResolutionMinutes,
      } });
      setStatus('saved');
    } catch {
      setStatus('error');
    }
  }

  const input = 'rounded-lg border border-slate-300 px-3 py-2 text-base text-navy focus:border-teal focus:outline-none focus:ring-2 focus:ring-teal/30';
  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-2xl font-bold text-navy sm:text-3xl">{d.company.title}</h1>
      <section className="mt-6 rounded-xl border border-slate-200 bg-white p-5" aria-labelledby="hours">
        <h2 id="hours" className="text-lg font-semibold text-navy">{d.company.hours}</h2>
        <div className="mt-4 divide-y divide-slate-100">
          {DAYS.map((day) => {
            const iv = s.businessHours[day]?.[0];
            return (
              <div key={day} className="flex flex-wrap items-center gap-3 py-3">
                <label className="flex w-36 items-center gap-2 text-base font-medium text-navy">
                  <input type="checkbox" checked={!!iv} onChange={(e) => toggleDay(day, e.target.checked)} className="h-5 w-5 accent-[#0E7490]" />
                  {d.days[day]}
                </label>
                {iv ? (
                  <div className="flex items-center gap-2" dir="ltr">
                    <input aria-label={`${d.days[day]} ${d.company.open}`} type="time" value={iv[0]} onChange={(e) => setDay(day, 0, e.target.value)} className={input} />
                    <span aria-hidden="true">–</span>
                    <input aria-label={`${d.days[day]} ${d.company.close}`} type="time" value={iv[1]} onChange={(e) => setDay(day, 1, e.target.value)} className={input} />
                  </div>
                ) : (
                  <span className="text-base text-slate-500">{d.company.closed}</span>
                )}
              </div>
            );
          })}
        </div>
      </section>
      <section className="mt-6 grid gap-6 rounded-xl border border-slate-200 bg-white p-5 sm:grid-cols-2">
        <fieldset>
          <legend className="text-lg font-semibold text-navy">{d.company.languages}</legend>
          {(['ar', 'en'] as const).map((l) => (
            <label key={l} className="mt-3 flex items-center gap-2 text-base text-navy">
              <input type="checkbox" className="h-5 w-5 accent-[#0E7490]" checked={s.languages.includes(l)}
                onChange={(e) => setS({ ...s, languages: e.target.checked ? [...new Set([...s.languages, l])] : s.languages.filter((x) => x !== l) })} />
              {d.languageNames[l]}
            </label>
          ))}
        </fieldset>
        <fieldset>
          <legend className="text-lg font-semibold text-navy">{d.company.sla}</legend>
          <label className="mt-3 block text-sm font-semibold text-navy" htmlFor="first">{d.company.first}</label>
          <input id="first" type="number" min={1} inputMode="numeric" className={`${input} mt-1 w-full`} value={s.slaFirstResponseMinutes ?? ''}
            onChange={(e) => setS({ ...s, slaFirstResponseMinutes: e.target.value ? Number(e.target.value) : null })} />
          <label className="mt-3 block text-sm font-semibold text-navy" htmlFor="resolve">{d.company.resolve}</label>
          <input id="resolve" type="number" min={1} inputMode="numeric" className={`${input} mt-1 w-full`} value={s.slaResolutionMinutes ?? ''}
            onChange={(e) => setS({ ...s, slaResolutionMinutes: e.target.value ? Number(e.target.value) : null })} />
        </fieldset>
      </section>
      <section className="mt-6 rounded-xl border border-slate-200 bg-white p-5" aria-labelledby="holidays">
        <h2 id="holidays" className="text-lg font-semibold text-navy">{d.company.holidays}</h2>
        {s.holidays.length === 0 ? <p className="mt-2 text-slate-600">{d.company.noHolidays}</p> : (
          <ul className="mt-3 space-y-2">
            {s.holidays.map((h) => (
              <li key={h.id} className="flex flex-wrap justify-between gap-2 text-base text-navy">
                <span>{h.name}</span><span className="text-slate-600">{formatDate(locale, h.day)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <div className="mt-6 flex items-center gap-4">
        <button onClick={save} className="rounded-lg bg-emerald-strong px-5 py-3 text-base font-semibold text-white hover:bg-[#065f46]">{d.common.save}</button>
        <p role="status" className="text-base text-slate-700">{status === 'saved' ? d.common.saved : status === 'error' ? d.common.error : ''}</p>
      </div>
    </div>
  );
}
