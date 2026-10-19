import type { Locale } from '@/lib/i18n';
import { t } from '@/lib/i18n';
import { LanguageSwitch } from './LanguageSwitch';
import { Logo } from './Logo';

const ICONS: Record<string, string> = {
  secure: 'M12 3l7 3v5c0 4.5-3 8.4-7 10-4-1.6-7-5.5-7-10V6z',
  gulf: 'M12 3a9 9 0 100 18 9 9 0 000-18zm0 0c2.5 2.7 3.8 5.7 3.8 9S14.5 18.3 12 21m0-18C9.5 5.7 8.2 8.7 8.2 12s1.3 6.3 3.8 9M3.6 9h16.8M3.6 15h16.8',
  ai: 'M12 3v3m0 12v3M3 12h3m12 0h3M6.3 6.3l2.1 2.1m7.2 7.2l2.1 2.1m0-11.4l-2.1 2.1m-7.2 7.2l-2.1 2.1M12 9a3 3 0 110 6 3 3 0 010-6z',
  separate: 'M4 5h7v14H4zM13 5h7v14h-7z',
};

/** Two-panel layout from the approved login design: brand panel and form card. Mirrors in Arabic. */
export function AuthLayout({ locale, children }: { locale: Locale; children: React.ReactNode }) {
  const d = t(locale);
  return (
    <div className="flex min-h-screen flex-col lg:flex-row">
      <aside className="relative flex flex-col justify-between gap-10 overflow-hidden bg-navy px-6 py-8 text-white lg:w-[46%] lg:px-12 lg:py-12">
        <div aria-hidden="true" className="brand-glow pointer-events-none absolute inset-0 opacity-60" />
        <div className="relative flex items-center justify-between gap-4">
          <Logo by={d.brand.by} inverse />
          <span className="lg:hidden"><LanguageSwitch locale={locale} className="border-slate-500 text-white hover:bg-white/10" /></span>
        </div>
        <div className="relative hidden lg:block">
          <p className="max-w-md text-3xl font-semibold leading-snug">{d.brand.tagline}</p>
          <ul className="mt-10 space-y-4">
            {(['secure', 'gulf', 'ai', 'separate'] as const).map((k) => (
              <li key={k} className="flex items-center gap-3 text-base text-slate-100">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#10B981" strokeWidth="1.8" aria-hidden="true">
                  <path d={ICONS[k]} strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                {d.features[k]}
              </li>
            ))}
          </ul>
        </div>
        <p className="relative hidden text-sm text-slate-300 lg:block">© 2026 Meronatic</p>
      </aside>
      <main className="flex flex-1 items-start justify-center px-4 py-8 sm:items-center sm:px-8">
        <div className="w-full max-w-md">
          <div className="mb-6 hidden justify-end lg:flex"><LanguageSwitch locale={locale} /></div>
          <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">{children}</div>
        </div>
      </main>
    </div>
  );
}

export function Field(props: { id: string; label: string; type?: string; autoComplete?: string; hint?: string; dirLtr?: boolean } & React.InputHTMLAttributes<HTMLInputElement>) {
  const { id, label, hint, dirLtr, ...rest } = props;
  return (
    <div className="mb-4">
      <label htmlFor={id} className="mb-1.5 block text-sm font-semibold text-navy">{label}</label>
      <input id={id} name={id} {...rest} dir={dirLtr ? 'ltr' : undefined}
        aria-describedby={hint ? `${id}-hint` : undefined}
        className={`block w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2.5 text-base text-navy placeholder:text-slate-500 focus:border-teal focus:outline-none focus:ring-2 focus:ring-teal/30 ${dirLtr ? 'text-start' : ''}`} />
      {hint && <p id={`${id}-hint`} className="mt-1 text-sm text-slate-600">{hint}</p>}
    </div>
  );
}

export function PrimaryButton({ children, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button {...rest} className="w-full rounded-lg bg-emerald-strong px-4 py-3 text-base font-semibold text-white hover:bg-[#065f46] disabled:opacity-60">
      {children}
    </button>
  );
}
