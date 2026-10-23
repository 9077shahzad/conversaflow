import { NextResponse, type NextRequest } from 'next/server';
import { buildCsp, FALLBACK_CSP, newNonce, SHELL_CSP } from './lib/csp';
import { isLocale } from './lib/i18n';

/** Served without a page nonce: the API proxy and built static files. They still get the strict fallback policy. */
const isNonPage = (p: string) => p.startsWith('/v1/') || p.startsWith('/_next/static/') || p === '/favicon.ico';
/** The installable-app files (W2.5): the service worker must be able to fetch our own pages, so 'self' is allowed. */
const SHELL_FILES = new Set(['/sw.js', '/offline.html', '/offline.css', '/icon.svg', '/manifest.webmanifest']);

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (pathname === '/') {
    const prefersArabic = (req.headers.get('accept-language') ?? '').toLowerCase().startsWith('ar');
    const res = NextResponse.redirect(new URL(prefersArabic ? '/ar/sign-in' : '/en/sign-in', req.url));
    res.headers.set('content-security-policy', FALLBACK_CSP);
    return res;
  }
  if (SHELL_FILES.has(pathname)) {
    const res = NextResponse.next();
    res.headers.set('content-security-policy', SHELL_CSP);
    if (pathname === '/sw.js') { res.headers.set('cache-control', 'no-cache'); res.headers.set('service-worker-allowed', '/'); }
    return res;
  }
  if (isNonPage(pathname)) {
    const res = NextResponse.next();
    res.headers.set('content-security-policy', FALLBACK_CSP);
    return res;
  }
  // Unknown top-level paths (no /en or /ar prefix) are shown the localised not-found page, rendered per request
  // with a nonce, instead of Next.js's prerendered one (recheck R4-5). The address bar keeps the original path.
  const first = pathname.split('/')[1] ?? '';
  const preferred = (req.headers.get('accept-language') ?? '').toLowerCase().startsWith('ar') ? 'ar' : 'en';
  const locale = isLocale(first) ? first : preferred;
  const rewriteTo = !isLocale(first) && first !== '_next' ? new URL(`/${preferred}/__not-found`, req.url) : null;
  // Every other response (pages, not-found pages, prefetches) gets a fresh nonce. Next.js reads the policy from the
  // request headers and stamps the nonce on its own scripts; the same policy is sent to the browser.
  const nonce = newNonce();
  const csp = buildCsp(nonce, process.env.NODE_ENV === 'development');
  const headers = new Headers(req.headers);
  headers.set('x-nonce', nonce);
  headers.set('content-security-policy', csp);
  headers.set('x-cf-locale', locale); // fixed value: 'en' or 'ar' only
  const res = rewriteTo ? NextResponse.rewrite(rewriteTo, { request: { headers } }) : NextResponse.next({ request: { headers } });
  res.headers.set('content-security-policy', csp);
  return res;
}

// Runs on every request, so no response leaves without a policy (independent review F3).
export const config = { matcher: '/:path*' };
