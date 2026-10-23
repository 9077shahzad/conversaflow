'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { fill, isLocale, t, type Locale } from '@/lib/i18n';

/** Guided setup (W2.7): what is done, starter packs, and an automation from a plain description. */
type Checklist = { items: Record<string, boolean>; done: number; total: number };
type Pack = { key: string; tags: number; replies: number; articles: number; automation: { name: string; description: string; descriptionAr: string };
  may: { tags: boolean; replies: boolean; articles: boolean; automation: boolean } };
const LINKS: Record<string, string> = {
  hours: '/inbox-setup', channel: '/channel-health', team: '/settings/team', firstReply: '/inbox', savedReply: '/inbox-setup',
  knowledge: '/ai', automation: '/automations', notifications: '/notifications',
};

export default function SetupPage() {
  const params = useParams<{ locale: string }>();
  const locale: Locale = isLocale(params.locale) ? params.locale : 'en';
  const d = t(locale).setup;
  const [list, setList] = useState<Checklist | null>(null);
  const [packs, setPacks] = useState<Pack[]>([]);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [made, setMade] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { const [c, p] = await Promise.all([api<Checklist>('/v1/setup/checklist'), api<Pack[]>('/v1/setup/packs')]); setList(c); setPacks(p); }
    catch { setNotice({ ok: false, text: t(locale).common.error }); }
  }, [locale]);
  useEffect(() => { void load(); }, [load]);
  async function run(fn: () => Promise<unknown>, ok: string | (() => string)) {
    setBusy(true); setNotice(null);
    try { await fn(); await load(); setNotice({ ok: true, text: typeof ok === 'string' ? ok : ok() }); }
    catch (e) { setNotice({ ok: false, text: e instanceof ApiError ? (d.errors[e.code] ?? e.message) : t(locale).common.error }); }
    finally { setBusy(false); }
  }

  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="text-2xl font-bold text-navy sm:text-3xl">{d.title}</h1>
      <p className="mt-1 text-sm text-slate-700">{d.intro}</p>
      {notice && <p role={notice.ok ? 'status' : 'alert'} className={`mt-3 rounded-lg border px-3 py-2 text-sm ${notice.ok ? 'border-green-300 bg-green-50 text-green-900' : 'border-red-300 bg-red-50 text-red-800'}`}>{notice.text}</p>}
      {list && (
        <section aria-labelledby="s-check" className="mt-5 rounded-xl border border-slate-200 bg-white p-4">
          <h2 id="s-check" className="text-lg font-semibold text-navy">{fill(d.progress, { done: list.done, total: list.total })}</h2>
          <ul className="mt-2 grid gap-2">
            {Object.entries(list.items).map(([k, v]) => (
              <li key={k} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <span className="flex items-center gap-2">
                  <span aria-hidden="true" className={`inline-block h-4 w-4 rounded-full ${v ? 'bg-emerald-600' : 'border-2 border-slate-400'}`} />
                  <span className={v ? 'text-slate-600 line-through' : 'text-slate-900'}>{d.items[k] ?? k}</span>
                  <span className="sr-only">{v ? d.doneLabel : d.todoLabel}</span>
                </span>
                {!v && <Link href={`/${locale}/app${LINKS[k] ?? ''}`} className="text-sm font-semibold text-teal underline">{d.go}</Link>}
              </li>
            ))}
          </ul>
        </section>
      )}
      <section aria-labelledby="s-packs" className="mt-5 rounded-xl border border-slate-200 bg-white p-4">
        <h2 id="s-packs" className="text-lg font-semibold text-navy">{d.packs}</h2>
        <p className="mt-1 text-sm text-slate-700">{d.packsHelp}</p>
        <ul className="mt-2 grid gap-2 sm:grid-cols-3">
          {packs.map((p) => (
            <li key={p.key} className="rounded-lg border border-slate-200 p-3">
              <h3 className="font-semibold text-slate-900">{d.packNames[p.key] ?? p.key}</h3>
              <p className="mt-1 text-xs text-slate-700">{fill(d.packContents, { tags: p.tags, replies: p.replies, articles: p.articles })}</p>
              {(p.may.tags || p.may.replies || p.may.articles) && (
                <button type="button" className="btn-secondary mt-2" disabled={busy} onClick={() => { let skipped: string[] = [];
                  void run(async () => { skipped = (await api<{ skipped: string[] }>(`/v1/setup/packs/${p.key}/apply`, { method: 'POST' })).skipped; },
                    () => skipped.length ? `${d.packApplied} ${fill(d.skipped, { what: skipped.map((x) => d.partNames[x] ?? x).join('، ') })}` : d.packApplied); }}>{d.apply}</button>
              )}
              {p.may.automation && (
                <div className="mt-2 text-xs text-slate-700">
                  <p dir="auto">{fill(d.automationOffer, { name: p.automation.name })}</p>
                  <button type="button" className="btn-secondary mt-1" disabled={busy} onClick={() => void run(async () => {
                    const r = await api<{ id: string }>('/v1/setup/describe', { method: 'POST', body: { name: p.automation.name, description: locale === 'ar' ? p.automation.descriptionAr : p.automation.description } });
                    setMade(r.id);
                  }, d.drafted)}>{d.makeAutomation}</button>
                </div>
              )}
            </li>
          ))}
        </ul>
      </section>
      <section aria-labelledby="s-describe" className="mt-5 rounded-xl border border-slate-200 bg-white p-4">
        <h2 id="s-describe" className="text-lg font-semibold text-navy">{d.describe}</h2>
        <p className="mt-1 text-sm text-slate-700">{d.describeHelp}</p>
        <ul className="mt-1 list-disc ps-5 text-xs text-slate-700">{d.examples.map((x) => <li key={x} dir="auto">{x}</li>)}</ul>
        <form className="mt-3 grid gap-2" onSubmit={(e) => { e.preventDefault(); void run(async () => {
          const r = await api<{ id: string }>('/v1/setup/describe', { method: 'POST', body: { name: name.trim(), description: desc.trim() } });
          setMade(r.id); setName(''); setDesc('');
        }, d.drafted); }}>
          <label htmlFor="s-name" className="text-sm font-medium text-slate-900">{d.name}</label>
          <input id="s-name" value={name} maxLength={120} dir="auto" onChange={(e) => setName(e.target.value)} className="rounded-lg border border-slate-300 px-3 py-2 text-base" />
          <label htmlFor="s-desc" className="text-sm font-medium text-slate-900">{d.description}</label>
          <textarea id="s-desc" rows={3} value={desc} maxLength={2000} dir="auto" onChange={(e) => setDesc(e.target.value)} className="rounded-lg border border-slate-300 px-3 py-2 text-base" />
          <div><button type="submit" className="btn-primary" disabled={busy || name.trim().length < 2 || desc.trim().length < 5}>{d.makeDraft}</button></div>
        </form>
        {made && <Link href={`/${locale}/app/automations?id=${made}`} className="mt-2 inline-block text-sm font-semibold text-teal underline">{d.openDraft}</Link>}
      </section>
    </div>
  );
}
