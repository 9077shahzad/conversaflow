'use client';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { fill, isLocale, t, type Locale } from '@/lib/i18n';
import { TagChip, type Tag } from '@/components/TagChip';

/**
 * Shared inbox (BRD v1.2 CF-EXT-002, slice 2). Every action here is also enforced by the server; the screen only hides
 * what the server would refuse and explains refusals in plain words. Polls every 5 seconds (realtime comes later).
 */
interface ListItem {
  id: string; status: string; version: number; assignedMembershipId: string | null; lastMessageAt: string | null;
  windowOpen: boolean; contactName: string | null; optedOut: boolean; lastMessagePreview: string | null;
  lastMessageDirection: 'in' | 'out' | null; paused: boolean; needsAttention: boolean;
  slaKind: string | null; slaDueAt: string | null; tags: Tag[];
}
interface Message {
  id: string; direction: 'in' | 'out'; kind: string; body: string | null; providerType: string | null; status: string;
  errorCode: string | null; occurredAt: string; sentByMembershipId: string | null; fromAd: boolean; retryOf: string | null; retriedAs: string | null;
  /** Set only on a confirmed failure; null on an uncertain delivery. */
  failureKind: 'blocked' | 'rejected' | 'exhausted' | 'provider_reported' | null;
  originalAuthorMembershipId: string | null; retryNumber: number; retryable: boolean;
  templateId: string | null; pricingCategory: string | null;
  mediaType: string | null; mediaStatus: string | null; fileId: string | null; mediaFilename: string | null;
  scanBasis: string | null;
  /** Why this person cannot retry it now (null = they can), from the server. */
  retryBlock: string | null;
  attemptLog: Array<{ attempt: number; outcome: string; code: string | null; at: string }> | null;
}
interface Environment { whatsapp: { sandbox: boolean }; scanner: { basis: string }; maxFileBytes: number }
interface Template { id: string; name: string; language: string; category: string; status: string; paramCount: number;
  headerText: string | null; bodyText: string; footerText: string | null }
interface Note { id: string; body: string; authorMembershipId: string; createdAt: string }
interface Event { id: string; kind: string; actorMembershipId: string | null; data: Record<string, unknown>; createdAt: string }
interface Conversation {
  id: string; status: string; version: number; assignedMembershipId: string | null; activitySeq: number; windowOpen: boolean;
  contact: { id: string; displayName: string | null; optedOut: boolean; whatsapp: string | null; marketingConsentAt: string | null };
  sla: { kind: string; startedAt: string; dueAt: string } | null;
  provider?: string;
  messages: Message[]; notes: Note[]; events: Event[]; people: Record<string, string>; tags: Tag[];
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
  const [env, setEnv] = useState<Environment | null>(null);
  const [tags, setTags] = useState<Tag[]>([]);
  const [tagFilter, setTagFilter] = useState('');
  const can = useCallback((p: string) => !!access?.permissions.includes(p), [access]);

  const loadList = useCallback(async () => {
    try {
      const res = await api<{ items: ListItem[] }>(`/v1/conversations?status=active&assigned=${filter}&limit=50${tagFilter ? `&tag=${tagFilter}` : ''}`);
      setItems(res.items);
    } catch { setItems((x) => x ?? []); }
  }, [filter, tagFilter]);
  const loadConv = useCallback(async () => {
    if (!selected) { setConv(null); return; }
    try { setConv(await api<Conversation>(`/v1/conversations/${selected}`)); } catch { setConv(null); }
  }, [selected]);

