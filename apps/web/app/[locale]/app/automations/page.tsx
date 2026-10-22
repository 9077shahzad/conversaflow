'use client';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { fill, isLocale, t, type Locale } from '@/lib/i18n';

/**
 * Automations (Wave 2, W2.1). The list editor is the main way to build a workflow (keyboard and screen-reader
 * friendly); the flow diagram shows the same steps as a picture. Rehearsal runs the steps against a sample message
 * and shows what would happen; nothing is sent. Publishing creates a numbered version; rolling back publishes an
 * earlier version again. Runs already under way keep the version they started on.
 */
type Text = { en?: string; ar?: string };
type Cond = { kind: 'within_business_hours' } | { kind: 'message_contains'; words: string[] } | { kind: 'has_tag'; tagId: string } | { kind: 'contact_language'; language: 'en' | 'ar' } | { kind: 'first_message' };
type Step =
  | { id: string; kind: 'send_reply'; text: Text; next: string | null }
  | { id: string; kind: 'send_template'; templateId: string; params: Array<{ source: 'contact_name' | 'text'; value?: string; fallback?: string }>; next: string | null }
  | { id: string; kind: 'add_tag' | 'remove_tag'; tagId: string; next: string | null }
  | { id: string; kind: 'assign'; membershipId: string; next: string | null }
  | { id: string; kind: 'wait'; minutes: number; next: string | null }
  | { id: string; kind: 'condition'; if: Cond; then: string | null; else: string | null }
  | { id: string; kind: 'handoff'; note: string; next: string | null };
type Def = { trigger: { kind: 'message_received' | 'conversation_started'; keywords: string[] }; start: string | null; steps: Step[] };
interface Summary { id: string; name: string; status: string; publishedVersion: number | null; runs7d: number; failed7d: number }
interface RunStep { seq: number; stepId: string; kind: string; outcome: string; detail: Record<string, unknown> }
interface Run { id: string; mode: string; status: string; reason: string | null; startedAt: string; version: number | null; steps?: RunStep[] }
interface Full extends Summary { draft: Def; version: number; problems: Array<{ code: string; step?: string }>; versions: Array<{ number: number; publishedAt: string; rolledBackFrom: number | null }>; runs: Run[] }
interface Access { permissions: string[] }
interface Option { id: string; label: string }
const KINDS: Step['kind'][] = ['send_reply', 'send_template', 'add_tag', 'remove_tag', 'assign', 'wait', 'condition', 'handoff'];

function blank(kind: Step['kind'], id: string): Step {
  switch (kind) {
    case 'send_reply': return { id, kind, text: { en: '', ar: '' }, next: null };
    case 'send_template': return { id, kind, templateId: '', params: [], next: null };
    case 'add_tag': case 'remove_tag': return { id, kind, tagId: '', next: null };
    case 'assign': return { id, kind, membershipId: '', next: null };
    case 'wait': return { id, kind, minutes: 60, next: null };
    case 'condition': return { id, kind, if: { kind: 'within_business_hours' }, then: null, else: null };
    case 'handoff': return { id, kind, note: '', next: null };
  }
}

export default function AutomationsPage() {
  return <Suspense><Automations /></Suspense>;
}

function Automations() {
  const params = useParams<{ locale: string }>();
  const locale: Locale = isLocale(params.locale) ? params.locale : 'en';
  const d = t(locale).automations;
  const search = useSearchParams();
  const selected = search.get('id');
  const [access, setAccess] = useState<Access | null>(null);
  useEffect(() => { api<Access>('/v1/me/access').then(setAccess).catch(() => undefined); }, []);
  const allowed = !!access?.permissions.includes('automations.manage');
  return (
    <div className="mx-auto max-w-6xl">
      <h1 className="text-2xl font-bold text-navy sm:text-3xl">{d.title}</h1>
      <p className="mt-1 text-sm text-slate-700">{d.intro}</p>
      {access && !allowed && <p className="mt-4 text-sm text-slate-700">{d.noAccess}</p>}
      {allowed && (selected ? <Editor id={selected} locale={locale} /> : <List locale={locale} />)}
    </div>
  );
}

