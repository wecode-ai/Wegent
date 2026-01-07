// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Custom hook for managing knowledge documents
 */

import { useState, useCallback, useEffect } from 'react'
import {
  listDocuments,
  createDocument,
  updateDocument,
  deleteDocument,
  batchDeleteDocuments,
  type BatchOperationResult,
} from '@/apis/knowledge'
import type {
  KnowledgeDocument,
  KnowledgeDocumentCreate,
  KnowledgeDocumentUpdate,
} from '@/types/knowledge'
import { toast } from '@/hooks/use-toast'

interface UseDocumentsOptions {
  knowledgeBaseId: number | null
  autoLoad?: boolean
}

export function useDocuments(options: UseDocumentsOptions) {
  const { knowledgeBaseId, autoLoad = true } = options

  const [documents, setDocuments] = useState<KnowledgeDocument[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const fetchDocuments = useCallback(async () => {
    if (!knowledgeBaseId) {
      setDocuments([])
      return
    }

    setLoading(true)
    setError(null)
    try {
      const response = await listDocuments(knowledgeBaseId)
      setDocuments(response.items)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch documents')
    } finally {
      setLoading(false)
    }
  }, [knowledgeBaseId])

  const create = useCallback(
    async (data: KnowledgeDocumentCreate) => {
      if (!knowledgeBaseId) {
        throw new Error('Knowledge base ID is required')
      }

      setLoading(true)
      setError(null)
      try {
        const created = await createDocument(knowledgeBaseId, data)
        setDocuments(prev => [created, ...prev])
        return created
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to create document'
        toast({ title: message, variant: 'destructive' })
        throw err
      } finally {
        setLoading(false)
      }
    },
    [knowledgeBaseId]
  )

  const update = useCallback(async (id: number, data: KnowledgeDocumentUpdate) => {
    setLoading(true)
    setError(null)
    try {
      const updated = await updateDocument(id, data)
      setDocuments(prev => prev.map(doc => (doc.id === id ? updated : doc)))
      return updated
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to update document'
      toast({ title: message, variant: 'destructive' })
      throw err
    } finally {
      setLoading(false)
    }
  }, [])

  const remove = useCallback(async (id: number) => {
    setLoading(true)
    setError(null)
    try {
      await deleteDocument(id)
      setDocuments(prev => prev.filter(doc => doc.id !== id))
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to delete document'
      toast({ title: message, variant: 'destructive' })
      throw err
    } finally {
      setLoading(false)
    }
  }, [])

  // Batch operations
  const batchDelete = useCallback(async (ids: number[]): Promise<BatchOperationResult> => {
    setLoading(true)
    setError(null)
    try {
      const result = await batchDeleteDocuments(ids)
      // Remove successfully deleted documents from state
      setDocuments(prev =>
        prev.filter(doc => !ids.includes(doc.id) || result.failed_ids.includes(doc.id))
      )
      return result
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to batch delete documents'
      toast({ title: message, variant: 'destructive' })
      throw err
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (autoLoad && knowledgeBaseId) {
      fetchDocuments()
    }
  }, [autoLoad, knowledgeBaseId, fetchDocuments])

  return {
    documents,
    loading,
    error,
    refresh: fetchDocuments,
    create,
    update,
    remove,
    batchDelete,
  }
}
