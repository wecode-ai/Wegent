import type { RetrievalConfigDraft } from '@/types/knowledge'

/**
 * The one source of truth for "no score threshold configured".
 *
 * Zero means "do not cut": a threshold is a rule about a score scale, and the
 * scale belongs to the retriever backend, so any non-zero prefill is wrong on
 * some backend. Keep this in sync with DEFAULT_SCORE_THRESHOLD in
 * shared/models/runtime_config.py.
 */
export const DEFAULT_SCORE_THRESHOLD = 0

/** Baseline used until a system retrieval profile or user selection provides values. */
export function createDefaultRetrievalConfig(): RetrievalConfigDraft {
  return {
    retrieval_mode: 'vector',
    top_k: 5,
    score_threshold: DEFAULT_SCORE_THRESHOLD,
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
