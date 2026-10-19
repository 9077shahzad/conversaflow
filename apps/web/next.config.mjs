/** @type {import('next').NextConfig} */
// API_URL is read at BUILD time (Next.js writes rewrites into the build). Build once per environment.
const api = process.env.API_URL ?? 'http://127.0.0.1:4000';
export default {
  reactStrictMode: true,
  poweredByHeader: false,
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
        // Only this origin may serve scripts, styles, fonts and API calls; no framing, no form posts elsewhere.
        // 'unsafe-inline' for scripts is needed by Next.js's own bootstrap; moving to per-request nonces is on the backlog.
        { key: 'Content-Security-Policy', value: "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'" },
      ],
    }];
  },
};
