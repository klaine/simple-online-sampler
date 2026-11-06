/// <reference lib="webworker" />
const sw = /** @type {ServiceWorkerGlobalScope} */ (/** @type {unknown} */ (self))

// __BUILD_ID__ is replaced at build time (vite.config.ts) so every deploy gets a fresh cache
// and the activate handler purges the previous one. In dev it stays literal, which is harmless.
const CACHE_NAME = 'online-sampler-__BUILD_ID__'

// Install: skip waiting immediately
sw.addEventListener('install', () => {
  sw.skipWaiting()
})

// Activate: claim clients + purge old caches
sw.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => sw.clients.claim())
  )
})

// Network-first for everything, cache as fallback for offline
sw.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)

  // Skip non-GET and cross-origin
  if (event.request.method !== 'GET' || url.origin !== sw.location.origin) return

  // Skip preset ZIP files (large, don't cache in SW)
  if (url.pathname.endsWith('.zip')) return

  // Vite's /assets/* files are content-hashed (immutable): serve cache-first, no network wait
  if (url.pathname.includes('/assets/')) {
    event.respondWith(
      caches.match(event.request).then((cached) => cached || fetch(event.request).then((resp) => {
        if (resp.ok) {
          const clone = resp.clone()
          caches.open(CACHE_NAME).then((c) => c.put(event.request, clone))
        }
        return resp
      }))
    )
    return
  }

  event.respondWith(
    fetch(event.request)
      .then((resp) => {
        // Cache successful responses for offline use
        if (resp.ok) {
          const clone = resp.clone()
          caches.open(CACHE_NAME).then((c) => c.put(event.request, clone))
        }
        return resp
      })
      .catch(() => caches.match(event.request).then((cached) => {
        // Offline fallback: serve from cache, or return offline page for navigation
        if (cached) return cached
        if (event.request.mode === 'navigate') return caches.match(sw.registration.scope)
        return new Response('', { status: 503 })
      }))
  )
})
