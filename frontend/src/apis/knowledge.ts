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

// ============== Permission Management APIs ==============

import type {
  KnowledgeShareInfoResponse,
  MyPermissionResponse,
  PermissionBatchResult,
  PermissionCreate,
  PermissionListResponse,
  PermissionUpdate,
} from '@/types/knowledge'

/**
 * Get knowledge base share info (for share page)
 * @param kbId Knowledge base ID
 * @returns Share info with permission status
 */
export async function getKnowledgeShareInfo(kbId: number): Promise<KnowledgeShareInfoResponse> {
  return apiClient.get<KnowledgeShareInfoResponse>(`/knowledge-bases/${kbId}/share-info`)
}

/**
 * Get list of users with explicit permissions on a knowledge base
 * Requires manage permission
 * @param kbId Knowledge base ID
 * @returns List of permission records
 */
export async function getKnowledgePermissions(kbId: number): Promise<PermissionListResponse> {
  return apiClient.get<PermissionListResponse>(`/knowledge-bases/${kbId}/permissions`)
}

/**
 * Add permissions for multiple users to a knowledge base
 * Requires manage permission
 * @param kbId Knowledge base ID
 * @param data User IDs and permission type
 * @returns Batch operation result
 */
export async function addKnowledgePermissions(
  kbId: number,
  data: PermissionCreate
): Promise<PermissionBatchResult> {
  return apiClient.post<PermissionBatchResult>(`/knowledge-bases/${kbId}/permissions`, data)
}

/**
 * Update a user's permission for a knowledge base
 * Requires manage permission
 * @param kbId Knowledge base ID
 * @param userId User ID to update
 * @param data New permission type
 */
export async function updateKnowledgePermission(
  kbId: number,
  userId: number,
  data: PermissionUpdate
): Promise<{ message: string }> {
  return apiClient.put<{ message: string }>(`/knowledge-bases/${kbId}/permissions/${userId}`, data)
}

/**
 * Revoke a user's permission for a knowledge base
 * Requires manage permission
 * @param kbId Knowledge base ID
 * @param userId User ID to revoke
 */
export async function deleteKnowledgePermission(
  kbId: number,
  userId: number
): Promise<{ message: string }> {
  return apiClient.delete<{ message: string }>(`/knowledge-bases/${kbId}/permissions/${userId}`)
}

/**
 * Get current user's permission for a knowledge base
 * @param kbId Knowledge base ID
 * @returns Current user's permission info
 */
export async function getMyKnowledgePermission(kbId: number): Promise<MyPermissionResponse> {
  return apiClient.get<MyPermissionResponse>(`/knowledge-bases/${kbId}/my-permission`)
}

/**
 * Get the organization knowledge base
 * Creates it if doesn't exist and user is admin
 * @returns Organization knowledge base
 */
export async function getOrganizationKnowledgeBase(): Promise<KnowledgeBase> {
  return apiClient.get<KnowledgeBase>('/knowledge-bases/organization')
}

// ============== Permission Request APIs ==============

import type {
  MyRequestsResponse,
  PendingRequestCountResponse,
  PermissionRequestCheckResponse,
  PermissionRequestCreate,
  PermissionRequestListResponse,
  PermissionRequestProcess,
  PermissionRequestResponse,
} from '@/types/knowledge'

/**
 * Create a permission request for a knowledge base
 * @param data Request data with kind_id and optional reason
 * @returns Created permission request
 */
export async function createPermissionRequest(
  data: PermissionRequestCreate
): Promise<PermissionRequestResponse> {
  return apiClient.post<PermissionRequestResponse>('/permission-requests', data)
}

/**
 * Get all pending permission requests that the current user can process
 * @returns List of pending requests
 */
export async function getPendingPermissionRequests(): Promise<PermissionRequestListResponse> {
  return apiClient.get<PermissionRequestListResponse>('/permission-requests/pending')
}

/**
 * Get count of pending permission requests for notification badge
 * @returns Count of pending requests
 */
export async function getPendingRequestCount(): Promise<PendingRequestCountResponse> {
  return apiClient.get<PendingRequestCountResponse>('/permission-requests/pending/count')
}

/**
 * Get current user's permission requests
 * @param status Optional status filter
 * @returns List of user's requests
 */
export async function getMyPermissionRequests(status?: string): Promise<MyRequestsResponse> {
  const endpoint = status
    ? `/permission-requests/my?request_status=${status}`
    : '/permission-requests/my'
  return apiClient.get<MyRequestsResponse>(endpoint)
}

/**
 * Check if current user has a pending request for a knowledge base
 * @param kbId Knowledge base ID
 * @returns Check result with pending request if exists
 */
export async function checkPendingRequest(kbId: number): Promise<PermissionRequestCheckResponse> {
  return apiClient.get<PermissionRequestCheckResponse>(`/permission-requests/check/${kbId}`)
}

/**
 * Process (approve/reject) a permission request
 * @param requestId Request ID
 * @param data Processing data with action and optional message
 * @returns Updated permission request
 */
export async function processPermissionRequest(
  requestId: number,
  data: PermissionRequestProcess
): Promise<PermissionRequestResponse> {
  return apiClient.post<PermissionRequestResponse>(
    `/permission-requests/${requestId}/process`,
    data
  )
}

/**
 * Cancel a pending permission request
 * @param requestId Request ID
 * @returns Cancelled permission request
 */
export async function cancelPermissionRequest(
  requestId: number
): Promise<PermissionRequestResponse> {
  return apiClient.delete<PermissionRequestResponse>(`/permission-requests/${requestId}`)
}

/**
 * Get pending permission requests for a specific knowledge base
 * Requires manage permission
 * @param kbId Knowledge base ID
 * @returns List of pending requests
 */
export async function getKbPermissionRequests(
  kbId: number
): Promise<PermissionRequestListResponse> {
  return apiClient.get<PermissionRequestListResponse>(
    `/knowledge-bases/${kbId}/permission-requests`
  )
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
