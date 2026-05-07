// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useState, useEffect, useCallback } from 'react'
import { knowledgeBaseApi } from '@/apis/knowledge-base'
import type { DocumentDetailResponse } from '@/types/knowledge'
import { toast } from 'sonner'
import { useTranslation } from '@/hooks/useTranslation'

// Maximum characters per request (matches backend MAX_DOCUMENT_READ_LIMIT)
const MAX_CHARS_PER_REQUEST = 100000

interface UseDocumentDetailOptions {
  kbId: number
  docId: number
  includeContent?: boolean
  includeSummary?: boolean
  enabled?: boolean
}

interface UseDocumentDetailReturn {
  /** Document detail data */
  detail: DocumentDetailResponse | null
  /** Whether initial loading is in progress */
  loading: boolean
  /** Error message if loading failed */
  error: string | null
  /** Whether refreshing summary is in progress */
  refreshing: boolean
  /** Whether loading more content is in progress */
  loadingMore: boolean
  /** Current offset for pagination */
  currentOffset: number
  /** Whether more content is available to load */
  hasMoreContent: boolean
  /** Full accumulated content from all loads */
  fullContent: string
  /** Refresh document detail */
  refresh: () => Promise<void>
  /** Refresh document summary */
  refreshSummary: () => Promise<void>
  /** Load more content (for truncated documents) */
  loadMore: () => Promise<void>
  /** Load all remaining content (for editing) */
  loadAllContent: () => Promise<{ content: string; hasMore: boolean; loading: boolean } | undefined>
}

/**
 * Hook for fetching and managing document detail with pagination support.
 *
 * For large documents (>100k chars), content is loaded in chunks.
 * The hook accumulates content and provides loadMore functionality.
 */
export function useDocumentDetail({
  kbId,
  docId,
  includeContent = true,
  includeSummary = true,
  enabled = true,
}: UseDocumentDetailOptions): UseDocumentDetailReturn {
  const { t } = useTranslation('knowledge')

  // Main detail state (contains summary and metadata)
  const [detail, setDetail] = useState<DocumentDetailResponse | null>(null)

  // Loading states
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  // Pagination state
  const [currentOffset, setCurrentOffset] = useState(0)
  const [hasMoreContent, setHasMoreContent] = useState(false)
  const [fullContent, setFullContent] = useState('')

  /**
   * Fetch document detail (initial load or full refresh)
   */
  const fetchDetail = useCallback(async () => {
    try {
      setLoading(true)
      setError(null)

      const response = await knowledgeBaseApi.getDocumentDetail(kbId, docId, {
        includeContent,
        includeSummary,
        offset: 0,
        limit: MAX_CHARS_PER_REQUEST,
      })

      setDetail(response)

      // Reset pagination state
      if (response.content !== undefined) {
        setFullContent(response.content || '')
        setCurrentOffset(response.content?.length || 0)

        // Determine if more content is available
        // truncated=true means there's more content beyond what was returned
        const contentLength = response.content_length || 0
        const returnedLength = response.content?.length || 0
        setHasMoreContent(response.truncated === true || returnedLength < contentLength)
      } else {
        setFullContent('')
        setCurrentOffset(0)
        setHasMoreContent(false)
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to load document detail'
      setError(errorMessage)
      toast.error(t('document.detail.content.error'))
    } finally {
      setLoading(false)
    }
  }, [kbId, docId, includeContent, includeSummary, t])

  /**
   * Load more content (pagination)
   */
  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMoreContent) return

    try {
      setLoadingMore(true)

      const response = await knowledgeBaseApi.getDocumentDetail(kbId, docId, {
        includeContent: true,
        includeSummary: false, // Don't need summary on pagination
        offset: currentOffset,
        limit: MAX_CHARS_PER_REQUEST,
      })

      if (response.content) {
        // Append new content to existing content
        setFullContent(prev => prev + response.content)

        // Update offset
        const newOffset = currentOffset + response.content.length
        setCurrentOffset(newOffset)

        // Check if there's more content
        const totalLength = response.content_length || 0
        setHasMoreContent(newOffset < totalLength)

        // Update detail content for consistency
        setDetail(prev => (prev ? { ...prev, truncated: newOffset < totalLength } : null))
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to load more content'
      toast.error(errorMessage)
    } finally {
      setLoadingMore(false)
    }
  }, [kbId, docId, currentOffset, hasMoreContent, loadingMore])

  /**
   * Load all remaining content (for editing truncated documents)
   * This will keep loading until all content is fetched
   * Returns the final content and state flags to avoid stale closure issues
   */
  const loadAllContent = useCallback(async () => {
    // Guard against concurrent execution with loadMore or another loadAllContent call
    if (loadingMore || !hasMoreContent) {
      return { content: fullContent, hasMore: hasMoreContent, loading: loadingMore }
    }

    try {
      setLoadingMore(true)
      // Read state into local variables to avoid stale closure issues
      let offset = currentOffset
      let hasMore: boolean = hasMoreContent
      let accumulatedContent = fullContent

      // Keep loading until all content is fetched
      while (hasMore) {
        const response = await knowledgeBaseApi.getDocumentDetail(kbId, docId, {
          includeContent: true,
          includeSummary: false,
          offset: offset,
          limit: MAX_CHARS_PER_REQUEST,
        })

        if (response.content) {
          accumulatedContent += response.content
          offset += response.content.length

          const totalLength = response.content_length || 0
          hasMore = offset < totalLength
        } else {
          hasMore = false
        }
      }

      // Update state with all loaded content
      // Note: The loadingMore guard at the function start prevents concurrent execution,
      // so direct state updates are safe here
      setFullContent(accumulatedContent)
      setCurrentOffset(offset)
      setHasMoreContent(false)
      setDetail(prev => (prev ? { ...prev, truncated: false } : null))

      // Return the final content and state for immediate use by callers
      return { content: accumulatedContent, hasMore: false, loading: false }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to load all content'
      toast.error(errorMessage)
      // Return current state on error
      return { content: fullContent, hasMore: hasMoreContent, loading: false }
    } finally {
      setLoadingMore(false)
    }
  }, [kbId, docId, currentOffset, hasMoreContent, fullContent, loadingMore])

  /**
   * Refresh document summary
   */
  const refreshSummary = useCallback(async () => {
    try {
      setRefreshing(true)
      await knowledgeBaseApi.refreshDocumentSummary(kbId, docId)
      toast.success(t('document.detail.summary.refresh') + ' ' + t('common:actions.success'))
      // Refresh the detail after triggering summary generation
      await fetchDetail()
    } catch {
      toast.error(t('document.detail.summary.refresh') + ' ' + t('common:actions.failed'))
    } finally {
      setRefreshing(false)
    }
  }, [kbId, docId, fetchDetail, t])

  // Initial load
  useEffect(() => {
    if (enabled) {
      fetchDetail()
    }
  }, [fetchDetail, enabled])

  // Reset state when document changes
  useEffect(() => {
    setDetail(null)
    setFullContent('')
    setCurrentOffset(0)
    setHasMoreContent(false)
    // Clear transient flags to avoid stale UI state from previous document
    setLoadingMore(false)
    setError(null)
    setRefreshing(false)
  }, [kbId, docId])

  return {
    detail,
    loading,
    error,
    refreshing,
    loadingMore,
    currentOffset,
    hasMoreContent,
    fullContent,
    refresh: fetchDetail,
    refreshSummary,
    loadMore,
    loadAllContent,
  }
}
