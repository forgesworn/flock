// flock — minimal runtime-cache service worker.
// Makes the app installable and offline-capable for visited assets without
// needing to know Vite's hashed filenames at build time.

const CACHE = 'flock-runtime-v2'

self.addEventListener('install', () => self.skipWaiting())

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys()
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
      await self.clients.claim()
    })(),
  )
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return
  // Never touch relay/websocket or cross-origin (tiles, etc.) traffic.
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return

  // Network-first for navigations (HTML) so app updates are picked up;
  // fall back to cache when offline. Vite asset filenames are content-hashed,
  // so referencing fresh HTML always pulls the right (cacheable) assets.
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE)
        try {
          const res = await fetch(request)
          if (res && res.status === 200) cache.put(request, res.clone())
          return res
        } catch {
          return (await cache.match(request)) || (await cache.match('./index.html')) || Response.error()
        }
      })(),
    )
    return
  }

  // Cache-first for hashed assets (immutable), revalidating in the background.
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE)
      const cached = await cache.match(request)
      const network = fetch(request)
        .then((res) => {
          if (res && res.status === 200 && res.type === 'basic') cache.put(request, res.clone())
          return res
        })
        .catch(() => cached)
      return cached || network
    })(),
  )
})
