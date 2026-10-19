import type { UnifiedModel } from './models'
import { getClientRequestCache } from './request-cache'

export interface ModelRequestOptions {
  signal?: AbortSignal
  forceRefresh?: boolean
}

export function createModelApi(client: {
  get<T>(path: string, options?: ModelRequestOptions): Promise<T>
  getCacheScope?(): unknown
}) {
  const catalog = getClientRequestCache(client)
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
        () => client.get(endpoint),
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
