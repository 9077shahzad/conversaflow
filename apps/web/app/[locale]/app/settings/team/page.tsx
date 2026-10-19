'use client';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { isLocale, t, type Locale } from '@/lib/i18n';

interface Member { id: string; fullName: string; email: string; status: string; roles: string[] }

export default function Team() {
  const params = useParams<{ locale: string }>();
  const locale: Locale = isLocale(params.locale) ? params.locale : 'en';
  const d = t(locale);
  const [rows, setRows] = useState<Member[] | null>(null);
  useEffect(() => { api<Member[]>('/v1/members').then(setRows).catch(() => setRows([])); }, []);
  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="text-2xl font-bold text-navy sm:text-3xl">{d.team.title}</h1>
      {rows && (
        <ul className="mt-6 space-y-3 sm:hidden" aria-label={d.team.title}>
          {rows.map((m) => (
            <li key={m.id} className="rounded-xl border border-slate-200 bg-white p-4">
              <p className="text-base font-semibold text-navy"><bdi>{m.fullName}</bdi></p>
              <p className="mt-0.5 break-all text-sm text-slate-700" dir="ltr" style={{ textAlign: locale === 'ar' ? 'right' : 'left' }}>{m.email}</p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {m.roles.map((r) => (
                  <span key={r} className="inline-block rounded-full bg-teal-soft px-2.5 py-0.5 text-sm font-medium text-teal">{d.roles[r] ?? r}</span>
                ))}
                <span className="text-sm text-slate-600">{m.status === 'active' ? d.team.active : m.status}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
      {!rows ? <p className="mt-4 text-slate-600">{d.common.loading}</p> : (
        <div className="mt-6 hidden overflow-x-auto sm:block rounded-xl border border-slate-200 bg-white" role="region" aria-label={d.team.title} tabIndex={0}>
          <table className="w-full min-w-[560px] text-start text-base">
            <thead className="bg-slate-50 text-sm text-slate-700">
              <tr>
                <th scope="col" className="px-4 py-3 text-start font-semibold">{d.team.name}</th>
                <th scope="col" className="px-4 py-3 text-start font-semibold">{d.team.email}</th>
                <th scope="col" className="px-4 py-3 text-start font-semibold">{d.team.role}</th>
                <th scope="col" className="px-4 py-3 text-start font-semibold">{d.team.status}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((m) => (
                <tr key={m.id}>
                  <td className="px-4 py-3 font-medium text-navy"><bdi>{m.fullName}</bdi></td>
                  <td className="px-4 py-3 text-slate-700" dir="ltr"><bdi>{m.email}</bdi></td>
                  <td className="px-4 py-3">{m.roles.map((r) => (
                    <span key={r} className="me-1 inline-block rounded-full bg-teal-soft px-2.5 py-0.5 text-sm font-medium text-teal">{d.roles[r] ?? r}</span>
                  ))}</td>
                  <td className="px-4 py-3 text-slate-700">{m.status === 'active' ? d.team.active : m.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
