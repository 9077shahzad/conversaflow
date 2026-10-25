'use client';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { Logo } from '@/components/Logo';
import { ApiError } from '@/lib/api';
import { dirOf, formatDate, isLocale, t, type Locale } from '@/lib/i18n';

/**
 * The customer's quote (Conversa Operator, slice 1). Opened from the single-use link in the quote message. The token is
 * read from the address fragment, kept for this tab only, removed from the address bar and sent in a header. Opening
 * the page never accepts anything: the customer ticks that they agree and presses Accept.
 */
type Line = { name: { en: string; ar: string }; kind: 'fixed' | 'inspection'; quantity: number; unitPrice: number; discount: number; amount: number };
type View = {
  company: string; number: number; status: 'sent' | 'accepted' | 'expired' | 'superseded' | 'withdrawn' | string; currency: string; validUntil: string; acceptedAt: string | null;
  lines: Line[]; callout: number; travel: number; minimumTopUp: number; manualDiscount: number; taxable: number; taxRateBp: number; tax: number; total: number; deposit: number;
  inspectionOnly: boolean; scope: { en: string; ar: string }; terms: { en: string; ar: string }; canAccept: boolean;
};
const KEY = 'cf-quote-link';
const DIGITS: Record<string, number> = { KWD: 3, BHD: 3, OMR: 3 };

