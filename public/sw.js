/// <reference lib="webworker" />
const sw = /** @type {ServiceWorkerGlobalScope} */ (/** @type {unknown} */ (self))

const CACHE_NAME = 'online-sampler-v1'

// Pre-cache essential shell on install
sw.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(['/']))
  )
  sw.skipWaiting()
})

// Clean old caches on activate
sw.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  )
  sw.clients.claim()
})

// Network-first for navigation & API, cache-first for static assets
sw.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)

  // Skip non-GET and cross-origin
  if (event.request.method !== 'GET' || url.origin !== sw.location.origin) return

  // Navigation requests: network-first with offline fallback
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then((resp) => {
          const clone = resp.clone()
          caches.open(CACHE_NAME).then((c) => c.put(event.request, clone))
          return resp
        })
        .catch(() => caches.match('/'))
    )
    return
  }

  // Static assets (JS, CSS, fonts, images, audio): stale-while-revalidate
  event.respondWith(
    caches.open(CACHE_NAME).then((cache) =>
      cache.match(event.request).then((cached) => {
        const fetched = fetch(event.request).then((resp) => {
          if (resp.ok) cache.put(event.request, resp.clone())
          return resp
        })
        return cached || fetched
      })
    )
  )
})
