import type { UnifiedModel } from './models'

export function createModelApi(client: { get<T>(path: string): Promise<T> }) {
  return {
    listModels(): Promise<{ data: UnifiedModel[] }> {
      const query = new URLSearchParams()
      query.set('include_config', 'true')
      query.set('scope', 'all')
      query.set('model_category_type', 'llm')
      query.set('client_origin', 'wework')
      return client.get(`/models/unified?${query.toString()}`)
    },
  }
}
