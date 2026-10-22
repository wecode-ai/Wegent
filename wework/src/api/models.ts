export { createModelApi } from '@wegent/chat-core/model-api'

import type { HttpRequestOptions } from './http'
import type { UnifiedModelListResponse } from '@/types/api'

export interface ModelApi {
  listModels(
    options?: HttpRequestOptions & { forceRefresh?: boolean }
  ): Promise<UnifiedModelListResponse>
  refresh?(): void
  subscribe?(onChange: () => void): () => void
}
