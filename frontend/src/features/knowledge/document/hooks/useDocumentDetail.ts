// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useState, useEffect, useCallback, useRef } from 'react'
import { knowledgeBaseApi } from '@/apis/knowledge-base'
import type { DocumentDetailResponse } from '@/types/knowledge'
import { toast } from 'sonner'
import { useTranslation } from '@/hooks/useTranslation'

// Maximum characters per request (matches backend MAX_DOCUMENT_READ_LIMIT)
const MAX_CHARS_PER_REQUEST = 100000

// Maximum number of chunks to process before yielding to prevent UI blocking
const CHUNKS_BEFORE_YIELD = 5

/**
 * Yield control back to the browser to prevent UI blocking during large file loading.
 * Uses setTimeout to allow the browser to process pending rendering and user input.
 */
function yieldToBrowser(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0))
}

interface UseDocumentDetailOptions {
  kbId: number
  docId: number
  includeContent?: boolean
  includeSummary?: boolean
  enabled?: boolean
}

// Omit content from detail to prevent confusion - use fullContent instead
type DocumentDetailWithoutContent = Omit<DocumentDetailResponse, 'content'>

interface UseDocumentDetailReturn {
  /**
   * Document detail data (metadata, summary).
   * NOTE: Does NOT include content. Use fullContent for document content.
   */
  detail: DocumentDetailWithoutContent | null
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
  /** Full accumulated content from all loads - SINGLE SOURCE OF TRUTH for content */
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
 *
 * Features:
 * - Request cancellation via AbortController when component unmounts
 * - Race condition prevention using refs for offset tracking
 * - Single source of truth for content (fullContent)
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
  const [detail, setDetail] = useState<DocumentDetailWithoutContent | null>(null)

  // Loading states
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  // Pagination state
  const [currentOffset, setCurrentOffset] = useState(0)
  const [hasMoreContent, setHasMoreContent] = useState(false)
  const [fullContent, setFullContent] = useState('')

  // Use ref to track offset for preventing race conditions
  const offsetRef = useRef(0)
  // Use ref for abort controller to cancel requests on unmount
  const abortControllerRef = useRef<AbortController | null>(null)

  // Update ref when state changes
  useEffect(() => {
    offsetRef.current = currentOffset
  }, [currentOffset])

  // Cleanup abort controller on unmount
  useEffect(() => {
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort()
        abortControllerRef.current = null
      }
    }
  }, [])

  /**
   * Fetch document detail (initial load or full refresh)
   */
  const fetchDetail = useCallback(async () => {
    // Cancel any pending request
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
    }
    // Create new abort controller for this request
    abortControllerRef.current = new AbortController()

    try {
      setLoading(true)
      setError(null)

      const response = await knowledgeBaseApi.getDocumentDetail(kbId, docId, {
        includeContent,
        includeSummary,
        offset: 0,
        limit: MAX_CHARS_PER_REQUEST,
      })

      // Extract content from response and store separately
      // Content is excluded from detail to make fullContent the single source of truth
      const { content: initialContent, ...detailWithoutContent } = response
      setDetail(detailWithoutContent)

      // Reset pagination state
      if (initialContent !== undefined) {
        const content = initialContent || ''
        setFullContent(content)
        setCurrentOffset(content.length)
        offsetRef.current = content.length

        // Determine if more content is available
        // truncated=true means there's more content beyond what was returned
        const contentLength = response.content_length || 0
        setHasMoreContent(response.truncated === true || content.length < contentLength)
      } else {
        setFullContent('')
        setCurrentOffset(0)
        offsetRef.current = 0
        setHasMoreContent(false)
      }
    } catch (err) {
      // Don't show error for aborted requests
      if (err instanceof Error && err.name === 'AbortError') {
        return
      }
      const errorMessage = err instanceof Error ? err.message : 'Failed to load document detail'
      setError(errorMessage)
      toast.error(t('document.detail.content.error'))
    } finally {
      setLoading(false)
    }
  }, [kbId, docId, includeContent, includeSummary, t])

  /**
   * Load more content (pagination)
   * Uses ref to prevent race conditions with stale closure values
   */
  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMoreContent) return

    // Use ref to get latest offset value
    const offset = offsetRef.current

    try {
      setLoadingMore(true)

      const response = await knowledgeBaseApi.getDocumentDetail(kbId, docId, {
        includeContent: true,
        includeSummary: false, // Don't need summary on pagination
        offset: offset,
        limit: MAX_CHARS_PER_REQUEST,
      })

      if (response.content) {
        // Append new content to existing content
        setFullContent(prev => prev + response.content)

        // Update offset using ref pattern to avoid stale closure
        const newOffset = offset + response.content.length
        setCurrentOffset(newOffset)
        offsetRef.current = newOffset

        // Check if there's more content
        const totalLength = response.content_length || 0
        const stillHasMore = newOffset < totalLength
        setHasMoreContent(stillHasMore)

        // Update detail truncated flag for consistency
        setDetail(prev => (prev ? { ...prev, truncated: stillHasMore } : null))
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to load more content'
      toast.error(errorMessage)
    } finally {
      setLoadingMore(false)
    }
  }, [kbId, docId, hasMoreContent, loadingMore])

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
      let offset = offsetRef.current
      let hasMore: boolean = hasMoreContent
      let accumulatedContent = fullContent

      // Keep loading until all content is fetched
      let chunksProcessed = 0
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

        // Yield to browser periodically to prevent UI blocking for very large files
        chunksProcessed++
        if (chunksProcessed % CHUNKS_BEFORE_YIELD === 0 && hasMore) {
          await yieldToBrowser()
        }
      }

      // Update state with all loaded content
      // Note: The loadingMore guard at the function start prevents concurrent execution,
      // so direct state updates are safe here
      setFullContent(accumulatedContent)
      setCurrentOffset(offset)
      offsetRef.current = offset
      setHasMoreContent(false)
      // Update truncated flag only (content is not stored in detail)
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
  }, [kbId, docId, hasMoreContent, fullContent, loadingMore])

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
    // Cancel any pending request
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
      abortControllerRef.current = null
    }

    setDetail(null)
    setFullContent('')
    setCurrentOffset(0)
    offsetRef.current = 0
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
