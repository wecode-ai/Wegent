import { subscribeSystemResume } from '@/desktop/systemResume'
import type { UnifiedModel } from '@/types/api'

const REFRESH_INTERVAL_MS = 60_000
const RETRY_DELAY_MS = 5_000
const REQUEST_TIMEOUT_MS = 10_000

/** Own the cloud cache and keep it fresh only while a model consumer is mounted. */
export function createCloudModelCatalog(load: (signal: AbortSignal) => Promise<UnifiedModel[]>) {
  let models: UnifiedModel[] = []
  let nextRefreshAt = 0
  let retryDelay = RETRY_DELAY_MS
  let request: AbortController | null = null
  let refreshTimer: number | undefined
  let requestTimer: number | undefined
  let unsubscribeResume: (() => void) | undefined
  const listeners = new Set<() => void>()

  const scheduleRefresh = () => {
    window.clearTimeout(refreshTimer)
    if (listeners.size === 0 || request) return
    refreshTimer = window.setTimeout(refresh, Math.max(0, nextRefreshAt - Date.now()))
  }

  function refresh() {
    if (request) return
    window.clearTimeout(refreshTimer)
    const controller = new AbortController()
    request = controller
    requestTimer = window.setTimeout(() => {
      controller.abort(new DOMException('Cloud model request timed out', 'TimeoutError'))
    }, REQUEST_TIMEOUT_MS)

    void Promise.resolve()
      .then(() => load(controller.signal))
      .then(nextModels => {
        if (controller.signal.aborted || request !== controller) return
        models = nextModels
        retryDelay = RETRY_DELAY_MS
        nextRefreshAt = Date.now() + REFRESH_INTERVAL_MS
        listeners.forEach(listener => listener())
      })
      .catch(error => {
        if (request !== controller) return
        nextRefreshAt = Date.now() + retryDelay
        retryDelay = Math.min(retryDelay * 2, REFRESH_INTERVAL_MS)
        console.warn('[Wework] Failed to refresh cloud models in background', error)
      })
      .finally(() => {
        if (request !== controller) return
        window.clearTimeout(requestTimer)
        request = null
        scheduleRefresh()
      })
  }

  const refreshIfDue = () => {
    if (Date.now() >= nextRefreshAt) refresh()
  }

  return {
    refreshIfDue,
    getModels(): UnifiedModel[] {
      return models
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      if (listeners.size === 1) {
        window.addEventListener('online', refresh)
        window.addEventListener('focus', refreshIfDue)
        unsubscribeResume = subscribeSystemResume(refresh)
        refreshIfDue()
        scheduleRefresh()
      }
      return () => {
        if (!listeners.delete(listener)) return
        if (listeners.size > 0) return
        window.removeEventListener('online', refresh)
        window.removeEventListener('focus', refreshIfDue)
        unsubscribeResume?.()
        window.clearTimeout(refreshTimer)
        window.clearTimeout(requestTimer)
        if (request) {
          const controller = request
          request = null
          nextRefreshAt = 0
          controller.abort()
        }
      }
    },
  }
}
