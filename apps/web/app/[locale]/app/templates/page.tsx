'use client';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { fill, isLocale, t, type Locale } from '@/lib/i18n';

/** Message templates (Wave 1). The server checks every rule again; this screen only explains them. */
interface Template {
  id: string; name: string; language: string; category: string; status: string; quality: string; lastEvent: string | null;
  statusReason: string | null; bodyText: string; paramCount: number; statusChangedAt: string;
}
interface Access { permissions: string[] }

export default function Templates() {
  const params = useParams<{ locale: string }>();
  const locale: Locale = isLocale(params.locale) ? params.locale : 'en';
  const d = t(locale).templates;
  const [rows, setRows] = useState<Template[] | null>(null);
  const [access, setAccess] = useState<Access | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ name: '', language: locale === 'ar' ? 'ar' : 'en', category: 'utility', bodyText: '', examples: '' });
  const canManage = !!access?.permissions.includes('templates.manage');

  const load = useCallback(() => api<Template[]>('/v1/templates').then(setRows).catch(() => setRows([])), []);
  useEffect(() => { void load(); api<Access>('/v1/me/access').then(setAccess).catch(() => undefined); }, [load]);

  // Known refusals in the screen's language; the server's own wording (English) only on the English screen.
  const explain = (e: unknown) => (e instanceof ApiError
    ? t(locale).inbox.errors[e.code] ?? (locale === 'en' && e.message ? e.message : t(locale).inbox.errorGeneric)
    : t(locale).inbox.errorGeneric);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setNotice(null);
    try {
      await api('/v1/templates', { method: 'POST', body: {
        name: form.name.trim(), language: form.language, category: form.category, bodyText: form.bodyText,
        examples: form.examples.split('\n').map((x) => x.trim()).filter(Boolean),
      } });
      setNotice({ ok: true, text: d.created });
      setForm((f) => ({ ...f, name: '', bodyText: '', examples: '' }));
      await load();
    } catch (err) { setNotice({ ok: false, text: explain(err) }); } finally { setBusy(false); }
  }
  async function sync() {
    setBusy(true); setNotice(null);
    try {
      const r = await api<{ updated: number; unchanged: number }>('/v1/templates/sync', { method: 'POST' });
      setNotice({ ok: true, text: fill(d.synced, { updated: String(r.updated), unchanged: String(r.unchanged) }) });
      await load();
    } catch (err) { setNotice({ ok: false, text: explain(err) }); } finally { setBusy(false); }
  }

  const tone = (s: string) => (s === 'approved' ? 'bg-teal-soft text-teal' : s === 'pending' || s === 'in_appeal' ? 'bg-amber-100 text-amber-900' : 'bg-red-100 text-red-800');

  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="text-2xl font-bold text-navy sm:text-3xl">{d.title}</h1>
      <p className="mt-1 text-sm text-slate-700">{d.intro}</p>
      {notice && <p role="status" className={`mt-3 rounded-lg px-3 py-2 text-sm ${notice.ok ? 'bg-teal-soft text-slate-900' : 'bg-red-50 text-red-800'}`}>{notice.text}</p>}
      {canManage && (
        <div className="mt-3"><button type="button" className="btn-secondary" disabled={busy} onClick={sync}>{d.sync}</button></div>
      )}

      {!rows ? <p className="mt-4 text-slate-600">{t(locale).common.loading}</p>
        : rows.length === 0 ? <p className="mt-4 text-slate-600">{d.empty}</p> : (
          <ul className="mt-4 space-y-3" aria-label={d.title}>
            {rows.map((x) => (
              <li key={x.id} className="rounded-xl border border-slate-200 bg-white p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="break-all font-semibold text-navy" dir="ltr">{x.name}</span>
                  <span className="text-sm text-slate-700">{t(locale).languageNames[x.language.slice(0, 2)] ?? x.language}</span>
                  <span className="text-sm text-slate-700">· {t(locale).inbox.categories[x.category] ?? x.category}</span>
                  <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${tone(x.status)}`}>{d.statuses[x.status] ?? x.status}</span>
                  <span className="text-xs text-slate-700">{d.quality}: {d.qualities[x.quality] ?? x.quality}</span>
                </div>
                <p className="mt-2 whitespace-pre-wrap break-words text-sm text-slate-900" dir="auto">{x.bodyText}</p>
                {(x.lastEvent || x.statusReason) && (
                  <p className="mt-1 text-xs text-slate-700">{d.lastEvent}: <span dir="ltr">{x.lastEvent}</span>{x.statusReason ? <> · <span dir="auto">{x.statusReason}</span></> : null}</p>
                )}
              </li>
            ))}
          </ul>
        )}

      {canManage && (
        <form onSubmit={create} className="mt-6 space-y-3 rounded-xl border border-slate-200 bg-white p-4">
          <h2 className="text-lg font-semibold text-navy">{d.createTitle}</h2>
          <div>
            <label htmlFor="tpl-name" className="block text-sm font-medium text-slate-900">{d.name}</label>
            <input id="tpl-name" required pattern="[a-z0-9_]+" maxLength={100} value={form.name} dir="ltr"
              onChange={(e) => setForm({ ...form, name: e.target.value })} aria-describedby="tpl-name-help"
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-base" />
            <p id="tpl-name-help" className="mt-1 text-xs text-slate-700">{d.nameHelp}</p>
          </div>
          <div className="flex flex-wrap gap-3">
            <div>
              <label htmlFor="tpl-lang" className="block text-sm font-medium text-slate-900">{d.language}</label>
              <select id="tpl-lang" value={form.language} onChange={(e) => setForm({ ...form, language: e.target.value })}
                className="mt-1 rounded-lg border border-slate-300 bg-white px-2 py-2 text-base">
                <option value="ar">{t(locale).languageNames.ar}</option>
                <option value="en">{t(locale).languageNames.en}</option>
              </select>
            </div>
            <div>
              <label htmlFor="tpl-cat" className="block text-sm font-medium text-slate-900">{d.category}</label>
              <select id="tpl-cat" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}
                className="mt-1 rounded-lg border border-slate-300 bg-white px-2 py-2 text-base">
                {['utility', 'marketing', 'authentication'].map((c) => <option key={c} value={c}>{t(locale).inbox.categories[c]}</option>)}
              </select>
            </div>
          </div>
          <div>
            <label htmlFor="tpl-body" className="block text-sm font-medium text-slate-900">{d.body}</label>
            <textarea id="tpl-body" required rows={4} maxLength={1024} value={form.bodyText} dir="auto" aria-describedby="tpl-body-help"
              onChange={(e) => setForm({ ...form, bodyText: e.target.value })}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-base" />
            <p id="tpl-body-help" className="mt-1 text-xs text-slate-700">{d.bodyHelp}</p>
          </div>
          <div>
            <label htmlFor="tpl-examples" className="block text-sm font-medium text-slate-900">{d.examples}</label>
            <textarea id="tpl-examples" rows={2} value={form.examples} dir="auto" onChange={(e) => setForm({ ...form, examples: e.target.value })}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-base" />
          </div>
          <button type="submit" className="btn-primary" disabled={busy}>{d.submit}</button>
        </form>
      )}
    </div>
  );
}
