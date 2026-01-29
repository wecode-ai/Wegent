// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Knowledge base and document API client
 */

import { apiClient } from './client'
import type {
  AccessibleKnowledgeResponse,
  ChunkListResponse,
  ChunkResponse,
  DocumentDetailResponse,
  KnowledgeBase,
  KnowledgeBaseCreate,
  KnowledgeBaseListResponse,
  KnowledgeBaseUpdate,
  KnowledgeDocument,
  KnowledgeDocumentCreate,
  KnowledgeDocumentListResponse,
  KnowledgeDocumentUpdate,
  KnowledgeResourceScope,
  TableUrlValidationResponse,
  WebScrapeResponse,
} from '@/types/knowledge'

// ============== Knowledge Base APIs ==============

/**
 * List knowledge bases
 */
export async function listKnowledgeBases(
  scope: KnowledgeResourceScope = 'all',
  groupName?: string
): Promise<KnowledgeBaseListResponse> {
  let endpoint = `/knowledge-bases?scope=${scope}`
  if (scope === 'group' && groupName) {
    endpoint += `&group_name=${encodeURIComponent(groupName)}`
  }
  return apiClient.get<KnowledgeBaseListResponse>(endpoint)
}

/**
 * Get a knowledge base by ID
 */
export async function getKnowledgeBase(id: number): Promise<KnowledgeBase> {
  return apiClient.get<KnowledgeBase>(`/knowledge-bases/${id}`)
}

/**
 * Create a new knowledge base
 */
export async function createKnowledgeBase(data: KnowledgeBaseCreate): Promise<KnowledgeBase> {
  return apiClient.post<KnowledgeBase>('/knowledge-bases', data)
}

/**
 * Update a knowledge base
 */
export async function updateKnowledgeBase(
  id: number,
  data: KnowledgeBaseUpdate
): Promise<KnowledgeBase> {
  return apiClient.put<KnowledgeBase>(`/knowledge-bases/${id}`, data)
}

/**
 * Delete a knowledge base
 */
export async function deleteKnowledgeBase(id: number): Promise<void> {
  return apiClient.delete(`/knowledge-bases/${id}`)
}

/**
 * Update the knowledge base type (notebook <-> classic conversion)
 * @param id Knowledge base ID
 * @param kbType New type: 'notebook' or 'classic'
 * @returns Updated knowledge base
 */
export async function updateKnowledgeBaseType(
  id: number,
  kbType: 'notebook' | 'classic'
): Promise<KnowledgeBase> {
  return apiClient.patch<KnowledgeBase>(`/knowledge-bases/${id}/type`, { kb_type: kbType })
}

// ============== Knowledge Document APIs ==============

/**
 * List documents in a knowledge base
 */
export async function listDocuments(
  knowledgeBaseId: number
): Promise<KnowledgeDocumentListResponse> {
  return apiClient.get<KnowledgeDocumentListResponse>(
    `/knowledge-bases/${knowledgeBaseId}/documents`
  )
}

/**
 * Create a new document in a knowledge base
 */
export async function createDocument(
  knowledgeBaseId: number,
  data: KnowledgeDocumentCreate
): Promise<KnowledgeDocument> {
  return apiClient.post<KnowledgeDocument>(`/knowledge-bases/${knowledgeBaseId}/documents`, data)
}

/**
 * Update a document (enable/disable status)
 */
export async function updateDocument(
  documentId: number,
  data: KnowledgeDocumentUpdate
): Promise<KnowledgeDocument> {
  return apiClient.put<KnowledgeDocument>(`/knowledge-documents/${documentId}`, data)
}

/**
 * Delete a document
 */
export async function deleteDocument(documentId: number): Promise<void> {
  return apiClient.delete(`/knowledge-documents/${documentId}`)
}

// ============== Batch Document Operations ==============

/**
 * Batch operation result type
 */
export interface BatchOperationResult {
  success_count: number
  failed_count: number
  failed_ids: number[]
  message: string
}

/**
 * Batch delete multiple documents
 */
export async function batchDeleteDocuments(documentIds: number[]): Promise<BatchOperationResult> {
  return apiClient.post<BatchOperationResult>('/knowledge-documents/batch/delete', {
    document_ids: documentIds,
  })
}

// ============== Accessible Knowledge API ==============

/**
 * Get all accessible knowledge bases for the current user
 * (For AI chat integration)
 */
export async function getAccessibleKnowledge(): Promise<AccessibleKnowledgeResponse> {
  return apiClient.get<AccessibleKnowledgeResponse>('/knowledge-bases/accessible')
}

// ============== Table URL Validation APIs ==============

