'use client';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { fill, isLocale, t, type Locale } from '@/lib/i18n';

/**
 * AI assistant settings and the company's knowledge (Wave 2: W2.2, W2.3). The AI uses only these articles and the
 * company's settings as facts. Settings need ai.manage (owner, admin, two-step sign-in); articles need knowledge.manage.
 */
interface Access { permissions: string[] }
interface Settings { enabled: boolean; mode: 'suggest' | 'answer'; instructions: string; monthlyBudgetUsd: number; version: number; provider: string; simulated: boolean; usedThisMonthUsd: number }
interface Article { id: string; title: string; body: string; language: 'en' | 'ar'; published: boolean }

export default function AiPage() {
  const params = useParams<{ locale: string }>();
  const locale: Locale = isLocale(params.locale) ? params.locale : 'en';
  const d = t(locale).ai;
  const [access, setAccess] = useState<Access | null>(null);
  useEffect(() => { api<Access>('/v1/me/access').then(setAccess).catch(() => undefined); }, []);
  const can = (p: string) => !!access?.permissions.includes(p);
  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="text-2xl font-bold text-navy sm:text-3xl">{d.title}</h1>
      <p className="mt-1 text-sm text-slate-700">{d.intro}</p>
      {access && !can('ai.manage') && !can('knowledge.manage') && <p className="mt-4 text-sm text-slate-700">{d.noAccess}</p>}
      {can('ai.manage') && <SettingsForm locale={locale} />}
      {can('knowledge.manage') && <Knowledge locale={locale} />}
    </div>
  );
}

