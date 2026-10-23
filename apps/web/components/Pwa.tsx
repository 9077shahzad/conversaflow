'use client';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

/**
 * Registers the service worker (W2.5): offline page and notifications. Nothing is cached apart from the offline page
 * and the icon, so no conversation data stays on the device.
 */
export function PwaRegister() {
  const router = useRouter();
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => undefined);
    // A tapped notification asks this tab to open the conversation (no reload, so drafts are kept).
    const onMessage = (e: MessageEvent) => {
      const d = e.data as { type?: string; url?: string } | null;
      if (d?.type === 'open' && typeof d.url === 'string' && d.url.startsWith('/') && !d.url.startsWith('//')) router.push(d.url);
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => navigator.serviceWorker.removeEventListener('message', onMessage);
  }, [router]);
  return null;
}

/** Signing out: this browser stops receiving the member's alerts. */
export async function forgetPushHere(): Promise<void> {
  try {
    if (!('serviceWorker' in navigator)) return;
    const sub = await (await navigator.serviceWorker.getRegistration())?.pushManager.getSubscription();
    if (!sub) return;
    await fetch('/v1/me/notifications/devices/remove', { method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'conversaflow' }, body: JSON.stringify({ endpoint: sub.endpoint }) }).catch(() => undefined);
    await sub.unsubscribe();
  } catch { /* nothing to forget */ }
}

/** base64url (VAPID public key) to the bytes PushManager expects. */
export function urlBase64ToBytes(s: string): Uint8Array<ArrayBuffer> {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
