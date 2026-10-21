'use client';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { fill, isLocale, t, type Locale } from '@/lib/i18n';

/**
 * Campaigns (Wave 1). The preview is an estimate; the server checks every recipient again when their message is
 * queued and just before it is sent. Cost totals are shown only from verified rates.
 */
interface Template { id: string; name: string; language: string; category: string; status: string; paramCount: number; provider: string | null }
type Param = { source: 'contact_name'; fallback: string } | { source: 'static'; value: string };
interface Preview {
  eligible: number; contacts: number; excluded: Record<string, number>; sample: Array<{ name: string | null; text: string }>;
  dailyLimit: number; daysNeeded: number;
  cost: { state: 'estimated' | 'unavailable' | 'no_recipients'; complete: boolean; total: number | null; currency: string; missingMarkets: string[];
    lines: Array<{ market: string; recipients: number; rate: number | null }> };
}
interface Campaign {
  id: string; name: string; status: string; scheduledAt: string | null; templateName: string; templateLanguage: string;
  templateCategory: string; provider: string; progress: Record<string, number>; createdAt: string;
}
interface Suppression { id: string; waNumber: string; reason: string; note: string | null }

export default function Campaigns() {
  const params = useParams<{ locale: string }>();
  const locale: Locale = isLocale(params.locale) ? params.locale : 'en';
  const d = t(locale).campaigns;
  const [templates, setTemplates] = useState<Template[] | null>(null);
  const [rows, setRows] = useState<Campaign[] | null>(null);
  const [supp, setSupp] = useState<Suppression[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [values, setValues] = useState<Param[]>([]);
  const [recent, setRecent] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [needsMfa, setNeedsMfa] = useState(false);

  const explain = (e: unknown) => (e instanceof ApiError
    ? t(locale).inbox.errors[e.code] ?? (locale === 'en' && e.message ? e.message : d.errorGeneric) : d.errorGeneric);
  const load = useCallback(async () => {
    try { setRows(await api<Campaign[]>('/v1/campaigns')); setNeedsMfa(false); } catch (e) {
      setRows([]);
      // Campaigns need two-step sign-in: say so plainly instead of showing a form the server would refuse.
      if (e instanceof ApiError && (e.code === 'mfa_enrollment_required' || e.code === 'mfa_required')) setNeedsMfa(true); else setError(explain(e));
    }
    api<Suppression[]>('/v1/suppressions').then(setSupp).catch(() => undefined);
  }, []);
  useEffect(() => {
    void load();
    api<Template[]>('/v1/templates').then((l) => setTemplates(l.filter((x) => x.status === 'approved'))).catch(() => setTemplates([]));
    const i = setInterval(load, 10_000);
    return () => clearInterval(i);
  }, [load]);

  const tpl = templates?.find((x) => x.id === templateId) ?? null;
  const body = () => ({ templateId, params: values, audience: { recentDays: recent ? Number(recent) : null } });
  async function act(fn: () => Promise<unknown>) {
    setBusy(true); setError(null);
    try { await fn(); await load(); } catch (e) { setError(explain(e)); } finally { setBusy(false); }
  }
  const when = (iso: string) => new Intl.DateTimeFormat(locale === 'ar' ? 'ar-SA-u-nu-latn-ca-gregory' : 'en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
  const progressLabel = (k: string) => {
    const [state, reason] = k.split(':');
    const base = d.progress[state!] ?? state;
    return reason ? `${base} (${d.reasons[reason] ?? t(locale).inbox.failedTitles[reason] ?? reason})` : base;
  };

  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="text-2xl font-bold text-navy sm:text-3xl">{d.title}</h1>
      <p className="mt-1 text-sm text-slate-700">{d.intro}</p>
      {(templates?.some((x) => x.provider === 'sandbox') || rows?.some((x) => x.provider === 'sandbox')) && (
        <p role="status" className="mt-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-800">{d.sandboxNote}</p>
      )}
      {error && <p role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
      {needsMfa && <p role="status" className="mt-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">{d.needsMfa}</p>}

      {!needsMfa && <>
      <section className="mt-4 rounded-xl border border-slate-200 bg-white p-4">
        <h2 className="text-lg font-semibold text-navy">{d.newTitle}</h2>
        {templates && templates.length === 0 ? <p className="mt-2 text-sm text-slate-700">{d.noTemplates}</p> : (
          <div className="mt-2 space-y-3">
            <div>
              <label htmlFor="c-name" className="block text-sm font-medium text-slate-900">{d.name}</label>
              <input id="c-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} dir="auto"
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-base" />
            </div>
            <div>
              <label htmlFor="c-tpl" className="block text-sm font-medium text-slate-900">{d.template}</label>
              <select id="c-tpl" value={templateId} className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2 py-2 text-base"
                onChange={(e) => { setTemplateId(e.target.value); setPreview(null);
                  const n = templates?.find((x) => x.id === e.target.value)?.paramCount ?? 0;
                  setValues(Array.from({ length: n }, () => ({ source: 'contact_name', fallback: locale === 'ar' ? 'عميلنا' : 'there' }))); }}>
                <option value="">{d.chooseTemplate}</option>
                {(templates ?? []).map((x) => <option key={x.id} value={x.id}>{x.name} · {x.language} · {t(locale).inbox.categories[x.category] ?? x.category}</option>)}
              </select>
            </div>
            {tpl && values.map((v, i) => (
              <fieldset key={i} className="rounded-lg border border-slate-200 p-3">
                <legend className="px-1 text-sm font-medium text-slate-900">{fill(d.value, { n: String(i + 1) })}</legend>
                <div className="flex flex-wrap gap-3 text-sm">
                  <label className="flex items-center gap-1.5"><input type="radio" name={`src-${i}`} checked={v.source === 'contact_name'}
                    onChange={() => setValues((all) => all.map((x, j) => (j === i ? { source: 'contact_name', fallback: '' } : x)))} />{d.fromName}</label>
                  <label className="flex items-center gap-1.5"><input type="radio" name={`src-${i}`} checked={v.source === 'static'}
                    onChange={() => setValues((all) => all.map((x, j) => (j === i ? { source: 'static', value: '' } : x)))} />{d.fixedText}</label>
                </div>
                <label htmlFor={`v-${i}`} className="mt-2 block text-sm text-slate-800">{v.source === 'contact_name' ? d.fallback : d.fixed}</label>
                <input id={`v-${i}`} dir="auto" maxLength={200} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-base"
                  value={v.source === 'contact_name' ? v.fallback : v.value}
                  onChange={(e) => { const text = e.target.value.replace(/[\n\t]/g, ' ');
                    setValues((all) => all.map((x, j) => (j !== i ? x : x.source === 'contact_name' ? { ...x, fallback: text } : { ...x, value: text }))); setPreview(null); }} />
              </fieldset>
            ))}
            <div className="flex flex-wrap items-center gap-2 text-sm text-slate-800">
              <label htmlFor="c-recent">{d.recent}</label>
              <input id="c-recent" inputMode="numeric" value={recent} onChange={(e) => { setRecent(e.target.value.replace(/\D/g, '').slice(0, 3)); setPreview(null); }}
                className="w-20 rounded-lg border border-slate-300 px-2 py-1.5 text-base" />
              <span>{d.recentDays}</span>
            </div>
            <div className="flex flex-wrap gap-2">
              <button type="button" className="btn-secondary" disabled={busy || !tpl}
                onClick={() => act(async () => setPreview(await api<Preview>('/v1/campaigns/preview', { method: 'POST', body: body() })))}>{d.preview}</button>
              <button type="button" className="btn-primary" disabled={busy || !tpl || name.trim().length < 2}
                onClick={() => act(async () => { await api('/v1/campaigns', { method: 'POST', body: { name, ...body() } }); setName(''); setPreview(null); })}>{d.create}</button>
            </div>
            {preview && (
              <div className="space-y-2 rounded-lg bg-slate-50 p-3 text-sm text-slate-900" role="status">
                <p className="font-semibold">{fill(d.eligible, { n: String(preview.eligible) })} <span className="font-normal">{fill(d.contacts, { n: String(preview.contacts) })}</span></p>
                {Object.keys(preview.excluded).length > 0 && (
                  <p>{d.excluded}: {Object.entries(preview.excluded).map(([k, n]) => `${d.reasons[k] ?? k} ${n}`).join(' · ')}</p>
                )}
                <p>{fill(d.daysNeeded, { limit: String(preview.dailyLimit), days: String(preview.daysNeeded) })}</p>
                <p className="font-semibold">{d.cost}</p>
                <p>{preview.cost.lines.map((l) => fill(d.costLine, { market: l.market, n: String(l.recipients) })).join(' · ')}</p>
                <p>{preview.cost.state === 'estimated' && preview.cost.total !== null
                  ? fill(d.costTotal, { total: String(preview.cost.total), currency: preview.cost.currency })
                  : preview.cost.state === 'no_recipients' ? d.costNone
                  : fill(d.costMissing, { markets: preview.cost.missingMarkets.map((m) => d.markets[m] ?? m).join(', ') })}</p>
                {preview.sample.length > 0 && <>
                  <p className="font-semibold">{d.sample}</p>
                  <ul className="space-y-1">{preview.sample.map((s, i) => <li key={i} className="whitespace-pre-wrap break-words rounded bg-white px-2 py-1" dir="auto">{s.text}</li>)}</ul>
                </>}
              </div>
            )}
          </div>
        )}
      </section>

      <section className="mt-5">
        <h2 className="text-lg font-semibold text-navy">{d.list}</h2>
        {!rows ? <p className="mt-2 text-slate-600">{t(locale).common.loading}</p> : rows.length === 0 ? <p className="mt-2 text-sm text-slate-700">{d.empty}</p> : (
          <ul className="mt-2 space-y-3">
            {rows.map((c) => <CampaignRow key={c.id} c={c} locale={locale} busy={busy} when={when} label={progressLabel} act={act} />)}
          </ul>
        )}
      </section>

      <section className="mt-5 rounded-xl border border-slate-200 bg-white p-4">
        <h2 className="text-lg font-semibold text-navy">{d.suppression}</h2>
        <p className="text-sm text-slate-700">{d.suppressionIntro}</p>
        <SuppressionForm locale={locale} busy={busy} onAdd={(b) => act(() => api('/v1/suppressions', { method: 'POST', body: b }))} />
        {supp.length > 0 && (
          <ul className="mt-3 divide-y divide-slate-100 rounded-lg border border-slate-200">
            {supp.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
                <span className="font-medium" dir="ltr">+{s.waNumber}</span>
                <span className="min-w-0 flex-1 text-slate-700">{d.suppressionReasons[s.reason] ?? s.reason}{s.note ? <> · <span dir="auto">{s.note}</span></> : null}</span>
                <button type="button" className="btn-secondary" disabled={busy} onClick={() => act(() => api(`/v1/suppressions/${s.id}`, { method: 'DELETE' }))}>{d.remove}</button>
              </li>
            ))}
          </ul>
        )}
      </section>
      </>}
    </div>
  );
}

