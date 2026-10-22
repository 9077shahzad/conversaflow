'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { fill, isLocale, t, type Locale } from '@/lib/i18n';

/**
 * Provider health and recovery (Wave 1). Read-only except for recovery actions that cannot message a customer:
 * re-applying waiting delivery updates, downloading a customer's file again, re-reading template status, trying again
 * incoming events the background service gave up on.
 * Retrying a message happens in its conversation, with all the usual checks.
 */
interface Health {
  status: 'healthy' | 'attention' | 'degraded';
  problems: Array<{ code: string; level: string }>;
  checkedAt: string;
  connections: Array<{ id: string; label: string; displayPhone: string; status: string; lastEventAt: string | null; events24h: number }>;
  sending: { waiting: number; overdue: number; stuck: number; gaveUp: number };
  webhooks: { unprocessed: number; overdue: number; failed: number };
  delivery: { uncertain7d: number; failed7d: { blocked: number; rejected: number; exhausted: number; providerReported: number } };
  media: { pending: number; overdue: number; failed7d: number; blockedByScan7d: number };
  templates: { approved: number; pending: number; pausedOrDisabled: number; lowQuality: number };
  attention: Array<{ id: string; conversationId: string; status: string; failureKind: string | null; errorCode: string | null; createdAt: string; contactName: string | null }>;
  mediaProblems: Array<{ id: string; conversationId: string; mediaType: string; mediaStatus: string; lastError: string | null; canRetry: boolean }>;
}
interface Access { permissions: string[] }

