import type { UnifiedModel } from '@/types/api'

/** Publish one model source independently, refreshing only on explicit requests. */
export function createModelCatalog(
  source: 'local' | 'cloud',
  load: (signal: AbortSignal, forceRefresh: boolean) => Promise<UnifiedModel[]>
) {
  let models: UnifiedModel[] = []
  let loadStarted = false
  let loadCompleted = false
  let request: AbortController | null = null
  let requestPromise: Promise<void> | null = null
  const listeners = new Set<() => void>()

  function loadCatalog(forceRefresh: boolean) {
    if (request) return requestPromise
    loadStarted = true
    const controller = new AbortController()
    request = controller
    requestPromise = Promise.resolve()
      .then(() => {
        controller.signal.throwIfAborted()
        return load(controller.signal, forceRefresh)
      })
      .then(nextModels => {
        if (controller.signal.aborted || request !== controller) return
        models = nextModels
        loadCompleted = true
        listeners.forEach(listener => listener())
      })
      .catch(error => {
        if (request !== controller) return
        loadCompleted = true
        console.warn(`[Wework] Failed to refresh ${source} models`, error)
      })
      .finally(() => {
        if (request !== controller) return
        request = null
        requestPromise = null
      })
    return requestPromise
  }

  return {
    refresh(options?: { invalidate?: boolean }) {
      if (options?.invalidate) {
        const previous = request
        request = null
        previous?.abort()
      }
      return loadCatalog(true)
    },
    loadIfNeeded() {
      if (!loadStarted) loadCatalog(false)
      return loadCompleted ? Promise.resolve() : (requestPromise ?? Promise.resolve())
    },
    getModels(): UnifiedModel[] {
      return models
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => {
        if (!listeners.delete(listener) || listeners.size > 0) return
        queueMicrotask(() => {
          if (listeners.size || !request) return
          const controller = request
          request = null
          loadStarted = false
          controller.abort()
        })
      }
    },
  }
}
