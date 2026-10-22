import type { UnifiedModel } from './models'
import { getClientRequestCache } from './request-cache'

export interface ModelRequestOptions {
  signal?: AbortSignal
  forceRefresh?: boolean
}

const REQUEST_TIMEOUT_MS = 10_000

export function createModelApi(client: {
  get<T>(path: string, options?: ModelRequestOptions): Promise<T>
  getCacheScope?(): unknown
}) {
  const catalog = getClientRequestCache(client)

  async function loadModels(endpoint: string): Promise<{ data: UnifiedModel[] }> {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = new DOMException('Cloud model request timed out', 'TimeoutError')
        reject(error)
        controller.abort(error)
      }, REQUEST_TIMEOUT_MS)
    })
    try {
      // Settle even if a transport ignores abort, so the cache can evict its pending entry.
      return await Promise.race([
        client.get<{ data: UnifiedModel[] }>(endpoint, {
          signal: controller.signal,
        }),
        deadline,
      ])
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    listModels(options?: ModelRequestOptions): Promise<{ data: UnifiedModel[] }> {
      const query = new URLSearchParams()
      query.set('include_config', 'true')
      query.set('scope', 'all')
      query.set('model_category_type', 'llm')
      query.set('client_origin', 'wework')
      const endpoint = `/models/unified?${query.toString()}`
      const signal = options?.signal
      if (signal?.aborted)
        return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
      const request = catalog.get<{ data: UnifiedModel[] }>(
        endpoint,
        () => loadModels(endpoint),
        options?.forceRefresh ? 0 : 300_000
      )
      // Cancelling one subscriber must not abort another subscriber's shared read.
      if (!signal) return request
      return new Promise((resolve, reject) => {
        const abort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
        signal.addEventListener('abort', abort, { once: true })
        void request.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
      })
    },
  }
}
