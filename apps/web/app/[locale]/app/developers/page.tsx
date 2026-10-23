'use client';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { fill, formatDate, isLocale, t, type Locale } from '@/lib/i18n';

/** API keys and outgoing webhooks (W2.8). Secrets are shown once, when created. */
const SCOPES = ['conversations:read', 'messages:send', 'contacts:read', 'contacts:write', 'reports:read'] as const;
const EVENTS = ['message.received', 'message.status', 'conversation.resolved', 'customer_request.created', 'promise.missed'] as const;
type Key = { id: string; name: string; prefix: string; scopes: string[]; state: 'active' | 'revoked' | 'expired'; lastUsedAt: string | null; requests24h: number };
type Hook = { id: string; url: string; events: string[]; enabled: boolean; failedDeliveries: number };
type Delivery = { id: string; event: string; state: string; attempts: number; lastStatus: number | null; lastError: string | null; createdAt: string };

export default function DevelopersPage() {
  const params = useParams<{ locale: string }>();
  const locale: Locale = isLocale(params.locale) ? params.locale : 'en';
  const d = t(locale).developers;
  const [can, setCan] = useState<boolean | null>(null);
  useEffect(() => { api<{ permissions: string[] }>('/v1/me/access').then((a) => setCan(a.permissions.includes('api.manage'))).catch(() => setCan(false)); }, []);
  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="text-2xl font-bold text-navy sm:text-3xl">{d.title}</h1>
      <p className="mt-1 text-sm text-slate-700">{d.intro}</p>
      {can === false && <p className="mt-4 text-sm text-slate-700">{d.noAccess}</p>}
      {can && <><Keys locale={locale} /><Hooks locale={locale} /><p className="mt-6 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-800">{d.docs}</p></>}
    </div>
  );
}

function Secret({ label, value, locale }: { label: string; value: string; locale: Locale }) {
  const d = t(locale).developers;
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-2 rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-sm" aria-live="polite">
      <p className="text-emerald-900">{label}</p>
      <p className="mt-1 break-all font-mono text-xs" dir="ltr">{value}</p>
      <button type="button" className="btn-secondary mt-2" onClick={async () => { try { await navigator.clipboard.writeText(value); setCopied(true); } catch { setCopied(false); } }}>{copied ? d.copied : d.copy}</button>
    </div>
  );
}

