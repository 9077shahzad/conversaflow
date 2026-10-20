'use client';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { fill, isLocale, t, type Locale } from '@/lib/i18n';

/**
 * Shared inbox (BRD v1.2 CF-EXT-002, slice 2). Every action here is also enforced by the server; the screen only hides
 * what the server would refuse and explains refusals in plain words. Polls every 5 seconds (realtime comes later).
 */
interface ListItem {
  id: string; status: string; version: number; assignedMembershipId: string | null; lastMessageAt: string | null;
  windowOpen: boolean; contactName: string | null; optedOut: boolean; lastMessagePreview: string | null;
  lastMessageDirection: 'in' | 'out' | null; paused: boolean; needsAttention: boolean;
}
interface Message {
  id: string; direction: 'in' | 'out'; kind: string; body: string | null; providerType: string | null; status: string;
  errorCode: string | null; occurredAt: string; sentByMembershipId: string | null; fromAd: boolean; retryOf: string | null; retriedAs: string | null;
}
interface Note { id: string; body: string; authorMembershipId: string; createdAt: string }
interface Event { id: string; kind: string; actorMembershipId: string | null; data: Record<string, unknown>; createdAt: string }
interface Conversation {
  id: string; status: string; version: number; assignedMembershipId: string | null; activitySeq: number; windowOpen: boolean;
  contact: { id: string; displayName: string | null; optedOut: boolean; whatsapp: string | null };
  messages: Message[]; notes: Note[]; events: Event[]; people: Record<string, string>;
  pause: { active: boolean; reason?: string; pausedByMembershipId?: string; until?: string | null };
}
interface Access { membershipId: string; permissions: string[] }
interface Member { id: string; fullName: string; roles: string[]; status: string }

type Filter = 'any' | 'me' | 'unassigned';
const newKey = () => crypto.randomUUID();

export default function InboxPage() {
  return <Suspense><Inbox /></Suspense>;
}

