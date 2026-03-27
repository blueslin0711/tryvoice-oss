const CACHE = 'tryvoice-v1';

self.addEventListener('install', evt => {
  self.skipWaiting();
});

self.addEventListener('activate', evt => {
  evt.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', evt => {
  if (evt.request.method !== 'GET') return;
  // Only cache static assets, not API requests
  const url = new URL(evt.request.url);
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/ws')
      || url.pathname.startsWith('/health') || url.pathname.startsWith('/history')
      || url.pathname.startsWith('/slots') || url.pathname.startsWith('/tts')
      || url.pathname.startsWith('/adapter') || url.pathname.startsWith('/setup')
      || url.pathname.startsWith('/stt-config') || url.pathname.startsWith('/media')) {
    return;
  }
  evt.respondWith(
    caches.match(evt.request).then(cached =>
      cached || fetch(evt.request).then(resp => {
        if (resp.ok) {
          const clone = resp.clone();
          caches.open(CACHE).then(c => c.put(evt.request, clone));
        }
        return resp;
      })
    )
  );
});
