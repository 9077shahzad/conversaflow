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
