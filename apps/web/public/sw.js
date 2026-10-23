/*
 * ConversaFlow service worker (W2.5). Kept deliberately small:
 *  - shows notifications sent by the server (title, short text, link) and opens the conversation when tapped;
 *  - serves a plain offline page when there is no connection and the page cannot load.
 * It never stores API responses, messages or customer data: only the offline page and the icon are cached.
 */
// Change the version whenever the offline page or icon changes, so devices fetch them again.
const CACHE = 'cf-shell-v2';
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
  const url = sameOrigin(data.url) ? data.url : '/';
  event.waitUntil(self.registration.showNotification(data.title, { body: data.body, tag: data.tag, renotify: true, icon: '/icon.svg', badge: '/icon.svg', data: { url } }));
});

function sameOrigin(url) {
  try { return typeof url === 'string' && new URL(url, self.location.origin).origin === self.location.origin; } catch (e) { return false; }
}

// An open tab is focused and asked to open the conversation itself, so drafts and waiting replies in it survive.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const raw = (event.notification.data && event.notification.data.url) || '/';
  const url = sameOrigin(raw) ? raw : '/';
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
    for (const w of wins) {
      if (new URL(w.url).origin === self.location.origin && 'focus' in w) { w.postMessage({ type: 'open', url }); return w.focus(); }
    }
    return self.clients.openWindow(url);
  }));
});
