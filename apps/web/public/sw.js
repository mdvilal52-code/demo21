/* AI Concierge customer app — offline shell.
 *
 * Deliberately small and conservative:
 *  - scope is /concierge only, i.e. the app's start page and everything under it (registered that way); the staff dashboard is never touched;
 *  - /api/* (the chat itself) is NEVER cached — a customer must always see live messages;
 *  - static build assets are cache-first (they are content-hashed, so this is always safe);
 *  - a page navigation that fails (offline) falls back to a small precached /offline page.
 */
const VERSION = 'v2';
const SHELL_CACHE = `concierge-shell-${VERSION}`;
const STATIC_CACHE = `concierge-static-${VERSION}`;
const OFFLINE_URL = '/offline';

/**
 * Caches the offline page AND the hashed build assets it references, so the page can hydrate
 * (its reload button is a client component) when it is served with no connection.
 */
async function precacheOfflinePage() {
  const response = await fetch(new Request(OFFLINE_URL, { cache: 'reload' }));
  if (!response.ok) throw new Error('offline page unavailable');
  const html = await response.clone().text();
  const shell = await caches.open(SHELL_CACHE);
  await shell.put(OFFLINE_URL, response);
  const assets = [...new Set(html.match(/\/_next\/static\/[^"'\\\s)]+/g) || [])];
  const statics = await caches.open(STATIC_CACHE);
  await Promise.all(assets.map((asset) => statics.add(asset).catch(() => undefined)));
}

self.addEventListener('install', (event) => {
  event.waitUntil(precacheOfflinePage().then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => !key.endsWith(VERSION)).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  if (url.pathname.startsWith('/_next/static/')) {
    event.respondWith(
      caches.open(STATIC_CACHE).then(async (cache) => {
        const cached = await cache.match(request);
        if (cached) return cached;
        const response = await fetch(request);
        if (response.ok) cache.put(request, response.clone());
        return response;
      }),
    );
    return;
  }

  if (request.mode === 'navigate' && url.pathname.startsWith('/concierge')) {
    event.respondWith(
      fetch(request).catch(() =>
        caches.match(OFFLINE_URL).then((page) => page || Response.error()),
      ),
    );
  }
});
