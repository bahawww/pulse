/* Pulse service worker.
 *
 * It exists so the app can be installed and so the built files load fast. It
 * never touches /api (live data, login, the terminal socket) and never stores
 * the page itself: navigations always go to the network, so a new deploy shows
 * up at once. If the server cannot be reached, a small offline page is shown
 * instead of a blank screen. */
const CACHE = 'pulse-v16';
const OFFLINE = '/offline.html';
/** Every deploy adds fresh fingerprinted files; past this many, the oldest go. */
const MAX_ASSETS = 60;

function trim(cache) {
  return cache.keys().then((keys) => {
    const assets = keys.filter((k) => new URL(k.url).pathname.startsWith('/assets/'));
    return Promise.all(assets.slice(0, Math.max(0, assets.length - MAX_ASSETS)).map((k) => cache.delete(k)));
  });
}

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
              void caches.open(CACHE).then((cache) => cache.put(request, copy).then(() => trim(cache)));
            }
            return res;
          }),
      ),
    );
  }
});

// A push from the server (push.ts): a terminal notice while the app is in the
// background or closed. The payload is { title, body, tag, url }.
self.addEventListener('push', (event) => {
  let msg = {};
  try {
    msg = event.data ? event.data.json() : {};
  } catch {
    /* not JSON: show the generic line */
  }
  event.waitUntil(
    self.registration.showNotification(msg.title || 'Pulse', {
      body: msg.body || '',
      tag: msg.tag || 'pulse',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      data: { url: typeof msg.url === 'string' && msg.url.startsWith('/') ? msg.url : '/' },
    }),
  );
});

// An alert was tapped: bring the app forward on what it was about (the chat by
// default, the terminal for a push), or open it there.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/#chat';
  const hash = url.includes('#') ? url.slice(url.indexOf('#')) : '';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ('focus' in c) {
          if (hash) c.postMessage({ type: 'open', hash });
          return c.focus();
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});
