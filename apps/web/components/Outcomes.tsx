'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { fill, formatNumber, t, type Locale } from '@/lib/i18n';

/** Outcomes and costs for the last 30 days (W2.9): what is measured, and plainly what is not yet. */
type Outcomes = {
  period: { from: string; to: string; timeZone: string };
  conversations: { started: number; repeatWithin30Days: number; resolved: number; resolvedWithoutPerson: number; medianHoursToResolve: number | null };
  replies: { byPeople: number; byAutomations: number; byAi: number; viaApi: number; campaignsAndTemplates: number };
  promises: { due: number; keptOnTime: number; keptLate: number; missed: number; putRight: number; stillOpen: number };
  customerRequests: { askedForPerson: number; complaints: number };
  ai: { answered: number; suggested: number; handedToPerson: number; costUsd: number; uncertainUsd: number; simulated: boolean | null };
  costs: { knownUsd: number; perResolvedConversationUsd: number | null };
  notMeasuredYet: Array<{ what: string; why: string }>;
  assumptions: string[];
};

export function OutcomesPanel({ locale }: { locale: Locale }) {
  const d = t(locale).outcomes;
  const [o, setO] = useState<Outcomes | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => { api<Outcomes>('/v1/reports/outcomes').then(setO).catch(() => setError(true)); }, []);
  if (error) return <p role="alert" className="mt-4 text-sm text-red-800">{t(locale).common.error}</p>;
  if (!o) return <p className="mt-4 text-sm text-slate-700">{t(locale).common.loading}</p>;
  const n = (v: number) => formatNumber(locale, v);
  const usd = (v: number, digits = 2) => new Intl.NumberFormat(locale === 'ar' ? 'ar-AE-u-nu-latn' : 'en-GB', { style: 'currency', currency: 'USD', minimumFractionDigits: digits, maximumFractionDigits: digits }).format(v);
  const decided = o.promises.due - o.promises.stillOpen;
  const tiles: Array<[string, string]> = [
    [d.started, n(o.conversations.started)], [d.resolved, n(o.conversations.resolved)], [d.withoutPerson, n(o.conversations.resolvedWithoutPerson)],
    [d.repeat, n(o.conversations.repeatWithin30Days)], [d.medianResolve, o.conversations.medianHoursToResolve === null ? '—' : `${n(o.conversations.medianHoursToResolve)} ${d.hours}`],
    [d.promisesKept, `${n(o.promises.keptOnTime)} / ${n(decided)}`], [d.promisesMissed, n(o.promises.missed)], [d.requests, n(o.customerRequests.askedForPerson + o.customerRequests.complaints)],
  ];
  return (
    <section aria-labelledby="out-title" className="mt-6 rounded-xl border border-slate-200 bg-white p-4">
      <h2 id="out-title" className="text-lg font-semibold text-navy">{d.title}</h2>
      <p className="mt-1 text-sm text-slate-700">{d.intro}</p>
      <p className="mt-1 text-xs text-slate-700">{fill(t(locale).reports.periodNote, { from: o.period.from, to: o.period.to, tz: o.period.timeZone })}</p>
      <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {tiles.map(([label, value]) => (
          <div key={label} className="rounded-lg border border-slate-200 p-3">
            <dt className="text-xs text-slate-700">{label}</dt>
            <dd className="mt-1 text-xl font-semibold text-navy"><bdi>{value}</bdi></dd>
          </div>
        ))}
      </dl>
      <h3 className="mt-4 font-semibold text-slate-900">{d.whoReplied}</h3>
      <p className="text-sm text-slate-800">
        {d.people}: {n(o.replies.byPeople)} · {d.automations}: {n(o.replies.byAutomations)} · {d.ai}: {n(o.replies.byAi)}{o.ai.simulated ? ` (${d.simulated})` : ''} · {d.api}: {n(o.replies.viaApi)} · {d.campaigns}: {n(o.replies.campaignsAndTemplates)}
      </p>
      <h3 className="mt-4 font-semibold text-slate-900">{d.costs}</h3>
      <p className="text-sm text-slate-800">
        {d.aiSpend}: <bdi>{usd(o.ai.costUsd)}</bdi>{o.ai.simulated ? ` (${d.simulated})` : ''} · {d.perResolved}: <bdi>{o.costs.perResolvedConversationUsd === null ? '—' : usd(o.costs.perResolvedConversationUsd, 4)}</bdi>
        {o.ai.uncertainUsd > 0 && <> · {d.uncertain}: <bdi>{usd(o.ai.uncertainUsd)}</bdi></>}
      </p>
      <p className="text-xs text-slate-700">{d.costsNote}</p>
      <h3 className="mt-4 font-semibold text-slate-900">{d.notYet}</h3>
      <ul className="mt-1 list-disc ps-5 text-sm text-slate-800">{o.notMeasuredYet.map((x) => <li key={x.what}>{d.notYetItems[x.what] ?? x.what}</li>)}</ul>
      <h3 className="mt-4 font-semibold text-slate-900">{d.assumptionsTitle}</h3>
      <ul className="mt-1 list-disc ps-5 text-xs text-slate-700">{o.assumptions.map((x) => <li key={x}>{d.assumptions[x] ?? x}</li>)}</ul>
    </section>
  );
}
