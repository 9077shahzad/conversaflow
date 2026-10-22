'use client';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { fill, isLocale, t, type Locale } from '@/lib/i18n';
import { TagChip, type Tag, type TagColor } from '@/components/TagChip';

/** Inbox setup (Wave 1): tags, saved replies and automatic assignment. Each section needs its own permission. */
interface Access { permissions: string[] }
interface TagRow extends Tag { uses: number }
interface Reply { id: string; title: string; body: string; language: string | null }
interface Assignment { mode: 'off' | 'round_robin' | 'least_busy'; hoursOnly: boolean; members: Array<{ id: string; name: string; onList: boolean; canReply: boolean }> }
const COLORS: TagColor[] = ['slate', 'teal', 'green', 'amber', 'red', 'violet', 'blue'];

export default function InboxSetup() {
  const params = useParams<{ locale: string }>();
  const locale: Locale = isLocale(params.locale) ? params.locale : 'en';
  const d = t(locale).inboxSetup;
  const [access, setAccess] = useState<Access | null>(null);
  useEffect(() => { api<Access>('/v1/me/access').then(setAccess).catch(() => undefined); }, []);
  const can = (p: string) => !!access?.permissions.includes(p);
  const any = can('tags.manage') || can('saved_replies.manage') || can('inbox.assign');
  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="text-2xl font-bold text-navy sm:text-3xl">{d.title}</h1>
      <p className="mt-1 text-sm text-slate-700">{d.intro}</p>
      {access && !any && <p className="mt-4 text-sm text-slate-700">{d.noAccess}</p>}
      {can('tags.manage') && <Tags locale={locale} />}
      {can('saved_replies.manage') && <Replies locale={locale} />}
      {can('inbox.assign') && <AssignmentSettings locale={locale} />}
    </div>
  );
}

function useAction(locale: Locale) {
  const d = t(locale).inboxSetup;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await fn(); return true; } catch (e) {
      setError(e instanceof ApiError ? (t(locale).inbox.errors[e.code] ?? (locale === 'en' && e.message ? e.message : d.errorGeneric)) : d.errorGeneric);
      return false;
    } finally { setBusy(false); }
  };
  return { busy, error, run };
}

function Tags({ locale }: { locale: Locale }) {
  const d = t(locale).inboxSetup;
  const [rows, setRows] = useState<TagRow[]>([]);
  const [name, setName] = useState('');
  const [color, setColor] = useState<TagColor>('teal');
  const [confirming, setConfirming] = useState<string | null>(null);
  const { busy, error, run } = useAction(locale);
  const load = useCallback(() => api<TagRow[]>('/v1/tags').then(setRows).catch(() => undefined), []);
  useEffect(() => { void load(); }, [load]);
  return (
    <section className="mt-6 rounded-xl border border-slate-200 bg-white p-4" aria-labelledby="tags-h">
      <h2 id="tags-h" className="text-lg font-semibold text-navy">{d.tags}</h2>
      <p className="mt-1 text-sm text-slate-700">{d.tagsHelp}</p>
      <form className="mt-3 flex flex-wrap items-end gap-2" onSubmit={async (e) => {
        e.preventDefault();
        if (await run(() => api('/v1/tags', { method: 'POST', body: { name, color } }))) { setName(''); void load(); }
      }}>
        <div>
          <label htmlFor="tag-name" className="block text-sm font-medium text-slate-900">{d.tagName}</label>
          <input id="tag-name" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} dir="auto" className="mt-1 rounded-lg border border-slate-300 px-3 py-2 text-base" />
        </div>
        <div>
          <label htmlFor="tag-colour" className="block text-sm font-medium text-slate-900">{d.colour}</label>
          <select id="tag-colour" value={color} onChange={(e) => setColor(e.target.value as TagColor)} className="mt-1 rounded-lg border border-slate-300 bg-white px-2 py-2 text-base">
            {COLORS.map((c) => <option key={c} value={c}>{d.colours[c]}</option>)}
          </select>
        </div>
        <button type="submit" className="btn-primary" disabled={busy || !name.trim()}>{d.addTag}</button>
      </form>
      {error && <p role="alert" className="mt-2 text-sm text-red-800">{error}</p>}
      <ul className="mt-3 grid gap-2">
        {rows.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center gap-2 text-sm">
            <TagChip tag={r} />
            <span className="text-slate-700">{fill(d.uses, { n: String(r.uses) })}</span>
            {confirming === r.id
              ? <><span className="text-red-800">{d.deleteConfirm}</span>
                  <button type="button" className="btn-danger" disabled={busy} onClick={async () => { if (await run(() => api(`/v1/tags/${r.id}`, { method: 'DELETE' }))) { setConfirming(null); void load(); } }}>{d.yesDelete}</button>
                  <button type="button" className="btn-secondary" onClick={() => setConfirming(null)}>{d.cancel}</button></>
              : <button type="button" className="btn-secondary" onClick={() => setConfirming(r.id)}>{d.delete}</button>}
          </li>
        ))}
      </ul>
    </section>
  );
}

