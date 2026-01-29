// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useState, useEffect, useCallback } from 'react'
import { listDocumentChunks } from '@/apis/knowledge'
import type { ChunkItem, ChunkListResponse } from '@/types/knowledge'

interface UseDocumentChunksOptions {
  documentId: number
  enabled?: boolean
  pageSize?: number
}

interface UseDocumentChunksReturn {
  chunks: ChunkItem[]
  total: number
  page: number
  pageSize: number
  splitterType?: string
  splitterSubtype?: string
  loading: boolean
  error: string | null
  hasMore: boolean
  loadMore: () => Promise<void>
  refresh: () => Promise<void>
}

export function useDocumentChunks({
  documentId,
  enabled = true,
  pageSize = 20,
}: UseDocumentChunksOptions): UseDocumentChunksReturn {
  const [chunks, setChunks] = useState<ChunkItem[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [splitterType, setSplitterType] = useState<string | undefined>()
  const [splitterSubtype, setSplitterSubtype] = useState<string | undefined>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const fetchChunks = useCallback(
    async (pageNum: number, append: boolean = false) => {
      if (!documentId) return

      try {
        setLoading(true)
        setError(null)
        const response: ChunkListResponse = await listDocumentChunks(documentId, pageNum, pageSize)

        if (append) {
          setChunks(prev => [...prev, ...response.items])
        } else {
          setChunks(response.items)
        }
        setTotal(response.total)
        setPage(response.page)
        setSplitterType(response.splitter_type)
        setSplitterSubtype(response.splitter_subtype)
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'Failed to load chunks'
        setError(errorMessage)
      } finally {
        setLoading(false)
      }
    },
    [documentId, pageSize]
  )

  // Initial fetch when enabled
  useEffect(() => {
    if (enabled && documentId) {
      setChunks([])
      setPage(1)
      fetchChunks(1, false)
    }
  }, [enabled, documentId, fetchChunks])

  const loadMore = useCallback(async () => {
    if (loading || chunks.length >= total) return
    await fetchChunks(page + 1, true)
  }, [loading, chunks.length, total, page, fetchChunks])

  const refresh = useCallback(async () => {
    setChunks([])
    setPage(1)
    await fetchChunks(1, false)
  }, [fetchChunks])

  const hasMore = chunks.length < total

  return {
    chunks,
    total,
    page,
    pageSize,
    splitterType,
    splitterSubtype,
    loading,
    error,
    hasMore,
    loadMore,
    refresh,
  }
}
