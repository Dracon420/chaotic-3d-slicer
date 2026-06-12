/* Elegoo Slice — service worker
 * App-shell caching so the UI opens offline. The HTML is fetched NETWORK-FIRST
 * (so a new build is picked up immediately, with the cache only as an offline
 * fallback); content-hashed assets are cache-first (they're immutable). API,
 * upload, output and socket traffic always go straight to the network. */

const CACHE = 'chaotic-3d-v3';
const SHELL = ['/', '/index.html', '/manifest.json', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function isNetworkOnly(url) {
  return (
    url.pathname.startsWith('/api') ||
    url.pathname.startsWith('/uploads') ||
    url.pathname.startsWith('/output') ||
    url.pathname.startsWith('/socket.io')
  );
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || isNetworkOnly(url)) return;

  const isHtml =
    request.mode === 'navigate' || (request.headers.get('accept') || '').includes('text/html');

  if (isHtml) {
    // NETWORK-FIRST for the app shell — always get the latest build when online,
    // fall back to the cached shell only when offline.
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put('/index.html', copy));
          return res;
        })
        .catch(() => caches.match('/index.html').then((r) => r || caches.match('/')))
    );
    return;
  }

  // Cache-first for hashed/static assets (immutable), then network.
  event.respondWith(
    caches.match(request).then(
      (cached) =>
        cached ||
        fetch(request)
          .then((res) => {
            if (res.ok && res.type === 'basic') {
              const copy = res.clone();
              caches.open(CACHE).then((c) => c.put(request, copy));
            }
            return res;
          })
          .catch(() => undefined)
    )
  );
});
