// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Custom hook for fetching knowledge base detail by ID
 */

import { useState, useCallback, useEffect } from 'react'
import { getKnowledgeBase } from '@/apis/knowledge'
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

  const fetchKnowledgeBase = useCallback(async () => {
    if (!knowledgeBaseId) return

    setLoading(true)
    setError(null)
    try {
      const data = await getKnowledgeBase(knowledgeBaseId)
      setKnowledgeBase(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch knowledge base')
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
    refresh: fetchKnowledgeBase,
  }
}