  useEffect(() => { api<Access>('/v1/me/access').then(setAccess).catch(() => undefined); api<Environment>('/v1/me/environment').then(setEnv).catch(() => undefined); }, []);
  useEffect(() => { if (can('members.read')) api<Member[]>('/v1/members').then(setMembers).catch(() => undefined); }, [can]);
  useEffect(() => { api<Tag[]>('/v1/tags').then(setTags).catch(() => undefined); }, []);
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
            {tags.length > 0 && (
              <>
                <label htmlFor="tag-filter" className="sr-only">{d.tagFilter}</label>
                <select id="tag-filter" value={tagFilter} onChange={(e) => setTagFilter(e.target.value)}
                  className="rounded-full border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-800">
                  <option value="">{d.allTags}</option>
                  {tags.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                </select>
              </>
            )}
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
                        {it.slaDueAt && (new Date(it.slaDueAt).getTime() < Date.now()
                          ? <Badge tone="red">{d.slaBadgeOverdue}</Badge>
                          : <Badge tone="amber">{d.slaBadgeDue} {time(it.slaDueAt, locale)}</Badge>)}
                        {it.paused && <Badge tone="amber">{d.badges.paused}</Badge>}
                        {it.optedOut && <Badge tone="slate">{d.badges.optedOut}</Badge>}
                        {!it.windowOpen && <Badge tone="slate">{d.badges.windowClosed}</Badge>}
                        {!it.assignedMembershipId && <Badge tone="teal">{d.unassigned}</Badge>}
                        {(it.tags ?? []).map((x) => <TagChip key={x.id} tag={x} />)}
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
            : <ConversationView key={conv.id} conv={conv} locale={locale} access={access} members={members} can={can} env={env} tags={tags}
                onBack={() => open(null)} onChanged={refresh} />}
        </section>
      </div>
    </div>
  );
}

function ConversationView({ conv, locale, access, members, can, env, tags, onBack, onChanged }: {
  conv: Conversation; locale: Locale; access: Access | null; members: Member[]; can: (p: string) => boolean; env: Environment | null;
  tags: Tag[]; onBack: () => void; onChanged: () => Promise<void>;
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
          {conv.sla && (
            <p className={`text-sm font-medium ${new Date(conv.sla.dueAt).getTime() < Date.now() ? 'text-red-700' : 'text-amber-800'}`}>
              {fill(new Date(conv.sla.dueAt).getTime() < Date.now() ? d.slaOverdue : d.slaDue, { time: time(conv.sla.dueAt, locale) })}
              {' · '}{d.slaKinds[conv.sla.kind] ?? conv.sla.kind}
            </p>
          )}
          <MarketingConsent conv={conv} locale={locale} canEdit={can('contacts.write')} onChanged={onChanged} />
          <ConversationTags conv={conv} locale={locale} all={tags} canEdit={can('inbox.reply')} onChanged={onChanged} />
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
        {conv.provider === 'sandbox' && <Banner tone="slate">{d.sandboxBanner}</Banner>}
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
              {fill(d.events[x.e.kind] ?? x.e.kind, { actor: x.e.actorMembershipId ? name(x.e.actorMembershipId) : d.system,
                to: name((x.e.data as { to?: string; membershipId?: string }).to ?? (x.e.data as { membershipId?: string }).membershipId),
                tag: String((x.e.data as { name?: string }).name ?? '') })}
              {' · '}<time dateTime={x.e.createdAt}>{time(x.e.createdAt, locale)}</time>
            </li>
          );
          const m = x.m;
          const out = m.direction === 'out';
          return (
            <li key={m.id} className={`flex ${out ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[85%] rounded-2xl px-3.5 py-2 ${out ? 'bg-teal-soft text-slate-900' : 'bg-slate-100 text-slate-900'}`}>
                {m.fromAd && <p className="mb-1 text-xs font-semibold text-teal">{d.fromAd}</p>}
                {m.kind === 'template' && <p className="mb-1 text-xs font-semibold text-teal">{fill(d.templateBadge, { category: d.categories[m.pricingCategory ?? ''] ?? '' })}</p>}
                {m.kind === 'media' && <MediaItem m={m} locale={locale} canOpen={can('files.read')} maxFileBytes={env?.maxFileBytes ?? 16 * 1024 * 1024} />}
                {(m.body || m.kind !== 'media') && <p className="whitespace-pre-wrap break-words" dir="auto">{m.body ?? `[${m.providerType ?? m.kind}]`}</p>}
                <p className="mt-1 text-xs text-slate-600">
                  <time dateTime={m.occurredAt}>{time(m.occurredAt, locale)}</time>
                  {out && <> · {name(m.sentByMembershipId)} · <span className={m.status === 'failed' || m.status === 'uncertain' ? 'font-semibold text-red-700' : ''}>{d.statuses[m.status] ?? m.status}</span>
                    {conv.provider === 'sandbox' && ['sent', 'delivered', 'read'].includes(m.status) && <> ({d.simulated})</>}</>}
                </p>
                {out && m.retryOf && m.originalAuthorMembershipId && m.sentByMembershipId !== m.originalAuthorMembershipId && (
                  <p className="text-xs text-slate-600">{fill(d.retryOfBy, { actor: name(m.sentByMembershipId), author: name(m.originalAuthorMembershipId) })}</p>
                )}
                {out && (m.status === 'failed' || m.status === 'uncertain') && (
                  <DeliveryProblem m={m} conv={conv} locale={locale} busy={busy}
                    onRetry={(confirm) => act(() => api(`/v1/messages/${m.id}/retry`, { method: 'POST', body: { seenActivity: conv.activitySeq, clientMessageId: newKey(), confirmPossibleDuplicate: confirm } }))} />
                )}
              </div>
            </li>
          );
        })}
      </ol>

      {error && <p role="alert" className="mx-4 mb-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
      <Composer conv={conv} locale={locale} canTakeOver={can('inbox.assign')} canAttach={can('files.write')} maxFileBytes={env?.maxFileBytes ?? 16 * 1024 * 1024} blockedReason={
        pausedForMe ? d.badges.paused : conv.contact.optedOut ? d.badges.optedOut : !conv.windowOpen ? d.badges.windowClosed : null
      } templateBlocked={pausedForMe || conv.contact.optedOut} assignedOther={assignedOther} onDone={onChanged} />
    </div>
  );
}

