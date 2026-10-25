'use client';
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { fill, formatDate, t, type Locale } from '@/lib/i18n';

/**
 * Conversa Operator in a conversation (slice 1): the service case with what is known and what is missing, quote
 * versions with honest statuses, and the actions a person may take. Prices come only from the published price list.
 */
type Fact = { state: 'unknown' | 'unavailable' | 'not_applicable' | 'stated' | 'confirmed'; value?: string; original?: string };
type Quote = { id: string; number: number; status: string; currency: string; totalMinor: string; taxMinor: string; depositMinor: string; inspectionOnly: boolean;
  scopeEn: string; scopeAr: string; validUntil: string; needsApproval: string[]; sentAt: string | null; version: number; acceptance: { channel: string; acceptedAt: string } | null };
type Case = { id: string; status: string; facts: Record<string, Fact>; version: number; quotes: Quote[]; events: Array<{ kind: string; createdAt: string }> };
type Settings = { enabled: boolean; paused: boolean; publishedRateCard: { id: string; version: number } | null };
type Card = { id: string; status: string; card: { currency: string; services: Array<{ serviceKey: string; nameEn: string; nameAr: string; kind: string }>; areas: Record<string, number> } };
const FACTS = ['service', 'quantity', 'equipment', 'area', 'address', 'preferred_time', 'language', 'access', 'contact_preference'] as const;
const DIGITS: Record<string, number> = { KWD: 3, BHD: 3, OMR: 3 };

