'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { AuthLayout } from '@/components/AuthLayout';
import { isLocale, t, type Locale } from '@/lib/i18n';

/**
 * Not-found page rendered per request inside the locale layout, so it carries the page nonce and no inline styles
 * (independent recheck R4-5). Unknown top-level paths are routed here by middleware.ts with status 404.
 */
export default function NotFound() {
  const params = useParams<{ locale?: string }>();
  const locale: Locale = params.locale && isLocale(params.locale) ? params.locale : 'en';
  const d = t(locale);
  return (
    <AuthLayout locale={locale}>
      <h1 className="mb-4 text-2xl font-bold text-navy">{d.notFound.title}</h1>
      <p className="text-base text-slate-700">{d.notFound.body}</p>
      <p className="mt-6 text-center text-sm"><Link href={`/${locale}/sign-in`} className="font-semibold text-teal hover:underline">{d.notFound.home}</Link></p>
    </AuthLayout>
  );
}
