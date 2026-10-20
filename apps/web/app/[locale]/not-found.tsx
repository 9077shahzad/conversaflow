import Link from 'next/link';
import { headers } from 'next/headers';
import { AuthLayout } from '@/components/AuthLayout';
import { isLocale, t, type Locale } from '@/lib/i18n';

/**
 * Not-found page, rendered on the server per request inside the locale layout: it carries the page nonce, has no
 * inline styles, and its heading is in the HTML before any script runs (recheck R4-5; review of candidate 2).
 * middleware.ts passes the language in x-cf-locale, because not-found pages receive no route parameters.
 */
export default async function NotFound() {
  const requested = (await headers()).get('x-cf-locale') ?? 'en';
  const locale: Locale = isLocale(requested) ? requested : 'en';
  const d = t(locale);
  return (
    <AuthLayout locale={locale}>
      <h1 className="mb-4 text-2xl font-bold text-navy">{d.notFound.title}</h1>
      <p className="text-base text-slate-700">{d.notFound.body}</p>
      <p className="mt-6 text-center text-sm"><Link href={`/${locale}/sign-in`} className="font-semibold text-teal hover:underline">{d.notFound.home}</Link></p>
    </AuthLayout>
  );
}