/**
 * Validate a table URL and extract metadata
 * @param url The table URL to validate
 * @returns Validation result with provider and extracted metadata
 */
export async function validateTableUrl(url: string): Promise<TableUrlValidationResponse> {
  return apiClient.post<TableUrlValidationResponse>('/tables/validate-url', { url })
}

// ============== Web Scraper APIs ==============

/**
 * Scrape a web page and convert to Markdown
 * @param url The URL to scrape
 * @returns Scraped content with title, markdown content, and metadata
 */
export async function scrapeWebPage(url: string): Promise<WebScrapeResponse> {
  return apiClient.post<WebScrapeResponse>('/web-scraper/scrape', { url })
}

/**
 * Response for web document creation
 */
export interface WebDocumentCreateResponse {
  success: boolean
  document?: KnowledgeDocument
  error_code?: string
  error_message?: string
}

/**
 * Response for web document refresh
 */
export interface WebDocumentRefreshResponse {
  success: boolean
  document?: KnowledgeDocument
  error_code?: string
  error_message?: string
}

/**
 * Create a document from a web page in a knowledge base
 * This endpoint scrapes the web page, saves the content, and creates a document record
 * @param url The URL to scrape
 * @param knowledgeBaseId The knowledge base ID to add the document to
 * @param name Optional document name (uses page title if not provided)
 * @returns Created document or error
 */
export async function createWebDocument(
  url: string,
  knowledgeBaseId: number,
  name?: string
): Promise<WebDocumentCreateResponse> {
  return apiClient.post<WebDocumentCreateResponse>('/web-scraper/create-document', {
    url,
    knowledge_base_id: knowledgeBaseId,
    name,
  })
}

/**
 * Refresh a web document by re-scraping its URL
 * This endpoint re-scrapes the web page, updates the content, and re-indexes the document
 * @param documentId The document ID to refresh
 * @returns Refreshed document or error
 */
export async function refreshWebDocument(documentId: number): Promise<WebDocumentRefreshResponse> {
  return apiClient.post<WebDocumentRefreshResponse>('/web-scraper/refresh-document', {
    document_id: documentId,
  })
}

// ============== Summary Refresh APIs ==============

/**
 * Response type for knowledge base summary refresh
 */
export interface KnowledgeBaseSummaryRefreshResponse {
  message: string
  status: string
}

/**
 * Refresh knowledge base summary by re-aggregating document summaries
 * @param kbId The knowledge base ID to refresh summary for
 * @returns Refresh result with status
 */
export async function refreshKnowledgeBaseSummary(
  kbId: number
): Promise<KnowledgeBaseSummaryRefreshResponse> {
  return apiClient.post<KnowledgeBaseSummaryRefreshResponse>(
    `/knowledge-bases/${kbId}/summary/refresh`
  )
}

// ============== Configuration APIs ==============

/**
 * Knowledge base configuration response
 */
export interface KnowledgeConfig {
  chunk_storage_enabled: boolean
}

/**
 * Get knowledge base configuration
 * Returns system-level configuration for knowledge base features
 */
export async function getKnowledgeConfig(): Promise<KnowledgeConfig> {
  return apiClient.get<KnowledgeConfig>('/knowledge-bases/config')
}

// ============== Chunk APIs ==============

/**
 * List chunks for a document with pagination
 * @param documentId The document ID
 * @param page Page number (1-based)
 * @param pageSize Number of items per page
 * @param search Optional search keyword
 */
export async function listDocumentChunks(
  documentId: number,
  page: number = 1,
  pageSize: number = 20,
  search?: string
): Promise<ChunkListResponse> {
  let endpoint = `/knowledge-documents/${documentId}/chunks?page=${page}&page_size=${pageSize}`
  if (search) {
    endpoint += `&search=${encodeURIComponent(search)}`
  }
  return apiClient.get<ChunkListResponse>(endpoint)
}

/**
 * Get a single chunk by index
 * @param documentId The document ID
 * @param chunkIndex The chunk index (0-based)
 */
export async function getDocumentChunk(
  documentId: number,
  chunkIndex: number
): Promise<ChunkResponse> {
  return apiClient.get<ChunkResponse>(`/knowledge-documents/${documentId}/chunks/${chunkIndex}`)
}

/**
 * Get document detail (content and summary)
 * Note: This endpoint requires knowing the knowledge_base_id.
 * Use getDocumentContent for document-only access without kb_id.
 * @param documentId The document ID
 */
export async function getDocumentDetail(documentId: number): Promise<DocumentDetailResponse> {
  return apiClient.get<DocumentDetailResponse>(`/knowledge-documents/${documentId}/detail`)
}
