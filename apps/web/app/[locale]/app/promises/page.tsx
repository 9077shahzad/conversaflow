'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { when, type PromiseRow } from '@/components/Promises';
import { api } from '@/lib/api';
import { fill, isLocale, t, type Locale } from '@/lib/i18n';

/** The promises a member is responsible for, across conversations (W2.6). */
export default function PromisesPage() {
  const params = useParams<{ locale: string }>();
  const locale: Locale = isLocale(params.locale) ? params.locale : 'en';
  const d = t(locale).promises;
  const [status, setStatus] = useState<'open' | 'missed' | 'closed'>('open');
  const [scope, setScope] = useState<'mine' | 'all'>('mine');
  const [rows, setRows] = useState<PromiseRow[] | null>(null);
  const [seeAll, setSeeAll] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [auto, setAuto] = useState<boolean | null>(null);
  const [manage, setManage] = useState(false);

  useEffect(() => {
    api<{ permissions: string[] }>('/v1/me/access').then((a) => {
      setSeeAll(a.permissions.includes('inbox.read_all'));
      if (a.permissions.includes('inbox.assign')) { setManage(true); api<{ autoConfirm: boolean }>('/v1/promises/settings').then((s) => setAuto(s.autoConfirm)).catch(() => undefined); }
    }).catch(() => undefined);
  }, []);
  const load = useCallback(async () => {
    setRows(null); setError(null);
    try { setRows(await api<PromiseRow[]>(`/v1/promises?status=${status}&scope=${scope}`)); } catch { setError(t(locale).common.error); setRows([]); }
  }, [status, scope, locale]);
  useEffect(() => { void load(); }, [load]);

  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="text-2xl font-bold text-navy sm:text-3xl">{d.title}</h1>
      <p className="mt-1 text-sm text-slate-700">{d.intro}</p>
      <div className="mt-4 flex flex-wrap gap-2" role="group" aria-label={d.title}>
        {(['open', 'missed', 'closed'] as const).map((s) => (
          <button key={s} type="button" aria-pressed={status === s} onClick={() => setStatus(s)}
            className={`min-h-11 rounded-lg border px-3 text-sm font-semibold ${status === s ? 'border-teal bg-teal text-white' : 'border-slate-300 bg-white text-slate-800'}`}>{d.tabs[s]}</button>
        ))}
        {seeAll && (
          <label className="ms-auto flex items-center gap-2 text-sm text-slate-800">
            <input type="checkbox" checked={scope === 'all'} onChange={(e) => setScope(e.target.checked ? 'all' : 'mine')} />{d.everyone}
          </label>
        )}
      </div>
      {error && <p role="alert" className="mt-3 text-sm text-red-800">{error}</p>}
      {rows === null ? <p className="mt-4 text-sm text-slate-700">{t(locale).common.loading}</p> : rows.length === 0 ? <p className="mt-4 text-sm text-slate-700">{d.noneHere}</p> : (
        <ul className="mt-4 grid gap-2">
          {rows.map((p) => (
            <li key={p.id} className={`rounded-xl border bg-white p-3 ${p.status === 'missed' ? 'border-red-300' : 'border-slate-200'}`}>
              <p className="text-slate-900" dir="auto">{p.description}</p>
              <p className="mt-1 text-xs text-slate-700">{d.statuses[p.status]} · {fill(d.due, { when: when(locale, p.dueAt) })}</p>
              <Link href={`/${locale}/app/inbox?c=${p.conversationId}`} className="mt-1 inline-block text-sm font-semibold text-teal underline">{d.open}</Link>
            </li>
          ))}
        </ul>
      )}
      {manage && auto !== null && (
        <section aria-labelledby="pr-auto" className="mt-6 rounded-xl border border-slate-200 bg-white p-4">
          <h2 id="pr-auto" className="text-lg font-semibold text-navy">{d.rules}</h2>
          <label className="mt-2 flex items-start gap-2 text-sm text-slate-900">
            <input type="checkbox" checked={auto} onChange={async (e) => { const v = e.target.checked; try { await api('/v1/promises/settings', { method: 'PUT', body: { autoConfirm: v } }); setAuto(v); } catch { setError(t(locale).common.error); } }} />
            <span>{d.autoConfirm}</span>
          </label>
        </section>
      )}
    </div>
  );
}
