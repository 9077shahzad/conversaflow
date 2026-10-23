'use client';
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { fill, formatDate, t, type Locale } from '@/lib/i18n';

/**
 * Customer page links and requests for one conversation (W2.4). The link is shown once, when created; after that only
 * its state is listed. Creating a link sends nothing: the agent copies it into a reply.
 */
type Link = { id: string; createdAt: string; expiresAt: string; state: 'active' | 'expired' | 'revoked'; uses: number };
type Req = { id: string; kind: 'talk_to_person' | 'complaint'; body: string | null; createdAt: string; handledAt: string | null };

export function CustomerLinks({ conversationId, locale, canEdit }: { conversationId: string; locale: Locale; canEdit: boolean }) {
  const d = t(locale).customerLinks;
  const [links, setLinks] = useState<Link[]>([]);
  const [requests, setRequests] = useState<Req[]>([]);
  const [days, setDays] = useState(7);
  const [fresh, setFresh] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [l, r] = await Promise.all([
        api<Link[]>(`/v1/conversations/${conversationId}/customer-links`),
        api<Req[]>(`/v1/conversations/${conversationId}/customer-requests`),
      ]);
      setLinks(l); setRequests(r);
    } catch { setError(t(locale).common.error); }
  }, [conversationId, locale]);
  useEffect(() => { setFresh(null); void load(); }, [load]);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true); setError(null);
    try { await fn(); await load(); }
    catch (e) { setError(e instanceof ApiError ? (d.errors[e.code] ?? e.message) : t(locale).common.error); }
    finally { setBusy(false); }
  }
  const create = () => run(async () => {
    const r = await api<{ url: string }>(`/v1/conversations/${conversationId}/customer-links`, { method: 'POST', body: { days, locale } });
    setFresh(r.url); setCopied(false);
  });
  async function copy() {
    if (!fresh) return;
    try { await navigator.clipboard.writeText(fresh); setCopied(true); } catch { setCopied(false); }
  }
  const open = requests.filter((r) => !r.handledAt);

  return (
    <details className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm" open={open.length > 0}>
      <summary className="cursor-pointer font-semibold text-slate-800">
        {d.title}{open.length > 0 && <span className="ms-2 rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-900">{open.length}</span>}
      </summary>
      <p className="mt-1 text-slate-600">{d.help}</p>
      {error && <p role="alert" className="mt-1 text-red-800">{error}</p>}

      <h3 className="mt-3 font-semibold text-slate-800">{d.requests}</h3>
      {requests.length === 0 ? <p className="text-slate-600">{d.noRequests}</p> : (
        <ul className="mt-1 space-y-2">
          {requests.map((r) => (
            <li key={r.id} className="rounded border border-slate-200 p-2">
              <p className="text-xs text-slate-600">{d.kinds[r.kind]} · {formatDate(locale, r.createdAt)}</p>
              {r.body && <p className="mt-1 whitespace-pre-wrap" dir="auto">{r.body}</p>}
              {r.handledAt ? <p className="mt-1 text-xs text-emerald-700">{d.handled}</p>
                : canEdit && <button type="button" className="btn-secondary mt-1" disabled={busy} onClick={() => run(() => api(`/v1/customer-requests/${r.id}/handled`, { method: 'POST' }))}>{d.markHandled}</button>}
            </li>
          ))}
        </ul>
      )}

      {canEdit && (
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <label className="flex flex-col text-xs text-slate-700">{d.days}
            <select className="mt-1 min-h-11 rounded border border-slate-300 px-2 text-sm" value={days} onChange={(e) => setDays(Number(e.target.value))}>
              {[1, 3, 7, 14, 30].map((n) => <option key={n} value={n}>{d.dayOptions[n]}</option>)}
            </select>
          </label>
          <button type="button" className="btn-secondary" disabled={busy} onClick={create}>{d.create}</button>
        </div>
      )}
      {fresh && (
        <div className="mt-2 rounded border border-emerald-200 bg-emerald-50 p-2" aria-live="polite">
          <p className="text-emerald-900">{d.created}</p>
          <p className="mt-1 break-all font-mono text-xs" dir="ltr">{fresh}</p>
          <button type="button" className="btn-secondary mt-1" onClick={copy}>{copied ? d.copied : d.copy}</button>
        </div>
      )}
      {links.length === 0 ? <p className="mt-2 text-slate-600">{d.none}</p> : (
        <ul className="mt-2 space-y-1">
          {links.map((l) => (
            <li key={l.id} className="flex flex-wrap items-center justify-between gap-2">
              <span>{d.states[l.state]} · {fill(d.expires, { date: formatDate(locale, l.expiresAt) })} · {fill(d.used, { n: l.uses })}</span>
              {canEdit && l.state === 'active' && <button type="button" className="btn-secondary" disabled={busy} onClick={() => run(() => api(`/v1/customer-links/${l.id}/revoke`, { method: 'POST' }))}>{d.revoke}</button>}
            </li>
          ))}
        </ul>
      )}
      {canEdit && links.some((l) => l.state === 'active') && (
        <button type="button" className="btn-secondary mt-2" disabled={busy} onClick={() => run(() => api(`/v1/conversations/${conversationId}/customer-links/revoke-all`, { method: 'POST' }))}>{d.revokeAll}</button>
      )}
    </details>
  );
}
