// SPDX-FileCopyrightText: 2025 WeCode, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Knowledge base and document related types
 */

export type DocumentStatus = 'enabled' | 'disabled';

export type KnowledgeResourceScope = 'personal' | 'group' | 'all';

// Retrieval Config types
export interface RetrievalConfig {
  retriever_name: string;
  retriever_namespace: string;
  embedding_config: {
    model_name: string;
    model_namespace: string;
  };
  retrieval_mode?: 'vector' | 'keyword' | 'hybrid';
  top_k?: number;
  score_threshold?: number;
  hybrid_weights?: {
    vector_weight: number;
    keyword_weight: number;
  };
}

// Splitter Config types
export type SplitterType = 'sentence' | 'semantic';

// Base splitter config
export interface BaseSplitterConfig {
  type: SplitterType;
}

// Sentence splitter config
export interface SentenceSplitterConfig extends BaseSplitterConfig {
  type: 'sentence';
  separator?: string;
  chunk_size?: number;
  chunk_overlap?: number;
}

// Semantic splitter config
export interface SemanticSplitterConfig extends BaseSplitterConfig {
  type: 'semantic';
  buffer_size?: number; // 1-10, default 1
  breakpoint_percentile_threshold?: number; // 50-100, default 95
}

// Union type for splitter config
export type SplitterConfig = SentenceSplitterConfig | SemanticSplitterConfig;

// Knowledge Base types
export interface KnowledgeBase {
  id: number;
  name: string;
  description: string | null;
  user_id: number;
  namespace: string;
  document_count: number;
  is_active: boolean;
  retrieval_config?: RetrievalConfig;
  created_at: string;
  updated_at: string;
}

export interface KnowledgeBaseCreate {
  name: string;
  description?: string;
  namespace?: string;
  retrieval_config?: Partial<RetrievalConfig>;
}

export interface RetrievalConfigUpdate {
  retrieval_mode?: 'vector' | 'keyword' | 'hybrid';
  top_k?: number;
  score_threshold?: number;
  hybrid_weights?: {
    vector_weight: number;
    keyword_weight: number;
  };
}

export interface KnowledgeBaseUpdate {
  name?: string;
  description?: string;
  retrieval_config?: RetrievalConfigUpdate;
}

export interface KnowledgeBaseListResponse {
  total: number;
  items: KnowledgeBase[];
}

// Knowledge Document types
export interface KnowledgeDocument {
  id: number;
  kind_id: number;
  attachment_id: number | null;
  name: string;
  file_extension: string;
  file_size: number;
  status: DocumentStatus;
  user_id: number;
  is_active: boolean;
  splitter_config?: SplitterConfig;
  created_at: string;
  updated_at: string;
}

export interface KnowledgeDocumentCreate {
  attachment_id: number;
  name: string;
  file_extension: string;
  file_size: number;
  splitter_config?: Partial<SplitterConfig>;
}

export interface KnowledgeDocumentUpdate {
  name?: string;
  status?: DocumentStatus;
  splitter_config?: Partial<SplitterConfig>;
}

export interface KnowledgeDocumentListResponse {
  total: number;
  items: KnowledgeDocument[];
}

// Accessible Knowledge types (for AI integration)
export interface AccessibleKnowledgeBase {
  id: number;
  name: string;
  description: string | null;
  document_count: number;
  updated_at: string;
}

export interface TeamKnowledgeGroup {
  group_name: string;
  group_display_name: string | null;
  knowledge_bases: AccessibleKnowledgeBase[];
}

export interface AccessibleKnowledgeResponse {
  personal: AccessibleKnowledgeBase[];
  team: TeamKnowledgeGroup[];
}
