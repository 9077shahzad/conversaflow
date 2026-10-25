'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { fill, formatDate, isLocale, t, type Locale } from '@/lib/i18n';

/**
 * Conversa Operator set-up (slice 1): turn the module on, the emergency pause, customer terms, price lists (draft,
 * then publish) and the quotes waiting for approval. Prices are entered in the currency's normal units here and kept in
 * minor units by the server's rules.
 */
type Settings = { enabled: boolean; mode: string; paused: boolean; termsVersion: number; termsEn: string; termsAr: string; publishedRateCard: { id: string; version: number; publishedAt: string } | null };
type Service = { serviceKey: string; nameEn: string; nameAr: string; kind: 'fixed' | 'inspection'; unitPrice: number; minQuantity?: number; maxQuantity?: number; unitCost?: number; tiers?: Array<{ fromQuantity: number; discountBp: number }> };
type CardBody = { currency: string; taxRateBp: number; taxLabel: string; calloutCharge: number; minimumCharge: number; manualDiscountLimitBp: number; approvalAbove?: number; minMarginBp?: number;
  depositBp: number; validityHours: number; services: Service[]; areas: Record<string, number> };
type Card = { id: string; version: number; status: 'draft' | 'published' | 'retired'; card: CardBody; note: string | null; createdAt: string; publishedAt: string | null };
type Approval = { id: string; conversationId: string; number: number; currency: string; totalMinor: string; needsApproval: string[]; scopeEn: string; scopeAr: string; createdAt: string; version: number };
const DIGITS: Record<string, number> = { KWD: 3, BHD: 3, OMR: 3 };
const toMinor = (v: string, cur: string) => Math.round(Number(v || '0') * 10 ** (DIGITS[cur] ?? 2));
type Row = { serviceKey: string; nameEn: string; nameAr: string; kind: 'fixed' | 'inspection'; price: string; max: string; cost: string; tierFrom: string; tierPct: string };

