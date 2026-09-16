import type { HttpClient, HttpRequestOptions } from './http'
import type { UnifiedModelListResponse } from '@/types/api'

export interface ModelApi {
  listModels(options?: HttpRequestOptions): Promise<UnifiedModelListResponse>
  refresh?(): void
  subscribe?(onChange: () => void): () => void
}

export function createModelApi(client: HttpClient) {
  return {
    listModels(options?: HttpRequestOptions): Promise<UnifiedModelListResponse> {
      const query = new URLSearchParams()
      query.set('include_config', 'true')
      query.set('scope', 'all')
      query.set('model_category_type', 'llm')
      query.set('client_origin', 'wework')
      return client.get(`/models/unified?${query.toString()}`, options)
    },
  }
}