function Replies({ locale }: { locale: Locale }) {
  const d = t(locale).inboxSetup;
  const [rows, setRows] = useState<Reply[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [language, setLanguage] = useState('');
  const [confirming, setConfirming] = useState<string | null>(null);
  const { busy, error, run } = useAction(locale);
  const load = useCallback(() => api<Reply[]>('/v1/saved-replies').then(setRows).catch(() => undefined), []);
  useEffect(() => { void load(); }, [load]);
  const reset = () => { setEditing(null); setTitle(''); setBody(''); setLanguage(''); };
  return (
    <section className="mt-6 rounded-xl border border-slate-200 bg-white p-4" aria-labelledby="replies-h">
      <h2 id="replies-h" className="text-lg font-semibold text-navy">{d.replies}</h2>
      <p className="mt-1 text-sm text-slate-700">{d.repliesHelp}</p>
      <form className="mt-3 grid gap-2" onSubmit={async (e) => {
        e.preventDefault();
        const payload = { title, body, language: language || null };
        const ok = await run(() => editing ? api(`/v1/saved-replies/${editing}`, { method: 'PATCH', body: payload }) : api('/v1/saved-replies', { method: 'POST', body: payload }));
        if (ok) { reset(); void load(); }
      }}>
        <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
          <div>
            <label htmlFor="reply-title" className="block text-sm font-medium text-slate-900">{d.replyTitle}</label>
            <input id="reply-title" value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} dir="auto" className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-base" />
          </div>
          <div>
            <label htmlFor="reply-lang" className="block text-sm font-medium text-slate-900">{d.replyLanguage}</label>
            <select id="reply-lang" value={language} onChange={(e) => setLanguage(e.target.value)} className="mt-1 rounded-lg border border-slate-300 bg-white px-2 py-2 text-base">
              <option value="">{d.anyLanguage}</option><option value="en">English</option><option value="ar">العربية</option>
            </select>
          </div>
        </div>
        <div>
          <label htmlFor="reply-body" className="block text-sm font-medium text-slate-900">{d.replyBody}</label>
          <textarea id="reply-body" value={body} maxLength={4096} rows={3} onChange={(e) => setBody(e.target.value)} dir="auto" className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-base" />
        </div>
        <div className="flex gap-2">
          <button type="submit" className="btn-primary" disabled={busy || !title.trim() || !body.trim()}>{editing ? d.save : d.addReply}</button>
          {editing && <button type="button" className="btn-secondary" onClick={reset}>{d.cancel}</button>}
        </div>
      </form>
      {error && <p role="alert" className="mt-2 text-sm text-red-800">{error}</p>}
      <ul className="mt-3 divide-y divide-slate-100">
        {rows.map((r) => (
          <li key={r.id} className="py-2 text-sm">
            <p className="font-semibold text-navy"><span dir="auto">{r.title}</span>{r.language && <span className="ms-2 text-xs font-normal text-slate-700">{r.language === 'ar' ? 'العربية' : 'English'}</span>}</p>
            <p className="mt-0.5 whitespace-pre-wrap text-slate-800" dir="auto">{r.body}</p>
            <div className="mt-1 flex flex-wrap gap-2">
              <button type="button" className="btn-secondary" onClick={() => { setEditing(r.id); setTitle(r.title); setBody(r.body); setLanguage(r.language ?? ''); }}>{d.edit}</button>
              {confirming === r.id
                ? <><button type="button" className="btn-danger" disabled={busy} onClick={async () => { if (await run(() => api(`/v1/saved-replies/${r.id}`, { method: 'DELETE' }))) { setConfirming(null); void load(); } }}>{d.yesDelete}</button>
                    <button type="button" className="btn-secondary" onClick={() => setConfirming(null)}>{d.cancel}</button></>
                : <button type="button" className="btn-secondary" onClick={() => setConfirming(r.id)}>{d.delete}</button>}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function AssignmentSettings({ locale }: { locale: Locale }) {
  const d = t(locale).inboxSetup;
  const [s, setS] = useState<Assignment | null>(null);
  const [saved, setSaved] = useState(false);
  const { busy, error, run } = useAction(locale);
  useEffect(() => { api<Assignment>('/v1/inbox/assignment').then(setS).catch(() => undefined); }, []);
  if (!s) return null;
  return (
    <section className="mt-6 rounded-xl border border-slate-200 bg-white p-4" aria-labelledby="assign-h">
      <h2 id="assign-h" className="text-lg font-semibold text-navy">{d.assignment}</h2>
      <p className="mt-1 text-sm text-slate-700">{d.assignmentHelp}</p>
      <fieldset className="mt-3 grid gap-1.5">
        <legend className="sr-only">{d.assignment}</legend>
        {(['off', 'round_robin', 'least_busy'] as const).map((m) => (
          <label key={m} className="flex items-center gap-2 text-sm text-slate-900">
            <input type="radio" name="assign-mode" id={`assign-${m}`} checked={s.mode === m} onChange={() => { setS({ ...s, mode: m }); setSaved(false); }} />
            {d.modes[m]}
          </label>
        ))}
      </fieldset>
      <label className="mt-3 flex items-center gap-2 text-sm text-slate-900">
        <input type="checkbox" id="assign-hours" checked={s.hoursOnly} onChange={(e) => { setS({ ...s, hoursOnly: e.target.checked }); setSaved(false); }} />
        {d.hoursOnly}
      </label>
      <fieldset className="mt-3">
        <legend className="text-sm font-medium text-slate-900">{d.members}</legend>
        <div className="mt-1 grid gap-1">
          {s.members.map((m) => (
            <label key={m.id} className="flex items-center gap-2 text-sm text-slate-900">
              <input type="checkbox" id={`assign-m-${m.id}`} checked={m.onList} disabled={!m.canReply}
                onChange={(e) => { setS({ ...s, members: s.members.map((x) => x.id === m.id ? { ...x, onList: e.target.checked } : x) }); setSaved(false); }} />
              <span dir="auto">{m.name}</span>{!m.canReply && <span className="text-xs text-slate-700">({d.cannotReply})</span>}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="mt-3 flex items-center gap-3">
        <button type="button" className="btn-primary" disabled={busy} onClick={async () => {
          const ok = await run(async () => setS(await api<Assignment>('/v1/inbox/assignment', { method: 'PUT',
            body: { mode: s.mode, hoursOnly: s.hoursOnly, memberIds: s.members.filter((m) => m.onList).map((m) => m.id) } })));
          setSaved(ok);
        }}>{d.saveAssignment}</button>
        {saved && <span role="status" className="text-sm text-green-900">{d.saved}</span>}
      </div>
      {error && <p role="alert" className="mt-2 text-sm text-red-800">{error}</p>}
    </section>
  );
}
