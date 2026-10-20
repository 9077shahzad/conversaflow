import { NextResponse, type NextRequest } from 'next/server';
import { buildCsp, FALLBACK_CSP, newNonce } from './lib/csp';
import { isLocale } from './lib/i18n';

/** Served without a page nonce: the API proxy and built static files. They still get the strict fallback policy. */
const isNonPage = (p: string) => p.startsWith('/v1/') || p.startsWith('/_next/static/') || p === '/favicon.ico';

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (pathname === '/') {
    const prefersArabic = (req.headers.get('accept-language') ?? '').toLowerCase().startsWith('ar');
    const res = NextResponse.redirect(new URL(prefersArabic ? '/ar/sign-in' : '/en/sign-in', req.url));
    res.headers.set('content-security-policy', FALLBACK_CSP);
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
  const rewriteTo = !isLocale(first) && !first.startsWith('_next')
    ? new URL(`/${(req.headers.get('accept-language') ?? '').toLowerCase().startsWith('ar') ? 'ar' : 'en'}/__not-found`, req.url)
    : null;
  // Every other response (pages, not-found pages, prefetches) gets a fresh nonce. Next.js reads the policy from the
  // request headers and stamps the nonce on its own scripts; the same policy is sent to the browser.
  const nonce = newNonce();
  const csp = buildCsp(nonce, process.env.NODE_ENV === 'development');
  const headers = new Headers(req.headers);
  headers.set('x-nonce', nonce);
  headers.set('content-security-policy', csp);
  const res = rewriteTo ? NextResponse.rewrite(rewriteTo, { request: { headers } }) : NextResponse.next({ request: { headers } });
  res.headers.set('content-security-policy', csp);
  return res;
}

// Runs on every request, so no response leaves without a policy (independent review F3).
export const config = { matcher: '/:path*' };
