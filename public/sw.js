/* Pulse service worker.
 *
 * It exists so the app can be installed and so the built files load fast. It
 * never touches /api (live data, login, the terminal socket) and never stores
 * the page itself: navigations always go to the network, so a new deploy shows
 * up at once. If the server cannot be reached, a small offline page is shown
 * instead of a blank screen. */
const CACHE = 'pulse-v16';
const OFFLINE = '/offline.html';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll([OFFLINE, '/icons/icon-192.png']))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => caches.match(OFFLINE)));
    return;
  }

  // Vite fingerprints everything under /assets, so a cached copy never goes stale.
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.match(request).then(
        (hit) =>
          hit ||
          fetch(request).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              void caches.open(CACHE).then((cache) => cache.put(request, copy));
            }
            return res;
          }),
      ),
    );
  }
});
