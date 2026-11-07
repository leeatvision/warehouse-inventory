/* Keeps the app's own files on the device so it opens with no internet. Server calls are never cached. */
const VERSION = '%%VERSION%%';
const CACHE = 'app-' + VERSION;
const FILES = %%FILES%%;
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // The page itself and the install file (manifest) come from the network when online, so the browser always sees the
  // current app id and settings; everything else opens from the copy on the device.
  if (e.request.mode === 'navigate' || url.pathname.endsWith('.webmanifest')) {
    const cached = () => caches.match(e.request, { ignoreSearch: true }).then(hit => hit || caches.match('./index.html'));
    const net = fetch(e.request).then(r => { if (r.ok) { const c = r.clone(); caches.open(CACHE).then(k => k.put(e.request, c)); } return r; });
    // A slow connection should not hold up opening the app: after 3 seconds use the copy on the device.
    const slow = new Promise(res => setTimeout(res, 3000)).then(() => cached());
    e.respondWith(Promise.race([net.catch(() => cached()), slow.then(r => r || net)]));
    return;
  }
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(hit => hit || fetch(e.request).catch(() => caches.match('./index.html'))));
});