function Keys({ locale }: { locale: Locale }) {
  const d = t(locale).developers;
  const [keys, setKeys] = useState<Key[]>([]);
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<string[]>(['conversations:read']);
  const [days, setDays] = useState('');
  const [made, setMade] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => { try { setKeys(await api<Key[]>('/v1/developers/keys')); } catch { setError(t(locale).common.error); } }, [locale]);
  useEffect(() => { void load(); }, [load]);
  async function run(fn: () => Promise<unknown>) {
    setBusy(true); setError(null);
    try { await fn(); await load(); } catch (e) { setError(e instanceof ApiError ? (d.errors[e.code] ?? e.message) : t(locale).common.error); } finally { setBusy(false); }
  }
  return (
    <section aria-labelledby="dev-keys" className="mt-5 rounded-xl border border-slate-200 bg-white p-4">
      <h2 id="dev-keys" className="text-lg font-semibold text-navy">{d.keys}</h2>
      {error && <p role="alert" className="mt-1 text-sm text-red-800">{error}</p>}
      {keys.length === 0 ? <p className="mt-1 text-sm text-slate-700">{d.noKeys}</p> : (
        <ul className="mt-2 grid gap-2 text-sm">
          {keys.map((k) => (
            <li key={k.id} className="flex flex-wrap items-center justify-between gap-2 rounded border border-slate-200 p-2">
              <span className="min-w-0">
                <span className="font-semibold" dir="auto">{k.name}</span> · <span className="font-mono text-xs" dir="ltr">cf_live_{k.prefix}…</span> · {d.states[k.state]}
                <span className="block text-xs text-slate-700">{k.scopes.map((s) => d.scopeNames[s] ?? s).join(' · ')} · {fill(d.requests, { n: k.requests24h })} · {k.lastUsedAt ? fill(d.lastUsed, { when: formatDate(locale, k.lastUsedAt) }) : d.never}</span>
              </span>
              {k.state === 'active' && <button type="button" className="btn-secondary" disabled={busy} onClick={() => { if (window.confirm(d.confirmRevoke)) void run(() => api(`/v1/developers/keys/${k.id}/revoke`, { method: 'POST' })); }}>{d.revoke}</button>}
            </li>
          ))}
        </ul>
      )}
      <form className="mt-4 grid gap-2" onSubmit={(e) => { e.preventDefault(); void run(async () => {
        const r = await api<{ key: string }>('/v1/developers/keys', { method: 'POST', body: { name: name.trim(), scopes, ...(days ? { expiresInDays: Number(days) } : {}) } });
        setMade(r.key); setName(''); setDays('');
      }); }}>
        <h3 className="font-semibold text-slate-900">{d.newKey}</h3>
        <label htmlFor="k-name" className="text-sm font-medium text-slate-900">{d.name}</label>
        <input id="k-name" value={name} maxLength={80} dir="auto" onChange={(e) => setName(e.target.value)} className="rounded-lg border border-slate-300 px-3 py-2 text-base" />
        <fieldset className="grid gap-1 text-sm"><legend className="font-medium text-slate-900">{d.scopes}</legend>
          {SCOPES.map((s) => (
            <label key={s} className="flex items-center gap-2"><input type="checkbox" checked={scopes.includes(s)} onChange={(e) => setScopes(e.target.checked ? [...scopes, s] : scopes.filter((x) => x !== s))} />{d.scopeNames[s]}</label>
          ))}
        </fieldset>
        <label htmlFor="k-days" className="text-sm font-medium text-slate-900">{d.expires}</label>
        <input id="k-days" type="number" min={1} max={730} value={days} onChange={(e) => setDays(e.target.value)} className="w-32 rounded-lg border border-slate-300 px-3 py-2 text-base" />
        <div><button type="submit" className="btn-primary" disabled={busy || name.trim().length < 2 || scopes.length === 0}>{d.create}</button></div>
      </form>
      {made && <Secret label={d.shownOnce} value={made} locale={locale} />}
    </section>
  );
}

