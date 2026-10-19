'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useSession } from '@/components/AppShell';
import { api } from '@/lib/api';
import { fill, formatDate, formatNumber, isLocale, t, type Locale } from '@/lib/i18n';

interface Summary {
  subscription: { plan: string; status: string; trialEndsAt: string | null } | null;
  limits: Record<string, { limit: number | null; used: number }>;
}

export default function Dashboard() {
  const params = useParams<{ locale: string }>();
  const locale: Locale = isLocale(params.locale) ? params.locale : 'en';
  const d = t(locale);
  const { me } = useSession();
  const [s, setS] = useState<Summary | null>(null);
  useEffect(() => { api<Summary>('/v1/entitlements').then(setS).catch(() => setS(null)); }, []);
  const n = (v: number) => formatNumber(locale, v);
  const meter = (label: string, k: string) => {
    const x = s?.limits[k];
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-5">
        <p className="text-sm text-slate-600">{label}</p>
        <p className="mt-2 text-2xl font-bold text-navy" dir="ltr">
          <bdi>{x ? `${n(x.used)} / ${x.limit === null ? '∞' : n(x.limit)}` : '—'}</bdi>
        </p>
      </div>
    );
  };
  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="text-2xl font-bold text-navy sm:text-3xl">{fill(d.dashboard.welcome, { name: me.fullName })}</h1>
      <div className="mt-6 grid gap-4 sm:grid-cols-3">
        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <p className="text-sm text-slate-600">{d.dashboard.plan}</p>
          <p className="mt-2 text-2xl font-bold capitalize text-navy">{s?.subscription?.plan ?? '—'}</p>
          {s?.subscription?.trialEndsAt && (
            <p className="mt-1 text-sm text-slate-600">{fill(d.dashboard.trial, { date: formatDate(locale, s.subscription.trialEndsAt) })}</p>
          )}
        </div>
        {meter(d.dashboard.seats, 'seats')}
        {meter(d.dashboard.runs, 'automation_executions')}
      </div>
      <section className="mt-8 rounded-xl border border-slate-200 bg-white p-5">
        <h2 className="text-lg font-semibold text-navy">{d.dashboard.next}</h2>
        <ol className="mt-3 list-decimal space-y-2 ps-6 text-base text-slate-700">
          <li><Link className="font-semibold text-teal hover:underline" href={`/${locale}/app/settings/team`}>{d.dashboard.step1}</Link></li>
          <li><Link className="font-semibold text-teal hover:underline" href={`/${locale}/app/settings/company`}>{d.dashboard.step2}</Link></li>
          <li className="text-slate-500">{d.dashboard.step3}</li>
        </ol>
      </section>
    </div>
  );
}
