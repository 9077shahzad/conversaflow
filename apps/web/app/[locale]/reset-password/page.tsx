'use client';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { AuthLayout, Field, PrimaryButton } from '@/components/AuthLayout';
import { api, ApiError } from '@/lib/api';
import { isLocale, t, type Locale } from '@/lib/i18n';

function Reset() {
  const params = useParams<{ locale: string }>();
  const locale: Locale = isLocale(params.locale) ? params.locale : 'en';
  const d = t(locale);
  const token = useSearchParams().get('token') ?? '';
  const [state, setState] = useState<'form' | 'done' | 'failed' | 'weak'>(token ? 'form' : 'failed');
  async function onSubmit(ev: React.FormEvent<HTMLFormElement>) {
    ev.preventDefault();
    try {
      await api('/v1/auth/password/reset', { method: 'POST', body: { token, password: new FormData(ev.currentTarget).get('password') } });
      setState('done');
    } catch (e) {
      setState(e instanceof ApiError && e.status === 400 ? 'weak' : 'failed');
    }
  }
  return (
    <AuthLayout locale={locale}>
      <h1 className="mb-4 text-2xl font-bold text-navy">{d.reset.title}</h1>
      {state === 'done' && <p role="status" className="rounded-lg bg-emerald-soft px-3 py-3 text-base text-navy">{d.reset.done}</p>}
      {state === 'failed' && <p role="alert" className="rounded-lg bg-red-50 px-3 py-3 text-base text-danger">{d.reset.failed}</p>}
      {(state === 'form' || state === 'weak') && (
        <form onSubmit={onSubmit} noValidate>
          {state === 'weak' && <p role="alert" className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-danger">{d.signUp.checkFields}</p>}
          <Field id="password" label={d.reset.newPassword} type="password" autoComplete="new-password" required dirLtr hint={d.signUp.passwordHint} />
          <PrimaryButton type="submit">{d.reset.submit}</PrimaryButton>
        </form>
      )}
      <p className="mt-6 text-center text-sm"><Link href={`/${locale}/sign-in`} className="font-semibold text-teal hover:underline">{d.signUp.signIn}</Link></p>
    </AuthLayout>
  );
}

export default function ResetPasswordPage() {
  return <Suspense><Reset /></Suspense>;
}
