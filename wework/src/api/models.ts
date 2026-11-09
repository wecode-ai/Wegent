export { createModelApi } from '@wegent/chat-core/model-api'

import type { HttpRequestOptions } from './http'
import type { UnifiedModel, UnifiedModelListResponse } from '@/types/api'

export interface ModelApi {
  listModels(
    options?: HttpRequestOptions & { forceRefresh?: boolean }
  ): Promise<UnifiedModelListResponse>
  /** Resolve one model even when it is hidden from the selector catalog. */
  getModel?(modelName: string, modelType?: string): Promise<UnifiedModel>
  refresh?(): void
  subscribe?(onChange: () => void): () => void
}
