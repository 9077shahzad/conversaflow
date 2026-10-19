import { NextResponse, type NextRequest } from 'next/server';
import { buildCsp, newNonce } from './lib/csp';

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (pathname === '/') {
    const prefersArabic = (req.headers.get('accept-language') ?? '').toLowerCase().startsWith('ar');
    return NextResponse.redirect(new URL(prefersArabic ? '/ar/sign-in' : '/en/sign-in', req.url));
  }
  // A fresh nonce for every page. Next.js reads the policy from the request headers and stamps the nonce on its own
  // scripts; the same policy is sent to the browser.
  const nonce = newNonce();
  const csp = buildCsp(nonce, process.env.NODE_ENV === 'development');
  const headers = new Headers(req.headers);
  headers.set('x-nonce', nonce);
  headers.set('content-security-policy', csp);
  const res = NextResponse.next({ request: { headers } });
  res.headers.set('content-security-policy', csp);
  return res;
}

// Pages only: API proxy, built assets, images and the favicon do not need a nonce.
export const config = {
  matcher: [{ source: '/((?!v1/|_next/static|_next/image|favicon.ico).*)', missing: [{ type: 'header', key: 'next-router-prefetch' }] }],
};