function Hooks({ locale }: { locale: Locale }) {
  const d = t(locale).developers;
  const [hooks, setHooks] = useState<Hook[]>([]);
  const [url, setUrl] = useState('https://');
  const [events, setEvents] = useState<string[]>(['message.received']);
  const [secret, setSecret] = useState<string | null>(null);
  const [secretFor, setSecretFor] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => { try { setHooks(await api<Hook[]>('/v1/developers/webhooks')); } catch { setError(t(locale).common.error); } }, [locale]);
  useEffect(() => { void load(); }, [load]);
  async function run(fn: () => Promise<unknown>) {
    setBusy(true); setError(null);
    try { await fn(); await load(); if (open) setDeliveries(await api<Delivery[]>(`/v1/developers/webhooks/${open}/deliveries`)); }
    catch (e) { setError(e instanceof ApiError ? (d.errors[e.code] ?? e.message) : t(locale).common.error); } finally { setBusy(false); }
  }
  async function show(id: string) {
    if (open === id) { setOpen(null); return; }
    setOpen(id);
    try { setDeliveries(await api<Delivery[]>(`/v1/developers/webhooks/${id}/deliveries`)); } catch { setError(t(locale).common.error); }
  }
  return (
    <section aria-labelledby="dev-hooks" className="mt-5 rounded-xl border border-slate-200 bg-white p-4">
      <h2 id="dev-hooks" className="text-lg font-semibold text-navy">{d.webhooks}</h2>
      {error && <p role="alert" className="mt-1 text-sm text-red-800">{error}</p>}
      {hooks.length === 0 ? <p className="mt-1 text-sm text-slate-700">{d.noHooks}</p> : (
        <ul className="mt-2 grid gap-2 text-sm">
          {hooks.map((h) => (
            <li key={h.id} className="rounded border border-slate-200 p-2">
              <p className="break-all font-mono text-xs" dir="ltr">{h.url}</p>
              <p className="text-xs text-slate-700">{h.events.map((e) => d.eventNames[e] ?? e).join(' · ')}{h.enabled ? '' : ` · ${d.switchedOff}`}</p>
              <div className="mt-1 flex flex-wrap gap-2">
                <button type="button" className="btn-secondary" aria-expanded={open === h.id} onClick={() => show(h.id)}>{d.deliveries}</button>
                <button type="button" className="btn-secondary" disabled={busy} onClick={() => run(() => api(`/v1/developers/webhooks/${h.id}`, { method: 'PATCH', body: { enabled: !h.enabled } }))}>{h.enabled ? d.disable : d.enable}</button>
                <button type="button" className="btn-secondary" disabled={busy} onClick={() => run(async () => { setSecret((await api<{ secret: string }>(`/v1/developers/webhooks/${h.id}/rotate`, { method: 'POST' })).secret); setSecretFor(h.id); })}>{d.rotate}</button>
                <button type="button" className="btn-secondary" disabled={busy} onClick={() => { if (window.confirm(d.confirmRemove)) void run(() => api(`/v1/developers/webhooks/${h.id}`, { method: 'DELETE' })); }}>{d.remove}</button>
              </div>
              {secret && secretFor === h.id && <Secret label={d.secretOnce} value={secret} locale={locale} />}
              {open === h.id && (
                <ul className="mt-2 grid gap-1 text-xs">
                  {deliveries.map((x) => (
                    <li key={x.id} className="flex flex-wrap items-center justify-between gap-2">
                      <span>{d.eventNames[x.event] ?? x.event} · {d.deliveryStates[x.state] ?? x.state}{x.lastStatus ? ` (${x.lastStatus})` : ''}{x.lastError && !x.lastStatus ? ` (${d.deliveryErrors[x.lastError] ?? x.lastError})` : ''} · {formatDate(locale, x.createdAt)}</span>
                      <button type="button" className="btn-secondary" disabled={busy} onClick={() => run(() => api(`/v1/developers/deliveries/${x.id}/resend`, { method: 'POST' }))}>{d.resend}</button>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
      <form className="mt-4 grid gap-2" onSubmit={(e) => { e.preventDefault(); void run(async () => {
        const r = await api<{ secret: string }>('/v1/developers/webhooks', { method: 'POST', body: { url: url.trim(), events } });
        setSecret(r.secret); setSecretFor(null); setUrl('https://');
      }); }}>
        <h3 className="font-semibold text-slate-900">{d.newHook}</h3>
        <label htmlFor="h-url" className="text-sm font-medium text-slate-900">{d.url}</label>
        <input id="h-url" type="url" value={url} dir="ltr" onChange={(e) => setUrl(e.target.value)} className="rounded-lg border border-slate-300 px-3 py-2 text-base" />
        <fieldset className="grid gap-1 text-sm"><legend className="font-medium text-slate-900">{d.events}</legend>
          {EVENTS.map((ev) => (
            <label key={ev} className="flex items-center gap-2"><input type="checkbox" checked={events.includes(ev)} onChange={(e) => setEvents(e.target.checked ? [...events, ev] : events.filter((x) => x !== ev))} />{d.eventNames[ev]}</label>
          ))}
        </fieldset>
        <div><button type="submit" className="btn-primary" disabled={busy || !url.startsWith('https://') || events.length === 0}>{d.add}</button></div>
      </form>
      {secret && secretFor === null && <Secret label={d.secretOnce} value={secret} locale={locale} />}
    </section>
  );
}
