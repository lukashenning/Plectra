const CACHE = 'plectra-v1';

// On install: pre-cache the app shell (index.html).
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.add('/Plectra/')));
  self.skipWaiting();
});

// On activate: remove any old cache versions.
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// On fetch: network-first — serve live when online, fall back to cache offline.
// Every successful response is stored in the cache for future offline use.
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.open(CACHE).then(async cache => {
      try {
        const resp = await fetch(e.request);
        if (resp.ok) cache.put(e.request, resp.clone());
        return resp;
      } catch {
        const cached = await cache.match(e.request);
        return cached ?? Response.error();
      }
    })
  );
});