function SettingsForm({ locale }: { locale: Locale }) {
  const d = t(locale).ai;
  const [s, setS] = useState<Settings | null>(null);
  const [needsMfa, setNeedsMfa] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const load = useCallback(() => api<Settings>('/v1/ai/settings').then(setS).catch((e) => {
    if (e instanceof ApiError && (e.code === 'mfa_required' || e.code === 'mfa_enrollment_required')) setNeedsMfa(true);
  }), []);
  useEffect(() => { void load(); }, [load]);
  if (needsMfa) return <p role="status" className="mt-4 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">{d.needsMfa}</p>;
  if (!s) return null;
  return (
    <form className="mt-5 grid gap-3 rounded-xl border border-slate-200 bg-white p-4" aria-labelledby="ai-settings" onSubmit={async (e) => {
      e.preventDefault(); setNotice(null);
      try {
        await api('/v1/ai/settings', { method: 'PUT', body: { enabled: s.enabled, mode: s.mode, instructions: s.instructions, monthlyBudgetUsd: s.monthlyBudgetUsd, expectedVersion: s.version } });
        setNotice({ ok: true, text: t(locale).common.saved }); await load();
      } catch { setNotice({ ok: false, text: t(locale).common.error }); await load(); }
    }}>
      <h2 id="ai-settings" className="text-lg font-semibold text-navy">{d.settings}</h2>
      {s.simulated && <p className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-800">{d.simulatedNote}</p>}
      <label className="flex items-center gap-2 text-sm font-medium text-slate-900">
        <input type="checkbox" checked={s.enabled} onChange={(e) => setS({ ...s, enabled: e.target.checked })} />{d.enabled}
      </label>
      <fieldset className="grid gap-1 text-sm">
        <legend className="font-medium text-slate-900">{d.mode}</legend>
        <label className="flex items-start gap-2"><input type="radio" name="mode" checked={s.mode === 'suggest'} onChange={() => setS({ ...s, mode: 'suggest' })} /><span>{d.modeSuggest}</span></label>
        <label className="flex items-start gap-2"><input type="radio" name="mode" checked={s.mode === 'answer'} onChange={() => setS({ ...s, mode: 'answer' })} /><span>{d.modeAnswer}</span></label>
      </fieldset>
      <div>
        <label htmlFor="ai-ins" className="block text-sm font-medium text-slate-900">{d.instructions}</label>
        <textarea id="ai-ins" rows={3} dir="auto" maxLength={2000} value={s.instructions} onChange={(e) => setS({ ...s, instructions: e.target.value })} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-base" />
        <p className="mt-1 text-xs text-slate-700">{d.instructionsHelp}</p>
      </div>
      <div>
        <label htmlFor="ai-budget" className="block text-sm font-medium text-slate-900">{d.budget}</label>
        <input id="ai-budget" type="number" min={0} max={10000} step={1} value={s.monthlyBudgetUsd} onChange={(e) => setS({ ...s, monthlyBudgetUsd: Math.max(0, Number(e.target.value) || 0) })} className="mt-1 w-32 rounded-lg border border-slate-300 px-3 py-2 text-base" />
        <p className="mt-1 text-xs text-slate-700">{fill(d.used, { used: s.usedThisMonthUsd.toFixed(2) })}</p>
      </div>
      <div><button type="submit" className="btn-primary">{t(locale).common.save}</button></div>
      {notice && <p role={notice.ok ? 'status' : 'alert'} className={`text-sm ${notice.ok ? 'text-green-900' : 'text-red-800'}`}>{notice.text}</p>}
      <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-800">
        <h3 className="font-semibold">{d.rulesTitle}</h3>
        <ul className="mt-1 list-disc ps-5">{d.rules.map((r) => <li key={r}>{r}</li>)}</ul>
      </div>
    </form>
  );
}

function Knowledge({ locale }: { locale: Locale }) {
  const d = t(locale).ai;
  const [items, setItems] = useState<Article[]>([]);
  const [edit, setEdit] = useState<Partial<Article> & { id?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => api<Article[]>('/v1/knowledge').then(setItems).catch(() => undefined), []);
  useEffect(() => { void load(); }, [load]);
  return (
    <section className="mt-5 rounded-xl border border-slate-200 bg-white p-4" aria-labelledby="ai-kb">
      <h2 id="ai-kb" className="text-lg font-semibold text-navy">{d.knowledge}</h2>
      <p className="text-sm text-slate-700">{d.knowledgeHelp}</p>
      {!edit && <div className="mt-2"><button type="button" className="btn-secondary" onClick={() => setEdit({ title: '', body: '', language: locale, published: true })}>{d.addArticle}</button></div>}
      {edit && (
        <form className="mt-3 grid gap-2" onSubmit={async (e) => {
          e.preventDefault(); setError(null);
          try {
            const body = { title: edit.title, body: edit.body, language: edit.language, published: edit.published };
            await api(edit.id ? `/v1/knowledge/${edit.id}` : '/v1/knowledge', { method: edit.id ? 'PUT' : 'POST', body });
            setEdit(null); await load();
          } catch (err) { setError(err instanceof ApiError && err.status === 400 ? d.articleInvalid : t(locale).common.error); }
        }}>
          <label htmlFor="kb-title" className="text-sm font-medium text-slate-900">{d.articleTitle}</label>
          <input id="kb-title" dir="auto" maxLength={200} value={edit.title ?? ''} onChange={(e) => setEdit({ ...edit, title: e.target.value })} className="rounded-lg border border-slate-300 px-3 py-2 text-base" />
          <label htmlFor="kb-body" className="text-sm font-medium text-slate-900">{d.articleBody}</label>
          <textarea id="kb-body" rows={5} dir="auto" maxLength={8000} value={edit.body ?? ''} onChange={(e) => setEdit({ ...edit, body: e.target.value })} className="rounded-lg border border-slate-300 px-3 py-2 text-base" />
          <div className="flex flex-wrap items-center gap-3">
            <label htmlFor="kb-lang" className="text-sm font-medium text-slate-900">{d.language}</label>
            <select id="kb-lang" value={edit.language} onChange={(e) => setEdit({ ...edit, language: e.target.value as 'en' | 'ar' })} className="rounded-lg border border-slate-300 bg-white px-2 py-2 text-base">
              <option value="en">{t(locale).languageNames.en}</option><option value="ar">{t(locale).languageNames.ar}</option>
            </select>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={!!edit.published} onChange={(e) => setEdit({ ...edit, published: e.target.checked })} />{d.published}</label>
          </div>
          <div className="flex gap-2"><button type="submit" className="btn-primary">{t(locale).common.save}</button><button type="button" className="btn-secondary" onClick={() => setEdit(null)}>{d.cancel}</button></div>
          {error && <p role="alert" className="text-sm text-red-800">{error}</p>}
        </form>
      )}
      {items.length === 0 ? <p className="mt-3 text-sm text-slate-700">{d.noArticles}</p> : (
        <ul className="mt-3 divide-y divide-slate-100">
          {items.map((a) => (
            <li key={a.id} className="flex flex-wrap items-start gap-2 py-2">
              <div className="min-w-0 flex-1">
                <p className="font-medium text-navy" dir="auto">{a.title}</p>
                <p className="text-xs text-slate-700">{t(locale).languageNames[a.language]}{a.published ? '' : ` · ${d.draft}`}</p>
                <p className="mt-1 line-clamp-2 text-sm text-slate-800" dir="auto">{a.body}</p>
              </div>
              <button type="button" className="btn-secondary" onClick={() => setEdit(a)}>{d.edit}</button>
              <button type="button" className="btn-secondary" onClick={async () => { await api(`/v1/knowledge/${a.id}`, { method: 'DELETE' }); await load(); }}>{d.delete}</button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
