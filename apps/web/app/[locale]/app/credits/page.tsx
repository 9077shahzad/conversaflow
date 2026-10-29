'use client';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { fill, formatDate, isLocale, t, type Locale } from '@/lib/i18n';

/**
 * Prepaid WhatsApp message credits (migration 0061): balance, top-ups and receipts, automatic top-up (off unless
 * turned on), the low-balance alert, refunds of unused credit, history and the monthly statement. Separate from the
 * subscription. In test mode no money moves and the page says so.
 */
type Account =
  | { mode: 'meta_direct' }
  | { mode: 'prepaid'; provider: { name: string; testMode: boolean } | null; currency: string; balanceMinor: number; reservedMinor: number; availableMinor: number;
      lowThresholdMinor: number; marginBp: number; minTopUpMinor: number;
      auto: { enabled: boolean; thresholdMinor: number | null; amountMinor: number | null; dailyLimitMinor: number | null; methodId: string | null; consentText: string };
      methods: Array<{ id: string; label: string }>; notices: Array<{ id: string; kind: string; data: Record<string, unknown>; createdAt: string; readAt: string | null }> };
type Entry = { id: string; kind: string; amountMinor: number; reservedDelta: number; balanceAfter: number; market: string | null; category: string | null; note: string | null; createdAt: string };
type TopUp = { id: string; amountMinor: number; currency: string; kind: string; status: string; failureReason: string | null; refundedMinor: number; reversed: boolean; receiptNo: string | null; createdAt: string };
type Doc = { type: 'receipt' | 'credit_note'; testMode: boolean; number: string; amountMinor: number; currency: string; date: string; company: string; issuer: string; description: string; forReceipt?: string };
type Statement = { month: string; currency: string; openingMinor: number; closingMinor: number; topupsMinor: number; chargesMinor: number; chargedMessages: number; refundsMinor: number; reversalsMinor: number; adjustmentsMinor: number };

