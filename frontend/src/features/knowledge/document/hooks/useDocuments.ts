// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Custom hook for managing knowledge documents with optional server-side pagination.
 *
 * When `paginationEnabled` is true (classic KB mode), documents are fetched page-by-page
 * using server-side offset/limit pagination. When false (notebook mode), all documents
 * are loaded at once without pagination.
 */

import { useState, useCallback, useEffect } from 'react'
import { ApiError } from '@/apis/client'
import {
  listDocuments,
  createDocument,
  updateDocument,
  deleteDocument,
  batchDeleteDocuments,
  transferDocuments,
  type BatchOperationResult,
  type TransferDocumentsRequest,
  type TransferDocumentsResponse,
} from '@/apis/knowledge'
import type {
  KnowledgeDocument,
  KnowledgeDocumentCreate,
  KnowledgeDocumentUpdate,
} from '@/types/knowledge'
import { toast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'
import { mapKnowledgeDocumentErrorMessage } from '../utils/error-messages'

const DEFAULT_PAGE_SIZE = 50

interface UseDocumentsOptions {
  knowledgeBaseId: number | null
  autoLoad?: boolean
  /** Whether server-side pagination is enabled (classic mode: true, notebook mode: false) */
  paginationEnabled?: boolean
}

export function useDocuments(options: UseDocumentsOptions) {
  const { knowledgeBaseId, autoLoad = true, paginationEnabled = false } = options
  const { t } = useTranslation('knowledge')

  const [documents, setDocuments] = useState<KnowledgeDocument[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Pagination state (only meaningful when paginationEnabled=true)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE)
  const [totalCount, setTotalCount] = useState(0)
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize))

  const fetchDocuments = useCallback(
    async (targetPage?: number, targetPageSize?: number) => {
      if (!knowledgeBaseId) {
        setDocuments([])
        setTotalCount(0)
        setPage(1)
        return
      }

      const effectivePage = targetPage ?? page
      const effectivePageSize = targetPageSize ?? pageSize

      setLoading(true)
      setError(null)
      try {
        let response

        if (paginationEnabled) {
          // Classic mode: server-side pagination
          const offset = (effectivePage - 1) * effectivePageSize
          response = await listDocuments(knowledgeBaseId, {
            limit: effectivePageSize,
            offset,
          })
        } else {
          // Notebook mode: load all documents at once
          response = await listDocuments(knowledgeBaseId)
        }

        setDocuments(response.items)
        setTotalCount(response.total)
        if (targetPage !== undefined) {
          setPage(targetPage)
        }
        if (targetPageSize !== undefined) {
          setPageSize(targetPageSize)
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to fetch documents')
      } finally {
        setLoading(false)
      }
    },
    [knowledgeBaseId, page, pageSize, paginationEnabled]
  )

  // Page navigation methods
  const goToPage = useCallback(
    (targetPage: number) => {
      if (targetPage < 1 || targetPage > totalPages) return
      fetchDocuments(targetPage)
    },
    [fetchDocuments, totalPages]
  )

  const changePageSize = useCallback(
    (newPageSize: number) => {
      // When page size changes, go back to page 1
      fetchDocuments(1, newPageSize)
    },
    [fetchDocuments]
  )

  const create = useCallback(
    async (data: KnowledgeDocumentCreate) => {
      if (!knowledgeBaseId) {
        throw new Error('Knowledge base ID is required')
      }

      setLoading(true)
      setError(null)
      try {
        const created = await createDocument(knowledgeBaseId, data)

        if (paginationEnabled) {
          // In paginated mode, refresh current page to get correct server state
          await fetchDocuments()
        } else {
          // In non-paginated mode, prepend to local state
          setDocuments(prev => [created, ...prev])
          setTotalCount(prev => prev + 1)
        }
        return created
      } catch (err) {
        const message = mapKnowledgeDocumentErrorMessage(err, t, 'document.document.createFailed')
        toast({ title: message, variant: 'destructive' })
        throw err
      } finally {
        setLoading(false)
      }
    },
    [knowledgeBaseId, t, paginationEnabled, fetchDocuments]
  )

  const update = useCallback(
    async (id: number, data: KnowledgeDocumentUpdate) => {
      setLoading(true)
      setError(null)
      try {
        const updated = await updateDocument(id, data)
        setDocuments(prev => prev.map(doc => (doc.id === id ? updated : doc)))
        return updated
      } catch (err) {
        const message = mapKnowledgeDocumentErrorMessage(err, t, 'document.document.updateFailed')
        toast({ title: message, variant: 'destructive' })
        throw err
      } finally {
        setLoading(false)
      }
    },
    [t]
  )

  const remove = useCallback(
    async (id: number) => {
      setLoading(true)
      setError(null)
      try {
        await deleteDocument(id)
        if (paginationEnabled) {
          // In paginated mode, refresh to handle empty page redirect
          const currentPage = page
          await fetchDocuments()
          // If the current page is now empty and we're not on page 1, go to previous page
          setDocuments(prev => {
            if (prev.length === 0 && currentPage > 1) {
              // Schedule navigation to previous page
              setTimeout(() => goToPage(currentPage - 1), 0)
            }
            return prev
          })
        } else {
          setDocuments(prev => prev.filter(doc => doc.id !== id))
          setTotalCount(prev => Math.max(0, prev - 1))
        }
      } catch (err) {
        const message = mapKnowledgeDocumentErrorMessage(err, t, 'document.document.deleteFailed')
        toast({ title: message, variant: 'destructive' })
        throw err
      } finally {
        setLoading(false)
      }
    },
    [t, paginationEnabled, fetchDocuments, page, goToPage]
  )

  // Batch operations
  const batchDelete = useCallback(
    async (ids: number[]): Promise<BatchOperationResult> => {
      setLoading(true)
      setError(null)
      try {
        const result = await batchDeleteDocuments(ids)
        if (paginationEnabled) {
          await fetchDocuments()
        } else {
          // Remove successfully deleted documents from state
          setDocuments(prev =>
            prev.filter(doc => !ids.includes(doc.id) || result.failed_ids.includes(doc.id))
          )
          setTotalCount(prev => Math.max(0, prev - (ids.length - result.failed_ids.length)))
        }
        return result
      } catch (err) {
        const message = mapKnowledgeDocumentErrorMessage(
          err,
          t,
          'document.document.batchDeleteFailed'
        )
        toast({ title: message, variant: 'destructive' })
        throw err
      } finally {
        setLoading(false)
      }
    },
    [t, paginationEnabled, fetchDocuments]
  )

  // Transfer documents to another KB
  const transfer = useCallback(
    async (data: TransferDocumentsRequest): Promise<TransferDocumentsResponse | null> => {
      if (!knowledgeBaseId) return null
      setLoading(true)
      setError(null)
      try {
        const result = await transferDocuments(knowledgeBaseId, data)
        toast({
          description: t('document.document.batch.transferSuccess', {
            docCount: result.transferred_document_count,
            folderCount: result.transferred_folder_count,
          }),
        })
        await fetchDocuments()
        return result
      } catch (err) {
        let message: string
        if (err instanceof ApiError && err.errorCode && typeof err.errorCode === 'string') {
          const i18nKey = `document.document.batch.errors.${err.errorCode}`
          message = t(i18nKey)
        } else {
          message = err instanceof Error ? err.message : t('document.document.batch.transferFailed')
        }
        toast({ title: message, variant: 'destructive' })
        return null
      } finally {
        setLoading(false)
      }
    },
    [knowledgeBaseId, fetchDocuments, t]
  )

  // Reset page when knowledge base changes
  useEffect(() => {
    setPage(1)
    setTotalCount(0)
  }, [knowledgeBaseId])

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
    transfer,
    // Pagination fields
    page,
    pageSize,
    totalCount,
    totalPages,
    goToPage,
    changePageSize,
  }
}
