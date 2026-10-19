'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { AuthLayout, Field, PrimaryButton } from '@/components/AuthLayout';
import { api, ApiError } from '@/lib/api';
import { isLocale, t, type Locale } from '@/lib/i18n';

export default function SignUpPage() {
  const params = useParams<{ locale: string }>();
  const locale: Locale = isLocale(params.locale) ? params.locale : 'en';
  const d = t(locale);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(ev: React.FormEvent<HTMLFormElement>) {
    ev.preventDefault();
    const f = new FormData(ev.currentTarget);
    setBusy(true);
    setError(null);
    try {
      await api('/v1/auth/signup', { method: 'POST', body: { fullName: f.get('fullName'), email: f.get('email'), password: f.get('password'), locale } });
      setDone(true);
    } catch (e) {
      setError(e instanceof ApiError && e.status === 400 ? d.signUp.checkFields : d.common.error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout locale={locale}>
      <h1 className="text-2xl font-bold text-navy">{d.signUp.title}</h1>
      <p className="mb-6 mt-2 text-base text-slate-600">{d.signUp.subtitle}</p>
      {done ? (
        <p role="status" className="rounded-lg border border-emerald/40 bg-emerald-soft px-3 py-3 text-base text-navy">{d.signUp.sent}</p>
      ) : (
        <form onSubmit={onSubmit} noValidate>
          {error && <p role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-danger">{error}</p>}
          <Field id="fullName" label={d.signUp.fullName} autoComplete="name" required />
          <Field id="email" label={d.signIn.email} type="email" autoComplete="email" required dirLtr />
          <Field id="password" label={d.signIn.password} type="password" autoComplete="new-password" required dirLtr hint={d.signUp.passwordHint} />
          <PrimaryButton type="submit" disabled={busy}>{d.signUp.submit}</PrimaryButton>
        </form>
      )}
      <p className="mt-6 text-center text-sm text-slate-600">
        {d.signUp.have}{' '}
        <Link href={`/${locale}/sign-in`} className="font-semibold text-teal underline-offset-4 hover:underline">{d.signUp.signIn}</Link>
      </p>
    </AuthLayout>
  );
}