function DeliveryProblem({ m, conv, locale, busy, onRetry }: {
  m: Message; conv: Conversation; locale: Locale; busy: boolean; onRetry: (confirm: boolean) => void;
}) {
  const d = t(locale).inbox;
  const [confirming, setConfirming] = useState(false);
  // Codes look like "131026" or "retries_exhausted:130429": try the whole code, then its first and last parts.
  const reason = m.errorCode ? (d.reasons[m.errorCode] ?? d.reasons[m.errorCode.split(':')[0]!] ?? d.reasons[m.errorCode.split(':').pop()!]
    ?? fill(d.reasonCode, { code: m.errorCode })) : null;
  const uncertain = m.status === 'uncertain';
  void conv;
  return (
    <div role="status" className={`mt-2 rounded-lg border px-3 py-2 text-sm ${uncertain ? 'border-amber-400 bg-amber-50 text-amber-950' : 'border-red-300 bg-red-50 text-red-900'}`}>
      <p className="font-semibold">{uncertain ? d.uncertainTitle : (m.failureKind && d.failedTitles[m.failureKind]) || d.failedTitle}</p>
      {!uncertain && <p>{d.failedConfirmed}</p>}
      {reason && <p>{fill(d.failedReason, { reason })}</p>}
      {uncertain && <p>{d.uncertainHelp}</p>}
      {m.attemptLog && m.attemptLog.length > 0 && (
        <p className="mt-1 text-xs">{d.attempts}: {m.attemptLog.map((a) => `${a.attempt} · ${d.attemptOutcomes[a.outcome] ?? a.outcome}${a.code ? ` (${a.code})` : ''}`).join('; ')}</p>
      )}
      {m.retriedAs ? <p className="mt-1 font-medium">{d.retried}</p>
        : !m.retryable || m.retryBlock === 'retry_limit_reached' ? <p className="mt-1">{d.retryLimit}</p>
        : m.retryBlock ? <p className="mt-1">{fill(d.retryNotPossible, { reason: d.errors[m.retryBlock] ?? m.retryBlock })}</p>
        : (
          uncertain && !confirming
            ? <button type="button" className="btn-secondary mt-2" disabled={busy} onClick={() => setConfirming(true)}>{d.retry}</button>
            : <button type="button" className="btn-danger mt-2" disabled={busy} onClick={() => onRetry(uncertain)}>
                {uncertain ? d.retryAnyway : d.retry}
              </button>
        )}
    </div>
  );
}

