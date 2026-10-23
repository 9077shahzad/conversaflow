/*
 * ConversaFlow service worker (W2.5). Kept deliberately small:
 *  - shows notifications sent by the server (title, short text, link) and opens the conversation when tapped;
 *  - serves a plain offline page when there is no connection and the page cannot load.
 * It never stores API responses, messages or customer data: only the offline page and the icon are cached.
 */
const CACHE = 'cf-shell-v1';
const OFFLINE = ['/offline.html', '/icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(OFFLINE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  // Only page navigations get the offline fallback; everything else goes to the network untouched.
  if (req.mode !== 'navigate') return;
  event.respondWith(fetch(req).catch(() => caches.match('/offline.html')));
});

self.addEventListener('push', (event) => {
  let data = { title: 'ConversaFlow', body: '', url: '/', tag: 'conversaflow' };
  try { data = { ...data, ...event.data.json() }; } catch (e) { /* keep the default */ }
  // Only our own pages may be opened from a notification.
  const url = typeof data.url === 'string' && data.url.startsWith('/') && !data.url.startsWith('//') ? data.url : '/';
  event.waitUntil(self.registration.showNotification(data.title, { body: data.body, tag: data.tag, renotify: true, icon: '/icon.svg', badge: '/icon.svg', data: { url } }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
    for (const w of wins) {
      if (new URL(w.url).origin === self.location.origin && 'focus' in w) { w.navigate(url); return w.focus(); }
    }
    return self.clients.openWindow(url);
  }));
});
