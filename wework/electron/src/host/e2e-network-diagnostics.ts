import type { WebRequest } from 'electron'

/** Record stalled local requests without retaining headers, bodies, or query strings. */
export function installE2ENetworkDiagnostics(webRequest: WebRequest): void {
  const filter = { urls: ['http://127.0.0.1/*', 'http://localhost/*'] }
  const pending = new Map<
    number,
    { path: string; method: string; webContentsId?: number; startedAt: number }
  >()
  webRequest.onBeforeRequest(filter, (details, callback) => {
    pending.set(details.id, {
      path: new URL(details.url).pathname,
      method: details.method,
      webContentsId: details.webContentsId,
      startedAt: Date.now(),
    })
    callback({})
  })
  webRequest.onCompleted(filter, details => pending.delete(details.id))
  webRequest.onErrorOccurred(filter, details => {
    pending.delete(details.id)
    console.error('[desktop-e2e-network-error]', {
      at: new Date().toISOString(),
      path: new URL(details.url).pathname,
      method: details.method,
      error: details.error,
      webContentsId: details.webContentsId,
    })
  })
  const timer = setInterval(() => {
    const now = Date.now()
    const stalled = [...pending.values()]
      .map(({ startedAt, ...request }) => ({ ...request, elapsedMs: now - startedAt }))
      .filter(request => request.elapsedMs >= 5000)
    if (stalled.length) console.log('[desktop-e2e-pending-requests]', { at: now, stalled })
  }, 5000)
  timer.unref()
}
