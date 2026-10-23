'use client';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { Logo } from '@/components/Logo';
import { ApiError } from '@/lib/api';
import { dirOf, formatDate, isLocale, t, type Locale } from '@/lib/i18n';

/**
 * Customer control centre (W2.4). Opened from a private link a company sent on WhatsApp. The token is read from the
 * address fragment (never sent to the server by the browser), kept for this tab only, removed from the address bar and
 * sent to the API in a header. No sign-in, no cookies.
 */
type View = {
  company: { name: string };
  customer: { firstName: string | null; locale: 'en' | 'ar' };
  consent: { messages: 'allowed' | 'stopped'; marketing: boolean };
  conversations: Array<{ id: string; status: string; startedAt: string; lastActivityAt: string | null; resolvedAt: string | null; withPerson: boolean }>;
  requests: Array<{ id: string; kind: 'talk_to_person' | 'complaint'; createdAt: string; handledAt: string | null }>;
  linkExpiresAt: string;
};
const KEY = 'cf-customer-link';

function readToken(): string | null {
  const fromHash = typeof window !== 'undefined' ? window.location.hash.replace(/^#/, '') : '';
  if (fromHash) {
    try { sessionStorage.setItem(KEY, fromHash); } catch { /* storage may be blocked */ }
    // Keeps the token out of the address bar, history and screenshots.
    window.history.replaceState(null, '', window.location.pathname);
    return fromHash;
  }
  try { return sessionStorage.getItem(KEY); } catch { return null; }
}

async function call<T>(token: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/v1/customer/${path}`, {
    method: body === undefined ? 'GET' : 'POST', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer',
    headers: { 'X-Customer-Link': token, 'X-Requested-With': 'conversaflow', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = (data as { error?: { code?: string; message?: string } }).error ?? {};
    throw new ApiError(res.status, e.code ?? 'unknown', e.message ?? res.statusText);
  }
  return data as T;
}

export default function CustomerPage() {
  const params = useParams<{ locale: string }>();
  const [locale, setLocale] = useState<Locale>(isLocale(params.locale) ? params.locale : 'en');
  const d = t(locale).customer;
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const [view, setView] = useState<View | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'invalid' | 'error' | 'limited'>('loading');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [complaint, setComplaint] = useState('');
  const [confirmStop, setConfirmStop] = useState(false);

  const fail = useCallback((e: unknown) => {
    if (e instanceof ApiError && e.code === 'invalid_link') { setState('invalid'); setView(null); return; }
    if (e instanceof ApiError && e.code === 'rate_limited') { setState('limited'); return; }
    if (e instanceof ApiError && (e.code === 'messages_stopped' || e.code === 'too_many_requests')) { setNotice({ kind: 'error', text: d.errors[e.code] }); return; }
    setNotice({ kind: 'error', text: d.errors.generic });
  }, [d]);

  const load = useCallback(async (tok: string) => {
    try { setView(await call<View>(tok, 'portal')); setState('ready'); } catch (e) {
      if (e instanceof ApiError && (e.code === 'invalid_link' || e.code === 'rate_limited')) fail(e); else setState('error');
    }
  }, [fail]);

  useEffect(() => {
    const tok = readToken();
    setToken(tok);
    if (!tok) { setState('invalid'); return; }
    void load(tok);
  }, [load]);

  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = dirOf(locale);
  }, [locale]);

  async function act(path: string, body: unknown, ok: string) {
    if (!token) return;
    setBusy(true); setNotice(null);
    try { await call(token, path, body); await load(token); setNotice({ kind: 'ok', text: ok }); } catch (e) { fail(e); } finally { setBusy(false); }
  }

  async function chooseLanguage(l: Locale) {
    setLocale(l);
    window.history.replaceState(null, '', `/${l}/c`);
    if (token && state === 'ready') await act('preferences', { locale: l }, t(l).customer.saved);
  }

  const statusText = (c: View['conversations'][number]) =>
    c.status === 'resolved' ? d.status.resolved : c.withPerson ? d.status.withPerson : d.status.open;

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-2xl items-center justify-between gap-4 px-4 py-4">
          <Logo by={t(locale).brand.by} />
          <div role="group" aria-label={d.language} className="flex gap-1">
            {(['en', 'ar'] as const).map((l) => (
              <button key={l} type="button" onClick={() => void chooseLanguage(l)} aria-pressed={locale === l} disabled={busy}
                className={`min-h-11 rounded-lg border px-3 text-sm font-semibold ${locale === l ? 'border-teal bg-teal text-white' : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-100'}`}>
                {l === 'en' ? 'English' : 'العربية'}
              </button>
            ))}
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-2xl space-y-6 px-4 py-6">
        {state === 'loading' && <p role="status" className="text-slate-600">{d.loading}</p>}
        {state === 'invalid' && (
          <section className="rounded-xl border border-slate-200 bg-white p-6">
            <h1 className="text-xl font-bold text-navy">{d.invalidTitle}</h1>
            <p className="mt-2 text-slate-600">{d.invalidHelp}</p>
          </section>
        )}
        {state === 'limited' && <p role="alert" className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-amber-900">{d.errors.rate_limited}</p>}
        {state === 'error' && (
          <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-4 text-danger">
            {d.errors.generic}{' '}
            <button type="button" className="font-semibold underline" onClick={() => token && void load(token)}>{d.retry}</button>
          </div>
        )}
        {state === 'ready' && view && (
          <>
            <section>
              <h1 className="text-2xl font-bold text-navy">{view.customer.firstName ? d.hello.replace('{name}', view.customer.firstName) : d.helloNoName}</h1>
              <p className="mt-1 text-slate-600">{d.intro.replace('{company}', view.company.name)}</p>
              <p className="mt-1 text-sm text-slate-500">{d.expires.replace('{date}', formatDate(locale, view.linkExpiresAt))}</p>
            </section>
            {notice && <p role={notice.kind === 'error' ? 'alert' : 'status'} className={`rounded-lg border p-3 text-sm ${notice.kind === 'error' ? 'border-red-200 bg-red-50 text-danger' : 'border-emerald-200 bg-emerald-50 text-emerald-900'}`}>{notice.text}</p>}

            <section aria-labelledby="cs-conv" className="rounded-xl border border-slate-200 bg-white p-5">
              <h2 id="cs-conv" className="text-lg font-semibold text-navy">{d.conversations}</h2>
              {view.conversations.length === 0 ? <p className="mt-2 text-slate-600">{d.noConversations}</p> : (
                <ul className="mt-3 divide-y divide-slate-100">
                  {view.conversations.map((c) => (
                    <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
                      <span className="text-slate-700">{d.started.replace('{date}', formatDate(locale, c.startedAt))}</span>
                      <span className={`rounded-full px-3 py-1 text-sm font-semibold ${c.status === 'resolved' ? 'bg-slate-100 text-slate-700' : 'bg-teal/10 text-teal'}`}>{statusText(c)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section aria-labelledby="cs-help" className="rounded-xl border border-slate-200 bg-white p-5">
              <h2 id="cs-help" className="text-lg font-semibold text-navy">{d.needHelp}</h2>
              <button type="button" disabled={busy} onClick={() => void act('requests', { kind: 'talk_to_person' }, d.requestSent)}
                className="mt-3 min-h-11 rounded-lg bg-teal px-4 font-semibold text-white hover:bg-teal/90 disabled:opacity-60">{d.talkToPerson}</button>
              <form className="mt-5" onSubmit={(e) => { e.preventDefault(); if (complaint.trim()) void act('requests', { kind: 'complaint', text: complaint.trim() }, d.requestSent).then(() => setComplaint('')); }}>
                <label htmlFor="cs-complaint" className="block font-semibold text-slate-800">{d.complaint}</label>
                <p className="text-sm text-slate-500">{d.complaintHelp}</p>
                <textarea id="cs-complaint" value={complaint} onChange={(e) => setComplaint(e.target.value)} maxLength={2000} rows={4}
                  className="mt-2 w-full rounded-lg border border-slate-300 p-3 text-base focus:border-teal focus:outline-none focus:ring-2 focus:ring-teal/30" />
                <button type="submit" disabled={busy || !complaint.trim()} className="mt-2 min-h-11 rounded-lg border border-slate-300 bg-white px-4 font-semibold text-slate-800 hover:bg-slate-100 disabled:opacity-60">{d.sendComplaint}</button>
              </form>
              {view.requests.length > 0 && (
                <ul className="mt-5 space-y-2" aria-label={d.yourRequests}>
                  {view.requests.map((r) => (
                    <li key={r.id} className="flex flex-wrap justify-between gap-2 text-sm">
                      <span>{d.kinds[r.kind]} · {formatDate(locale, r.createdAt)}</span>
                      <span className={r.handledAt ? 'text-emerald-700' : 'text-amber-700'}>{r.handledAt ? d.handled : d.waiting}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section aria-labelledby="cs-msg" className="rounded-xl border border-slate-200 bg-white p-5">
              <h2 id="cs-msg" className="text-lg font-semibold text-navy">{d.messagesTitle}</h2>
              <p className="mt-1 text-slate-600">{view.consent.messages === 'allowed' ? d.messagesAllowed.replace('{company}', view.company.name) : d.messagesStopped.replace('{company}', view.company.name)}</p>
              {view.consent.messages === 'allowed' ? (
                confirmStop ? (
                  <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3">
                    <p className="text-amber-900">{d.stopConfirm}</p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <button type="button" disabled={busy} onClick={() => { setConfirmStop(false); void act('consent', { messages: 'stop' }, d.saved); }} className="min-h-11 rounded-lg bg-danger px-4 font-semibold text-white">{d.stopYes}</button>
                      <button type="button" onClick={() => setConfirmStop(false)} className="min-h-11 rounded-lg border border-slate-300 bg-white px-4 font-semibold">{d.cancel}</button>
                    </div>
                  </div>
                ) : <button type="button" disabled={busy} onClick={() => setConfirmStop(true)} className="mt-3 min-h-11 rounded-lg border border-slate-300 bg-white px-4 font-semibold text-slate-800 hover:bg-slate-100">{d.stop}</button>
              ) : <button type="button" disabled={busy} onClick={() => void act('consent', { messages: 'start' }, d.saved)} className="mt-3 min-h-11 rounded-lg bg-teal px-4 font-semibold text-white">{d.start}</button>}
              <div className="mt-5 flex items-start gap-3">
                <input id="cs-mkt" type="checkbox" className="mt-1 h-5 w-5" checked={view.consent.marketing} disabled={busy || view.consent.messages === 'stopped'}
                  onChange={(e) => void act('consent', { marketing: e.target.checked }, d.saved)} />
                <label htmlFor="cs-mkt" className="text-slate-800">{d.marketing.replace('{company}', view.company.name)}
                  {view.consent.messages === 'stopped' && <span className="block text-sm text-slate-500">{d.marketingNeedsMessages}</span>}
                </label>
              </div>
            </section>
            <p className="text-sm text-slate-500">{d.privacy}</p>
          </>
        )}
      </main>
    </div>
  );
}