function Composer({ conv, locale, canTakeOver, canAttach, maxFileBytes, blockedReason, templateBlocked, assignedOther, onDone }: {
  conv: Conversation; locale: Locale; canTakeOver: boolean; canAttach: boolean; maxFileBytes: number; blockedReason: string | null; templateBlocked: boolean;
  assignedOther: boolean; onDone: () => Promise<void>;
}) {
  const d = t(locale).inbox;
  const [mode, setMode] = useState<'reply' | 'note' | 'template'>(conv.windowOpen ? 'reply' : 'template');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<{ code: string; message: string } | null>(null);
  const [file, setFile] = useState<{ id: string; name: string } | null>(null);
  const [templates, setTemplates] = useState<Template[] | null>(null);
  const [templateId, setTemplateId] = useState('');
  const [values, setValues] = useState<string[]>([]);
  // One key per draft: a retried request (double click, network blip) can never send twice.
  const key = useRef(newKey());
  const replyBlocked = mode === 'reply' && !!blockedReason;
  const tpl = templates?.find((x) => x.id === templateId) ?? null;

  useEffect(() => {
    if (mode === 'template' && templates === null) {
      api<Template[]>('/v1/templates').then((list) => setTemplates(list.filter((x) => x.status === 'approved'))).catch(() => setTemplates([]));
    }
  }, [mode, templates]);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true); setProblem(null);
    try {
      await fn();
      setText(''); setFile(null); setValues((v) => v.map(() => '')); key.current = newKey();
    } catch (e) {
      const code = e instanceof ApiError ? e.code : 'error';
      setProblem({ code, message: code === 'conversation_changed' ? d.changed : explain(e, d) });
      if (code === 'conversation_changed') key.current = newKey();
    } finally {
      setBusy(false);
      await onDone();
    }
  }

  function submit(takeover = false) {
    if (mode === 'template') {
      if (!tpl) return;
      return run(() => api(`/v1/conversations/${conv.id}/template`, { method: 'POST',
        body: { templateId: tpl.id, params: values.slice(0, tpl.paramCount), seenActivity: conv.activitySeq, clientMessageId: key.current, takeover } }));
    }
    if (!text.trim() && !(mode === 'reply' && file)) return;
    if (mode === 'note') return run(() => api(`/v1/conversations/${conv.id}/notes`, { method: 'POST', body: { body: text } }));
    return run(() => api(`/v1/conversations/${conv.id}/reply`, { method: 'POST',
      body: { text, fileId: file?.id, seenActivity: conv.activitySeq, clientMessageId: key.current, takeover } }));
  }

  const mb = String(Math.floor(maxFileBytes / (1024 * 1024)));
  async function attach(f: File) {
    // The same limit the server enforces, shown before anything is uploaded.
    if (f.size > maxFileBytes) { setProblem({ code: 'too_large', message: fill(d.tooBig, { mb }) }); return; }
    setBusy(true); setProblem(null);
    try {
      const form = new FormData();
      form.append('file', f);
      const res = await fetch('/v1/files', { method: 'POST', body: form, credentials: 'same-origin', headers: { 'X-Requested-With': 'conversaflow' } });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new ApiError(res.status, data?.error?.code ?? 'unknown', data?.error?.message ?? '');
      if (data.status !== 'available') throw new ApiError(400, 'not_found_file', '');
      setFile({ id: data.id, name: data.name });
    } catch (e) {
      setProblem({ code: 'attach', message: explain(e, d) });
    } finally { setBusy(false); }
  }

  const preview = tpl ? [tpl.headerText, tpl.bodyText.replace(/\{\{(\d+)\}\}/g, (_, n: string) => values[Number(n) - 1] || `{{${n}}}`), tpl.footerText].filter(Boolean).join('\n\n') : '';
  const canSendTemplate = !!tpl && values.slice(0, tpl.paramCount).filter((v) => v.trim()).length === tpl.paramCount && !templateBlocked;

  return (
    <form className="border-t border-slate-200 p-3" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <div role="tablist" aria-label={d.replyTab} className="mb-2 flex flex-wrap gap-2">
        {(['reply', 'template', 'note'] as const).map((m) => (
          <button key={m} type="button" role="tab" aria-selected={mode === m} onClick={() => { setMode(m); setProblem(null); }}
            className={`rounded-full px-3 py-1 text-sm font-medium ${mode === m ? (m === 'note' ? 'bg-amber-100 text-amber-900' : 'bg-navy text-white') : 'text-slate-700 hover:bg-slate-100'}`}>
            {m === 'reply' ? d.replyTab : m === 'note' ? d.noteTab : d.templateTab}
          </button>
        ))}
      </div>
      {mode === 'template' ? (
        <div className="space-y-2">
          <p className="text-sm text-slate-700">{d.templateHelp}</p>
          {templates && templates.length === 0 ? <p className="text-sm text-slate-700">{d.templateNone}</p> : (
            <>
              <label className="block text-sm font-medium text-slate-900" htmlFor={`tpl-${conv.id}`}>{d.templateLabel}</label>
              <select id={`tpl-${conv.id}`} value={templateId} disabled={busy || templateBlocked}
                onChange={(e) => { setTemplateId(e.target.value); const n = templates?.find((x) => x.id === e.target.value)?.paramCount ?? 0; setValues(Array.from({ length: n }, () => '')); }}
                className="w-full rounded-lg border border-slate-300 bg-white px-2 py-2 text-base">
                <option value="">{d.templateChoose}</option>
                {(templates ?? []).map((x) => <option key={x.id} value={x.id}>{x.name} · {x.language} · {d.categories[x.category] ?? x.category}</option>)}
              </select>
              {tpl && Array.from({ length: tpl.paramCount }, (_, i) => (
                <div key={i}>
                  <label className="block text-sm font-medium text-slate-900" htmlFor={`tpl-${conv.id}-${i}`}>{fill(d.templateValue, { n: String(i + 1) })}</label>
                  <input id={`tpl-${conv.id}-${i}`} value={values[i] ?? ''} maxLength={200} dir="auto" disabled={busy || templateBlocked}
                    onChange={(e) => setValues((v) => v.map((x, j) => (j === i ? e.target.value.replace(/[\n\t]/g, ' ') : x)))}
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-base" />
                </div>
              ))}
              {tpl && (
                <div className="rounded-lg bg-slate-50 px-3 py-2">
                  <p className="text-xs font-semibold text-slate-700">{d.templatePreview}</p>
                  <p className="whitespace-pre-wrap break-words text-sm text-slate-900" dir="auto">{preview}</p>
                </div>
              )}
            </>
          )}
        </div>
      ) : (
        <>
          {mode === 'reply' && !replyBlocked && <SavedReplyPicker conv={conv} locale={locale} onPick={(body) => setText((cur) => (cur ? `${cur}\n${body}` : body))} />}
          <label htmlFor={`compose-${conv.id}`} className="sr-only">{mode === 'reply' ? d.replyLabel : d.noteLabel}</label>
          <textarea id={`compose-${conv.id}`} value={text} onChange={(e) => setText(e.target.value)} rows={3} dir="auto" maxLength={4000}
            placeholder={mode === 'reply' ? d.replyLabel : d.noteLabel} disabled={replyBlocked}
            className={`w-full resize-y rounded-lg border px-3 py-2 text-base ${mode === 'note' ? 'border-amber-300 bg-amber-50' : 'border-slate-300'} disabled:bg-slate-100`} />
          {mode === 'reply' && canAttach && !replyBlocked && (
            <div className="mt-1 flex flex-wrap items-center gap-2 text-sm">
              {file ? (
                <>
                  <span className="max-w-full truncate rounded-full bg-slate-100 px-2.5 py-1 text-slate-800" dir="auto">{file.name}</span>
                  <button type="button" className="btn-secondary" onClick={() => setFile(null)}>{d.attachRemove}</button>
                </>
              ) : (
                <label className="btn-secondary cursor-pointer">
                  {busy ? d.attaching : d.attach}
                  <input type="file" className="sr-only" disabled={busy}
                    accept="image/jpeg,image/png,application/pdf,text/plain,audio/mpeg,audio/ogg,audio/mp4,video/mp4,.doc,.docx,.xls,.xlsx,.ppt,.pptx"
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) void attach(f); e.target.value = ''; }} />
                </label>
              )}
              <span className="text-xs text-slate-600">{d.attachHelp} {fill(d.sizeLimit, { mb })}</span>
            </div>
          )}
        </>
      )}
      {problem && (
        <div role="alert" className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
          {problem.message}
          {problem.code === 'assigned_to_other' && canTakeOver && (
            <button type="button" className="btn-secondary ms-2" disabled={busy} onClick={() => submit(true)}>{d.takeOver}</button>
          )}
        </div>
      )}
      {mode !== 'note' && assignedOther && !problem && !blockedReason && <p className="mt-1 text-sm text-slate-600">{d.assignedOther}</p>}
      <div className="mt-2 flex justify-end">
        {mode === 'template'
          ? <button type="submit" disabled={busy || !canSendTemplate} className="btn-primary">{busy ? d.sending : d.templateSend}</button>
          : <button type="submit" disabled={busy || replyBlocked || (!text.trim() && !(mode === 'reply' && file))} className="btn-primary">
              {busy ? d.sending : mode === 'reply' ? d.send : d.addNote}
            </button>}
      </div>
    </form>
  );
}

