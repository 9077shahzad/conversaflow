import { AppShell } from '@/components/AppShell';
import { isLocale } from '@/lib/i18n';
import { notFound } from 'next/navigation';

export default async function AppLayout({ children, params }: { children: React.ReactNode; params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  return <AppShell locale={locale}>{children}</AppShell>;
}
