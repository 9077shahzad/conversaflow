'use client';
import { PwaRegister } from './Pwa';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { createContext, useContext, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { t, type Locale } from '@/lib/i18n';
import { LanguageSwitch } from './LanguageSwitch';
import { Logo } from './Logo';

export interface Me { id: string; email: string; fullName: string; activeTenantId: string | null; mfaEnabled: boolean }
export interface Workspace { id: string; legalName: string; active: boolean }
const Ctx = createContext<{ me: Me; workspace: Workspace | null } | null>(null);
export const useSession = () => {
  const v = useContext(Ctx);
  if (!v) throw new Error('useSession outside AppShell');
  return v;
};

type Item = { href: string; key: keyof ReturnType<typeof t>['nav']; later?: boolean; icon: string };
const ITEMS: Item[] = [
  { href: '', key: 'dashboard', icon: 'M4 13h6V4H4zm10 7h6V11h-6zM4 20h6v-5H4zm10-11h6V4h-6z' },
  { href: '/inbox', key: 'inbox', icon: 'M4 5h16v10h-5l-3 3-3-3H4z' },
  { href: '/templates', key: 'templates', icon: 'M6 3h9l3 3v15H6zm3 7h6m-6 4h6m-6 4h4' },
  { href: '/channel-health', key: 'health', icon: 'M3 12h4l3-7 4 14 3-7h4' },
  { href: '/contacts', key: 'contacts', icon: 'M12 12a4 4 0 100-8 4 4 0 000 8zm-7 8a7 7 0 0114 0' },
  { href: '/campaigns', key: 'campaigns', icon: 'M4 10v4l12 5V5zM16 9h4v6h-4' },
  { href: '/inbox-setup', key: 'inboxSetup', icon: 'M4 6h16M4 12h10M4 18h7m9-4l-3 3-2-2' },
  { href: '/ai', key: 'ai', icon: 'M12 3l1.8 4.2L18 9l-4.2 1.8L12 15l-1.8-4.2L6 9l4.2-1.8zM18 15l.9 2.1L21 18l-2.1.9L18 21l-.9-2.1L15 18l2.1-.9z' },
  { href: '/automations', key: 'automations', icon: 'M5 4h5v5H5zm9 11h5v5h-5zM7.5 9v4.5h9V15' },
  { href: '/reports', key: 'reports', icon: 'M5 20V10m7 10V4m7 16v-7' },
  { href: '/promises', key: 'promises', icon: 'M9 12l2 2 4-4M12 3a9 9 0 100 18 9 9 0 000-18z' },
  { href: '/notifications', key: 'notifications', icon: 'M6 16V11a6 6 0 0112 0v5l2 2H4zm4 4h4' },
  { href: '/settings/company', key: 'company', icon: 'M4 21V5l8-3 8 3v16M9 21v-5h6v5' },
  { href: '/settings/team', key: 'team', icon: 'M8 11a3 3 0 100-6 3 3 0 000 6zm8 0a3 3 0 100-6 3 3 0 000 6zM2 20a6 6 0 0112 0m-2 0a6 6 0 0110 0' },
];

export function AppShell({ locale, children }: { locale: Locale; children: React.ReactNode }) {
  const d = t(locale);
  const router = useRouter();
  const path = usePathname() ?? '';
  const [state, setState] = useState<{ me: Me; workspace: Workspace | null } | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const me = await api<Me>('/v1/me');
        const tenants = await api<Workspace[]>('/v1/me/tenants');
        setState({ me, workspace: tenants.find((w) => w.active) ?? null });
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) router.replace(`/${locale}/sign-in`);
      }
    })();
  }, [locale, router]);

  async function signOut() {
    await api('/v1/auth/logout', { method: 'POST' }).catch(() => undefined);
    router.replace(`/${locale}/sign-in`);
  }

  const base = `/${locale}/app`;
  const nav = (
    <nav aria-label={d.nav.main} className="flex flex-col gap-1 p-3">
      {ITEMS.map((it) => {
        const href = base + it.href;
        const current = it.href === '' ? path === base : path === href || path.startsWith(`${href}/`);
        const cls = `flex items-center gap-3 rounded-lg px-3 py-2.5 text-[15px] ${current ? 'bg-teal text-white' : 'text-slate-200 hover:bg-white/10'}`;
        const icon = (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
            <path d={it.icon} strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        );
        if (it.later) {
          return (
            <span key={it.key} className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-[15px] text-slate-400" aria-disabled="true">
              {icon}
              <span className="flex-1">{d.nav[it.key]}</span>
              <span className="rounded-sm bg-white/10 px-1.5 py-0.5 text-[11px] text-slate-300">{d.common.later}</span>
            </span>
          );
        }
        return (
          <Link key={it.key} href={href} className={cls} aria-current={current ? 'page' : undefined} onClick={() => setOpen(false)}>
            {icon}
            {d.nav[it.key]}
          </Link>
        );
      })}
    </nav>
  );

  return (
    <div className="flex min-h-screen">
      <PwaRegister />
      <aside className="hidden w-72 shrink-0 flex-col bg-navy lg:flex">
        <div className="px-5 py-5"><Logo by={d.brand.by} inverse /></div>
        {nav}
      </aside>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label={d.nav.menu}>
          <button className="absolute inset-0 bg-navy/60" aria-label={d.nav.menu} onClick={() => setOpen(false)} />
          <div className="absolute inset-y-0 inset-s-0 w-72 bg-navy">
            <div className="px-5 py-5"><Logo by={d.brand.by} inverse /></div>
            {nav}
          </div>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-slate-200 bg-white px-4 py-3 sm:px-6">
          <button className="rounded-lg border border-slate-300 p-2 lg:hidden" aria-label={d.nav.menu} aria-expanded={open} onClick={() => setOpen(true)}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16" /></svg>
          </button>
          {/* dir="auto": a Latin company name inside the Arabic layout is laid out (and shortened) in its own direction */}
          <p className="min-w-0 flex-1 truncate font-semibold text-navy" dir="auto">{state?.workspace?.legalName ?? ''}</p>
          <LanguageSwitch locale={locale} />
          <button onClick={signOut} className="rounded-full px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100">{d.common.signOut}</button>
        </header>
        <main className="min-w-0 flex-1 px-4 py-6 sm:px-8">
          {state ? <Ctx.Provider value={state}>{children}</Ctx.Provider> : <p className="text-slate-600">{d.common.loading}</p>}
        </main>
      </div>
    </div>
  );
}
