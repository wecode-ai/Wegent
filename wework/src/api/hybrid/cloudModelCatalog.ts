import type { UnifiedModel } from '@/types/api'

/** Cache cloud models and refresh only on initial load or an explicit request. */
export function createCloudModelCatalog(
  load: (signal: AbortSignal, forceRefresh: boolean) => Promise<UnifiedModel[]>
) {
  let models: UnifiedModel[] = []
  let loadStarted = false
  let request: AbortController | null = null
  const listeners = new Set<() => void>()

  function loadCatalog(forceRefresh: boolean) {
    if (request) return
    loadStarted = true
    const controller = new AbortController()
    request = controller
    void Promise.resolve()
      .then(() => load(controller.signal, forceRefresh))
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
        request = null
      })
  }

  return {
    refresh: () => loadCatalog(true),
    loadIfNeeded() {
      if (!loadStarted) loadCatalog(false)
    },
    getModels(): UnifiedModel[] {
      return models
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => {
        if (!listeners.delete(listener) || listeners.size > 0) return
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
