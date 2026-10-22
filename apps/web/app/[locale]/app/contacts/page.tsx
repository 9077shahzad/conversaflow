'use client';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { fill, isLocale, t, type Locale } from '@/lib/i18n';

/**
 * Contacts (Wave 1): the company's contacts, and import from a CSV file in two steps (check, then import), with undo.
 * The server checks every row again at import time; nothing is ever sent by an import.
 */
interface Contact { id: string; name: string | null; language: string | null; whatsapp: string | null; optedOut: boolean; marketingConsentAt: string | null; importId: string | null; createdAt: string }
interface Preview {
  id: string;
  summary: { rows: number; new: number; existing: number; problemCount: number; problems: Record<string, number>; consentToRecord: number;
    consentAlready: number; consentRefusedOptedOut: number; ignoredColumns: string[]; needsEvidence: boolean };
  problemRows: Array<{ line: number; problem: string }>;
  sample: Array<{ line: number; phone: string; name: string | null; language: string | null; consent: boolean | null; outcome: string }>;
}
interface Batch {
  id: string; fileName: string; status: string; createdAt: string; importedAt: string | null; undoneAt: string | null;
  summary: { result?: { created: number; updated: number; consentGranted: number; skipped: number }; undo?: { removed: number; kept: number; consentWithdrawn: number } };
}
interface Access { permissions: string[] }
const MAX_BYTES = 2 * 1024 * 1024;

