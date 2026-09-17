import type { UnifiedModel } from '@/types/api'

const REQUEST_TIMEOUT_MS = 10_000

/** Cache cloud models and refresh only on initial load or an explicit request. */
export function createCloudModelCatalog(load: (signal: AbortSignal) => Promise<UnifiedModel[]>) {
  let models: UnifiedModel[] = []
  let loadStarted = false
  let request: AbortController | null = null
  let requestTimer: number | undefined
  const listeners = new Set<() => void>()

  function refresh() {
    if (request) return
    loadStarted = true
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
        listeners.forEach(listener => listener())
      })
      .catch(error => {
        if (request !== controller) return
        console.warn('[Wework] Failed to refresh cloud models', error)
      })
      .finally(() => {
        if (request !== controller) return
        window.clearTimeout(requestTimer)
        request = null
      })
  }

  return {
    refresh,
    loadIfNeeded() {
      if (!loadStarted) refresh()
    },
    getModels(): UnifiedModel[] {
      return models
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => {
        if (!listeners.delete(listener) || listeners.size > 0) return
        window.clearTimeout(requestTimer)
        if (request) {
          const controller = request
          request = null
          loadStarted = false
          controller.abort()
        }
      }
    },
  }
}