function List({ locale }: { locale: Locale }) {
  const d = t(locale).automations;
  const router = useRouter();
  const [items, setItems] = useState<Summary[] | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [needsMfa, setNeedsMfa] = useState(false);
  useEffect(() => {
    api<Summary[]>('/v1/automations').then(setItems).catch((e) => {
      if (e instanceof ApiError && (e.code === 'mfa_required' || e.code === 'mfa_enrollment_required')) setNeedsMfa(true);
      setItems([]);
    });
  }, []);
  if (needsMfa) return <p role="status" className="mt-4 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">{d.needsMfa}</p>;
  async function create(e: React.FormEvent) {
    e.preventDefault(); setError(null);
    try {
      const r = await api<{ id: string }>('/v1/automations', { method: 'POST', body: { name } });
      router.push(`/${locale}/app/automations?id=${r.id}`);
    } catch (err) { setError(err instanceof ApiError && (err.code === 'mfa_required' || err.code === 'mfa_enrollment_required') ? d.needsMfa : t(locale).common.error); }
  }
  return (
    <>
      <form onSubmit={create} className="mt-5 flex flex-wrap items-end gap-2 rounded-xl border border-slate-200 bg-white p-4">
        <div className="min-w-0 flex-1">
          <label htmlFor="a-name" className="block text-sm font-medium text-slate-900">{d.newName}</label>
          <input id="a-name" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} dir="auto" className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-base" />
        </div>
        <button type="submit" className="btn-primary" disabled={name.trim().length < 2}>{d.create}</button>
        {error && <p role="alert" className="w-full text-sm text-red-800">{error}</p>}
      </form>
      <section className="mt-5" aria-labelledby="a-list">
        <h2 id="a-list" className="text-lg font-semibold text-navy">{d.yours}</h2>
        {items && items.length === 0 && <p className="mt-2 text-sm text-slate-700">{d.none}</p>}
        <ul className="mt-2 grid gap-2">
          {(items ?? []).map((a) => (
            <li key={a.id} className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-3">
              <Link href={`/${locale}/app/automations?id=${a.id}`} className="font-semibold text-navy underline-offset-2 hover:underline" dir="auto">{a.name}</Link>
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-800">{d.statuses[a.status] ?? a.status}</span>
              {a.publishedVersion && <span className="text-sm text-slate-700">{fill(d.versionN, { n: String(a.publishedVersion) })}</span>}
              <span className="text-sm text-slate-700">{fill(d.runs7d, { n: String(a.runs7d) })}{a.failed7d ? ` · ${fill(d.failed7d, { n: String(a.failed7d) })}` : ''}</span>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}

function Editor({ id, locale }: { id: string; locale: Locale }) {
  const d = t(locale).automations;
  const [w, setW] = useState<Full | null>(null);
  const [def, setDef] = useState<Def | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [problems, setProblems] = useState<Array<{ code: string; step?: string }>>([]);
  const [tags, setTags] = useState<Option[]>([]);
  const [members, setMembers] = useState<Option[]>([]);
  const [templates, setTemplates] = useState<Option[]>([]);
  const [run, setRun] = useState<Run | null>(null);

  const load = useCallback(async () => {
    const x = await api<Full>(`/v1/automations/${id}`);
    setW(x); setDef(x.draft); setName(x.name); setProblems(x.problems);
  }, [id]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    api<Array<{ id: string; name: string }>>('/v1/tags').then((x) => setTags(x.map((y) => ({ id: y.id, label: y.name })))).catch(() => undefined);
    api<Array<{ id: string; fullName: string; status: string; roles: string[] }>>('/v1/members')
      .then((x) => setMembers(x.filter((m) => m.status === 'active' && m.roles.some((r) => r !== 'analyst')).map((m) => ({ id: m.id, label: m.fullName })))).catch(() => undefined);
    api<Array<{ id: string; name: string; language: string; status: string }>>('/v1/templates')
      .then((x) => setTemplates(x.filter((y) => y.status === 'approved').map((y) => ({ id: y.id, label: `${y.name} (${y.language})` })))).catch(() => undefined);
  }, []);

  async function act(fn: () => Promise<unknown>, ok: string) {
    setBusy(true); setNotice(null);
    try { await fn(); await load(); setNotice({ ok: true, text: ok }); } catch (e) {
      if (e instanceof ApiError && Array.isArray((e.details as { problems?: unknown })?.problems)) setProblems((e.details as { problems: Array<{ code: string; step?: string }> }).problems);
      setNotice({ ok: false, text: e instanceof ApiError ? (d.errors[e.code] ?? t(locale).common.error) : t(locale).common.error });
      await load().catch(() => undefined);
    } finally { setBusy(false); }
  }
  if (!w || !def) return <p className="mt-4 text-sm text-slate-700">{t(locale).common.loading}</p>;
  const ids = def.steps.map((s) => s.id);
  const update = (i: number, s: Step) => setDef({ ...def, steps: def.steps.map((x, j) => (j === i ? s : x)) });
  const addStep = (kind: Step['kind']) => {
    let n = def.steps.length + 1; while (ids.includes(`step-${n}`)) n++;
    const id = `step-${n}`;
    // A new step follows the last one by default.
    const steps = def.steps.map((s, j) => (j === def.steps.length - 1 && s.kind !== 'condition' && s.next === null ? { ...s, next: id } : s));
    setDef({ ...def, start: def.start ?? id, steps: [...steps, blank(kind, id)] });
  };
  const remove = (i: number) => {
    const gone = def.steps[i]!.id;
    const fix = (n: string | null) => (n === gone ? null : n);
    setDef({ ...def, start: def.start === gone ? null : def.start, steps: def.steps.filter((_, j) => j !== i).map((s) => (s.kind === 'condition' ? { ...s, then: fix(s.then), else: fix(s.else) } : { ...s, next: fix(s.next) })) });
  };
  const move = (i: number, by: number) => {
    const j = i + by; if (j < 0 || j >= def.steps.length) return;
    const steps = [...def.steps]; [steps[i], steps[j]] = [steps[j]!, steps[i]!]; setDef({ ...def, steps });
  };
  const save = () => act(async () => { const r = await api<{ problems: typeof problems }>(`/v1/automations/${id}/draft`, { method: 'PUT', body: { name, draft: def, expectedVersion: w.version } }); setProblems(r.problems); }, d.saved);

  return (
    <div className="mt-4">
      <Link href={`/${locale}/app/automations`} className="text-sm text-teal underline">{d.back}</Link>
      <div className="mt-2 flex flex-wrap items-end gap-2">
        <div className="min-w-0 flex-1">
          <label htmlFor="e-name" className="block text-sm font-medium text-slate-900">{d.name}</label>
          <input id="e-name" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} dir="auto" className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-base" />
        </div>
        <span className="rounded-full bg-slate-100 px-2 py-1 text-sm font-semibold text-slate-800">{d.statuses[w.status] ?? w.status}{w.publishedVersion ? ` · ${fill(d.versionN, { n: String(w.publishedVersion) })}` : ''}</span>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" className="btn-secondary" disabled={busy} onClick={save}>{d.save}</button>
        <button type="button" className="btn-primary" disabled={busy} onClick={() => act(async () => {
          const r = await api<{ version: number }>(`/v1/automations/${id}/draft`, { method: 'PUT', body: { name, draft: def, expectedVersion: w.version } });
          await api(`/v1/automations/${id}/publish`, { method: 'POST', body: { expectedVersion: r.version } });
        }, d.published)}>{d.publish}</button>
        {w.status === 'active' && <button type="button" className="btn-secondary" disabled={busy} onClick={() => act(() => api(`/v1/automations/${id}/pause`, { method: 'POST', body: { expectedVersion: w.version } }), d.pausedNote)}>{d.pause}</button>}
        {w.status === 'paused' && <button type="button" className="btn-secondary" disabled={busy} onClick={() => act(() => api(`/v1/automations/${id}/resume`, { method: 'POST', body: { expectedVersion: w.version } }), d.resumedNote)}>{d.resume}</button>}
      </div>
      {notice && <p role={notice.ok ? 'status' : 'alert'} className={`mt-3 rounded-lg border px-3 py-2 text-sm ${notice.ok ? 'border-green-300 bg-green-50 text-green-900' : 'border-red-300 bg-red-50 text-red-800'}`}>{notice.text}</p>}
      {problems.length > 0 && (
        <div role="status" className="mt-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <p className="font-semibold">{d.problemsTitle}</p>
          <ul className="mt-1 list-disc ps-5">{problems.map((p, i) => <li key={i}>{d.problems[p.code] ?? p.code}{p.step ? ` (${p.step})` : ''}</li>)}</ul>
        </div>
      )}

      <section className="mt-5 rounded-xl border border-slate-200 bg-white p-4" aria-labelledby="e-trigger">
        <h2 id="e-trigger" className="text-lg font-semibold text-navy">{d.trigger}</h2>
        <div className="mt-2 flex flex-wrap gap-3">
          <div>
            <label htmlFor="e-tk" className="block text-sm font-medium text-slate-900">{d.when}</label>
            <select id="e-tk" value={def.trigger.kind} onChange={(e) => setDef({ ...def, trigger: { ...def.trigger, kind: e.target.value as Def['trigger']['kind'] } })} className="mt-1 rounded-lg border border-slate-300 bg-white px-2 py-2 text-base">
              <option value="message_received">{d.triggers.message_received}</option>
              <option value="conversation_started">{d.triggers.conversation_started}</option>
            </select>
          </div>
          <div className="min-w-0 flex-1">
            <label htmlFor="e-kw" className="block text-sm font-medium text-slate-900">{d.keywords}</label>
            <input id="e-kw" value={def.trigger.keywords.join(', ')} dir="auto" onChange={(e) => setDef({ ...def, trigger: { ...def.trigger, keywords: e.target.value.split(/[,،]/).map((x) => x.trim()).filter(Boolean).slice(0, 20) } })}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-base" />
            <p className="mt-1 text-xs text-slate-700">{d.keywordsHelp}</p>
          </div>
        </div>
      </section>

      <section className="mt-5 rounded-xl border border-slate-200 bg-white p-4" aria-labelledby="e-steps">
        <h2 id="e-steps" className="text-lg font-semibold text-navy">{d.steps}</h2>
        <div className="mt-2">
          <label htmlFor="e-start" className="block text-sm font-medium text-slate-900">{d.start}</label>
          <select id="e-start" value={def.start ?? ''} onChange={(e) => setDef({ ...def, start: e.target.value || null })} className="mt-1 rounded-lg border border-slate-300 bg-white px-2 py-2 text-base">
            <option value="">—</option>{ids.map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
        </div>
        <ol className="mt-3 grid gap-3">
          {def.steps.map((s, i) => (
            <li key={s.id} className="rounded-lg border border-slate-200 p-3">
              <StepEditor s={s} ids={ids} tags={tags} members={members} templates={templates} locale={locale} onChange={(x) => update(i, x)} />
              <div className="mt-2 flex flex-wrap gap-2">
                <button type="button" className="btn-secondary" onClick={() => move(i, -1)} disabled={i === 0} aria-label={fill(d.moveUp, { id: s.id })}>↑</button>
                <button type="button" className="btn-secondary" onClick={() => move(i, 1)} disabled={i === def.steps.length - 1} aria-label={fill(d.moveDown, { id: s.id })}>↓</button>
                <button type="button" className="btn-secondary" onClick={() => remove(i)}>{d.remove}</button>
              </div>
            </li>
          ))}
        </ol>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-slate-900">{d.addStep}</span>
          {KINDS.map((k) => <button key={k} type="button" className="btn-secondary" onClick={() => addStep(k)} disabled={def.steps.length >= 30}>{d.kinds[k]}</button>)}
        </div>
      </section>

      <section className="mt-5 rounded-xl border border-slate-200 bg-white p-4" aria-labelledby="e-flow">
        <h2 id="e-flow" className="text-lg font-semibold text-navy">{d.flow}</h2>
        <p className="text-sm text-slate-700">{d.flowHelp}</p>
        <FlowDiagram def={def} locale={locale} />
      </section>

      <Rehearsal id={id} locale={locale} tags={tags} onRun={setRun} beforeRun={save} />
      {run && <RunLog run={run} locale={locale} />}

      <section className="mt-5 rounded-xl border border-slate-200 bg-white p-4" aria-labelledby="e-versions">
        <h2 id="e-versions" className="text-lg font-semibold text-navy">{d.versions}</h2>
        {w.versions.length === 0 ? <p className="mt-2 text-sm text-slate-700">{d.noVersions}</p> : (
          <ul className="mt-2 grid gap-1 text-sm">
            {w.versions.map((v) => (
              <li key={v.number} className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{fill(d.versionN, { n: String(v.number) })}</span>
                <span className="text-slate-700">{new Date(v.publishedAt).toLocaleString(locale === 'ar' ? 'ar-SA-u-nu-latn-ca-gregory' : 'en-GB')}</span>
                {v.rolledBackFrom && <span className="text-slate-700">{fill(d.rolledBackFrom, { n: String(v.rolledBackFrom) })}</span>}
                {v.number !== w.publishedVersion && <button type="button" className="btn-secondary" disabled={busy} onClick={() => act(() => api(`/v1/automations/${id}/rollback`, { method: 'POST', body: { toVersion: v.number, expectedVersion: w.version } }), d.rolledBack)}>{d.rollback}</button>}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-5 rounded-xl border border-slate-200 bg-white p-4" aria-labelledby="e-runs">
        <h2 id="e-runs" className="text-lg font-semibold text-navy">{d.runs}</h2>
        {w.runs.length === 0 ? <p className="mt-2 text-sm text-slate-700">{d.noRuns}</p> : (
          <ul className="mt-2 grid gap-1 text-sm">
            {w.runs.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-2">
                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold">{d.modes[r.mode] ?? r.mode}</span>
                <span>{d.runStatuses[r.status] ?? r.status}{r.reason ? ` · ${d.reasons[r.reason.split(':')[0]!] ?? r.reason}` : ''}</span>
                <span className="text-slate-700">{new Date(r.startedAt).toLocaleString(locale === 'ar' ? 'ar-SA-u-nu-latn-ca-gregory' : 'en-GB')}</span>
                <button type="button" className="btn-secondary" onClick={async () => setRun(await api<Run>(`/v1/automation-runs/${r.id}`))}>{d.details}</button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function NextSelect({ id, label, value, ids, self, onChange }: { id: string; label: string; value: string | null; ids: string[]; self: string; onChange: (v: string | null) => void }) {
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-slate-900">{label}</label>
      <select id={id} value={value ?? ''} onChange={(e) => onChange(e.target.value || null)} className="mt-1 rounded-lg border border-slate-300 bg-white px-2 py-2 text-base">
        <option value="">⏹</option>{ids.filter((x) => x !== self).map((x) => <option key={x} value={x}>{x}</option>)}
      </select>
    </div>
  );
}

function StepEditor({ s, ids, tags, members, templates, locale, onChange }: { s: Step; ids: string[]; tags: Option[]; members: Option[]; templates: Option[]; locale: Locale; onChange: (s: Step) => void }) {
  const d = t(locale).automations;
  const f = (k: string) => `s-${s.id}-${k}`;
  const select = (k: string, label: string, value: string, opts: Option[], set: (v: string) => void) => (
    <div>
      <label htmlFor={f(k)} className="block text-sm font-medium text-slate-900">{label}</label>
      <select id={f(k)} value={value} onChange={(e) => set(e.target.value)} className="mt-1 rounded-lg border border-slate-300 bg-white px-2 py-2 text-base">
        <option value="">—</option>{opts.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
      </select>
    </div>
  );
  return (
    <div>
      <p className="text-sm font-semibold text-navy"><bdi dir="ltr">{s.id}</bdi> · {d.kinds[s.kind]}</p>
      <div className="mt-2 flex flex-wrap items-end gap-3">
        {s.kind === 'send_reply' && (
          <>
            <div className="min-w-0 flex-1">
              <label htmlFor={f('en')} className="block text-sm font-medium text-slate-900">{d.textEn}</label>
              <textarea id={f('en')} rows={2} dir="ltr" value={s.text.en ?? ''} maxLength={1000} onChange={(e) => onChange({ ...s, text: { ...s.text, en: e.target.value } })} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-base" />
            </div>
            <div className="min-w-0 flex-1">
              <label htmlFor={f('ar')} className="block text-sm font-medium text-slate-900">{d.textAr}</label>
              <textarea id={f('ar')} rows={2} dir="rtl" lang="ar" value={s.text.ar ?? ''} maxLength={1000} onChange={(e) => onChange({ ...s, text: { ...s.text, ar: e.target.value } })} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-base" />
            </div>
          </>
        )}
        {s.kind === 'send_template' && select('tpl', d.template, s.templateId, templates, (v) => onChange({ ...s, templateId: v, params: v ? [{ source: 'contact_name', fallback: locale === 'ar' ? 'عميلنا' : 'there' }] : [] }))}
        {(s.kind === 'add_tag' || s.kind === 'remove_tag') && select('tag', d.tag, s.tagId, tags, (v) => onChange({ ...s, tagId: v }))}
        {s.kind === 'assign' && select('member', d.member, s.membershipId, members, (v) => onChange({ ...s, membershipId: v }))}
        {s.kind === 'wait' && (
          <div>
            <label htmlFor={f('min')} className="block text-sm font-medium text-slate-900">{d.minutes}</label>
            <input id={f('min')} type="number" min={1} max={10080} value={s.minutes} onChange={(e) => onChange({ ...s, minutes: Math.max(1, Math.min(10080, Number(e.target.value) || 1)) })} className="mt-1 w-28 rounded-lg border border-slate-300 px-3 py-2 text-base" />
          </div>
        )}
        {s.kind === 'handoff' && (
          <div className="min-w-0 flex-1">
            <label htmlFor={f('note')} className="block text-sm font-medium text-slate-900">{d.note}</label>
            <input id={f('note')} value={s.note} maxLength={500} dir="auto" onChange={(e) => onChange({ ...s, note: e.target.value })} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-base" />
          </div>
        )}
        {s.kind === 'condition' && (
          <>
            <div>
              <label htmlFor={f('if')} className="block text-sm font-medium text-slate-900">{d.ifLabel}</label>
              <select id={f('if')} value={s.if.kind} onChange={(e) => {
                const k = e.target.value as Cond['kind'];
                const c: Cond = k === 'message_contains' ? { kind: k, words: [] } : k === 'has_tag' ? { kind: k, tagId: '' } : k === 'contact_language' ? { kind: k, language: 'ar' } : { kind: k } as Cond;
                onChange({ ...s, if: c });
              }} className="mt-1 rounded-lg border border-slate-300 bg-white px-2 py-2 text-base">
                {(['within_business_hours', 'message_contains', 'has_tag', 'contact_language', 'first_message'] as const).map((k) => <option key={k} value={k}>{d.conditions[k]}</option>)}
              </select>
            </div>
            {s.if.kind === 'message_contains' && (
              <div className="min-w-0 flex-1">
                <label htmlFor={f('words')} className="block text-sm font-medium text-slate-900">{d.words}</label>
                <input id={f('words')} dir="auto" value={s.if.words.join(', ')} onChange={(e) => onChange({ ...s, if: { kind: 'message_contains', words: e.target.value.split(/[,،]/).map((x) => x.trim()).filter(Boolean).slice(0, 20) } })} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-base" />
              </div>
            )}
            {s.if.kind === 'has_tag' && select('ctag', d.tag, s.if.tagId, tags, (v) => onChange({ ...s, if: { kind: 'has_tag', tagId: v } }))}
            {s.if.kind === 'contact_language' && (
              <div>
                <label htmlFor={f('lang')} className="block text-sm font-medium text-slate-900">{d.language}</label>
                <select id={f('lang')} value={s.if.language} onChange={(e) => onChange({ ...s, if: { kind: 'contact_language', language: e.target.value as 'en' | 'ar' } })} className="mt-1 rounded-lg border border-slate-300 bg-white px-2 py-2 text-base">
                  <option value="en">{t(locale).languageNames.en}</option><option value="ar">{t(locale).languageNames.ar}</option>
                </select>
              </div>
            )}
            <NextSelect id={f('then')} label={d.then} value={s.then} ids={ids} self={s.id} onChange={(v) => onChange({ ...s, then: v })} />
            <NextSelect id={f('else')} label={d.else} value={s.else} ids={ids} self={s.id} onChange={(v) => onChange({ ...s, else: v })} />
          </>
        )}
        {s.kind !== 'condition' && <NextSelect id={f('next')} label={d.next} value={s.next} ids={ids} self={s.id} onChange={(v) => onChange({ ...s, next: v } as Step)} />}
      </div>
    </div>
  );
}

/** The same workflow as a picture: steps in layers from the start, with arrows. Read-only; the list above edits it. */
function FlowDiagram({ def, locale }: { def: Def; locale: Locale }) {
  const d = t(locale).automations;
  const layout = useMemo(() => {
    const byId = new Map(def.steps.map((s) => [s.id, s]));
    const depth = new Map<string, number>();
    const queue: string[] = def.start && byId.has(def.start) ? [def.start] : [];
    if (queue[0]) depth.set(queue[0], 0);
    while (queue.length) {
      const id = queue.shift()!;
      const s = byId.get(id)!;
      for (const n of s.kind === 'condition' ? [s.then, s.else] : [s.next]) {
        if (n && byId.has(n) && !depth.has(n) && depth.size < 60) { depth.set(n, depth.get(id)! + 1); queue.push(n); }
      }
    }
    const rows = new Map<number, string[]>();
    for (const [id, dpt] of depth) rows.set(dpt, [...(rows.get(dpt) ?? []), id]);
    const pos = new Map<string, { x: number; y: number }>();
    for (const [dpt, list] of rows) list.forEach((id, i) => pos.set(id, { x: 20 + i * 200, y: 20 + dpt * 90 }));
    const width = Math.max(240, ...[...rows.values()].map((l) => 40 + l.length * 200));
    const height = 40 + rows.size * 90;
    return { pos, width, height, byId };
  }, [def]);
  if (layout.pos.size === 0) return <p className="mt-2 text-sm text-slate-700">{d.noFlow}</p>;
  const edges: Array<{ from: string; to: string; label?: string }> = [];
  for (const s of def.steps) {
    if (!layout.pos.has(s.id)) continue;
    if (s.kind === 'condition') { if (s.then) edges.push({ from: s.id, to: s.then, label: d.yes }); if (s.else) edges.push({ from: s.id, to: s.else, label: d.no }); }
    else if (s.next) edges.push({ from: s.id, to: s.next });
  }
  return (
    <div className="mt-3 overflow-x-auto" tabIndex={0} role="region" aria-label={d.flow}>
      <svg width={layout.width} height={layout.height} role="img" aria-label={d.flow} className="text-slate-800">
        <defs><marker id="arrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="currentColor" /></marker></defs>
        {edges.map((e, i) => {
          const a = layout.pos.get(e.from)!; const b = layout.pos.get(e.to);
          if (!b) return null;
          return (
            <g key={i}>
              <line x1={a.x + 80} y1={a.y + 44} x2={b.x + 80} y2={b.y} stroke="currentColor" strokeWidth="1.5" markerEnd="url(#arrow)" />
              {e.label && <text x={(a.x + b.x) / 2 + 86} y={(a.y + 44 + b.y) / 2} fontSize="12" fill="currentColor">{e.label}</text>}
            </g>
          );
        })}
        {[...layout.pos].map(([id, p]) => {
          const s = layout.byId.get(id)!;
          return (
            <g key={id}>
              <rect x={p.x} y={p.y} width="160" height="44" rx="8" fill={s.kind === 'condition' ? '#fef3c7' : '#e6f4f4'} stroke="#0f766e" />
              <text x={p.x + 80} y={p.y + 18} fontSize="12" textAnchor="middle" fill="#0b2545">{d.kinds[s.kind]}</text>
              <text x={p.x + 80} y={p.y + 34} fontSize="11" textAnchor="middle" fill="#334155">{id}</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function Rehearsal({ id, locale, tags, onRun, beforeRun }: { id: string; locale: Locale; tags: Option[]; onRun: (r: Run) => void; beforeRun: () => Promise<void> }) {
  const d = t(locale).automations;
  const [text, setText] = useState('');
  const [language, setLanguage] = useState<'en' | 'ar'>(locale);
  const [name, setName] = useState('');
  const [first, setFirst] = useState(true);
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  return (
    <section className="mt-5 rounded-xl border border-slate-200 bg-white p-4" aria-labelledby="e-reh">
      <h2 id="e-reh" className="text-lg font-semibold text-navy">{d.rehearse}</h2>
      <p className="text-sm text-slate-700">{d.rehearseHelp}</p>
      <form className="mt-2 grid gap-2" onSubmit={async (e) => {
        e.preventDefault(); setError(null);
        try { await beforeRun(); onRun(await api<Run>(`/v1/automations/${id}/rehearse`, { method: 'POST', body: { text, language, contactName: name || undefined, firstMessage: first, tagIds } })); }
        catch (err) { setError(err instanceof ApiError ? (d.errors[err.code] ?? t(locale).common.error) : t(locale).common.error); }
      }}>
        <label htmlFor="r-text" className="text-sm font-medium text-slate-900">{d.sampleText}</label>
        <textarea id="r-text" rows={2} dir="auto" value={text} maxLength={1000} onChange={(e) => setText(e.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-base" />
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label htmlFor="r-lang" className="block text-sm font-medium text-slate-900">{d.language}</label>
            <select id="r-lang" value={language} onChange={(e) => setLanguage(e.target.value as 'en' | 'ar')} className="mt-1 rounded-lg border border-slate-300 bg-white px-2 py-2 text-base">
              <option value="en">{t(locale).languageNames.en}</option><option value="ar">{t(locale).languageNames.ar}</option>
            </select>
          </div>
          <div>
            <label htmlFor="r-name" className="block text-sm font-medium text-slate-900">{d.sampleName}</label>
            <input id="r-name" value={name} dir="auto" maxLength={100} onChange={(e) => setName(e.target.value)} className="mt-1 rounded-lg border border-slate-300 px-3 py-2 text-base" />
          </div>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={first} onChange={(e) => setFirst(e.target.checked)} />{d.sampleFirst}</label>
          {tags.length > 0 && (
            <fieldset className="flex flex-wrap gap-2 text-sm"><legend className="sr-only">{d.sampleTags}</legend>
              {tags.map((x) => <label key={x.id} className="flex items-center gap-1"><input type="checkbox" checked={tagIds.includes(x.id)} onChange={(e) => setTagIds(e.target.checked ? [...tagIds, x.id] : tagIds.filter((y) => y !== x.id))} /><span dir="auto">{x.label}</span></label>)}
            </fieldset>
          )}
        </div>
        <div><button type="submit" className="btn-secondary" disabled={!text.trim()}>{d.runRehearsal}</button></div>
        {error && <p role="alert" className="text-sm text-red-800">{error}</p>}
      </form>
    </section>
  );
}

function RunLog({ run, locale }: { run: Run; locale: Locale }) {
  const d = t(locale).automations;
  return (
    <section className="mt-5 rounded-xl border border-slate-200 bg-white p-4" aria-labelledby="e-log" aria-live="polite">
      <h2 id="e-log" className="text-lg font-semibold text-navy">{run.mode === 'rehearsal' ? d.rehearsalResult : d.runResult}</h2>
      {run.mode === 'rehearsal' && <p className="text-sm text-slate-700">{d.rehearsalNote}</p>}
      <p className="mt-1 text-sm">{d.runStatuses[run.status] ?? run.status}{run.reason ? ` · ${d.reasons[run.reason.split(':')[0]!] ?? run.reason}` : ''}</p>
      <ol className="mt-2 grid gap-1 text-sm">
        {(run.steps ?? []).map((s) => (
          <li key={s.seq} className="rounded border border-slate-100 px-2 py-1">
            <span className="font-medium"><bdi dir="ltr">{s.stepId}</bdi> · {d.kinds[s.kind as Step['kind']] ?? s.kind}</span>{' — '}{d.outcomes[s.outcome] ?? s.outcome}
            {typeof s.detail.text === 'string' && <span className="mt-1 block whitespace-pre-wrap text-slate-800" dir="auto">“{s.detail.text}”</span>}
            {typeof s.detail.reason === 'string' && <span className="block text-amber-900">{d.reasons[s.detail.reason] ?? s.detail.reason}</span>}
            {typeof s.detail.result === 'boolean' && <span className="block text-slate-700">{s.detail.result ? d.yes : d.no}</span>}
            {typeof s.detail.minutes === 'number' && <span className="block text-slate-700">{fill(d.waitFor, { n: String(s.detail.minutes) })}</span>}
          </li>
        ))}
      </ol>
    </section>
  );
}