export default function CreditsPage() {
  const params = useParams<{ locale: string }>();
  const locale: Locale = isLocale(params.locale) ? params.locale : 'en';
  const d = t(locale).credits;
  const [perms, setPerms] = useState<string[]>([]);
  const [acct, setAcct] = useState<Account | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [tops, setTops] = useState<TopUp[]>([]);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [amount, setAmount] = useState('100');
  const [pending, setPending] = useState<string | null>(null);
  const [threshold, setThreshold] = useState('');
  const [auto, setAuto] = useState({ threshold: '50', amount: '200', daily: '600', methodId: '', agree: false });
  const [refund, setRefund] = useState<{ id: string; amount: string; reason: string } | null>(null);
  const [doc, setDoc] = useState<Doc | null>(null);
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const [statement, setStatement] = useState<Statement | null>(null);
  const manage = perms.includes('billing.manage');

  const load = useCallback(async () => {
    try {
      const a = await api<{ permissions: string[] }>('/v1/me/access');
      setPerms(a.permissions);
      const ac = await api<Account>('/v1/credits');
      setAcct(ac);
      if (ac.mode === 'prepaid') {
        setEntries(await api<Entry[]>('/v1/credits/entries?limit=50'));
        setTops(await api<TopUp[]>('/v1/credits/topups'));
        setThreshold((v) => v || String(ac.lowThresholdMinor / 100));
      }
    } catch (e) { setNotice({ ok: false, text: e instanceof ApiError && e.status === 403 ? d.noPermission : t(locale).common.error }); }
  }, [locale, d]);
  useEffect(() => { void load(); }, [load]);
  // Back from the test checkout (or reloaded): the pending test top-up is offered again for simulation.
  useEffect(() => {
    const ref = new URLSearchParams(window.location.search).get('testCheckout');
    const m = ref ? /^pay_test_([0-9a-f-]{36})$/.exec(ref) : null;
    if (m) setPending(m[1]!);
  }, []);

  async function run(fn: () => Promise<unknown>, ok: string) {
    setBusy(true); setNotice(null);
    try { await fn(); await load(); setNotice({ ok: true, text: ok }); }
    catch (e) { setNotice({ ok: false, text: e instanceof ApiError ? (d.errors[e.code] ?? e.message) : t(locale).common.error }); }
    finally { setBusy(false); }
  }
  const cur = acct?.mode === 'prepaid' ? acct.currency : 'SAR';
  const money = (minor: number) => new Intl.NumberFormat(locale === 'ar' ? 'ar-SA-u-nu-latn' : 'en-GB', { style: 'currency', currency: cur }).format(minor / 100);
  const minor = (v: string) => Math.round(Number(v || '0') * 100);
  const input = 'mt-1 w-full min-w-0 rounded-lg border border-slate-300 px-3 py-2 text-base';
  const card = 'mt-5 rounded-xl border border-slate-200 bg-white p-4';

  return (
    <div className="mx-auto max-w-5xl overflow-x-hidden">
      <h1 className="text-2xl font-bold text-navy sm:text-3xl">{d.title}</h1>
      <p className="mt-1 text-sm text-slate-700">{d.intro}</p>
      {notice && <p role={notice.ok ? 'status' : 'alert'} className={`mt-3 rounded-lg border px-3 py-2 text-sm ${notice.ok ? 'border-green-300 bg-green-50 text-green-900' : 'border-red-300 bg-red-50 text-red-800'}`}>{notice.text}</p>}
      {!acct && !notice && <p role="status" className="mt-4 text-slate-600">{t(locale).common.loading}</p>}

      {acct?.mode === 'meta_direct' && (
        <section className={card} aria-labelledby="cr-direct">
          <h2 id="cr-direct" className="text-lg font-semibold text-navy">{d.directTitle}</h2>
          <p className="mt-1 text-sm text-slate-700">{d.directBody}</p>
        </section>
      )}

      {acct?.mode === 'prepaid' && (
        <>
          {acct.provider?.testMode && <p role="note" className="mt-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-900">{d.testMode}</p>}
          {!acct.provider && <p role="note" className="mt-3 rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm">{d.paymentsOff}</p>}
          <section className={card} aria-labelledby="cr-balance">
            <h2 id="cr-balance" className="text-lg font-semibold text-navy">{d.balanceTitle}</h2>
            <dl className="mt-2 grid gap-3 sm:grid-cols-3">
              <div className="rounded-lg bg-slate-50 p-3"><dt className="text-xs text-slate-600">{d.available}</dt><dd className={`text-2xl font-bold ${acct.availableMinor < acct.lowThresholdMinor ? 'text-red-700' : 'text-navy'}`}><bdi>{money(acct.availableMinor)}</bdi></dd></div>
              <div className="rounded-lg bg-slate-50 p-3"><dt className="text-xs text-slate-600">{d.reserved}</dt><dd className="text-xl font-semibold"><bdi>{money(acct.reservedMinor)}</bdi></dd></div>
              <div className="rounded-lg bg-slate-50 p-3"><dt className="text-xs text-slate-600">{d.balance}</dt><dd className="text-xl font-semibold"><bdi>{money(acct.balanceMinor)}</bdi></dd></div>
            </dl>
            <p className="mt-2 text-xs text-slate-600">{d.howCharged}</p>
            {acct.notices.filter((n) => !n.readAt).length > 0 && (
              <div className="mt-3 rounded border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900" role="status">
                <ul className="grid gap-1">{acct.notices.filter((n) => !n.readAt).map((n) => <li key={n.id}>{d.noticeKinds[n.kind] ?? n.kind} · {formatDate(locale, n.createdAt)}</li>)}</ul>
                <button type="button" className="mt-1 text-xs font-semibold underline" onClick={() => run(() => api('/v1/credits/notices/read', { method: 'POST' }), d.noticesCleared)}>{d.markRead}</button>
              </div>
            )}
          </section>

          {manage && acct.provider && (
            <section className={card} aria-labelledby="cr-topup">
              <h2 id="cr-topup" className="text-lg font-semibold text-navy">{d.topUpTitle}</h2>
              <form className="mt-2 flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); void run(async () => {
                const r = await api<{ id: string; checkoutUrl: string; testMode: boolean }>('/v1/credits/topups', { method: 'POST', body: { amountMinor: minor(amount) } });
                if (r.testMode) setPending(r.id); else window.location.assign(r.checkoutUrl);
              }, d.topUpStarted); }}>
                <label className="flex flex-col text-sm">{fill(d.amount, { c: cur })}<input type="number" min={acct.minTopUpMinor / 100} step="0.01" value={amount} dir="ltr" onChange={(e) => setAmount(e.target.value)} className={input} /></label>
                <button type="submit" className="btn-primary" disabled={busy}>{d.topUp}</button>
              </form>
              <p className="mt-1 text-xs text-slate-600">{fill(d.minimum, { m: money(acct.minTopUpMinor) })}</p>
              {pending && acct.provider.testMode && (
                <div className="mt-3 rounded border border-amber-300 bg-amber-50 p-2 text-sm">
                  <p>{d.simulateHelp}</p>
                  <div className="mt-1 flex flex-wrap gap-2">
                    <button type="button" className="btn-secondary" disabled={busy} onClick={() => run(async () => { await api(`/v1/credits/test/topups/${pending}/complete`, { method: 'POST', body: { outcome: 'succeeded' } }); setPending(null); }, d.paid)}>{d.simulatePaid}</button>
                    <button type="button" className="btn-secondary" disabled={busy} onClick={() => run(async () => { await api(`/v1/credits/test/topups/${pending}/complete`, { method: 'POST', body: { outcome: 'failed' } }); setPending(null); }, d.failedRecorded)}>{d.simulateFailed}</button>
                  </div>
                </div>
              )}
            </section>
          )}

          {manage && (
            <section className={card} aria-labelledby="cr-alerts">
              <h2 id="cr-alerts" className="text-lg font-semibold text-navy">{d.alertsTitle}</h2>
              <form className="mt-2 flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); void run(() => api('/v1/credits/settings', { method: 'PUT', body: { lowThresholdMinor: minor(threshold) } }), d.saved); }}>
                <label className="flex flex-col text-sm">{fill(d.lowThreshold, { c: cur })}<input type="number" min={0} step="0.01" value={threshold} dir="ltr" onChange={(e) => setThreshold(e.target.value)} className={input} /></label>
                <button type="submit" className="btn-secondary" disabled={busy}>{d.save}</button>
              </form>

              <h3 className="mt-4 font-semibold text-slate-900">{d.autoTitle}</h3>
              <p className="text-sm text-slate-700">{acct.auto.enabled ? fill(d.autoOn, { t: money(acct.auto.thresholdMinor ?? 0), a: money(acct.auto.amountMinor ?? 0), l: money(acct.auto.dailyLimitMinor ?? 0) }) : d.autoOff}</p>
              {acct.auto.enabled ? (
                <button type="button" className="btn-secondary mt-2" disabled={busy} onClick={() => run(() => api('/v1/credits/auto-topup', { method: 'PUT', body: { enabled: false } }), d.autoDisabled)}>{d.turnOff}</button>
              ) : acct.provider ? (
                <form className="mt-2 grid gap-2" onSubmit={(e) => { e.preventDefault(); void run(() => api('/v1/credits/auto-topup', { method: 'PUT', body: {
                  enabled: true, thresholdMinor: minor(auto.threshold), amountMinor: minor(auto.amount), dailyLimitMinor: minor(auto.daily), methodId: auto.methodId, consentText: acct.auto.consentText } }), d.autoEnabled); }}>
                  <div className="grid gap-2 sm:grid-cols-4">
                    <label className="flex flex-col text-sm">{d.autoThreshold}<input type="number" min={0} step="0.01" value={auto.threshold} dir="ltr" onChange={(e) => setAuto({ ...auto, threshold: e.target.value })} className={input} /></label>
                    <label className="flex flex-col text-sm">{d.autoAmount}<input type="number" min={0} step="0.01" value={auto.amount} dir="ltr" onChange={(e) => setAuto({ ...auto, amount: e.target.value })} className={input} /></label>
                    <label className="flex flex-col text-sm">{d.autoDaily}<input type="number" min={0} step="0.01" value={auto.daily} dir="ltr" onChange={(e) => setAuto({ ...auto, daily: e.target.value })} className={input} /></label>
                    <label className="flex flex-col text-sm">{d.card}<select value={auto.methodId} onChange={(e) => setAuto({ ...auto, methodId: e.target.value })} className={input}>
                      <option value="">{d.chooseCard}</option>{acct.methods.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}</select></label>
                  </div>
                  {acct.provider.testMode && (
                    <div className="flex flex-wrap gap-2 text-sm">
                      <button type="button" className="btn-secondary" disabled={busy} onClick={() => run(() => api('/v1/credits/test/methods', { method: 'POST', body: { last4: '4242' } }), d.cardAdded)}>{d.addTestCard}</button>
                      <button type="button" className="btn-secondary" disabled={busy} onClick={() => run(() => api('/v1/credits/test/methods', { method: 'POST', body: { last4: '0002' } }), d.cardAdded)}>{d.addDecliningCard}</button>
                    </div>
                  )}
                  <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={auto.agree} onChange={(e) => setAuto({ ...auto, agree: e.target.checked })} />
                    <span dir="ltr" className="text-start">{acct.auto.consentText}</span></label>
                  <p className="text-xs text-slate-600">{d.consentNote}</p>
                  <div><button type="submit" className="btn-primary" disabled={busy || !auto.agree || !auto.methodId}>{d.turnOn}</button></div>
                </form>
              ) : null}
            </section>
          )}

          <section className={card} aria-labelledby="cr-topups">
            <h2 id="cr-topups" className="text-lg font-semibold text-navy">{d.topUpsTitle}</h2>
            {tops.length === 0 ? <p className="mt-1 text-sm text-slate-600">{d.noTopUps}</p> : (
              <ul className="mt-2 grid gap-2 text-sm">
                {tops.map((x) => (
                  <li key={x.id} className="rounded border border-slate-200 p-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span><bdi>{money(x.amountMinor)}</bdi> · {d.kinds[x.kind] ?? x.kind} · {d.statuses[x.status] ?? x.status}{x.reversed ? ` · ${d.reversed}` : ''}{x.refundedMinor ? ` · ${fill(d.refunded, { a: money(x.refundedMinor) })}` : ''} · {formatDate(locale, x.createdAt)}</span>
                      <span className="flex gap-2">
                        {x.receiptNo && <button type="button" className="text-sm font-semibold text-teal underline" onClick={async () => setDoc(await api<Doc>(`/v1/credits/documents/${x.id}`))}>{fill(d.receipt, { n: x.receiptNo })}</button>}
                        {manage && x.status === 'succeeded' && !x.reversed && x.refundedMinor < x.amountMinor && acct.provider &&
                          <button type="button" className="btn-secondary" onClick={() => setRefund({ id: x.id, amount: String((x.amountMinor - x.refundedMinor) / 100), reason: '' })}>{d.refund}</button>}
                      </span>
                    </div>
                    {x.failureReason && <p className="text-xs text-red-700">{x.failureReason}</p>}
                    {refund?.id === x.id && (
                      <form className="mt-2 flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); void run(async () => {
                        const r = await api<{ id: string; status: string }>('/v1/credits/refunds', { method: 'POST', body: { topupId: x.id, amountMinor: minor(refund.amount), reason: refund.reason } });
                        setRefund(null);
                        if (r.status === 'succeeded') setDoc(await api<Doc>(`/v1/credits/documents/${r.id}`));
                        else throw new ApiError(409, r.status === 'failed' ? 'refund_refused' : 'refund_pending', '');
                      }, d.refundDone); }}>
                        <label className="flex flex-col text-xs">{fill(d.amount, { c: cur })}<input type="number" min={0.01} step="0.01" value={refund.amount} dir="ltr" onChange={(e) => setRefund({ ...refund, amount: e.target.value })} className={input} /></label>
                        <label className="flex min-w-0 flex-1 flex-col text-xs">{d.reason}<input value={refund.reason} maxLength={300} onChange={(e) => setRefund({ ...refund, reason: e.target.value })} className={input} /></label>
                        <button type="submit" className="btn-primary" disabled={busy || refund.reason.trim().length < 3}>{d.refund}</button>
                        <button type="button" className="btn-secondary" onClick={() => setRefund(null)}>{d.cancel}</button>
                      </form>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-2 text-xs text-slate-600">{d.refundRule}</p>
          </section>

          {doc && (
            <section className={card} aria-labelledby="cr-doc">
              <h2 id="cr-doc" className="text-lg font-semibold text-navy">{doc.type === 'receipt' ? d.receiptTitle : d.creditNoteTitle} <bdi dir="ltr">{doc.number}</bdi></h2>
              <dl className="mt-2 grid gap-1 text-sm sm:grid-cols-2">
                <dt className="text-slate-600">{d.issuer}</dt><dd>{doc.issuer}</dd>
                <dt className="text-slate-600">{d.customer}</dt><dd dir="auto">{doc.company}</dd>
                <dt className="text-slate-600">{d.date}</dt><dd>{formatDate(locale, doc.date)}</dd>
                <dt className="text-slate-600">{d.amountLabel}</dt><dd><bdi>{money(doc.amountMinor)}</bdi></dd>
                {doc.forReceipt && <><dt className="text-slate-600">{d.forReceipt}</dt><dd dir="ltr">{doc.forReceipt}</dd></>}
              </dl>
              {doc.testMode && <p role="note" className="mt-2 rounded border border-amber-300 bg-amber-50 p-2 text-sm font-semibold text-amber-900">{d.testDocument}</p>}
              <p className="mt-2 text-xs text-slate-600">{d.notTaxInvoice}</p>
              <div className="mt-2 flex gap-2"><button type="button" className="btn-secondary" onClick={() => window.print()}>{d.print}</button><button type="button" className="btn-secondary" onClick={() => setDoc(null)}>{d.close}</button></div>
            </section>
          )}

          <section className={card} aria-labelledby="cr-statement">
            <h2 id="cr-statement" className="text-lg font-semibold text-navy">{d.statementTitle}</h2>
            <form className="mt-2 flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); void (async () => {
              try { setStatement(await api<Statement>(`/v1/credits/statements/${month}`)); } catch (err) { setNotice({ ok: false, text: err instanceof ApiError ? (d.errors[err.code] ?? err.message) : t(locale).common.error }); }
            })(); }}>
              <label className="flex flex-col text-sm">{d.month}<input type="month" value={month} dir="ltr" onChange={(e) => setMonth(e.target.value)} className={input} /></label>
              <button type="submit" className="btn-secondary">{d.show}</button>
            </form>
            {statement && (
              <dl className="mt-3 grid gap-1 text-sm sm:grid-cols-2">
                <dt className="text-slate-600">{d.opening}</dt><dd><bdi>{money(statement.openingMinor)}</bdi></dd>
                <dt className="text-slate-600">{d.topUpsIn}</dt><dd><bdi>{money(statement.topupsMinor)}</bdi></dd>
                <dt className="text-slate-600">{fill(d.messagesCharged, { n: statement.chargedMessages })}</dt><dd><bdi>{money(-statement.chargesMinor)}</bdi></dd>
                <dt className="text-slate-600">{d.refundsOut}</dt><dd><bdi>{money(-statement.refundsMinor)}</bdi></dd>
                {statement.reversalsMinor > 0 && <><dt className="text-slate-600">{d.reversalsOut}</dt><dd><bdi>{money(-statement.reversalsMinor)}</bdi></dd></>}
                {statement.adjustmentsMinor !== 0 && <><dt className="text-slate-600">{d.adjustments}</dt><dd><bdi>{money(statement.adjustmentsMinor)}</bdi></dd></>}
                <dt className="font-semibold">{d.closing}</dt><dd className="font-semibold"><bdi>{money(statement.closingMinor)}</bdi></dd>
              </dl>
            )}
          </section>

          <section className={card} aria-labelledby="cr-history">
            <h2 id="cr-history" className="text-lg font-semibold text-navy">{d.historyTitle}</h2>
            {entries.length === 0 ? <p className="mt-1 text-sm text-slate-600">{d.noEntries}</p> : (
              <div className="mt-2 overflow-x-auto" tabIndex={0} role="region" aria-labelledby="cr-history">
                <table className="w-full min-w-[32rem] text-start text-sm">
                  <thead><tr className="border-b text-xs text-slate-600"><th className="py-1 text-start">{d.date}</th><th className="text-start">{d.what}</th><th className="text-end">{d.amountLabel}</th><th className="text-end">{d.balanceAfter}</th></tr></thead>
                  <tbody>
                    {entries.map((e) => (
                      <tr key={e.id} className="border-b border-slate-100">
                        <td className="py-1">{formatDate(locale, e.createdAt)}</td>
                        <td>{d.entryKinds[e.kind] ?? e.kind}{e.category ? ` · ${d.categories[e.category] ?? e.category}` : ''}{e.note ? ` · ${e.note}` : ''}</td>
                        <td className="text-end"><bdi>{e.kind === 'reserve' || e.kind === 'release' ? `(${money(e.reservedDelta)})` : money(e.amountMinor)}</bdi></td>
                        <td className="text-end"><bdi>{money(e.balanceAfter)}</bdi></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
