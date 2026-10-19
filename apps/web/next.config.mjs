/** @type {import('next').NextConfig} */
// API_URL is read at BUILD time (Next.js writes rewrites into the build). Build once per environment.
const api = process.env.API_URL ?? 'http://127.0.0.1:4000';
export default {
  reactStrictMode: true,
  poweredByHeader: false,
  // Pages render per request (CSP nonce). Without this, Next.js streams <title> and other metadata after the body,
  // so the title is briefly missing for assistive technology. Treat every client as needing metadata up front.
  htmlLimitedBots: /.*/,
  // The browser talks only to this origin; API calls are proxied, so cookies stay first-party.
  async rewrites() {
    return [{ source: '/v1/:path*', destination: `${api}/v1/:path*` }];
  },
  async headers() {
    return [{
      source: '/:path*',
      headers: [
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        // The Content-Security-Policy is set per request in middleware.ts with a fresh nonce (ADR-028).
      ],
    }];
  },
};
