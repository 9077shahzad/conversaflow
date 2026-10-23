/**
 * Content Security Policy built per request (ADR-028).
 * Scripts run only with this response's nonce; 'strict-dynamic' lets those scripts load Next.js chunks.
 * Inline styles and inline event handlers are not allowed. 'self' is a fallback for browsers without nonce support.
 */
export function buildCsp(nonce: string, dev = false): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ''}`,
    `style-src 'self' 'nonce-${nonce}'`,
    "style-src-attr 'none'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src 'self'${dev ? ' ws:' : ''}`,
    // The service worker (W2.5) and the app manifest come from this origin only.
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    'upgrade-insecure-requests',
  ].join('; ');
}

/** 128 random bits, base64, from the Web Crypto API (available in the Edge middleware runtime). */
export function newNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
}

/** The service worker, offline page, icon and manifest: own-origin resources only, no scripts in the offline page. */
export const SHELL_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

/** For responses that are not pages (API JSON, files, built assets): nothing may run, frame or load from them. */
export const FALLBACK_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