function MediaItem({ m, locale, canOpen, maxFileBytes }: { m: Message; locale: Locale; canOpen: boolean; maxFileBytes: number }) {
  const d = t(locale).inbox;
  const [opening, setOpening] = useState(false);
  async function open() {
    if (!m.fileId) return;
    setOpening(true);
    try {
      const link = await api<{ url: string }>(`/v1/files/${m.fileId}/link`, { method: 'POST' });
      window.open(link.url, '_blank', 'noopener');
    } catch { /* the link is short-lived and checked again on download */ } finally { setOpening(false); }
  }
  const ok = m.mediaStatus === 'available';
  return (
    <div className={`mb-1 rounded-lg border px-2.5 py-1.5 text-sm ${ok ? 'border-slate-300 bg-white' : 'border-amber-300 bg-amber-50'}`}>
      <p className="font-medium text-slate-900">{d.media[m.mediaType ?? ''] ?? m.mediaType}{m.mediaFilename ? <> · <span dir="auto">{m.mediaFilename}</span></> : null}</p>
      {m.direction === 'in' && <p className="text-xs text-slate-700">{fill(d.mediaStatus[m.mediaStatus ?? ''] ?? m.mediaStatus ?? '', { mb: String(Math.floor(maxFileBytes / (1024 * 1024))) })}</p>}
      {(m.mediaStatus === 'available' || m.mediaStatus === 'rejected') && m.scanBasis && <p className="text-xs text-slate-700">{d.scanBasis[m.scanBasis] ?? m.scanBasis}</p>}
      {ok && canOpen && m.fileId && <button type="button" className="btn-secondary mt-1" disabled={opening} onClick={open}>{d.openFile}</button>}
    </div>
  );
}

