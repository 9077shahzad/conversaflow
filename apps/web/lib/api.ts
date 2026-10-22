/** Thin client for the ConversaFlow API (same origin, proxied by Next.js). */
export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: unknown) {
    super(message);
  }
}

export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method: init.method ?? 'GET',
    credentials: 'same-origin',
    headers: {
      ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      'X-Requested-With': 'conversaflow',
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = (data as { error?: { code?: string; message?: string; details?: unknown } }).error ?? {};
    throw new ApiError(res.status, e.code ?? 'unknown', e.message ?? res.statusText, e.details);
  }
  return data as T;
}