export default function Contacts() {
  const params = useParams<{ locale: string }>();
  const locale: Locale = isLocale(params.locale) ? params.locale : 'en';
  const d = t(locale).contacts;
  const [access, setAccess] = useState<Access | null>(null);
  const [rows, setRows] = useState<Contact[] | null>(null);
  const [q, setQ] = useState('');
  const can = (p: string) => !!access?.permissions.includes(p);

  const load = useCallback(async (term: string) => {
    try { setRows(await api<Contact[]>(`/v1/contacts?limit=100${term ? `&q=${encodeURIComponent(term)}` : ''}`)); } catch { setRows([]); }
  }, []);
  useEffect(() => { api<Access>('/v1/me/access').then(setAccess).catch(() => undefined); }, []);
  useEffect(() => { const h = setTimeout(() => void load(q), 250); return () => clearTimeout(h); }, [q, load]);

  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="text-2xl font-bold text-navy sm:text-3xl">{d.title}</h1>
      <p className="mt-1 max-w-3xl text-sm text-slate-700">{d.intro}</p>

      {access && (can('contacts.import') ? <Importer locale={locale} onDone={() => load(q)} /> : <p className="mt-4 text-sm text-slate-700">{d.noImport}</p>)}

      <section className="mt-6" aria-labelledby="contacts-list">
        <h2 id="contacts-list" className="sr-only">{d.title}</h2>
        <label htmlFor="contacts-q" className="block text-sm font-medium text-slate-900">{d.search}</label>
        <input id="contacts-q" type="search" value={q} onChange={(e) => setQ(e.target.value)} dir="auto"
          className="mt-1 w-full max-w-md rounded-lg border border-slate-300 bg-white px-3 py-2 text-base" />
        {!rows ? <p className="mt-4 text-slate-600">{t(locale).common.loading}</p>
          : rows.length === 0 ? <p className="mt-4 text-slate-600">{q ? d.noMatch : d.empty}</p>
          : (
            <div className="mt-3 overflow-x-auto rounded-xl border border-slate-200 bg-white" tabIndex={0} role="region" aria-label={d.title}>
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-start text-slate-700">
                  <tr>
                    <th scope="col" className="px-3 py-2 text-start font-semibold">{d.name}</th>
                    <th scope="col" className="px-3 py-2 text-start font-semibold">{d.number}</th>
                    <th scope="col" className="px-3 py-2 text-start font-semibold">{d.language}</th>
                    <th scope="col" className="px-3 py-2 text-start font-semibold">{d.consent}</th>
                    <th scope="col" className="px-3 py-2 text-start font-semibold">{d.status}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {rows.map((c) => (
                    <tr key={c.id}>
                      <td className="px-3 py-2 text-navy" dir="auto">{c.name ?? '—'}{c.importId && <span className="ms-2 rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-700">{d.importedTag}</span>}</td>
                      <td className="px-3 py-2 tabular-nums" dir="ltr">{c.whatsapp ? `+${c.whatsapp}` : '—'}</td>
                      <td className="px-3 py-2">{c.language ? d.languages[c.language] ?? c.language : '—'}</td>
                      <td className="px-3 py-2">{c.marketingConsentAt ? d.consentYes : d.consentNo}</td>
                      <td className="px-3 py-2">{c.optedOut ? <span className="font-semibold text-red-800">{d.optedOut}</span> : d.active}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </section>
    </div>
  );
}

function Importer({ locale, onDone }: { locale: Locale; onDone: () => void }) {
  const d = t(locale).contacts;
  const [fileName, setFileName] = useState('');
  const [csv, setCsv] = useState('');
  const [evidence, setEvidence] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [needsMfa, setNeedsMfa] = useState(false);
  const [undoing, setUndoing] = useState<string | null>(null);

  const explain = (e: unknown) => {
    if (e instanceof ApiError && (e.code === 'mfa_enrollment_required' || e.code === 'mfa_required')) { setNeedsMfa(true); return null; }
    return e instanceof ApiError ? (locale === 'en' && e.message ? e.message : d.errorGeneric) : d.errorGeneric;
  };
  const loadBatches = useCallback(() => api<Batch[]>('/v1/contacts/imports').then((b) => { setBatches(b); setNeedsMfa(false); }).catch((e) => explain(e)), []);
  useEffect(() => { void loadBatches(); }, [loadBatches]);

  async function check() {
    setBusy(true); setError(null); setDone(null);
    try { setPreview(await api<Preview>('/v1/contacts/imports', { method: 'POST', body: { fileName: fileName || 'contacts.csv', csv, consentEvidence: evidence.trim() || null } })); }
    catch (e) { setPreview(null); setError(explain(e)); } finally { setBusy(false); }
  }
  async function commit() {
    if (!preview) return;
    setBusy(true); setError(null);
    try {
      const b = await api<Batch>(`/v1/contacts/imports/${preview.id}/commit`, { method: 'POST' });
      const r = b.summary.result!;
      setDone(fill(d.importedResult, { created: String(r.created), updated: String(r.updated), consent: String(r.consentGranted), skipped: String(r.skipped) }));
      setPreview(null); setCsv(''); setFileName(''); setEvidence('');
      onDone(); void loadBatches();
    } catch (e) { setError(explain(e)); } finally { setBusy(false); }
  }
  async function undo(id: string) {
    setBusy(true); setError(null);
    try {
      const b = await api<Batch>(`/v1/contacts/imports/${id}/undo`, { method: 'POST' });
      const u = b.summary.undo!;
      setDone(fill(d.undone, { removed: String(u.removed), kept: String(u.kept), consent: String(u.consentWithdrawn) }));
      setUndoing(null); onDone(); void loadBatches();
    } catch (e) { setError(explain(e)); } finally { setBusy(false); }
  }

  if (needsMfa) return <p role="status" className="mt-4 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">{d.needsMfa}</p>;
  const s = preview?.summary;
  const importable = s ? s.new + s.existing : 0;
  return (
    <section className="mt-5 rounded-xl border border-slate-200 bg-white p-4" aria-labelledby="import-h">
      <h2 id="import-h" className="text-lg font-semibold text-navy">{d.importTitle}</h2>
      <p className="mt-1 max-w-3xl text-sm text-slate-700">{d.importHelp}</p>
      <div className="mt-3 grid gap-3">
        <div>
          <label htmlFor="import-file" className="block text-sm font-medium text-slate-900">{d.file}</label>
          <input id="import-file" type="file" accept=".csv,text/csv" className="mt-1 block text-sm" onChange={async (e) => {
            const f = e.target.files?.[0];
            setPreview(null); setDone(null); setError(null);
            if (!f) return;
            if (f.size > MAX_BYTES) { setError(d.fileTooBig); setCsv(''); return; }
            setFileName(f.name); setCsv(await f.text());
          }} />
        </div>
        <div>
          <label htmlFor="import-evidence" className="block text-sm font-medium text-slate-900">{d.evidence}</label>
          <textarea id="import-evidence" value={evidence} onChange={(e) => setEvidence(e.target.value)} rows={2} maxLength={500} dir="auto"
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-base" />
          <p className="mt-1 text-xs text-slate-700">{d.evidenceHelp}</p>
        </div>
        <div><button type="button" className="btn-secondary" disabled={busy || !csv} onClick={check}>{d.preview}</button></div>
      </div>

      {error && <p role="alert" className="mt-3 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
      {done && <p role="status" className="mt-3 rounded-lg border border-green-300 bg-green-50 px-3 py-2 text-sm text-green-900">{done}</p>}

      {s && preview && (
        <div className="mt-4 grid gap-2 rounded-lg bg-slate-50 p-3 text-sm text-slate-800">
          <p className="font-semibold">{fill(d.summary, { rows: String(s.rows), new: String(s.new), existing: String(s.existing), problems: String(s.problemCount) })} <span className="font-normal text-slate-700">{d.previewNote}</span></p>
          {(s.consentToRecord + s.consentAlready + s.consentRefusedOptedOut) > 0 && (
            <p>{fill(d.consentSummary, { grant: String(s.consentToRecord), already: String(s.consentAlready), refused: String(s.consentRefusedOptedOut) })}</p>
          )}
          {s.ignoredColumns.length > 0 && <p>{fill(d.ignored, { cols: s.ignoredColumns.join(', ') })}</p>}
          {s.needsEvidence && <p role="alert" className="font-semibold text-amber-900">{d.needsEvidence}</p>}
          {preview.problemRows.length > 0 && (
            <div>
              <h3 className="font-semibold">{d.problemsTitle}</h3>
              <ul className="mt-1 grid gap-0.5">
                {preview.problemRows.map((p) => <li key={p.line}>{fill(d.line, { n: String(p.line) })}: {d.problems[p.problem] ?? p.problem}</li>)}
              </ul>
            </div>
          )}
          {preview.sample.length > 0 && (
            <div className="overflow-x-auto" tabIndex={0} role="region" aria-label={d.sampleTitle}>
              <h3 className="font-semibold">{d.sampleTitle}</h3>
              <table className="mt-1 text-sm">
                <tbody>
                  {preview.sample.map((r) => (
                    <tr key={r.line}>
                      <td className="pe-3 tabular-nums" dir="ltr">+{r.phone}</td>
                      <td className="pe-3" dir="auto">{r.name ?? '—'}</td>
                      <td className="pe-3">{d.outcome[r.outcome] ?? r.outcome}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div><button type="button" className="btn-primary" disabled={busy || importable === 0 || s.needsEvidence} onClick={commit}>{fill(d.import, { n: String(importable) })}</button></div>
        </div>
      )}

      {batches.length > 0 && (
        <div className="mt-5">
          <h3 className="font-semibold text-navy">{d.history}</h3>
          <ul className="mt-2 grid gap-2">
            {batches.map((b) => (
              <li key={b.id} className="flex flex-wrap items-center gap-2 text-sm text-slate-800">
                <span dir="auto" className="font-medium">{b.fileName}</span>
                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold">{d.statuses[b.status] ?? b.status}</span>
                {b.summary.result && <span>{fill(d.importedResult, { created: String(b.summary.result.created), updated: String(b.summary.result.updated), consent: String(b.summary.result.consentGranted), skipped: String(b.summary.result.skipped) })}</span>}
                {b.status === 'imported' && (undoing === b.id
                  ? <><span className="text-red-800">{d.undoConfirm}</span><button type="button" className="btn-danger" disabled={busy} onClick={() => undo(b.id)}>{d.undo}</button></>
                  : <button type="button" className="btn-secondary" onClick={() => setUndoing(b.id)}>{d.undo}</button>)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
