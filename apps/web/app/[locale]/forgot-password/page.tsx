'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { AuthLayout, Field, PrimaryButton } from '@/components/AuthLayout';
import { api } from '@/lib/api';
import { isLocale, t, type Locale } from '@/lib/i18n';

export default function ForgotPassword() {
  const params = useParams<{ locale: string }>();
  const locale: Locale = isLocale(params.locale) ? params.locale : 'en';
  const d = t(locale);
  const [sent, setSent] = useState(false);
  async function onSubmit(ev: React.FormEvent<HTMLFormElement>) {
    ev.preventDefault();
    await api('/v1/auth/password/forgot', { method: 'POST', body: { email: new FormData(ev.currentTarget).get('email') } }).catch(() => undefined);
    setSent(true); // same answer whether or not the account exists
  }
  return (
    <AuthLayout locale={locale}>
      <h1 className="mb-6 text-2xl font-bold text-navy">{d.forgot.title}</h1>
      {sent ? <p role="status" className="rounded-lg bg-emerald-soft px-3 py-3 text-base text-navy">{d.forgot.sent}</p> : (
        <form onSubmit={onSubmit} noValidate>
          <Field id="email" label={d.signIn.email} type="email" autoComplete="email" required dirLtr />
          <PrimaryButton type="submit">{d.forgot.submit}</PrimaryButton>
        </form>
      )}
      <p className="mt-6 text-center text-sm"><Link href={`/${locale}/sign-in`} className="font-semibold text-teal hover:underline">{d.signUp.signIn}</Link></p>
    </AuthLayout>
  );
}
