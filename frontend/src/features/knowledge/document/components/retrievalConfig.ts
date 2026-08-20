import type { RetrievalConfigDraft } from '@/types/knowledge'

/** Baseline used until a system retrieval profile or user selection provides values. */
export function createDefaultRetrievalConfig(): RetrievalConfigDraft {
  return {
    retrieval_mode: 'vector',
    top_k: 5,
    score_threshold: 0.5,
    hybrid_weights: {
      vector_weight: 0.7,
      keyword_weight: 0.3,
    },
  }
}

/** Baseline for the administrator form, which starts with public namespaces. */
export function createDefaultRetrievalProfile(): RetrievalConfigDraft {
  return {
    ...createDefaultRetrievalConfig(),
    retriever_namespace: 'default',
    embedding_config: { model_namespace: 'default' },
  }
}
