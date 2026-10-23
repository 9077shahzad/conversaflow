'use client';
import { useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { t, type Locale } from '@/lib/i18n';

/**
 * Agent assistance in a conversation (W2.3): a summary, a suggested reply (inserted into the reply box for the agent
 * to edit and send) and, per message, a translation that keeps the original. Results are labelled as AI, and as
 * simulated when the simulated provider produced them. Nothing here sends anything to the customer.
 */
interface AssistResult { task: string; decision: 'suggestion' | 'human_needed'; text: string | null; reason: string | null; citations: Array<{ id: string; title: string }>; simulated: boolean }

export function AiAssist({ conversationId, locale, onUse }: { conversationId: string; locale: Locale; onUse: (text: string) => void }) {
  const d = t(locale).ai;
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<AssistResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function run(kind: 'summary' | 'suggest') {
    setBusy(kind); setError(null); setResult(null);
    try { setResult(await api<AssistResult>(`/v1/conversations/${conversationId}/assist/${kind}`, { method: 'POST' })); }
    catch (e) { setError(e instanceof ApiError ? (d.errors[e.code] ?? t(locale).common.error) : t(locale).common.error); }
    finally { setBusy(null); }
  }
  return (
    <div className="mb-2 rounded-lg border border-violet-200 bg-violet-50 px-3 py-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold text-violet-900">{d.assistant}</span>
        <button type="button" className="btn-secondary" disabled={!!busy} onClick={() => run('summary')}>{d.summarise}</button>
        <button type="button" className="btn-secondary" disabled={!!busy} onClick={() => run('suggest')}>{d.suggest}</button>
      </div>
      {error && <p role="alert" className="mt-1 text-red-800">{error}</p>}
      {result && (
        <div className="mt-2" aria-live="polite">
          <p className="text-xs font-semibold text-violet-900">{result.simulated ? d.labelSimulated : d.label}</p>
          {result.decision === 'human_needed'
            ? <p className="mt-1 text-slate-800">{d.humanNeeded}{result.reason ? ` (${d.reasons[result.reason] ?? result.reason})` : ''}</p>
            : <p className="mt-1 whitespace-pre-wrap text-slate-900" dir="auto">{result.text}</p>}
          {result.citations.length > 0 && <p className="mt-1 text-xs text-slate-700">{d.sources}: {result.citations.map((c) => c.title).join(' · ')}</p>}
          {result.task === 'suggest_replies' && result.decision === 'suggestion' && result.text && (
            <button type="button" className="btn-secondary mt-1" onClick={() => onUse(result.text!)}>{d.useReply}</button>
          )}
        </div>
      )}
    </div>
  );
}

export function TranslateButton({ messageId, locale }: { messageId: string; locale: Locale }) {
  const d = t(locale).ai;
  const [r, setR] = useState<{ text: string; simulated: boolean } | null>(null);
  const [error, setError] = useState(false);
  if (r) return (
    <span className="mt-1 block border-t border-slate-200 pt-1 text-sm">
      <span className="block text-xs font-semibold text-violet-900">{r.simulated ? d.translationSimulated : d.translation}</span>
      <span className="block whitespace-pre-wrap" dir="auto">{r.text}</span>
    </span>
  );
  return (
    <button type="button" className="mt-1 text-xs font-medium text-teal underline" onClick={async () => {
      try { setR(await api<{ text: string; simulated: boolean }>(`/v1/messages/${messageId}/translate`, { method: 'POST', body: { to: locale } })); } catch { setError(true); }
    }}>{error ? d.translateFailed : d.translate}</button>
  );
}

/** The label on a message the AI wrote, with its explanation on request: sources, decision and checks (CF-EXT-021). */
export function AiWhy({ conversationId, interactionId, locale, label }: { conversationId: string; interactionId: string; locale: Locale; label: string }) {
  const d = t(locale).ai;
  const [why, setWhy] = useState<{ decision: string; reasons: string[]; citations: Array<{ title: string }>; settingsVersion: number | null; checkerVersion: string | null } | null>(null);
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  async function toggle() {
    setOpen(!open);
    if (why || open) return;
    try {
      const all = await api<Array<{ id: string; decision: string; reasons: string[]; citations: Array<{ title: string }>; settingsVersion: number | null; checkerVersion: string | null }>>(`/v1/conversations/${conversationId}/ai`);
      setWhy(all.find((x) => x.id === interactionId) ?? null);
    } catch { setFailed(true); }
  }
  return (
    <div className="mb-1 text-xs">
      <button type="button" className="font-semibold text-violet-800 underline-offset-2 hover:underline" aria-expanded={open} onClick={toggle}>{label} · {d.why}</button>
      {open && (failed ? <p className="text-red-800">{t(locale).common.error}</p> : why ? (
        <p className="mt-1 text-slate-700">{d.sources}: {why.citations.map((c) => c.title).join(' · ') || '—'}{why.settingsVersion ? ` · ${d.settingsVersionN.replace('{n}', String(why.settingsVersion))}` : ''}</p>
      ) : <p className="text-slate-700">{t(locale).common.loading}</p>)}
    </div>
  );
}
