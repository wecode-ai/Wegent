import type { UnifiedModel } from './models'

export interface ModelRequestOptions {
  signal?: AbortSignal
}

export function createModelApi(client: {
  get<T>(path: string, options?: ModelRequestOptions): Promise<T>
}) {
  return {
    listModels(options?: ModelRequestOptions): Promise<{ data: UnifiedModel[] }> {
      const query = new URLSearchParams()
      query.set('include_config', 'true')
      query.set('scope', 'all')
      query.set('model_category_type', 'llm')
      query.set('client_origin', 'wework')
      return client.get(`/models/unified?${query.toString()}`, options)
    },
  }
}
