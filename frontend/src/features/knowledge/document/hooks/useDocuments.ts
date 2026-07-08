// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Custom hook for managing knowledge documents with optional server-side pagination.
 *
 * When `paginationEnabled` is true, the UI first tries to load a bounded
 * metadata snapshot for local filtering and pagination. Large knowledge bases
 * fall back to server-side offset/limit pagination.
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
  type ListDocumentsParams,
} from '@/apis/knowledge'
import type {
  KnowledgeDocument,
  KnowledgeDocumentCreate,
  KnowledgeDocumentUpdate,
} from '@/types/knowledge'
import { toast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'
import { mapKnowledgeDocumentErrorMessage } from '../utils/error-messages'

const DEFAULT_PAGE_SIZE = 100
const SEARCH_DEBOUNCE_MS = 300
const LOCAL_METADATA_LIMIT = 2000
const SERVER_REQUEST_LIMIT = 500

type LocalSnapshotMode = 'unknown' | 'local' | 'server'

interface DocumentQuery {
  folderId?: number
  includeSubfolders: boolean
  folderScopeIds?: number[]
  keyword?: string
  sortBy: ListDocumentsParams['sort_by']
  sortOrder: ListDocumentsParams['sort_order']
}

function getDocumentSortValue(
  document: KnowledgeDocument,
  sortBy: ListDocumentsParams['sort_by']
): string | number {
  switch (sortBy) {
    case 'name':
      return document.name.toLocaleLowerCase()
    case 'size':
      return document.file_size
    case 'updatedAt':
      return Date.parse(document.updated_at) || 0
    case 'createdAt':
    default:
      return Date.parse(document.created_at) || 0
  }
}

function compareDocuments(
  left: KnowledgeDocument,
  right: KnowledgeDocument,
  sortBy: ListDocumentsParams['sort_by'],
  sortOrder: ListDocumentsParams['sort_order']
) {
  const leftValue = getDocumentSortValue(left, sortBy)
  const rightValue = getDocumentSortValue(right, sortBy)
  let result = 0

  if (typeof leftValue === 'string' && typeof rightValue === 'string') {
    result = leftValue.localeCompare(rightValue)
  } else {
    result = Number(leftValue) - Number(rightValue)
  }

  if (result !== 0) {
    return sortOrder === 'asc' ? result : -result
  }

  return right.id - left.id
}

function applyLocalQuery(
  documents: KnowledgeDocument[],
  query: DocumentQuery
): KnowledgeDocument[] {
  const trimmedKeyword = query.keyword?.trim().toLocaleLowerCase()
  const folderScope = query.folderScopeIds ? new Set(query.folderScopeIds) : undefined

  return documents
    .filter(document => {
      if (query.folderId !== undefined) {
        if (query.includeSubfolders && folderScope) {
          if (!folderScope.has(document.folder_id ?? 0)) return false
        } else if ((document.folder_id ?? 0) !== query.folderId) {
          return false
        }
      }

      if (trimmedKeyword && !document.name.toLocaleLowerCase().includes(trimmedKeyword)) {
        return false
      }

      return true
    })
    .sort((left, right) => compareDocuments(left, right, query.sortBy, query.sortOrder))
}

interface UseDocumentsOptions {
  knowledgeBaseId: number | null
  autoLoad?: boolean
  /** Whether server-side pagination is enabled */
  paginationEnabled?: boolean
  folderId?: number
  includeSubfolders?: boolean
  /** Folder ids in the active folder subtree for local metadata pagination */
  folderScopeIds?: number[]
  keyword?: string
  sortBy?: ListDocumentsParams['sort_by']
  sortOrder?: ListDocumentsParams['sort_order']
}

export function useDocuments(options: UseDocumentsOptions) {
  const {
    knowledgeBaseId,
    autoLoad = true,
    paginationEnabled = true,
    folderId,
    includeSubfolders = false,
    folderScopeIds,
    keyword,
    sortBy = 'createdAt',
    sortOrder = 'desc',
  } = options
  const { t } = useTranslation('knowledge')

  const [documents, setDocuments] = useState<KnowledgeDocument[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [debouncedKeyword, setDebouncedKeyword] = useState(keyword)

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
  const requestSeqRef = useRef(0)
  const localSnapshotRef = useRef<KnowledgeDocument[]>([])
  const localSnapshotKbIdRef = useRef<number | null>(null)
  const localSnapshotModeRef = useRef<LocalSnapshotMode>('unknown')
  const queryRef = useRef<DocumentQuery>({
    folderId,
    includeSubfolders,
    folderScopeIds,
    keyword: debouncedKeyword,
    sortBy,
    sortOrder,
  })

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
  useEffect(() => {
    queryRef.current = {
      folderId,
      includeSubfolders,
      folderScopeIds,
      keyword: debouncedKeyword,
      sortBy,
      sortOrder,
    }
  }, [folderId, includeSubfolders, folderScopeIds, debouncedKeyword, sortBy, sortOrder])

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setDebouncedKeyword(keyword)
    }, SEARCH_DEBOUNCE_MS)

    return () => window.clearTimeout(timeoutId)
  }, [keyword])

  const resetLocalSnapshot = useCallback(() => {
    localSnapshotRef.current = []
    localSnapshotKbIdRef.current = null
    localSnapshotModeRef.current = 'unknown'
  }, [])

  const loadLocalSnapshot = useCallback(async (knowledgeBaseId: number, requestSeq: number) => {
    const items: KnowledgeDocument[] = []
    let offset = 0

    while (offset < LOCAL_METADATA_LIMIT) {
      const response = await listDocuments(knowledgeBaseId, {
        limit: SERVER_REQUEST_LIMIT,
        offset,
      })

      if (requestSeq !== requestSeqRef.current) {
        return null
      }

      if (response.total > LOCAL_METADATA_LIMIT) {
        localSnapshotRef.current = []
        localSnapshotKbIdRef.current = knowledgeBaseId
        localSnapshotModeRef.current = 'server'
        return null
      }

      items.push(...response.items)
      if (!response.has_more || response.items.length === 0 || items.length >= response.total) {
        localSnapshotRef.current = items
        localSnapshotKbIdRef.current = knowledgeBaseId
        localSnapshotModeRef.current = 'local'
        return items
      }

      offset += response.items.length
    }

    localSnapshotRef.current = []
    localSnapshotKbIdRef.current = knowledgeBaseId
    localSnapshotModeRef.current = 'server'
    return null
  }, [])

  const fetchServerPage = useCallback(
    async (
      knowledgeBaseId: number,
      query: DocumentQuery,
      effectivePage: number,
      effectivePageSize: number
    ) => {
      const trimmedKeyword = query.keyword?.trim()
      const params: ListDocumentsParams = {
        folder_id: query.folderId,
        include_subfolders: query.includeSubfolders,
        keyword: trimmedKeyword || undefined,
        sort_by: query.sortBy,
        sort_order: query.sortOrder,
      }
      const response = await listDocuments(knowledgeBaseId, {
        ...params,
        limit: Math.min(effectivePageSize, SERVER_REQUEST_LIMIT),
        offset: (effectivePage - 1) * effectivePageSize,
      })

      return { items: response.items, total: response.total }
    },
    []
  )

  const fetchDocuments = useCallback(
    async (targetPage?: number, targetPageSize?: number) => {
      const requestSeq = requestSeqRef.current + 1
      requestSeqRef.current = requestSeq
      const currentKbId = knowledgeBaseIdRef.current
      if (!currentKbId) {
        setDocuments([])
        setTotalCount(0)
        setPage(1)
        return
      }

      const effectivePage = targetPage ?? pageRef.current
      const effectivePageSize = targetPageSize ?? pageSizeRef.current
      const query = queryRef.current

      setLoading(true)
      setError(null)
      try {
        let nextDocuments: KnowledgeDocument[]
        let nextTotalCount: number

        if (paginationEnabledRef.current) {
          if (localSnapshotKbIdRef.current !== currentKbId) {
            localSnapshotModeRef.current = 'unknown'
          }

          let snapshot = localSnapshotRef.current
          if (localSnapshotModeRef.current === 'unknown') {
            snapshot = (await loadLocalSnapshot(currentKbId, requestSeq)) ?? []
          }

          if (requestSeq !== requestSeqRef.current) {
            return
          }

          if (localSnapshotModeRef.current === 'local') {
            const filteredDocuments = applyLocalQuery(snapshot, query)
            nextTotalCount = filteredDocuments.length
            nextDocuments = filteredDocuments.slice(
              (effectivePage - 1) * effectivePageSize,
              effectivePage * effectivePageSize
            )
          } else {
            const response = await fetchServerPage(
              currentKbId,
              query,
              effectivePage,
              effectivePageSize
            )
            nextDocuments = response.items
            nextTotalCount = response.total
          }
        } else {
          // Compatibility mode: load documents without explicit pagination
          const response = await listDocuments(currentKbId, {
            folder_id: query.folderId,
            include_subfolders: query.includeSubfolders,
            keyword: query.keyword?.trim() || undefined,
            sort_by: query.sortBy,
            sort_order: query.sortOrder,
          })
          nextDocuments = response.items
          nextTotalCount = response.total
        }

        if (requestSeq !== requestSeqRef.current) {
          return
        }

        setDocuments(nextDocuments)
        setTotalCount(nextTotalCount)
        if (targetPage !== undefined) {
          setPage(targetPage)
        }
        if (targetPageSize !== undefined) {
          setPageSize(targetPageSize)
        }
      } catch (err) {
        if (requestSeq !== requestSeqRef.current) {
          return
        }
        setError(err instanceof Error ? err.message : t('document.document.fetchFailed'))
      } finally {
        if (requestSeq === requestSeqRef.current) {
          setLoading(false)
        }
      }
    },
    // No page/pageSize dependencies — reads from refs instead to avoid
    // recreating on every state change which would trigger the auto-load effect.
    [fetchServerPage, loadLocalSnapshot, t]
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
          resetLocalSnapshot()
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
    [t, fetchDocuments, resetLocalSnapshot]
  )

  const update = useCallback(
    async (id: number, data: KnowledgeDocumentUpdate) => {
      setLoading(true)
      setError(null)
      try {
        const updated = await updateDocument(id, data)
        if (paginationEnabledRef.current) {
          resetLocalSnapshot()
          await fetchDocuments()
        } else {
          setDocuments(prev => prev.map(doc => (doc.id === id ? updated : doc)))
        }
        return updated
      } catch (err) {
        const message = mapKnowledgeDocumentErrorMessage(err, t, 'document.document.updateFailed')
        toast({ title: message, variant: 'destructive' })
        throw err
      } finally {
        setLoading(false)
      }
    },
    [t, fetchDocuments, resetLocalSnapshot]
  )

  const remove = useCallback(
    async (id: number) => {
      setLoading(true)
      setError(null)
      try {
        await deleteDocument(id)
        if (paginationEnabledRef.current) {
          resetLocalSnapshot()
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
    [t, fetchDocuments, goToPage, resetLocalSnapshot]
  )

  // Batch operations
  const batchDelete = useCallback(
    async (ids: number[]): Promise<BatchOperationResult> => {
      setLoading(true)
      setError(null)
      try {
        const result = await batchDeleteDocuments(ids)
        if (paginationEnabledRef.current) {
          resetLocalSnapshot()
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
    [t, fetchDocuments, resetLocalSnapshot]
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
        resetLocalSnapshot()
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
    [fetchDocuments, resetLocalSnapshot, t]
  )

  const refreshDocuments = useCallback(
    async (targetPage?: number, targetPageSize?: number) => {
      resetLocalSnapshot()
      await fetchDocuments(targetPage, targetPageSize)
    },
    [fetchDocuments, resetLocalSnapshot]
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
  }, [
    autoLoad,
    knowledgeBaseId,
    folderId,
    includeSubfolders,
    folderScopeIds,
    debouncedKeyword,
    sortBy,
    sortOrder,
    fetchDocuments,
  ])

  return {
    documents,
    loading,
    error,
    refresh: refreshDocuments,
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
