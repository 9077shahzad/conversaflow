'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { Locale } from '@/lib/i18n';
import { t } from '@/lib/i18n';

export function LanguageSwitch({ locale, className = '' }: { locale: Locale; className?: string }) {
  const path = usePathname() ?? `/${locale}`;
  const other: Locale = locale === 'en' ? 'ar' : 'en';
  const target = path.replace(/^\/(en|ar)(?=\/|$)/, `/${other}`);
  return (
    <Link
      href={target}
      hrefLang={other}
      lang={other}
      aria-label={t(locale).lang.switchLabel}
      className={`rounded-full border border-slate-300 px-3 py-1.5 text-sm font-medium text-navy hover:bg-white ${className}`}
    >
      {t(locale).lang.switchTo}
    </Link>
  );
}
