'use client';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { AuthLayout, Field, PrimaryButton } from '@/components/AuthLayout';
import { api, ApiError } from '@/lib/api';
import { isLocale, t, type Locale } from '@/lib/i18n';

export default function SignInPage() {
  const params = useParams<{ locale: string }>();
  const locale: Locale = isLocale(params.locale) ? params.locale : 'en';
  const d = t(locale);
  const router = useRouter();
  const [step, setStep] = useState<'password' | 'mfa'>('password');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const message = (e: unknown) => {
    if (e instanceof ApiError) {
      if (e.code === 'invalid_credentials') return step === 'mfa' ? d.signIn.badCode : d.signIn.invalid;
      if (e.code === 'email_not_verified') return d.signIn.unverified;
      if (e.code === 'rate_limited') return d.signIn.tooMany;
    }
    return d.common.error;
  };

  async function onSubmit(ev: React.FormEvent<HTMLFormElement>) {
    ev.preventDefault();
    const f = new FormData(ev.currentTarget);
    setBusy(true);
    setError(null);
    try {
      if (step === 'password') {
        const r = await api<{ mfaRequired: boolean }>('/v1/auth/login', { method: 'POST', body: { email: f.get('email'), password: f.get('password') } });
        if (r.mfaRequired) return setStep('mfa');
      } else {
        await api('/v1/auth/mfa/challenge', { method: 'POST', body: { code: String(f.get('code') ?? '').trim() } });
      }
      router.push(`/${locale}/app`);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout locale={locale}>
      <h1 className="text-2xl font-bold text-navy">{step === 'password' ? d.signIn.title : d.signIn.mfaTitle}</h1>
      <p className="mb-6 mt-2 text-base text-slate-600">{step === 'password' ? d.signIn.subtitle : d.signIn.mfaHelp}</p>
      {error && <p role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-danger">{error}</p>}
      <form onSubmit={onSubmit} noValidate>
        {step === 'password' ? (
          <>
            <Field id="email" label={d.signIn.email} type="email" autoComplete="email" required dirLtr placeholder="name@company.com" />
            <Field id="password" label={d.signIn.password} type="password" autoComplete="current-password" required dirLtr />
            <div className="mb-6 flex justify-end">
              <Link href={`/${locale}/forgot-password`} className="text-sm font-semibold text-teal underline-offset-4 hover:underline">{d.signIn.forgot}</Link>
            </div>
          </>
        ) : (
          <Field id="code" label={d.signIn.code} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required dirLtr />
        )}
        <PrimaryButton type="submit" disabled={busy}>{step === 'password' ? d.signIn.submit : d.signIn.verify}</PrimaryButton>
      </form>
      <p className="mt-6 text-center text-sm text-slate-600">
        {d.signIn.noAccount}{' '}
        <Link href={`/${locale}/sign-up`} className="font-semibold text-teal underline-offset-4 hover:underline">{d.signIn.create}</Link>
      </p>
    </AuthLayout>
  );
}
