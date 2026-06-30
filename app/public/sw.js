// flock — minimal runtime-cache service worker.
// Makes the app installable and offline-capable for visited assets without
// needing to know Vite's hashed filenames at build time.

const CACHE = 'flock-runtime-v1'

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
  // Never cache relay/websocket or cross-origin API traffic.
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return

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
