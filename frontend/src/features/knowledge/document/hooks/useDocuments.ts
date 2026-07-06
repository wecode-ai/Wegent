// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Custom hook for managing knowledge documents with optional server-side pagination.
 *
 * When `paginationEnabled` is true, documents are fetched page-by-page using
 * server-side offset/limit pagination. Notebook and documents views can both
 * use pagination so large knowledge bases do not load all documents at once.
 */

import { useState, useCallback, useEffect, useRef } from 'react'
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
  /** Whether server-side pagination is enabled */
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

  // Use refs for pagination state to avoid stale closures and duplicate fetches.
  // This prevents fetchDocuments from depending on page/pageSize, which would
  // cause the auto-load effect to re-fire on every page change.
  const pageRef = useRef(page)
  const pageSizeRef = useRef(pageSize)
  const paginationEnabledRef = useRef(paginationEnabled)
  const knowledgeBaseIdRef = useRef(knowledgeBaseId)

  // Keep refs in sync with state
  useEffect(() => {
    pageRef.current = page
  }, [page])
  useEffect(() => {
    pageSizeRef.current = pageSize
  }, [pageSize])
  useEffect(() => {
    paginationEnabledRef.current = paginationEnabled
  }, [paginationEnabled])
  useEffect(() => {
    knowledgeBaseIdRef.current = knowledgeBaseId
  }, [knowledgeBaseId])

  const fetchDocuments = useCallback(
    async (targetPage?: number, targetPageSize?: number) => {
      const currentKbId = knowledgeBaseIdRef.current
      if (!currentKbId) {
        setDocuments([])
        setTotalCount(0)
        setPage(1)
        return
      }

      const effectivePage = targetPage ?? pageRef.current
      const effectivePageSize = targetPageSize ?? pageSizeRef.current

      setLoading(true)
      setError(null)
      try {
        let response

        if (paginationEnabledRef.current) {
          // Server-side pagination
          const offset = (effectivePage - 1) * effectivePageSize
          response = await listDocuments(currentKbId, {
            limit: effectivePageSize,
            offset,
          })
        } else {
          // Compatibility mode: load documents without explicit pagination
          response = await listDocuments(currentKbId)
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
        setError(err instanceof Error ? err.message : t('document.document.fetchFailed'))
      } finally {
        setLoading(false)
      }
    },
    // No page/pageSize dependencies — reads from refs instead to avoid
    // recreating on every state change which would trigger the auto-load effect.
    []
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
      const currentKbId = knowledgeBaseIdRef.current
      if (!currentKbId) {
        throw new Error('Knowledge base ID is required')
      }

      setLoading(true)
      setError(null)
      try {
        const created = await createDocument(currentKbId, data)

        if (paginationEnabledRef.current) {
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
    [t, fetchDocuments]
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
        if (paginationEnabledRef.current) {
          // In paginated mode, refresh to handle empty page redirect
          const currentPage = pageRef.current
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
    [t, fetchDocuments, goToPage]
  )

  // Batch operations
  const batchDelete = useCallback(
    async (ids: number[]): Promise<BatchOperationResult> => {
      setLoading(true)
      setError(null)
      try {
        const result = await batchDeleteDocuments(ids)
        if (paginationEnabledRef.current) {
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
    [t, fetchDocuments]
  )

  // Transfer documents to another KB
  const transfer = useCallback(
    async (data: TransferDocumentsRequest): Promise<TransferDocumentsResponse | null> => {
      const currentKbId = knowledgeBaseIdRef.current
      if (!currentKbId) return null
      setLoading(true)
      setError(null)
      try {
        const result = await transferDocuments(currentKbId, data)
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
    [fetchDocuments, t]
  )

  // Reset page and reload when knowledge base changes.
  // Combined into a single effect to avoid stale-page fetches.
  // Explicitly pass page=1 to fetchDocuments because setPage(1) is async
  // and pageRef.current still holds the old page value at this point.
  useEffect(() => {
    setPage(1)
    setTotalCount(0)
    if (autoLoad && knowledgeBaseId) {
      fetchDocuments(1, pageSizeRef.current)
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
