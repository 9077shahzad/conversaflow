import { NextResponse, type NextRequest } from 'next/server';

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (pathname === '/') {
    const prefersArabic = (req.headers.get('accept-language') ?? '').toLowerCase().startsWith('ar');
    return NextResponse.redirect(new URL(prefersArabic ? '/ar/sign-in' : '/en/sign-in', req.url));
  }
  return NextResponse.next();
}

export const config = { matcher: ['/'] };
