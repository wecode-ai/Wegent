// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Custom hook for managing knowledge bases
 */

import { useState, useCallback, useEffect } from 'react'
import {
  listKnowledgeBases,
  createKnowledgeBase,
  updateKnowledgeBase,
  deleteKnowledgeBase,
} from '@/apis/knowledge'
import type {
  KnowledgeBase,
  KnowledgeBaseCreate,
  KnowledgeBaseUpdate,
  KnowledgeResourceScope,
} from '@/types/knowledge'

interface UseKnowledgeBasesOptions {
  scope?: KnowledgeResourceScope
  groupName?: string
  autoLoad?: boolean
}

export function useKnowledgeBases(options: UseKnowledgeBasesOptions = {}) {
  const { scope = 'all', groupName, autoLoad = true } = options

  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBase[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const fetchKnowledgeBases = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const response = await listKnowledgeBases(scope, groupName)
      setKnowledgeBases(response.items)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch knowledge bases')
    } finally {
      setLoading(false)
    }
  }, [scope, groupName])

  const create = useCallback(async (data: KnowledgeBaseCreate) => {
    setLoading(true)
    setError(null)
    try {
      const created = await createKnowledgeBase(data)
      setKnowledgeBases(prev => [created, ...prev])
      return created
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create knowledge base'
      setError(message)
      throw err
    } finally {
      setLoading(false)
    }
  }, [])

  const update = useCallback(async (id: number, data: KnowledgeBaseUpdate) => {
    setLoading(true)
    setError(null)
    try {
      const updated = await updateKnowledgeBase(id, data)
      setKnowledgeBases(prev => prev.map(kb => (kb.id === id ? updated : kb)))
      return updated
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to update knowledge base'
      setError(message)
      throw err
    } finally {
      setLoading(false)
    }
  }, [])

  const remove = useCallback(async (id: number) => {
    setLoading(true)
    setError(null)
    try {
      await deleteKnowledgeBase(id)
      setKnowledgeBases(prev => prev.filter(kb => kb.id !== id))
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to delete knowledge base'
      setError(message)
      throw err
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (autoLoad) {
      fetchKnowledgeBases()
    }
  }, [autoLoad, fetchKnowledgeBases])

  return {
    knowledgeBases,
    loading,
    error,
    refresh: fetchKnowledgeBases,
    create,
    update,
    remove,
  }
}
