/** Recovery for stale-deploy asset failures.
 *  A static host replaces hashed /assets/* on every deploy, so a tab (or cached index.html) from an
 *  older build can fail to fetch a lazy chunk. One automatic reload picks up the current build;
 *  the sessionStorage guard prevents a reload loop if the failure is persistent. */

const RELOAD_KEY = 'chunk-reload-at'
const RELOAD_WINDOW_MS = 30_000

export function isChunkLoadError(err: unknown): boolean {
  const msg = err instanceof Error ? `${err.name} ${err.message}` : String(err ?? '')
  return /dynamically imported module|importing a module script failed|error loading dynamically imported|loading chunk|loading css chunk|module script failed/i.test(msg)
}

/** Reloads once per 30s window. Returns true if a reload was triggered. */
export function reloadOnceForNewVersion(): boolean {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_KEY) ?? 0)
    if (Date.now() - last < RELOAD_WINDOW_MS) return false
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()))
  } catch {
    return false // storage unavailable: don't risk a reload loop
  }
  window.location.reload()
  return true
}

/** Drop the service worker + its caches, then reload (manual "something is badly stuck" escape hatch). */
export async function resetAppCacheAndReload(): Promise<void> {
  try {
    const regs = await navigator.serviceWorker?.getRegistrations?.()
    await Promise.all((regs ?? []).map((r) => r.unregister()))
    const keys = await caches?.keys?.()
    await Promise.all((keys ?? []).map((k) => caches.delete(k)))
  } catch { /* best effort */ }
  window.location.reload()
}