function MarketingConsent({ conv, locale, canEdit, onChanged }: { conv: Conversation; locale: Locale; canEdit: boolean; onChanged: () => Promise<void> }) {
  const d = t(locale).inbox;
  const [editing, setEditing] = useState(false);
  const [evidence, setEvidence] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const granted = !!conv.contact.marketingConsentAt;
  async function save() {
    setBusy(true); setError(null);
    try {
      await api(`/v1/contacts/${conv.contact.id}/marketing-consent`, { method: 'POST', body: { granted: !granted, evidence } });
      setEditing(false); setEvidence(''); await onChanged();
    } catch (e) { setError(explain(e, d)); } finally { setBusy(false); }
  }
  return (
    <div className="text-sm text-slate-700">
      <span>{granted ? d.marketingYes : d.marketingNo}</span>
      {canEdit && !conv.contact.optedOut && !editing && (
        <button type="button" className="ms-2 font-medium text-teal underline" onClick={() => setEditing(true)}>{granted ? d.marketingWithdraw : d.marketingRecord}</button>
      )}
      {editing && (
        <span className="mt-1 flex flex-wrap items-center gap-2">
          <label className="sr-only" htmlFor={`consent-${conv.id}`}>{d.marketingEvidence}</label>
          <input id={`consent-${conv.id}`} value={evidence} onChange={(e) => setEvidence(e.target.value)} minLength={5} maxLength={300} dir="auto"
            placeholder={d.marketingEvidence} className="min-w-0 flex-1 rounded-lg border border-slate-300 px-2 py-1.5 text-base" />
          <button type="button" className="btn-primary" disabled={busy || evidence.trim().length < 5} onClick={save}>{d.marketingSave}</button>
          <button type="button" className="btn-secondary" onClick={() => setEditing(false)}>{d.cancel}</button>
        </span>
      )}
      {error && <span role="alert" className="ms-2 text-red-800">{error}</span>}
    </div>
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

/** Tags on this conversation: shown to everyone; added and removed by anyone who can reply here. */
function ConversationTags({ conv, locale, all, canEdit, onChanged }: { conv: Conversation; locale: Locale; all: Tag[]; canEdit: boolean; onChanged: () => Promise<void> }) {
  const d = t(locale).inbox;
  const [busy, setBusy] = useState(false);
  const mine = conv.tags ?? [];
  const available = all.filter((x) => !mine.some((m) => m.id === x.id));
  async function change(tagId: string, on: boolean) {
    setBusy(true);
    try { await api(`/v1/conversations/${conv.id}/tags/${tagId}`, { method: on ? 'PUT' : 'DELETE' }); await onChanged(); } catch { /* refreshed on the next poll */ } finally { setBusy(false); }
  }
  if (!canEdit && mine.length === 0) return null;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1.5" aria-label={d.tags}>
      {mine.map((x) => <TagChip key={x.id} tag={x} onRemove={canEdit && !busy ? () => change(x.id, false) : undefined} removeLabel={fill(d.removeTag, { name: x.name })} />)}
      {canEdit && available.length > 0 && (
        <>
          <label htmlFor={`add-tag-${conv.id}`} className="sr-only">{d.addTag}</label>
          <select id={`add-tag-${conv.id}`} value="" disabled={busy} onChange={(e) => e.target.value && change(e.target.value, true)}
            className="rounded-full border border-slate-300 bg-white px-2 py-0.5 text-xs text-slate-800">
            <option value="">+ {d.addTag}</option>
            {available.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </select>
        </>
      )}
      {canEdit && all.length === 0 && <span className="text-xs text-slate-600">{d.noTagsYet}</span>}
    </div>
  );
}

/** Inserts a saved reply into the reply box (with {name} filled in). Nothing is sent until the agent presses Send. */
function SavedReplyPicker({ conv, locale, onPick }: { conv: Conversation; locale: Locale; onPick: (text: string) => void }) {
  const d = t(locale).inbox;
  const [replies, setReplies] = useState<Array<{ id: string; title: string; body: string; language: string | null }> | null>(null);
  useEffect(() => { api<Array<{ id: string; title: string; body: string; language: string | null }>>('/v1/saved-replies').then(setReplies).catch(() => setReplies([])); }, []);
  if (!replies || replies.length === 0) return null;
  return (
    <div className="mb-2">
      <label htmlFor={`saved-${conv.id}`} className="sr-only">{d.savedReply}</label>
      <select id={`saved-${conv.id}`} value="" onChange={(e) => {
        const r = replies.find((x) => x.id === e.target.value);
        if (r) onPick(r.body.replaceAll('{name}', conv.contact.displayName ?? ''));
      }} className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-800">
        <option value="">{d.chooseSavedReply}</option>
        {replies.map((r) => <option key={r.id} value={r.id}>{r.title}</option>)}
      </select>
    </div>
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
