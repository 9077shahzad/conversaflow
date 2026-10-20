import '@fontsource/inter/400.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '@fontsource/ibm-plex-sans-arabic/400.css';
import '@fontsource/ibm-plex-sans-arabic/600.css';
import '@fontsource/ibm-plex-sans-arabic/700.css';
import '../globals.css';
import type { Metadata, Viewport } from 'next';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { dirOf, isLocale, t } from '@/lib/i18n';

export const metadata: Metadata = { title: 'ConversaFlow by Meronatic', description: 'One Platform. Every Conversation. Every Customer.' };
export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#0F172A' };
// Pages render per request so each one carries its own CSP nonce (ADR-028).
export const dynamic = 'force-dynamic';

export default async function LocaleLayout({ children, params }: { children: React.ReactNode; params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  await headers(); // reads the request (and its nonce); keeps rendering dynamic
  return (
    <html lang={locale} dir={dirOf(locale)}>
      <body className={`min-h-screen antialiased ${locale === 'ar' ? 'font-arabic' : 'font-latin'}`}>
        {/* Shown only by browsers older than the supported set (ADR-031); supported browsers hide it in globals.css. */}
        <p className="browser-notice" role="note">{t(locale).browser.unsupported}</p>
        {children}
      </body>
    </html>
  );
}
