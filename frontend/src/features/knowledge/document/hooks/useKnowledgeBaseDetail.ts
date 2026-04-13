// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Custom hook for fetching knowledge base detail by ID
 */

import { useState, useCallback, useEffect } from 'react'
import { getKnowledgeBase } from '@/apis/knowledge'
import { ApiError } from '@/apis/client'
import type { KnowledgeBase } from '@/types/knowledge'

interface UseKnowledgeBaseDetailOptions {
  knowledgeBaseId: number
  autoLoad?: boolean
}

export function useKnowledgeBaseDetail(options: UseKnowledgeBaseDetailOptions) {
  const { knowledgeBaseId, autoLoad = true } = options

  const [knowledgeBase, setKnowledgeBase] = useState<KnowledgeBase | null>(null)
  // Initialize loading to true when autoLoad is enabled and we have a valid ID
  // This prevents brief flash of error/empty state before the effect fires
  const [loading, setLoading] = useState(autoLoad && !!knowledgeBaseId)
  const [error, setError] = useState<string | null>(null)
  // Track access denied state for 403 errors
  const [accessDenied, setAccessDenied] = useState(false)

  const fetchKnowledgeBase = useCallback(async () => {
    if (!knowledgeBaseId) return

    setLoading(true)
    setError(null)
    setAccessDenied(false)
    try {
      const data = await getKnowledgeBase(knowledgeBaseId)
      setKnowledgeBase(data)
    } catch (err) {
      // Check if it's a 403 Forbidden error (access denied)
      if (err instanceof ApiError && err.status === 403) {
        // 403 path: exclusive access denied state
        setAccessDenied(true)
        setError(null)
        setKnowledgeBase(null)
      } else {
        // Non-403 errors: set error state and clear other states
        setAccessDenied(false)
        setError(err instanceof Error ? err.message : 'Failed to fetch knowledge base')
        setKnowledgeBase(null)
      }
    } finally {
      setLoading(false)
    }
  }, [knowledgeBaseId])

  useEffect(() => {
    if (autoLoad && knowledgeBaseId) {
      fetchKnowledgeBase()
    }
  }, [autoLoad, knowledgeBaseId, fetchKnowledgeBase])

  return {
    knowledgeBase,
    loading,
    error,
    accessDenied,
    refresh: fetchKnowledgeBase,
  }
}
