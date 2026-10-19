/** ConversaFlow mark (a "C" forming a speech bubble) and wordmark. The wordmark is always Latin, left-to-right. */
export function LogoMark({ size = 40 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="cf-g" x1="6" y1="6" x2="42" y2="42" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#0E7490" />
          <stop offset="1" stopColor="#10B981" />
        </linearGradient>
      </defs>
      <path
        d="M38.5 14.5A17 17 0 1 0 39 33l-6.2-3.6A10 10 0 1 1 32.4 18z"
        fill="url(#cf-g)"
      />
      <path d="M12 38l-2 7 7.5-4.2z" fill="#0E7490" />
      <circle cx="24" cy="24" r="4.2" fill="#10B981" />
    </svg>
  );
}

export function Logo({ by, inverse = false }: { by: string; inverse?: boolean }) {
  return (
    <span className="inline-flex items-center gap-3" dir="ltr">
      <LogoMark />
      <span className="flex flex-col leading-tight">
        <span className={`text-xl font-bold font-latin ${inverse ? 'text-white' : 'text-navy'}`}>
          Conversa<span className={inverse ? 'text-emerald' : 'text-emerald-strong'}>Flow</span>
        </span>
        <span className={`text-xs ${inverse ? 'text-slate-200' : 'text-slate-600'}`}>{by}</span>
      </span>
    </span>
  );
}
