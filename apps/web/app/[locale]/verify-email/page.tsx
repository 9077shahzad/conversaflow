'use client';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { AuthLayout } from '@/components/AuthLayout';
import { api } from '@/lib/api';
import { isLocale, t, type Locale } from '@/lib/i18n';

function Verify() {
  const params = useParams<{ locale: string }>();
  const locale: Locale = isLocale(params.locale) ? params.locale : 'en';
  const d = t(locale);
  const token = useSearchParams().get('token') ?? '';
  const [state, setState] = useState<'working' | 'done' | 'failed'>('working');
  useEffect(() => {
    if (!token) return setState('failed');
    api('/v1/auth/verify-email', { method: 'POST', body: { token } }).then(() => setState('done'), () => setState('failed'));
  }, [token]);
  return (
    <AuthLayout locale={locale}>
      <h1 className="mb-4 text-2xl font-bold text-navy">{d.verify.title}</h1>
      <p role="status" className={`rounded-lg px-3 py-3 text-base ${state === 'failed' ? 'bg-red-50 text-danger' : 'bg-emerald-soft text-navy'}`}>
        {state === 'working' ? d.common.loading : state === 'done' ? d.verify.done : d.verify.failed}
      </p>
      <p className="mt-6 text-center text-sm"><Link href={`/${locale}/sign-in`} className="font-semibold text-teal hover:underline">{d.signUp.signIn}</Link></p>
    </AuthLayout>
  );
}

export default function VerifyEmailPage() {
  return <Suspense><Verify /></Suspense>;
}