export function OperatorPanel({ conversationId, activitySeq, locale, canApprove }: { conversationId: string; activitySeq: number; locale: Locale; canApprove: boolean }) {
  const d = t(locale).operator;
  const [settings, setSettings] = useState<Settings | null>(null);
  const [card, setCard] = useState<Card | null>(null);
  const [kase, setKase] = useState<Case | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [lines, setLines] = useState<Array<{ serviceKey: string; quantity: number }>>([]);
  const [area, setArea] = useState('');
  const [discount, setDiscount] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [fact, setFact] = useState<Fact>({ state: 'unknown' });
  const [recording, setRecording] = useState<string | null>(null);
  const [note, setNote] = useState('');

  const load = useCallback(async () => {
    try {
      const s = await api<Settings>('/v1/operator/settings');
      setSettings(s);
      if (!s.enabled) return;
      const cards = await api<Card[]>('/v1/operator/rate-cards');
      const pub = cards.find((c) => c.status === 'published') ?? null;
      setCard(pub);
      if (pub && !area) setArea(Object.keys(pub.card.areas)[0] ?? '');
      const cases = await api<Array<{ id: string; status: string }>>(`/v1/operator/conversations/${conversationId}/cases`);
      const open = cases.find((c) => c.status !== 'closed') ?? cases[0];
      setKase(open ? await api<Case>(`/v1/operator/cases/${open.id}`) : null);
    } catch (e) { setError(e instanceof ApiError && e.status === 403 ? d.noPermission : t(locale).common.error); }
  }, [conversationId, locale, d, area]);
  useEffect(() => { setKase(null); setLines([]); setEditing(null); void load(); }, [conversationId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function run(fn: () => Promise<unknown>) {
    setBusy(true); setError(null);
    try { await fn(); await load(); }
    catch (e) { setError(e instanceof ApiError ? (d.errors[e.code] ?? e.message) : t(locale).common.error); await load(); }
    finally { setBusy(false); }
  }
  const money = (minor: string | number, currency: string) => {
    const digits = DIGITS[currency] ?? 2;
    return new Intl.NumberFormat(locale === 'ar' ? 'ar-SA-u-nu-latn' : 'en-GB', { style: 'currency', currency, minimumFractionDigits: digits, maximumFractionDigits: digits }).format(Number(minor) / 10 ** digits);
  };
  const serviceName = (key: string) => { const s = card?.card.services.find((x) => x.serviceKey === key); return s ? (locale === 'ar' ? s.nameAr : s.nameEn) : key; };

  if (settings && !settings.enabled) return null;
  return (
    <details className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm" open={!!kase}>
      <summary className="cursor-pointer font-semibold text-slate-800">{d.panelTitle}{kase && <span className="ms-2 rounded-full bg-slate-100 px-2 py-0.5 text-xs">{d.caseStatus[kase.status] ?? kase.status}</span>}</summary>
      {error && <p role="alert" className="mt-1 text-red-800">{error}</p>}
      {settings?.paused && <p role="status" className="mt-1 rounded border border-amber-300 bg-amber-50 p-2 text-amber-900">{d.pausedNotice}</p>}
      {!kase && <button type="button" className="btn-secondary mt-2" disabled={busy} onClick={() => run(() => api(`/v1/operator/conversations/${conversationId}/cases`, { method: 'POST' }))}>{d.openCase}</button>}
      {kase && (
        <div className="mt-2 space-y-3">
          <section aria-label={d.facts}>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-600">{d.facts}</h3>
            <ul className="mt-1 grid gap-1">
              {FACTS.map((k) => {
                const f = kase.facts[k] ?? { state: 'unknown' };
                return (
                  <li key={k} className="flex flex-wrap items-center justify-between gap-2">
                    <span><span className="text-slate-700">{d.factNames[k]}:</span>{' '}
                      <span className={f.state === 'confirmed' ? 'font-semibold text-emerald-800' : f.state === 'stated' ? 'text-slate-900' : 'text-slate-500'}>
                        {f.value ? <bdi>{f.value}</bdi> : d.factStates[f.state]}{f.value && ` (${d.factStates[f.state]})`}
                      </span></span>
                    {editing !== k && <button type="button" className="text-xs font-semibold text-teal underline" onClick={() => { setEditing(k); setFact({ state: f.state, value: f.value ?? '', original: f.original ?? '' }); }}>{d.edit}</button>}
                    {editing === k && (
                      <form className="flex w-full flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); void run(() => api(`/v1/operator/cases/${kase.id}/facts`, { method: 'PATCH',
                        body: { facts: { [k]: { state: fact.state, ...(fact.value ? { value: fact.value } : {}), ...(fact.original ? { original: fact.original } : {}) } }, expectedVersion: kase.version } })).then(() => setEditing(null)); }}>
                        <label className="flex flex-col text-xs">{d.state}
                          <select value={fact.state} onChange={(e) => setFact({ ...fact, state: e.target.value as Fact['state'] })} className="mt-1 rounded border border-slate-300 px-2 py-1.5">
                            {(['unknown', 'stated', 'confirmed', 'unavailable', 'not_applicable'] as const).map((s) => <option key={s} value={s}>{d.factStates[s]}</option>)}
                          </select>
                        </label>
                        <label className="flex flex-col text-xs">{d.value}
                          <input value={fact.value ?? ''} maxLength={300} dir="auto" onChange={(e) => setFact({ ...fact, value: e.target.value })} className="mt-1 rounded border border-slate-300 px-2 py-1.5" />
                        </label>
                        <button type="submit" className="btn-secondary" disabled={busy}>{d.save}</button>
                        <button type="button" className="btn-secondary" onClick={() => setEditing(null)}>{d.cancel}</button>
                      </form>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>

          <section aria-label={d.quotes}>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-600">{d.quotes}</h3>
            {kase.quotes.length === 0 && <p className="text-slate-600">{d.noQuotes}</p>}
            <ul className="mt-1 space-y-2">
              {kase.quotes.map((q) => (
                <li key={q.id} className={`rounded border p-2 ${q.status === 'accepted' ? 'border-emerald-300 bg-emerald-50' : q.status === 'pending_approval' ? 'border-amber-300 bg-amber-50' : 'border-slate-200'}`}>
                  <p className="font-semibold">{fill(d.quoteNo, { n: q.number })} · <bdi>{money(q.totalMinor, q.currency)}</bdi> · {d.quoteStatus[q.status] ?? q.status}</p>
                  <p className="text-xs text-slate-700" dir="auto">{locale === 'ar' ? q.scopeAr : q.scopeEn}</p>
                  {q.status === 'sent' && <p className="text-xs text-slate-600">{fill(d.validUntil, { date: formatDate(locale, q.validUntil) })}</p>}
                  {q.needsApproval.length > 0 && q.status === 'pending_approval' && <p className="text-xs text-amber-900">{d.needsApprovalFor} {q.needsApproval.map((r) => d.approvalReasons[r] ?? r).join('، ')}</p>}
                  {q.acceptance && <p className="text-xs text-emerald-800">{fill(d.acceptedBy, { how: d.acceptanceChannels[q.acceptance.channel] ?? q.acceptance.channel, date: formatDate(locale, q.acceptance.acceptedAt) })} {d.notBookedYet}</p>}
                  <div className="mt-1 flex flex-wrap gap-2">
                    {q.status === 'pending_approval' && canApprove && <button type="button" className="btn-secondary" disabled={busy} onClick={() => run(() => api(`/v1/operator/quotes/${q.id}/approve`, { method: 'POST', body: { expectedVersion: q.version } }))}>{d.approve}</button>}
                    {(q.status === 'draft' || q.status === 'approved') && <button type="button" className="btn-primary" disabled={busy || settings?.paused} onClick={() => run(() => api(`/v1/operator/quotes/${q.id}/send`, { method: 'POST', body: { expectedVersion: q.version, seenActivity: activitySeq, locale } }))}>{d.send}</button>}
                    {q.status === 'sent' && recording !== q.id && <button type="button" className="btn-secondary" disabled={busy} onClick={() => { setRecording(q.id); setNote(''); }}>{d.recordAcceptance}</button>}
                    {['draft', 'pending_approval', 'approved', 'sent'].includes(q.status) && <button type="button" className="btn-secondary" disabled={busy} onClick={() => run(() => api(`/v1/operator/quotes/${q.id}/withdraw`, { method: 'POST', body: { expectedVersion: q.version } }))}>{d.withdraw}</button>}
                  </div>
                  {recording === q.id && (
                    <form className="mt-2" onSubmit={(e) => { e.preventDefault(); if (note.trim().length >= 5) void run(() => api(`/v1/operator/quotes/${q.id}/record-acceptance`, { method: 'POST', body: { evidenceNote: note.trim(), expectedVersion: q.version } })).then(() => setRecording(null)); }}>
                      <label htmlFor={`acc-${q.id}`} className="block text-xs font-medium">{d.howAccepted}</label>
                      <input id={`acc-${q.id}`} value={note} maxLength={500} dir="auto" onChange={(e) => setNote(e.target.value)} className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5" />
                      <button type="submit" className="btn-secondary mt-1" disabled={busy || note.trim().length < 5}>{d.save}</button>
                    </form>
                  )}
                </li>
              ))}
            </ul>
          </section>

          {card ? (
            <form className="grid gap-2 rounded border border-slate-200 p-2" onSubmit={(e) => { e.preventDefault(); void run(() => api(`/v1/operator/cases/${kase.id}/quotes`, { method: 'POST',
              body: { lines: lines.filter((l) => l.serviceKey), areaKey: area, ...(discount ? { manualDiscountBp: Math.round(Number(discount) * 100) } : {}) } })).then(() => { setLines([]); setDiscount(''); }); }}>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-600">{d.newQuote}</h3>
              {lines.map((l, i) => (
                <div key={i} className="flex flex-wrap items-end gap-2">
                  <label className="flex flex-col text-xs">{d.service}
                    <select value={l.serviceKey} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, serviceKey: e.target.value } : x)))} className="mt-1 rounded border border-slate-300 px-2 py-1.5">
                      {card.card.services.map((s) => <option key={s.serviceKey} value={s.serviceKey}>{serviceName(s.serviceKey)}{s.kind === 'inspection' ? ` (${d.inspection})` : ''}</option>)}
                    </select>
                  </label>
                  <label className="flex flex-col text-xs">{d.quantity}
                    <input type="number" min={1} max={100} value={l.quantity} dir="ltr" onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, quantity: Number(e.target.value) } : x)))} className="mt-1 w-20 rounded border border-slate-300 px-2 py-1.5" />
                  </label>
                  <button type="button" className="btn-secondary" onClick={() => setLines(lines.filter((_, j) => j !== i))}>{d.remove}</button>
                </div>
              ))}
              <button type="button" className="btn-secondary justify-self-start" onClick={() => setLines([...lines, { serviceKey: card.card.services[0]?.serviceKey ?? '', quantity: 1 }])}>{d.addService}</button>
              <div className="flex flex-wrap items-end gap-2">
                <label className="flex flex-col text-xs">{d.area}
                  <select value={area} onChange={(e) => setArea(e.target.value)} className="mt-1 rounded border border-slate-300 px-2 py-1.5">
                    {Object.keys(card.card.areas).map((a) => <option key={a} value={a}>{a.replace(/_/g, ' ')}</option>)}
                  </select>
                </label>
                <label className="flex flex-col text-xs">{d.discountPct}
                  <input type="number" min={0} max={50} step="0.5" value={discount} dir="ltr" onChange={(e) => setDiscount(e.target.value)} className="mt-1 w-24 rounded border border-slate-300 px-2 py-1.5" />
                </label>
              </div>
              <p className="text-xs text-slate-600">{d.priceFromList}</p>
              <div><button type="submit" className="btn-secondary" disabled={busy || lines.length === 0 || !area}>{d.makeQuote}</button></div>
            </form>
          ) : <p className="text-slate-600">{d.noPriceList}</p>}
        </div>
      )}
    </details>
  );
}