function readToken(): string | null {
  const fromHash = typeof window !== 'undefined' ? window.location.hash.replace(/^#/, '') : '';
  if (fromHash) {
    try { sessionStorage.setItem(KEY, fromHash); } catch { /* storage may be blocked */ }
    window.history.replaceState(null, '', window.location.pathname);
    return fromHash;
  }
  try { return sessionStorage.getItem(KEY); } catch { return null; }
}
function forget() { try { sessionStorage.removeItem(KEY); } catch { /* storage may be blocked */ } }

async function call<T>(token: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/v1/quote${path}`, {
    method: body === undefined ? 'GET' : 'POST', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer',
    headers: { 'X-Quote-Link': token, 'X-Requested-With': 'conversaflow', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = (data as { error?: { code?: string; message?: string } }).error ?? {};
    throw new ApiError(res.status, e.code ?? 'unknown', e.message ?? res.statusText);
  }
  return data as T;
}

export default function QuotePage() {
  const params = useParams<{ locale: string }>();
  const [locale, setLocale] = useState<Locale>(isLocale(params.locale) ? params.locale : 'en');
  const d = t(locale).quotePage;
  const [token, setToken] = useState<string | null>(null);
  const [view, setView] = useState<View | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'invalid' | 'error' | 'limited'>('loading');
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const load = useCallback(async (tok: string) => {
    try { setView(await call<View>(tok, '')); setState('ready'); } catch (e) {
      if (e instanceof ApiError && e.code === 'invalid_link') { forget(); setState('invalid'); }
      else if (e instanceof ApiError && e.code === 'rate_limited') setState('limited');
      else setState('error');
    }
  }, []);
  useEffect(() => { const tok = readToken(); setToken(tok); if (!tok) { setState('invalid'); return; } void load(tok); }, [load]);
  useEffect(() => { document.documentElement.lang = locale; document.documentElement.dir = dirOf(locale); }, [locale]);

  const money = (v: number) => {
    const digits = DIGITS[view?.currency ?? ''] ?? 2;
    return new Intl.NumberFormat(locale === 'ar' ? 'ar-SA-u-nu-latn' : 'en-GB', { style: 'currency', currency: view?.currency ?? 'SAR', minimumFractionDigits: digits, maximumFractionDigits: digits }).format(v / 10 ** digits);
  };
  async function accept() {
    if (!token || !view) return;
    setBusy(true); setNotice(null);
    try { await call(token, '/accept', { quoteNumber: view.number, agree: true }); await load(token); setNotice({ kind: 'ok', text: d.acceptedNotice }); }
    catch (e) {
      const code = e instanceof ApiError ? e.code : 'generic';
      if (code === 'invalid_link') { forget(); setState('invalid'); }
      setNotice({ kind: 'error', text: d.errors[code] ?? d.errors.generic });
      if (token) await load(token);
    } finally { setBusy(false); }
  }

  const statusText = (s: string) => d.status[s] ?? s;
  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-2xl items-center justify-between gap-4 px-4 py-4">
          <Logo by={t(locale).brand.by} />
          <div role="group" aria-label={d.language} className="flex gap-1">
            {(['en', 'ar'] as const).map((l) => (
              <button key={l} type="button" onClick={() => { setLocale(l); window.history.replaceState(null, '', `/${l}/q`); }} aria-pressed={locale === l}
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
            {d.errors.generic}{' '}<button type="button" className="font-semibold underline" onClick={() => token && void load(token)}>{d.retry}</button>
          </div>
        )}
        {state === 'ready' && view && (
          <>
            <section>
              <p className="text-sm text-slate-600"><bdi>{view.company}</bdi></p>
              <h1 className="text-2xl font-bold text-navy">{d.title.replace('{n}', String(view.number))}</h1>
              <p className={`mt-2 inline-block rounded-full px-3 py-1 text-sm font-semibold ${view.status === 'accepted' ? 'bg-emerald-50 text-emerald-800' : view.status === 'sent' ? 'bg-teal/10 text-teal' : 'bg-slate-100 text-slate-700'}`}>
                {statusText(view.status)}
              </p>
              {view.status === 'sent' && <p className="mt-2 text-sm text-slate-600">{d.validUntil.replace('{date}', formatDate(locale, view.validUntil))}</p>}
              {view.status === 'accepted' && view.acceptedAt && <p className="mt-2 text-sm text-slate-600">{d.acceptedOn.replace('{date}', formatDate(locale, view.acceptedAt))} {d.notBookedYet}</p>}
            </section>
            {notice && <p role={notice.kind === 'error' ? 'alert' : 'status'} className={`rounded-lg border p-3 text-sm ${notice.kind === 'error' ? 'border-red-200 bg-red-50 text-danger' : 'border-emerald-200 bg-emerald-50 text-emerald-900'}`}>{notice.text}</p>}

            <section aria-labelledby="q-scope" className="rounded-xl border border-slate-200 bg-white p-5">
              <h2 id="q-scope" className="text-lg font-semibold text-navy">{d.whatIsIncluded}</h2>
              <p className="mt-1 text-slate-700" dir="auto">{view.scope[locale]}</p>
              {view.inspectionOnly && <p className="mt-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">{d.inspectionNote}</p>}
              <table className="mt-4 w-full text-sm">
                <caption className="sr-only">{d.priceBreakdown}</caption>
                <thead><tr className="text-slate-600"><th scope="col" className="py-1 text-start font-medium">{d.item}</th><th scope="col" className="py-1 text-end font-medium">{d.amount}</th></tr></thead>
                <tbody className="divide-y divide-slate-100">
                  {view.lines.map((l, i) => (
                    <tr key={i}>
                      <td className="py-2"><span dir="auto">{l.name[locale]}</span>{l.kind === 'fixed' && <> × <bdi>{l.quantity}</bdi></>}{l.discount > 0 && <span className="block text-xs text-emerald-700">{d.volumeDiscount} <bdi>−{money(l.discount)}</bdi></span>}</td>
                      <td className="py-2 text-end"><bdi>{money(l.amount)}</bdi></td>
                    </tr>
                  ))}
                  {view.callout > 0 && <tr><td className="py-2">{d.callout}</td><td className="py-2 text-end"><bdi>{money(view.callout)}</bdi></td></tr>}
                  {view.travel > 0 && <tr><td className="py-2">{d.travel}</td><td className="py-2 text-end"><bdi>{money(view.travel)}</bdi></td></tr>}
                  {view.minimumTopUp > 0 && <tr><td className="py-2">{d.minimum}</td><td className="py-2 text-end"><bdi>{money(view.minimumTopUp)}</bdi></td></tr>}
                  {view.manualDiscount > 0 && <tr><td className="py-2">{d.discount}</td><td className="py-2 text-end"><bdi>−{money(view.manualDiscount)}</bdi></td></tr>}
                  <tr><td className="py-2">{d.tax.replace('{rate}', String(view.taxRateBp / 100))}</td><td className="py-2 text-end"><bdi>{money(view.tax)}</bdi></td></tr>
                  <tr className="font-semibold"><td className="py-2">{d.total}</td><td className="py-2 text-end text-lg"><bdi>{money(view.total)}</bdi></td></tr>
                  {view.deposit > 0 && <tr><td className="py-2 text-slate-700">{d.deposit}</td><td className="py-2 text-end"><bdi>{money(view.deposit)}</bdi></td></tr>}
                </tbody>
              </table>
            </section>

            <section aria-labelledby="q-terms" className="rounded-xl border border-slate-200 bg-white p-5">
              <h2 id="q-terms" className="text-lg font-semibold text-navy">{d.terms}</h2>
              <p className="mt-2 whitespace-pre-wrap text-sm text-slate-700" dir="auto">{view.terms[locale] || view.terms[locale === 'ar' ? 'en' : 'ar']}</p>
            </section>

            {view.canAccept && (
              <section aria-labelledby="q-accept" className="rounded-xl border border-slate-200 bg-white p-5">
                <h2 id="q-accept" className="text-lg font-semibold text-navy">{d.acceptTitle}</h2>
                <div className="mt-3 flex items-start gap-3">
                  <input id="q-agree" type="checkbox" className="mt-1 h-5 w-5" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
                  <label htmlFor="q-agree" className="text-slate-800">{d.agree.replace('{total}', money(view.total))}</label>
                </div>
                <p className="mt-2 text-sm text-slate-600">{d.acceptHelp}</p>
                <button type="button" disabled={busy || !agree} onClick={() => void accept()}
                  className="mt-3 min-h-11 rounded-lg bg-teal px-5 font-semibold text-white hover:bg-teal/90 disabled:opacity-60">{d.accept}</button>
              </section>
            )}
            {!view.canAccept && view.status !== 'accepted' && <p className="rounded-lg border border-slate-200 bg-white p-4 text-slate-700">{d.cannotAccept[view.status] ?? d.cannotAccept.other}</p>}
            <p className="text-sm text-slate-600">{d.questions}</p>
          </>
        )}
      </main>
    </div>
  );
}
