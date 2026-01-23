// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Hook for lazy-loading and caching chunk content for citations.
 */

import { useState, useCallback, useRef } from 'react'
import { getDocumentChunk } from '@/apis/knowledge'
import type { ChunkResponse } from '@/types/knowledge'

interface CacheEntry {
  content: ChunkResponse
  timestamp: number
}

// Cache duration: 5 minutes
const CACHE_DURATION = 5 * 60 * 1000

/**
 * Hook for fetching and caching chunk content for citation tooltips.
 * Provides lazy loading with caching to minimize API calls.
 */
export function useCitationContent() {
  const [loading, setLoading] = useState<Record<string, boolean>>({})
  const [error, setError] = useState<Record<string, string>>({})
  const cacheRef = useRef<Record<string, CacheEntry>>({})

  /**
   * Generate a cache key from document and chunk info
   */
  const getCacheKey = useCallback((documentId: number, chunkIndex: number) => {
    return `${documentId}-${chunkIndex}`
  }, [])

  /**
   * Check if a cache entry is still valid
   */
  const isCacheValid = useCallback((key: string) => {
    const entry = cacheRef.current[key]
    if (!entry) return false
    return Date.now() - entry.timestamp < CACHE_DURATION
  }, [])

  /**
   * Fetch chunk content with caching
   */
  const fetchChunkContent = useCallback(
    async (documentId: number, chunkIndex: number): Promise<ChunkResponse | null> => {
      const key = getCacheKey(documentId, chunkIndex)

      // Return cached content if valid
      if (isCacheValid(key)) {
        return cacheRef.current[key].content
      }

      // Set loading state
      setLoading(prev => ({ ...prev, [key]: true }))
      setError(prev => {
        const newError = { ...prev }
        delete newError[key]
        return newError
      })

      try {
        const content = await getDocumentChunk(documentId, chunkIndex)

        // Cache the result
        cacheRef.current[key] = {
          content,
          timestamp: Date.now(),
        }

        return content
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'Failed to fetch chunk content'
        setError(prev => ({ ...prev, [key]: errorMessage }))
        return null
      } finally {
        setLoading(prev => ({ ...prev, [key]: false }))
      }
    },
    [getCacheKey, isCacheValid]
  )

  /**
   * Get loading state for a specific chunk
   */
  const isLoading = useCallback(
    (documentId: number, chunkIndex: number) => {
      const key = getCacheKey(documentId, chunkIndex)
      return loading[key] || false
    },
    [getCacheKey, loading]
  )

  /**
   * Get error state for a specific chunk
   */
  const getError = useCallback(
    (documentId: number, chunkIndex: number) => {
      const key = getCacheKey(documentId, chunkIndex)
      return error[key] || null
    },
    [getCacheKey, error]
  )

  /**
   * Get cached content for a specific chunk (if available)
   */
  const getCachedContent = useCallback(
    (documentId: number, chunkIndex: number): ChunkResponse | null => {
      const key = getCacheKey(documentId, chunkIndex)
      if (isCacheValid(key)) {
        return cacheRef.current[key].content
      }
      return null
    },
    [getCacheKey, isCacheValid]
  )

  /**
   * Clear the cache
   */
  const clearCache = useCallback(() => {
    cacheRef.current = {}
  }, [])

  return {
    fetchChunkContent,
    isLoading,
    getError,
    getCachedContent,
    clearCache,
  }
}