function CampaignRow({ c, locale, busy, when, label, act }: {
  c: Campaign; locale: Locale; busy: boolean; when: (iso: string) => string; label: (k: string) => string; act: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const d = t(locale).campaigns;
  const [at, setAt] = useState('');
  const [confirming, setConfirming] = useState(false);
  const post = (path: string, body?: unknown) => act(() => api(`/v1/campaigns/${c.id}/${path}`, { method: 'POST', body }));
  return (
    <li className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold text-navy" dir="auto">{c.name}</span>
        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-800">{d.statuses[c.status] ?? c.status}</span>
        <span className="text-sm text-slate-700" dir="ltr">{c.templateName}</span>
        {c.scheduledAt && <span className="text-sm text-slate-700">· {when(c.scheduledAt)}</span>}
      </div>
      {Object.keys(c.progress).length > 0 && (
        <p className="mt-1 text-sm text-slate-800">{Object.entries(c.progress).map(([k, n]) => `${label(k)}: ${n}`).join(' · ')}</p>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {c.status === 'draft' && (
          <>
            <label className="sr-only" htmlFor={`at-${c.id}`}>{d.scheduleAt}</label>
            <input id={`at-${c.id}`} type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} className="rounded-lg border border-slate-300 px-2 py-1.5 text-base" />
            <button type="button" className="btn-primary" disabled={busy} onClick={() => post('schedule', { at: at ? new Date(at).toISOString() : null })}>{at ? d.schedule : d.now}</button>
          </>
        )}
        {(c.status === 'scheduled' || c.status === 'running') && <button type="button" className="btn-secondary" disabled={busy} onClick={() => post('pause')}>{d.pause}</button>}
        {c.status === 'paused' && <button type="button" className="btn-secondary" disabled={busy} onClick={() => post('resume')}>{d.resume}</button>}
        {['draft', 'scheduled', 'running', 'paused'].includes(c.status) && (confirming
          ? <><span className="text-sm text-red-800">{d.cancelConfirm}</span><button type="button" className="btn-danger" disabled={busy} onClick={() => post('cancel')}>{d.cancel}</button></>
          : <button type="button" className="btn-secondary" onClick={() => setConfirming(true)}>{d.cancel}</button>)}
      </div>
    </li>
  );
}

function SuppressionForm({ locale, busy, onAdd }: { locale: Locale; busy: boolean; onAdd: (b: { waNumber: string; reason: string; note?: string }) => void }) {
  const d = t(locale).campaigns;
  const [n, setN] = useState('');
  const [reason, setReason] = useState('customer_request');
  const [note, setNote] = useState('');
  return (
    <form className="mt-2 flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); onAdd({ waNumber: n, reason, note: note || undefined }); setN(''); setNote(''); }}>
      <div>
        <label htmlFor="s-n" className="block text-sm font-medium text-slate-900">{d.number}</label>
        <input id="s-n" required dir="ltr" inputMode="tel" pattern="\+?[0-9]{6,20}" value={n} onChange={(e) => setN(e.target.value)} className="mt-1 rounded-lg border border-slate-300 px-3 py-2 text-base" />
      </div>
      <div>
        <label htmlFor="s-r" className="block text-sm font-medium text-slate-900">{d.reason}</label>
        <select id="s-r" value={reason} onChange={(e) => setReason(e.target.value)} className="mt-1 rounded-lg border border-slate-300 bg-white px-2 py-2 text-base">
          {Object.entries(d.suppressionReasons).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </div>
      <div className="min-w-0 flex-1">
        <label htmlFor="s-note" className="block text-sm font-medium text-slate-900">{d.note}</label>
        <input id="s-note" dir="auto" maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-base" />
      </div>
      <button type="submit" className="btn-primary" disabled={busy}>{d.add}</button>
    </form>
  );
}