export default function OperatorPage() {
  const params = useParams<{ locale: string }>();
  const locale: Locale = isLocale(params.locale) ? params.locale : 'en';
  const d = t(locale).operator;
  const [perms, setPerms] = useState<string[]>([]);
  const [s, setS] = useState<Settings | null>(null);
  const [cards, setCards] = useState<Card[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [terms, setTerms] = useState({ en: '', ar: '' });
  const [cur, setCur] = useState('SAR');
  const [tax, setTax] = useState('15');
  const [taxLabel, setTaxLabel] = useState('VAT');
  const [callout, setCallout] = useState('0');
  const [minimum, setMinimum] = useState('0');
  const [discLimit, setDiscLimit] = useState('0');
  const [approvalAbove, setApprovalAbove] = useState('');
  const [deposit, setDeposit] = useState('0');
  const [validity, setValidity] = useState('48');
  const [rows, setRows] = useState<Row[]>([{ serviceKey: 'split_ac_service', nameEn: 'Split AC service', nameAr: 'صيانة مكيف سبليت', kind: 'fixed', price: '', max: '20', cost: '', tierFrom: '', tierPct: '' }]);
  const [areas, setAreas] = useState<Array<{ key: string; travel: string }>>([{ key: 'khobar', travel: '0' }]);
  const manage = perms.includes('operator.manage');
  const approve = perms.includes('operator.approve');

  const load = useCallback(async () => {
    try {
      const a = await api<{ permissions: string[] }>('/v1/me/access');
      setPerms(a.permissions);
      const st = await api<Settings>('/v1/operator/settings');
      setS(st); setTerms({ en: st.termsEn, ar: st.termsAr });
      setCards(await api<Card[]>('/v1/operator/rate-cards'));
      if (a.permissions.includes('operator.approve')) setApprovals(await api<Approval[]>('/v1/operator/approvals'));
    } catch (e) { setNotice({ ok: false, text: e instanceof ApiError && e.status === 403 ? d.noPermission : t(locale).common.error }); }
  }, [locale, d]);
  useEffect(() => { void load(); }, [load]);

  async function run(fn: () => Promise<unknown>, ok: string) {
    setBusy(true); setNotice(null);
    try { await fn(); await load(); setNotice({ ok: true, text: ok }); }
    catch (e) { setNotice({ ok: false, text: e instanceof ApiError ? (d.errors[e.code] ?? e.message) : t(locale).common.error }); }
    finally { setBusy(false); }
  }
  function draftBody(): CardBody {
    return {
      currency: cur, taxRateBp: Math.round(Number(tax) * 100), taxLabel, calloutCharge: toMinor(callout, cur), minimumCharge: toMinor(minimum, cur),
      manualDiscountLimitBp: Math.round(Number(discLimit) * 100), ...(approvalAbove ? { approvalAbove: toMinor(approvalAbove, cur) } : {}),
      depositBp: Math.round(Number(deposit) * 100), validityHours: Number(validity),
      services: rows.map((r) => ({ serviceKey: r.serviceKey.trim(), nameEn: r.nameEn.trim(), nameAr: r.nameAr.trim(), kind: r.kind, unitPrice: toMinor(r.price, cur),
        maxQuantity: Number(r.max || '20'), ...(r.cost ? { unitCost: toMinor(r.cost, cur) } : {}),
        ...(r.kind === 'fixed' && r.tierFrom && r.tierPct ? { tiers: [{ fromQuantity: Number(r.tierFrom), discountBp: Math.round(Number(r.tierPct) * 100) }] } : {}) })),
      areas: Object.fromEntries(areas.filter((a) => a.key.trim()).map((a) => [a.key.trim(), toMinor(a.travel, cur)])),
    };
  }
  const money = (minor: string | number, c: string) => new Intl.NumberFormat(locale === 'ar' ? 'ar-SA-u-nu-latn' : 'en-GB', { style: 'currency', currency: c, minimumFractionDigits: DIGITS[c] ?? 2, maximumFractionDigits: DIGITS[c] ?? 2 }).format(Number(minor) / 10 ** (DIGITS[c] ?? 2));
  const input = 'mt-1 w-full min-w-0 rounded-lg border border-slate-300 px-3 py-2 text-base';

  return (
    <div className="mx-auto max-w-5xl overflow-x-hidden">
      <h1 className="text-2xl font-bold text-navy sm:text-3xl">{d.title}</h1>
      <p className="mt-1 text-sm text-slate-700">{d.intro}</p>
      {notice && <p role={notice.ok ? 'status' : 'alert'} className={`mt-3 rounded-lg border px-3 py-2 text-sm ${notice.ok ? 'border-green-300 bg-green-50 text-green-900' : 'border-red-300 bg-red-50 text-red-800'}`}>{notice.text}</p>}
      {!s && !notice && <p role="status" className="mt-4 text-slate-600">{t(locale).common.loading}</p>}
      {s && (
        <section aria-labelledby="op-state" className="mt-5 rounded-xl border border-slate-200 bg-white p-4">
          <h2 id="op-state" className="text-lg font-semibold text-navy">{d.moduleState}</h2>
          <p className="mt-1 text-sm">{s.enabled ? d.isOn : d.isOff} · {d.modeLabel}: {d.modes[s.mode] ?? s.mode}{s.publishedRateCard ? ` · ${fill(d.priceListInUse, { v: s.publishedRateCard.version })}` : ` · ${d.noPriceList}`}</p>
          {s.paused && <p role="status" className="mt-2 rounded border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900">{d.pausedNotice}</p>}
          {manage && (
            <div className="mt-3 flex flex-wrap gap-2">
              <button type="button" className="btn-secondary" disabled={busy} onClick={() => run(() => api('/v1/operator/settings', { method: 'PUT', body: { enabled: !s.enabled } }), d.saved)}>{s.enabled ? d.turnOff : d.turnOn}</button>
              <label className="flex items-center gap-2 text-sm">{d.modeLabel}
                <select value={s.mode} disabled={busy} onChange={(e) => void run(() => api('/v1/operator/settings', { method: 'PUT', body: { mode: e.target.value } }), d.saved)} className="rounded border border-slate-300 px-2 py-1.5">
                  {(['off', 'assist', 'approval', 'limited'] as const).map((m) => <option key={m} value={m}>{d.modes[m]}</option>)}
                </select>
              </label>
              {s.paused
                ? <button type="button" className="btn-primary" disabled={busy} onClick={() => run(() => api('/v1/operator/resume', { method: 'POST' }), d.resumed)}>{d.resume}</button>
                : <button type="button" className="btn-secondary border-red-300 text-red-800" disabled={busy} onClick={() => { if (window.confirm(d.pauseConfirm)) void run(() => api('/v1/operator/pause', { method: 'POST', body: {} }), d.pausedDone); }}>{d.pause}</button>}
            </div>
          )}
          <p className="mt-2 text-xs text-slate-600">{d.modeHelp}</p>
        </section>
      )}
      {s && manage && (
        <section aria-labelledby="op-terms" className="mt-5 rounded-xl border border-slate-200 bg-white p-4">
          <h2 id="op-terms" className="text-lg font-semibold text-navy">{d.terms}</h2>
          <p className="mt-1 text-xs text-slate-600">{fill(d.termsHelp, { v: s.termsVersion })}</p>
          <form className="mt-2 grid gap-2 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); void run(() => api('/v1/operator/settings', { method: 'PUT', body: { termsEn: terms.en, termsAr: terms.ar } }), d.saved); }}>
            <label className="flex flex-col text-sm font-medium">{d.termsEn}<textarea rows={5} value={terms.en} maxLength={4000} dir="ltr" onChange={(e) => setTerms({ ...terms, en: e.target.value })} className={input} /></label>
            <label className="flex flex-col text-sm font-medium">{d.termsAr}<textarea rows={5} value={terms.ar} maxLength={4000} dir="rtl" onChange={(e) => setTerms({ ...terms, ar: e.target.value })} className={input} /></label>
            <div><button type="submit" className="btn-secondary" disabled={busy}>{d.save}</button></div>
          </form>
        </section>
      )}
      {approve && (
        <section aria-labelledby="op-appr" className="mt-5 rounded-xl border border-slate-200 bg-white p-4">
          <h2 id="op-appr" className="text-lg font-semibold text-navy">{d.approvals}</h2>
          {approvals.length === 0 ? <p className="mt-1 text-sm text-slate-600">{d.noApprovals}</p> : (
            <ul className="mt-2 grid gap-2 text-sm">
              {approvals.map((a) => (
                <li key={a.id} className="rounded border border-amber-300 bg-amber-50 p-2">
                  <p className="font-semibold">{fill(d.quoteNo, { n: a.number })} · <bdi>{money(a.totalMinor, a.currency)}</bdi> · {a.needsApproval.map((r) => d.approvalReasons[r] ?? r).join('، ')}</p>
                  <p className="text-xs" dir="auto">{locale === 'ar' ? a.scopeAr : a.scopeEn} · {formatDate(locale, a.createdAt)}</p>
                  <div className="mt-1 flex gap-2">
                    <button type="button" className="btn-secondary" disabled={busy} onClick={() => run(() => api(`/v1/operator/quotes/${a.id}/approve`, { method: 'POST', body: { expectedVersion: a.version } }), d.approved)}>{d.approve}</button>
                    <Link href={`/${locale}/app/inbox`} className="text-sm font-semibold text-teal underline">{d.openConversation}</Link>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      <section aria-labelledby="op-cards" className="mt-5 rounded-xl border border-slate-200 bg-white p-4">
        <h2 id="op-cards" className="text-lg font-semibold text-navy">{d.priceLists}</h2>
        {cards.length === 0 ? <p className="mt-1 text-sm text-slate-600">{d.noPriceLists}</p> : (
          <ul className="mt-2 grid gap-2 text-sm">
            {cards.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 rounded border border-slate-200 p-2">
                <span>{fill(d.priceListVersion, { v: c.version })} · {d.cardStatus[c.status]} · {c.card.services.length} {d.servicesCount} · {c.card.currency}{c.note ? ` · ${c.note}` : ''}</span>
                {manage && c.status === 'draft' && <button type="button" className="btn-secondary" disabled={busy} onClick={() => { if (window.confirm(d.publishConfirm)) void run(() => api(`/v1/operator/rate-cards/${c.id}/publish`, { method: 'POST' }), d.published); }}>{d.publish}</button>}
              </li>
            ))}
          </ul>
        )}
        {manage && (
          <form className="mt-4 grid gap-3" onSubmit={(e) => { e.preventDefault(); void run(() => api('/v1/operator/rate-cards', { method: 'POST', body: { card: draftBody() } }), d.drafted); }}>
            <h3 className="font-semibold text-slate-900">{d.newPriceList}</h3>
            <div className="grid gap-2 sm:grid-cols-4">
              <label className="flex flex-col text-sm">{d.currency}<select value={cur} onChange={(e) => setCur(e.target.value)} className={input}>{['SAR', 'AED', 'QAR', 'KWD', 'BHD', 'OMR'].map((c) => <option key={c}>{c}</option>)}</select></label>
              <label className="flex flex-col text-sm">{d.taxRate}<input type="number" min={0} max={50} step="0.01" value={tax} dir="ltr" onChange={(e) => setTax(e.target.value)} className={input} /></label>
              <label className="flex flex-col text-sm">{d.taxName}<input value={taxLabel} maxLength={30} onChange={(e) => setTaxLabel(e.target.value)} className={input} /></label>
              <label className="flex flex-col text-sm">{d.validity}<input type="number" min={1} max={720} value={validity} dir="ltr" onChange={(e) => setValidity(e.target.value)} className={input} /></label>
              <label className="flex flex-col text-sm">{d.calloutCharge}<input type="number" min={0} step="0.01" value={callout} dir="ltr" onChange={(e) => setCallout(e.target.value)} className={input} /></label>
              <label className="flex flex-col text-sm">{d.minimumCharge}<input type="number" min={0} step="0.01" value={minimum} dir="ltr" onChange={(e) => setMinimum(e.target.value)} className={input} /></label>
              <label className="flex flex-col text-sm">{d.depositPct}<input type="number" min={0} max={100} step="0.5" value={deposit} dir="ltr" onChange={(e) => setDeposit(e.target.value)} className={input} /></label>
              <label className="flex flex-col text-sm">{d.discountLimit}<input type="number" min={0} max={50} step="0.5" value={discLimit} dir="ltr" onChange={(e) => setDiscLimit(e.target.value)} className={input} /></label>
              <label className="flex flex-col text-sm">{d.approvalAbove}<input type="number" min={0} step="0.01" value={approvalAbove} dir="ltr" onChange={(e) => setApprovalAbove(e.target.value)} className={input} /></label>
            </div>
            <fieldset className="grid gap-2"><legend className="text-sm font-semibold">{d.services}</legend>
              {rows.map((r, i) => {
                const set = (patch: Partial<Row>) => setRows(rows.map((x, j) => (j === i ? { ...x, ...patch } : x)));
                return (
                  <div key={i} className="grid gap-2 rounded border border-slate-200 p-2 sm:grid-cols-5">
                    <label className="flex flex-col text-xs">{d.code}<input value={r.serviceKey} maxLength={40} dir="ltr" onChange={(e) => set({ serviceKey: e.target.value })} className={input} /></label>
                    <label className="flex flex-col text-xs">{d.nameEn}<input value={r.nameEn} maxLength={80} dir="ltr" onChange={(e) => set({ nameEn: e.target.value })} className={input} /></label>
                    <label className="flex flex-col text-xs">{d.nameAr}<input value={r.nameAr} maxLength={80} dir="rtl" onChange={(e) => set({ nameAr: e.target.value })} className={input} /></label>
                    <label className="flex flex-col text-xs">{d.kind}<select value={r.kind} onChange={(e) => set({ kind: e.target.value as Row['kind'] })} className={input}><option value="fixed">{d.kinds.fixed}</option><option value="inspection">{d.kinds.inspection}</option></select></label>
                    <label className="flex flex-col text-xs">{r.kind === 'inspection' ? d.visitPrice : d.unitPrice}<input type="number" min={0} step="0.01" value={r.price} dir="ltr" onChange={(e) => set({ price: e.target.value })} className={input} /></label>
                    <label className="flex flex-col text-xs">{d.maxQty}<input type="number" min={1} max={100} value={r.max} dir="ltr" onChange={(e) => set({ max: e.target.value })} className={input} /></label>
                    <label className="flex flex-col text-xs">{d.unitCost}<input type="number" min={0} step="0.01" value={r.cost} dir="ltr" onChange={(e) => set({ cost: e.target.value })} className={input} /></label>
                    {r.kind === 'fixed' && <label className="flex flex-col text-xs">{d.tierFrom}<input type="number" min={2} max={100} value={r.tierFrom} dir="ltr" onChange={(e) => set({ tierFrom: e.target.value })} className={input} /></label>}
                    {r.kind === 'fixed' && <label className="flex flex-col text-xs">{d.tierPct}<input type="number" min={0} max={50} step="0.5" value={r.tierPct} dir="ltr" onChange={(e) => set({ tierPct: e.target.value })} className={input} /></label>}
                    <div className="flex items-end"><button type="button" className="btn-secondary" onClick={() => setRows(rows.filter((_, j) => j !== i))} disabled={rows.length === 1}>{d.remove}</button></div>
                  </div>
                );
              })}
              <button type="button" className="btn-secondary justify-self-start" onClick={() => setRows([...rows, { serviceKey: '', nameEn: '', nameAr: '', kind: 'fixed', price: '', max: '20', cost: '', tierFrom: '', tierPct: '' }])}>{d.addService}</button>
            </fieldset>
            <fieldset className="grid gap-2"><legend className="text-sm font-semibold">{d.areas}</legend>
              {areas.map((a, i) => (
                <div key={i} className="flex flex-wrap items-end gap-2">
                  <label className="flex flex-col text-xs">{d.areaCode}<input value={a.key} maxLength={60} dir="ltr" onChange={(e) => setAreas(areas.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))} className={input} /></label>
                  <label className="flex flex-col text-xs">{d.travelCharge}<input type="number" min={0} step="0.01" value={a.travel} dir="ltr" onChange={(e) => setAreas(areas.map((x, j) => (j === i ? { ...x, travel: e.target.value } : x)))} className={input} /></label>
                  <button type="button" className="btn-secondary" disabled={areas.length === 1} onClick={() => setAreas(areas.filter((_, j) => j !== i))}>{d.remove}</button>
                </div>
              ))}
              <button type="button" className="btn-secondary justify-self-start" onClick={() => setAreas([...areas, { key: '', travel: '0' }])}>{d.addArea}</button>
            </fieldset>
            <p className="text-xs text-slate-600">{d.draftHelp}</p>
            <div><button type="submit" className="btn-primary" disabled={busy}>{d.saveDraft}</button></div>
          </form>
        )}
      </section>
    </div>
  );
}