export default function ChannelHealth() {
  const params = useParams<{ locale: string }>();
  const locale: Locale = isLocale(params.locale) ? params.locale : 'en';
  const d = t(locale).health;
  const di = t(locale).inbox;
  const [h, setH] = useState<Health | null>(null);
  const [failed, setFailed] = useState(false);
  const [access, setAccess] = useState<Access | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [env, setEnv] = useState<{ whatsapp: { sandbox: boolean }; scanner: { basis: string } } | null>(null);
  const canManage = !!access?.permissions.includes('channels.manage');

  const load = useCallback(() => api<Health>('/v1/channels/health').then((x) => { setH(x); setFailed(false); }).catch(() => setFailed(true)), []);
  useEffect(() => { void load(); api<Access>('/v1/me/access').then(setAccess).catch(() => undefined);
    api<{ whatsapp: { sandbox: boolean }; scanner: { basis: string } }>('/v1/me/environment').then(setEnv).catch(() => undefined); const i = setInterval(load, 30_000); return () => clearInterval(i); }, [load]);

  async function act(fn: () => Promise<string>) {
    setBusy(true); setNotice(null);
    try { setNotice({ ok: true, text: await fn() }); await load(); } catch (e) {
      // Known refusals in the screen's language; the server's English wording only on the English screen.
      setNotice({ ok: false, text: e instanceof ApiError ? (di.errors[e.code] ?? (locale === 'en' && e.message ? e.message : di.errorGeneric)) : di.errorGeneric });
    } finally { setBusy(false); }
  }
  const when = (iso: string | null) => (iso ? new Intl.DateTimeFormat(locale === 'ar' ? 'ar-SA-u-nu-latn-ca-gregory' : 'en-GB',
    { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(iso)) : d.never);
  const tone = { healthy: 'border-teal bg-teal-soft text-slate-900', attention: 'border-amber-400 bg-amber-50 text-amber-950', degraded: 'border-red-400 bg-red-50 text-red-900' };

  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="text-2xl font-bold text-navy sm:text-3xl">{d.title}</h1>
      <p className="mt-1 text-sm text-slate-700">{d.intro}</p>
      {env && (env.whatsapp.sandbox || env.scanner.basis !== 'official_current') && (
        <div role="status" className="mt-2 space-y-1 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-800">
          {env.whatsapp.sandbox && <p>{d.sandboxNote}</p>}
          {env.scanner.basis !== 'official_current' && <p>{d.scannerNote[env.scanner.basis] ?? d.scannerNote.unverified_signatures}</p>}
        </div>
      )}
      {failed && !h && <p role="alert" className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">{di.errorGeneric}</p>}
      {!h ? (!failed && <p className="mt-4 text-slate-600">{t(locale).common.loading}</p>) : (
        <>
          <section role="status" aria-live="polite" className={`mt-4 rounded-xl border-2 px-4 py-3 ${tone[h.status]}`}>
            <p className="text-lg font-semibold">{d.status[h.status]}</p>
            {h.problems.length > 0 && (
              <ul className="mt-1 list-disc space-y-0.5 ps-5 text-sm">
                {h.problems.map((p) => <li key={p.code}>{d.problems[p.code] ?? p.code}</li>)}
              </ul>
            )}
            <p className="mt-1 text-xs">{fill(d.checked, { time: when(h.checkedAt) })}</p>
          </section>
          {notice && <p role="status" className={`mt-3 rounded-lg px-3 py-2 text-sm ${notice.ok ? 'bg-teal-soft text-slate-900' : 'bg-red-50 text-red-800'}`}>{notice.text}</p>}

          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <Card title={d.connections}>
              {h.connections.length === 0 ? <p>{d.none}</p> : h.connections.map((c) => (
                <div key={c.id} className="text-sm">
                  <p className="font-medium text-navy" dir="auto">{c.label} · <span dir="ltr">{c.displayPhone}</span></p>
                  <p>{d.lastEvent}: {when(c.lastEventAt)} · {d.events24h}: {c.events24h}</p>
                </div>
              ))}
            </Card>
            <Card title={d.incoming}>
              <Row label={d.waiting} value={h.webhooks.unprocessed} />
              <Row label={d.overdue} value={h.webhooks.overdue} warn />
              <Row label={d.incomingFailed} value={h.webhooks.failed} warn />
            </Card>
            <Card title={d.sending}>
              <Row label={d.waiting} value={h.sending.waiting} />
              <Row label={d.overdue} value={h.sending.overdue} warn />
              <Row label={d.stuck} value={h.sending.stuck} warn />
              <Row label={d.gaveUp} value={h.sending.gaveUp} />
            </Card>
            <Card title={d.delivery}>
              <Row label={d.uncertain} value={h.delivery.uncertain7d} warn />
              <Row label={d.rejected} value={h.delivery.failed7d.rejected} />
              <Row label={d.exhausted} value={h.delivery.failed7d.exhausted} />
              <Row label={d.providerReported} value={h.delivery.failed7d.providerReported} />
              <Row label={d.blocked} value={h.delivery.failed7d.blocked} />
            </Card>
            <Card title={d.mediaTitle}>
              <Row label={d.pending} value={h.media.pending} />
              <Row label={d.failed7d} value={h.media.failed7d} warn />
              <Row label={d.blockedByScan7d} value={h.media.blockedByScan7d} />
            </Card>
            <Card title={d.templatesTitle}>
              <Row label={d.approved} value={h.templates.approved} />
              <Row label={d.inReview} value={h.templates.pending} />
              <Row label={d.pausedOrDisabled} value={h.templates.pausedOrDisabled} warn />
              <Row label={d.lowQuality} value={h.templates.lowQuality} warn />
            </Card>
          </div>

          <section className="mt-5">
            <h2 className="text-lg font-semibold text-navy">{d.attention}</h2>
            <p className="text-sm text-slate-700">{d.attentionHelp}</p>
            {h.attention.length === 0 ? <p className="mt-2 text-sm text-slate-700">{d.none}</p> : (
              <ul className="mt-2 divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white">
                {h.attention.map((a) => (
                  <li key={a.id} className="flex flex-wrap items-center gap-2 px-4 py-2.5 text-sm">
                    <span className="min-w-0 flex-1">
                      <span className="font-medium text-navy" dir="auto">{a.contactName ?? '—'}</span>
                      {' · '}{a.status === 'uncertain' ? di.uncertainTitle : (a.failureKind && di.failedTitles[a.failureKind]) || di.failedTitle}
                      {' · '}{when(a.createdAt)}
                    </span>
                    <Link className="btn-secondary" href={`/${locale}/app/inbox?c=${a.conversationId}`}>{d.open}</Link>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="mt-5">
            <h2 className="text-lg font-semibold text-navy">{d.mediaProblems}</h2>
            {h.mediaProblems.length === 0 ? <p className="mt-2 text-sm text-slate-700">{d.none}</p> : (
              <ul className="mt-2 divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white">
                {h.mediaProblems.map((m) => (
                  <li key={m.id} className="flex flex-wrap items-center gap-2 px-4 py-2.5 text-sm">
                    <span className="min-w-0 flex-1">{di.media[m.mediaType] ?? m.mediaType} · {di.mediaStatus[m.mediaStatus] ?? m.mediaStatus}</span>
                    <Link className="btn-secondary" href={`/${locale}/app/inbox?c=${m.conversationId}`}>{d.open}</Link>
                    {canManage && m.canRetry && (
                      <button type="button" className="btn-secondary" disabled={busy}
                        onClick={() => act(async () => { await api(`/v1/channels/recovery/media/${m.id}`, { method: 'POST' }); return d.done; })}>{d.retryDownload}</button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="mt-5 rounded-xl border border-slate-200 bg-white p-4">
            <h2 className="text-lg font-semibold text-navy">{d.recovery}</h2>
            {canManage ? (
              <div className="mt-2 flex flex-wrap gap-2">
                <button type="button" className="btn-secondary" disabled={busy} onClick={() => act(async () => {
                  const r = await api<{ applied: number; stillWaiting: number }>('/v1/channels/recovery/statuses', { method: 'POST' });
                  return fill(d.reapplied, { applied: String(r.applied), stillWaiting: String(r.stillWaiting) });
                })}>{d.reapply}</button>
                {h.webhooks.failed > 0 && (
                  <button type="button" className="btn-secondary" disabled={busy} onClick={() => act(async () => {
                    const r = await api<{ requeued: number }>('/v1/channels/recovery/incoming', { method: 'POST' });
                    return fill(d.incomingRequeued, { n: String(r.requeued) });
                  })}>{d.retryIncoming}</button>
                )}
                <button type="button" className="btn-secondary" disabled={busy} onClick={() => act(async () => {
                  const r = await api<{ updated: number; unchanged: number }>('/v1/templates/sync', { method: 'POST' });
                  return fill(t(locale).templates.synced, { updated: String(r.updated), unchanged: String(r.unchanged) });
                })}>{d.syncTemplates}</button>
              </div>
            ) : <p className="mt-1 text-sm text-slate-700">{d.needsManage}</p>}
          </section>
        </>
      )}
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4">
      <h2 className="text-base font-semibold text-navy">{title}</h2>
      <div className="mt-2 space-y-1 text-slate-800">{children}</div>
    </section>
  );
}
function Row({ label, value, warn }: { label: string; value: number; warn?: boolean }) {
  return (
    <p className="flex justify-between gap-3 text-sm">
      <span>{label}</span>
      <span className={`font-semibold ${warn && value > 0 ? 'text-red-700' : 'text-slate-900'}`}>{value}</span>
    </p>
  );
}
