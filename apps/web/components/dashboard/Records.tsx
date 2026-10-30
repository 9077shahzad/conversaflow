'use client';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import type { Locale } from '@/lib/i18n';
import type { InsightsText } from '@/lib/i18n-insights';
import { useFormat } from './Charts';

/**
 * The messages behind a dashboard figure: metadata only, newest first, with the inbox's conversation visibility
 * (the server leaves out conversations the person cannot open and says how many).
 */
export interface Drill { what: string; query: Record<string, string> }
interface Rec { id: string; conversationId: string; at: string; direction: string; status: string; kind: string; country: string; channelLabel: string; sender: string | null }
interface Page { records: Rec[]; next: string | null; hiddenOutsideYourConversations: number }

export function Records({ locale, d, drill, onClose }: { locale: Locale; d: InsightsText; drill: Drill; onClose: () => void }) {
  const f = useFormat(locale);
  const [rows, setRows] = useState<Rec[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [hidden, setHidden] = useState(0);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const heading = useRef<HTMLHeadingElement>(null);

  const load = async (before?: string) => {
    setLoading(true); setError(false);
    const qs = new URLSearchParams({ ...drill.query, ...(before ? { before } : {}) });
    try {
      const p = await api<Page>(`/v1/reports/dashboard/records?${qs}`);
      setRows((r) => (before ? [...r, ...p.records] : p.records)); setNext(p.next); setHidden(p.hiddenOutsideYourConversations);
    } catch { setError(true); } finally { setLoading(false); }
  };
  useEffect(() => { void load(); heading.current?.focus(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [JSON.stringify(drill.query)]);

  const time = (iso: string) => new Intl.DateTimeFormat(locale === 'ar' ? 'ar-AE-u-nu-latn-ca-gregory' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
  return (
    <section className="mt-5 rounded-xl border border-teal/40 bg-white p-4" aria-labelledby="records-h">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 id="records-h" ref={heading} tabIndex={-1} className="text-lg font-semibold text-navy outline-none">{d.recordsTitle}</h2>
          <p className="text-sm text-slate-700">{d.recordsFor.replace('{what}', drill.what)}</p>
        </div>
        <button type="button" className="btn-secondary" onClick={onClose}>{d.close}</button>
      </div>
      {error && <p role="alert" className="mt-3 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">{d.error}</p>}
      {!error && !loading && rows.length === 0 && <p className="mt-3 text-sm text-slate-700">{d.noRecords}</p>}
      {rows.length > 0 && (
        <div className="mt-3 max-h-[28rem] overflow-auto rounded-lg border border-slate-200" tabIndex={0} role="region" aria-label={d.recordsTitle}>
          <table className="min-w-full text-sm">
            <thead className="sticky top-0 bg-slate-50 text-slate-900">
              <tr>
                {(['at', 'direction', 'status', 'kind', 'country', 'channel', 'sender'] as const).map((c) => (
                  <th key={c} scope="col" className="whitespace-nowrap px-3 py-2 text-start font-semibold">{d.cols[c]}</th>
                ))}
                <th scope="col" className="px-3 py-2"><span className="sr-only">{d.openConversation}</span></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-slate-100">
                  <td className="whitespace-nowrap px-3 py-1.5 tabular-nums">{time(r.at)}</td>
                  <td className="px-3 py-1.5">{d.directions[r.direction] ?? r.direction}</td>
                  <td className="px-3 py-1.5">{d.statuses[r.status] ?? r.status}</td>
                  <td className="px-3 py-1.5">{d.kinds[r.kind] ?? r.kind}</td>
                  <td className="px-3 py-1.5">{f.country(r.country, d.other)}</td>
                  <td className="px-3 py-1.5" dir="auto">{r.channelLabel}</td>
                  <td className="px-3 py-1.5" dir="auto">{r.direction === 'in' ? '—' : r.sender === null ? d.automatic : r.sender === 'member' ? d.member : r.sender}</td>
                  <td className="px-3 py-1.5"><Link className="font-medium text-teal hover:underline" href={`/${locale}/app/inbox?c=${r.conversationId}`}>{d.openConversation}</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {hidden > 0 && <p className="mt-2 text-sm text-slate-700">{d.hiddenNote.replace('{n}', f.n(hidden))}</p>}
      {next && <button type="button" className="btn-secondary mt-3" disabled={loading} onClick={() => void load(next)}>{d.more}</button>}
      {loading && <p className="mt-2 text-sm text-slate-700" role="status">{d.loading}</p>}
    </section>
  );
}