function Inbox() {
  const params = useParams<{ locale: string }>();
  const locale: Locale = isLocale(params.locale) ? params.locale : 'en';
  const d = t(locale).inbox;
  const router = useRouter();
  const search = useSearchParams();
  const selected = search.get('c');
  const [access, setAccess] = useState<Access | null>(null);
  const [filter, setFilter] = useState<Filter>('any');
  const [items, setItems] = useState<ListItem[] | null>(null);
  const [conv, setConv] = useState<Conversation | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const can = useCallback((p: string) => !!access?.permissions.includes(p), [access]);

  const loadList = useCallback(async () => {
    try {
      const res = await api<{ items: ListItem[] }>(`/v1/conversations?status=active&assigned=${filter}&limit=50`);
      setItems(res.items);
    } catch { setItems((x) => x ?? []); }
  }, [filter]);
  const loadConv = useCallback(async () => {
    if (!selected) { setConv(null); return; }
    try { setConv(await api<Conversation>(`/v1/conversations/${selected}`)); } catch { setConv(null); }
  }, [selected]);

  useEffect(() => { api<Access>('/v1/me/access').then(setAccess).catch(() => undefined); }, []);
  useEffect(() => { if (can('members.read')) api<Member[]>('/v1/members').then(setMembers).catch(() => undefined); }, [can]);
  useEffect(() => { void loadList(); const h = setInterval(loadList, 5000); return () => clearInterval(h); }, [loadList]);
  useEffect(() => { void loadConv(); const h = setInterval(loadConv, 5000); return () => clearInterval(h); }, [loadConv]);

  const open = (id: string | null) => router.replace(id ? `/${locale}/app/inbox?c=${id}` : `/${locale}/app/inbox`, { scroll: false });
  const refresh = async () => { await Promise.all([loadConv(), loadList()]); };

  return (
    <div className="mx-auto max-w-7xl">
      <h1 className="text-2xl font-bold text-navy sm:text-3xl">{d.title}</h1>
      <p className="mt-1 text-sm text-slate-600">{d.demoNote}</p>
      <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(280px,360px)_1fr]">
        <section aria-label={d.title} className={`${selected ? 'hidden lg:block' : ''} min-w-0`}>
          <div role="group" aria-label={d.filterLabel} className="flex flex-wrap gap-2">
            {(['any', 'me', 'unassigned'] as Filter[]).map((f) => (
              <button key={f} type="button" aria-pressed={filter === f} onClick={() => setFilter(f)}
                className={`rounded-full px-3 py-1.5 text-sm font-medium ${filter === f ? 'bg-teal text-white' : 'border border-slate-300 bg-white text-slate-800 hover:bg-slate-50'}`}>
                {d.filters[f]}
              </button>
            ))}
          </div>
          {!items ? <p className="mt-4 text-slate-600">{t(locale).common.loading}</p>
            : items.length === 0 ? <p className="mt-4 text-slate-600">{d.empty}</p>
            : (
              <ul className="mt-3 divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200 bg-white">
                {items.map((it) => (
                  <li key={it.id}>
                    <button type="button" onClick={() => open(it.id)} aria-current={selected === it.id ? 'true' : undefined}
                      className={`block w-full px-4 py-3 text-start hover:bg-slate-50 ${selected === it.id ? 'bg-teal-soft' : ''}`}>
                      <span className="flex items-center gap-2">
                        <span className="min-w-0 flex-1 truncate font-semibold text-navy" dir="auto">{it.contactName ?? '—'}</span>
                        {it.lastMessageAt && <time className="shrink-0 text-xs text-slate-600" dateTime={it.lastMessageAt}>{time(it.lastMessageAt, locale)}</time>}
                      </span>
                      <span className="mt-0.5 block truncate text-sm text-slate-700" dir="auto">{it.lastMessagePreview ?? ''}</span>
                      <span className="mt-1.5 flex flex-wrap gap-1.5">
                        {it.needsAttention && <Badge tone="red">{d.badges.attention}</Badge>}
                        {it.paused && <Badge tone="amber">{d.badges.paused}</Badge>}
                        {it.optedOut && <Badge tone="slate">{d.badges.optedOut}</Badge>}
                        {!it.windowOpen && <Badge tone="slate">{d.badges.windowClosed}</Badge>}
                        {!it.assignedMembershipId && <Badge tone="teal">{d.unassigned}</Badge>}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
        </section>

        <section aria-label={conv?.contact.displayName ?? d.title} className={`${selected ? '' : 'hidden lg:block'} min-w-0`}>
          {!selected ? <p className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center text-slate-600">{d.choose}</p>
            : !conv ? <p className="text-slate-600">{t(locale).common.loading}</p>
            : <ConversationView key={conv.id} conv={conv} locale={locale} access={access} members={members} can={can}
                onBack={() => open(null)} onChanged={refresh} />}
        </section>
      </div>
    </div>
  );
}

function ConversationView({ conv, locale, access, members, can, onBack, onChanged }: {
  conv: Conversation; locale: Locale; access: Access | null; members: Member[]; can: (p: string) => boolean;
  onBack: () => void; onChanged: () => Promise<void>;
}) {
  const d = t(locale).inbox;
  const me = access?.membershipId;
  const name = (id: string | null | undefined) => (id ? (id === me ? d.you : conv.people[id] ?? '—') : '—');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pausing, setPausing] = useState(false);
  const pausedForMe = conv.pause.active && conv.pause.pausedByMembershipId !== me;
  const assignedOther = !!conv.assignedMembershipId && conv.assignedMembershipId !== me;

  async function act(fn: () => Promise<unknown>) {
    setBusy(true); setError(null);
    try { await fn(); await onChanged(); } catch (e) { setError(explain(e, d)); await onChanged(); } finally { setBusy(false); }
  }
  const assign = (membershipId: string | null) => act(() => api(`/v1/conversations/${conv.id}/assign`, { method: 'POST', body: { membershipId, expectedVersion: conv.version } }));

  const timeline = useMemo(() => [
    ...conv.messages.map((m) => ({ at: m.occurredAt, kind: 'message' as const, m })),
    ...conv.notes.map((n) => ({ at: n.createdAt, kind: 'note' as const, n })),
    ...conv.events.filter((e) => e.kind !== 'assigned' || (e.data as { by?: string }).by !== 'reply').map((e) => ({ at: e.createdAt, kind: 'event' as const, e })),
  ].sort((a, b) => a.at.localeCompare(b.at)), [conv]);

  const repliers = members.filter((m) => m.status === 'active' && m.roles.some((r) => r !== 'analyst'));

  return (
    <div className="flex min-h-[60vh] flex-col overflow-hidden rounded-xl border border-slate-200 bg-white">
      <header className="flex flex-wrap items-center gap-3 border-b border-slate-200 px-4 py-3">
        <button type="button" onClick={onBack} className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm lg:hidden">{d.back}</button>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-lg font-semibold text-navy" dir="auto">{conv.contact.displayName ?? '—'}</h2>
          <p className="text-sm text-slate-700">
            <span className="sr-only">{d.phoneLabel}: </span><span dir="ltr">{conv.contact.whatsapp ? `+${conv.contact.whatsapp}` : ''}</span>
            {' · '}{conv.assignedMembershipId ? fill(d.assignedTo, { name: name(conv.assignedMembershipId) }) : d.unassigned}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {!conv.assignedMembershipId && <button type="button" disabled={busy} onClick={() => me && assign(me)} className="btn-secondary">{d.claim}</button>}
          {conv.assignedMembershipId === me && <button type="button" disabled={busy} onClick={() => assign(null)} className="btn-secondary">{d.handBack}</button>}
          {can('inbox.assign') && repliers.length > 0 && (
            <label className="flex items-center gap-1.5 text-sm text-slate-800">
              {d.assign}
              <select className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm" value={conv.assignedMembershipId ?? ''}
                disabled={busy} onChange={(e) => assign(e.target.value || null)}>
                <option value="">{d.assignNobody}</option>
                {repliers.map((m) => <option key={m.id} value={m.id}>{m.fullName}</option>)}
              </select>
            </label>
          )}
          {can('inbox.pause') && !conv.pause.active && <button type="button" onClick={() => setPausing(true)} className="btn-secondary">{d.pause}</button>}
          {conv.pause.active && (conv.pause.pausedByMembershipId === me || can('inbox.pause')) && (
            <button type="button" disabled={busy} onClick={() => act(() => api(`/v1/conversations/${conv.id}/pause`, { method: 'DELETE' }))} className="btn-secondary">{d.release}</button>
          )}
        </div>
      </header>

      {pausing && <PauseForm locale={locale} busy={busy} onCancel={() => setPausing(false)}
        onSubmit={(reason, minutes) => act(async () => { await api(`/v1/conversations/${conv.id}/pause`, { method: 'POST', body: { reason, minutes } }); setPausing(false); })} />}

      <div className="space-y-2 px-4 pt-3">
        {conv.pause.active && (
          <Banner tone="amber">
            {fill(d.pausedBanner, { name: name(conv.pause.pausedByMembershipId), reason: conv.pause.reason ?? '' })}{' '}
            {conv.pause.until ? fill(d.pausedUntil, { time: time(conv.pause.until, locale) }) : d.pausedManual}
            {!pausedForMe && <> {d.pausedYou}</>}
          </Banner>
        )}
        {conv.contact.optedOut && <Banner tone="slate">{d.optedOut}</Banner>}
        {!conv.windowOpen && !conv.contact.optedOut && <Banner tone="slate">{d.windowClosed}</Banner>}
      </div>

      <ol className="flex-1 space-y-3 overflow-y-auto px-4 py-4" aria-label={d.title}>
        {timeline.map((x) => {
          if (x.kind === 'note') return (
            <li key={x.n.id} className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-slate-900">
              <p className="text-xs font-semibold text-amber-900">{d.note} · {name(x.n.authorMembershipId)} · <time dateTime={x.n.createdAt}>{time(x.n.createdAt, locale)}</time></p>
              <p className="mt-1 whitespace-pre-wrap" dir="auto">{x.n.body}</p>
            </li>
          );
          if (x.kind === 'event') return (
            <li key={x.e.id} className="text-center text-xs text-slate-600">
              {fill(d.events[x.e.kind] ?? x.e.kind, { actor: x.e.actorMembershipId ? name(x.e.actorMembershipId) : d.system, to: name((x.e.data as { to?: string }).to) })}
              {' · '}<time dateTime={x.e.createdAt}>{time(x.e.createdAt, locale)}</time>
            </li>
          );
          const m = x.m;
          const out = m.direction === 'out';
          return (
            <li key={m.id} className={`flex ${out ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[85%] rounded-2xl px-3.5 py-2 ${out ? 'bg-teal-soft text-slate-900' : 'bg-slate-100 text-slate-900'}`}>
                {m.fromAd && <p className="mb-1 text-xs font-semibold text-teal">{d.fromAd}</p>}
                <p className="whitespace-pre-wrap break-words" dir="auto">{m.body ?? `[${m.providerType ?? m.kind}]`}</p>
                <p className="mt-1 text-xs text-slate-600">
                  <time dateTime={m.occurredAt}>{time(m.occurredAt, locale)}</time>
                  {out && <> · {name(m.sentByMembershipId)} · <span className={m.status === 'failed' || m.status === 'uncertain' ? 'font-semibold text-red-700' : ''}>{d.statuses[m.status] ?? m.status}</span></>}
                </p>
                {out && (m.status === 'failed' || m.status === 'uncertain') && (
                  <DeliveryProblem m={m} conv={conv} locale={locale} busy={busy} blocked={pausedForMe || conv.contact.optedOut || !conv.windowOpen || assignedOther}
                    onRetry={(confirm) => act(() => api(`/v1/messages/${m.id}/retry`, { method: 'POST', body: { seenActivity: conv.activitySeq, clientMessageId: newKey(), confirmPossibleDuplicate: confirm } }))} />
                )}
              </div>
            </li>
          );
        })}
      </ol>

      {error && <p role="alert" className="mx-4 mb-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
      <Composer conv={conv} locale={locale} canTakeOver={can('inbox.assign')} blockedReason={
        pausedForMe ? d.badges.paused : conv.contact.optedOut ? d.badges.optedOut : !conv.windowOpen ? d.badges.windowClosed : null
      } assignedOther={assignedOther} onDone={onChanged} />
    </div>
  );
}

function DeliveryProblem({ m, conv, locale, busy, blocked, onRetry }: {
  m: Message; conv: Conversation; locale: Locale; busy: boolean; blocked: boolean; onRetry: (confirm: boolean) => void;
}) {
  const d = t(locale).inbox;
  const [confirming, setConfirming] = useState(false);
  const reason = m.errorCode ? (d.reasons[m.errorCode.split(':').pop()!] ?? d.reasons[m.errorCode] ?? fill(d.reasonCode, { code: m.errorCode })) : null;
  void conv;
  return (
    <div role="status" className="mt-2 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900">
      <p className="font-semibold">{m.status === 'uncertain' ? d.uncertainTitle : d.failedTitle}</p>
      {reason && <p>{fill(d.failedReason, { reason })}</p>}
      {m.status === 'uncertain' && <p>{d.uncertainHelp}</p>}
      {m.retriedAs ? <p className="mt-1 font-medium">{d.retried}</p> : !blocked && (
        m.status === 'uncertain' && !confirming
          ? <button type="button" className="btn-secondary mt-2" disabled={busy} onClick={() => setConfirming(true)}>{d.retry}</button>
          : <button type="button" className="btn-danger mt-2" disabled={busy} onClick={() => onRetry(m.status === 'uncertain')}>
              {m.status === 'uncertain' ? d.retryAnyway : d.retry}
            </button>
      )}
    </div>
  );
}

function Composer({ conv, locale, canTakeOver, blockedReason, assignedOther, onDone }: {
  conv: Conversation; locale: Locale; canTakeOver: boolean; blockedReason: string | null; assignedOther: boolean; onDone: () => Promise<void>;
}) {
  const d = t(locale).inbox;
  const [mode, setMode] = useState<'reply' | 'note'>('reply');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<{ code: string; message: string } | null>(null);
  // One key per draft: a retried request (double click, network blip) can never send twice.
  const key = useRef(newKey());
  const replyBlocked = mode === 'reply' && !!blockedReason;

  async function submit(takeover = false) {
    if (!text.trim()) return;
    setBusy(true); setProblem(null);
    try {
      if (mode === 'note') await api(`/v1/conversations/${conv.id}/notes`, { method: 'POST', body: { body: text } });
      else await api(`/v1/conversations/${conv.id}/reply`, { method: 'POST', body: { text, seenActivity: conv.activitySeq, clientMessageId: key.current, takeover } });
      setText(''); key.current = newKey();
    } catch (e) {
      const code = e instanceof ApiError ? e.code : 'error';
      setProblem({ code, message: code === 'conversation_changed' ? d.changed : explain(e, d) });
      if (code === 'conversation_changed') key.current = newKey();
    } finally {
      setBusy(false);
      await onDone();
    }
  }

  return (
    <form className="border-t border-slate-200 p-3" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <div role="tablist" aria-label={d.replyTab} className="mb-2 flex gap-2">
        {(['reply', 'note'] as const).map((m) => (
          <button key={m} type="button" role="tab" aria-selected={mode === m} onClick={() => setMode(m)}
            className={`rounded-full px-3 py-1 text-sm font-medium ${mode === m ? (m === 'note' ? 'bg-amber-100 text-amber-900' : 'bg-navy text-white') : 'text-slate-700 hover:bg-slate-100'}`}>
            {m === 'reply' ? d.replyTab : d.noteTab}
          </button>
        ))}
      </div>
      <label htmlFor={`compose-${conv.id}`} className="sr-only">{mode === 'reply' ? d.replyLabel : d.noteLabel}</label>
      <textarea id={`compose-${conv.id}`} value={text} onChange={(e) => setText(e.target.value)} rows={3} dir="auto" maxLength={4000}
        placeholder={mode === 'reply' ? d.replyLabel : d.noteLabel} disabled={replyBlocked}
        className={`w-full resize-y rounded-lg border px-3 py-2 text-base ${mode === 'note' ? 'border-amber-300 bg-amber-50' : 'border-slate-300'} disabled:bg-slate-100`} />
      {problem && (
        <div role="alert" className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
          {problem.message}
          {problem.code === 'assigned_to_other' && canTakeOver && (
            <button type="button" className="btn-secondary ms-2" disabled={busy} onClick={() => submit(true)}>{d.takeOver}</button>
          )}
        </div>
      )}
      {mode === 'reply' && assignedOther && !problem && !blockedReason && <p className="mt-1 text-sm text-slate-600">{d.assignedOther}</p>}
      <div className="mt-2 flex justify-end">
        <button type="submit" disabled={busy || replyBlocked || !text.trim()} className="btn-primary">
          {busy ? d.sending : mode === 'reply' ? d.send : d.addNote}
        </button>
      </div>
    </form>
  );
}

function PauseForm({ locale, busy, onCancel, onSubmit }: { locale: Locale; busy: boolean; onCancel: () => void; onSubmit: (reason: string, minutes: number | null) => void }) {
  const d = t(locale).inbox;
  const [reason, setReason] = useState('');
  const [dur, setDur] = useState('60');
  return (
    <form className="mx-4 mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3" onSubmit={(e) => { e.preventDefault(); onSubmit(reason, dur === 'manual' ? null : Number(dur)); }}>
      <p className="font-semibold text-amber-900">{d.pauseTitle}</p>
      <label className="mt-2 block text-sm font-medium text-slate-900" htmlFor="pause-reason">{d.pauseReason}</label>
      <input id="pause-reason" required minLength={3} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} dir="auto"
        className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-base" />
      <label className="mt-2 block text-sm font-medium text-slate-900" htmlFor="pause-for">{d.pauseFor}</label>
      <select id="pause-for" value={dur} onChange={(e) => setDur(e.target.value)} className="mt-1 rounded-lg border border-slate-300 bg-white px-2 py-1.5">
        {Object.entries(d.pauseDurations).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
      </select>
      <div className="mt-3 flex gap-2">
        <button type="submit" className="btn-primary" disabled={busy || reason.trim().length < 3}>{d.pauseConfirm}</button>
        <button type="button" className="btn-secondary" onClick={onCancel}>{d.cancel}</button>
      </div>
    </form>
  );
}

function Badge({ tone, children }: { tone: 'red' | 'amber' | 'slate' | 'teal'; children: React.ReactNode }) {
  const cls = { red: 'bg-red-100 text-red-800', amber: 'bg-amber-100 text-amber-900', slate: 'bg-slate-100 text-slate-700', teal: 'bg-teal-soft text-teal' }[tone];
  return <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${cls}`}>{children}</span>;
}
function Banner({ tone, children }: { tone: 'amber' | 'slate'; children: React.ReactNode }) {
  return <p role="status" className={`rounded-lg px-3 py-2 text-sm ${tone === 'amber' ? 'bg-amber-50 text-amber-900 border border-amber-300' : 'bg-slate-50 text-slate-800 border border-slate-200'}`}>{children}</p>;
}
function time(iso: string, locale: Locale) {
  return new Intl.DateTimeFormat(locale === 'ar' ? 'ar-SA-u-nu-latn-ca-gregory' : 'en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
}
/** Refusals are explained in the screen's language from the server's error code, never from its English message. */
function explain(e: unknown, d: ReturnType<typeof t>['inbox']) {
  return e instanceof ApiError ? (d.errors[e.code] ?? d.errorGeneric) : d.errorGeneric;
}
