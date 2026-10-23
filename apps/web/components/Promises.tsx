'use client';
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { fill, t, type Locale } from '@/lib/i18n';

/**
 * Promises made to the customer in one conversation (W2.6): suggestions from the team's replies to confirm or
 * dismiss, promises recorded by hand, and closing them as kept, cancelled or, after a miss, recovered.
 */
export type PromiseRow = {
  id: string; conversationId: string; description: string; ownerMembershipId: string | null; dueAt: string; source: 'manual' | 'rule';
  status: 'suggested' | 'confirmed' | 'kept' | 'missed' | 'recovered' | 'dismissed' | 'cancelled'; matchedText: string | null; note: string | null; version: number;
};

export function when(locale: Locale, iso: string) {
  return new Intl.DateTimeFormat(locale === 'ar' ? 'ar-SA-u-nu-latn-ca-gregory' : 'en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
}
/** datetime-local value (the viewer's clock) to ISO with offset. */
const toIso = (local: string) => new Date(local).toISOString();
const localInput = (iso: string) => { const d = new Date(iso); return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16); };
const inHours = (h: number) => { const d = new Date(Date.now() + h * 3600_000); d.setSeconds(0, 0); return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16); };

export function ConversationPromises({ conversationId, locale, canEdit, names }: { conversationId: string; locale: Locale; canEdit: boolean; names: (id: string | null) => string }) {
  const d = t(locale).promises;
  const [rows, setRows] = useState<PromiseRow[]>([]);
  const [adding, setAdding] = useState(false);
  const [text, setText] = useState('');
  const [due, setDue] = useState(inHours(24));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recovering, setRecovering] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [newDue, setNewDue] = useState('');
  const [note, setNote] = useState('');

  const load = useCallback(async () => {
    try { setRows(await api<PromiseRow[]>(`/v1/conversations/${conversationId}/promises`)); } catch { setError(t(locale).common.error); }
  }, [conversationId, locale]);
  useEffect(() => { setAdding(false); setRecovering(null); void load(); }, [load]);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true); setError(null);
    try { await fn(); await load(); }
    catch (e) { setError(e instanceof ApiError ? (d.errors[e.code] ?? e.message) : t(locale).common.error); await load(); }
    finally { setBusy(false); }
  }
  const open = rows.filter((r) => r.status === 'suggested' || r.status === 'confirmed' || r.status === 'missed');
  const closed = rows.filter((r) => !open.includes(r));

  return (
    <details className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm" open={open.length > 0}>
      <summary className="cursor-pointer font-semibold text-slate-800">
        {d.title}{open.length > 0 && <span className="ms-2 rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-800">{open.length}</span>}
      </summary>
      {error && <p role="alert" className="mt-1 text-red-800">{error}</p>}
      {rows.length === 0 && <p className="mt-1 text-slate-600">{d.none}</p>}
      <ul className="mt-2 space-y-2">
        {[...open, ...closed].map((p) => (
          <li key={p.id} className={`rounded border p-2 ${p.status === 'missed' ? 'border-red-300 bg-red-50' : p.status === 'suggested' ? 'border-amber-300 bg-amber-50' : 'border-slate-200'}`}>
            <p className="whitespace-pre-wrap" dir="auto">{p.description}</p>
            <p className="mt-1 text-xs text-slate-700">
              {d.statuses[p.status]} · {fill(d.due, { when: when(locale, p.dueAt) })}{p.ownerMembershipId ? ` · ${names(p.ownerMembershipId)}` : ''}
              {p.source === 'rule' && <> · {d.fromReply}</>}
            </p>
            {p.status === 'suggested' && p.matchedText && <p className="text-xs text-slate-600" dir="auto">{fill(d.because, { words: p.matchedText })}</p>}
            {p.note && <p className="mt-1 text-xs text-slate-700" dir="auto">{p.note}</p>}
            {canEdit && (
              <div className="mt-1 flex flex-wrap gap-2">
                {(p.status === 'suggested' || p.status === 'confirmed') && editing !== p.id && (
                  <button type="button" className="btn-secondary" disabled={busy} onClick={() => { setEditing(p.id); setNewDue(localInput(p.dueAt)); }}>{d.changeDue}</button>
                )}
                {p.status === 'suggested' && <>
                  <button type="button" className="btn-secondary" disabled={busy} onClick={() => run(() => api(`/v1/promises/${p.id}/confirm`, { method: 'POST', body: { expectedVersion: p.version } }))}>{d.confirm}</button>
                  <button type="button" className="btn-secondary" disabled={busy} onClick={() => run(() => api(`/v1/promises/${p.id}/close`, { method: 'POST', body: { outcome: 'dismissed', expectedVersion: p.version } }))}>{d.dismiss}</button>
                </>}
                {(p.status === 'confirmed' || p.status === 'missed') && (
                  <button type="button" className="btn-secondary" disabled={busy} onClick={() => run(() => api(`/v1/promises/${p.id}/close`, { method: 'POST', body: { outcome: 'kept', expectedVersion: p.version } }))}>{d.kept}</button>
                )}
                {p.status === 'confirmed' && (
                  <button type="button" className="btn-secondary" disabled={busy} onClick={() => run(() => api(`/v1/promises/${p.id}/close`, { method: 'POST', body: { outcome: 'cancelled', expectedVersion: p.version } }))}>{d.cancel}</button>
                )}
                {p.status === 'missed' && recovering !== p.id && <button type="button" className="btn-secondary" disabled={busy} onClick={() => { setRecovering(p.id); setNote(''); }}>{d.recover}</button>}
              </div>
            )}
            {editing === p.id && (
              <form className="mt-2 flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); void run(() => api(`/v1/promises/${p.id}/confirm`, { method: 'POST', body: { dueAt: toIso(newDue), expectedVersion: p.version } })).then(() => setEditing(null)); }}>
                <label className="flex flex-col text-xs font-medium text-slate-800">{d.byWhen}
                  <input type="datetime-local" value={newDue} dir="ltr" onChange={(e) => setNewDue(e.target.value)} className="mt-1 rounded border border-slate-300 px-2 py-1.5 text-sm" />
                </label>
                <button type="submit" className="btn-secondary" disabled={busy || !newDue}>{p.status === 'suggested' ? d.confirm : d.save}</button>
                <button type="button" className="btn-secondary" onClick={() => setEditing(null)}>{d.cancelEdit}</button>
              </form>
            )}
            {recovering === p.id && (
              <form className="mt-2" onSubmit={(e) => { e.preventDefault(); if (note.trim()) void run(() => api(`/v1/promises/${p.id}/close`, { method: 'POST', body: { outcome: 'recovered', note: note.trim(), expectedVersion: p.version } })).then(() => setRecovering(null)); }}>
                <label htmlFor={`rec-${p.id}`} className="block text-xs font-medium text-slate-800">{d.recoverHow}</label>
                <input id={`rec-${p.id}`} value={note} maxLength={500} dir="auto" onChange={(e) => setNote(e.target.value)} className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-sm" />
                <button type="submit" className="btn-secondary mt-1" disabled={busy || !note.trim()}>{d.save}</button>
              </form>
            )}
          </li>
        ))}
      </ul>
      {canEdit && !adding && <button type="button" className="btn-secondary mt-2" onClick={() => setAdding(true)}>{d.add}</button>}
      {canEdit && adding && (
        <form className="mt-2 grid gap-2" onSubmit={(e) => { e.preventDefault(); if (text.trim().length >= 3) void run(() => api(`/v1/conversations/${conversationId}/promises`, { method: 'POST', body: { description: text.trim(), dueAt: toIso(due) } })).then(() => { setAdding(false); setText(''); }); }}>
          <label htmlFor={`pr-text-${conversationId}`} className="text-xs font-medium text-slate-800">{d.what}</label>
          <input id={`pr-text-${conversationId}`} value={text} maxLength={300} dir="auto" onChange={(e) => setText(e.target.value)} className="rounded border border-slate-300 px-2 py-1.5 text-sm" />
          <label htmlFor={`pr-due-${conversationId}`} className="text-xs font-medium text-slate-800">{d.byWhen}</label>
          <input id={`pr-due-${conversationId}`} type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} className="rounded border border-slate-300 px-2 py-1.5 text-sm" dir="ltr" />
          <div className="flex gap-2">
            <button type="submit" className="btn-secondary" disabled={busy || text.trim().length < 3}>{d.save}</button>
            <button type="button" className="btn-secondary" onClick={() => setAdding(false)}>{d.cancelEdit}</button>
          </div>
        </form>
      )}
    </details>
  );
}
