// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useMemo, useEffect, useRef, useCallback, Suspense } from 'react'
import {
  ArrowLeft,
  Upload,
  FileText,
  Search,
  BookOpen,
  Database,
  Trash2,
  Target,
  FileUp,
  RefreshCw,
  Info,
  CheckSquare,
  Square,
  AlertTriangle,
  FolderPlus,
  Pencil,
  FolderInput,
  ArrowRightLeft,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Spinner } from '@/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { DocumentDetailDialog } from './DocumentDetailDialog'
import { DocumentUpload, type TableDocument } from './DocumentUpload'
import { DeleteDocumentDialog } from './DeleteDocumentDialog'
import { EditDocumentDialog } from './EditDocumentDialog'
import { RetrievalTestDialog } from './RetrievalTestDialog'
import { useDocuments } from '../hooks/useDocuments'
import { useFolders } from '../hooks/useFolders'
import { FolderTree, type SortField, type SortOrder } from './FolderTree'
import { KnowledgeDocumentTreeGrid } from './knowledge-document-tree-grid'
import { KnowledgeFolderBreadcrumb } from './knowledge-folder-breadcrumb'
import { KnowledgeFolderNavView } from './knowledge-folder-nav-view'
import { CreateFolderDialog } from './CreateFolderDialog'
import { DeleteFolderDialog } from './DeleteFolderDialog'
import { MoveDocumentDialog } from './MoveDocumentDialog'
import { TransferToKbDialog } from './transfer-to-kb-dialog'
import {
  useKnowledgeResourceSelection,
  shouldDisableDocumentBatchActions,
} from '../hooks/useKnowledgeResourceSelection'
import { useFolderNavigation } from '../hooks/useFolderNavigation'
import { Pagination } from '@/components/ui/pagination'
import { listDocuments } from '@/apis/knowledge'
import { toast } from '@/hooks/use-toast'
import type {
  KnowledgeBase,
  KnowledgeDocument,
  KnowledgeFolder,
  SplitterConfig,
  KbGroupInfo,
} from '@/types/knowledge'
import { useTranslation } from '@/hooks/useTranslation'
import { useSearchParams, useRouter, usePathname } from 'next/navigation'
import { EditKnowledgeBaseSummaryDialog } from './EditKnowledgeBaseSummaryDialog'
import { useKnowledgeBaseSummaryEditor } from '../hooks/useKnowledgeBaseSummaryEditor'
import {
  getEffectiveKnowledgeBaseLongSummary,
  getKnowledgeBasePreviewSummary,
  hasManualSummaryOverride,
  shouldShowSummaryContent,
  shouldShowRetryButton,
} from '../utils/summarySelectors'
import { formatSelectionSummary } from '../utils/selection-summary'
import {
  buildKnowledgeResourceTree,
  deletedFolderAffectsActiveFolder,
  folderTreeContainsId,
} from '../utils/resource-tree'

const EXPAND_ALL_THRESHOLD = 100

export { deletedFolderAffectsActiveFolder, folderTreeContainsId }
export { shouldDisableDocumentBatchActions } from '../hooks/useKnowledgeResourceSelection'

/**
 * Find a document by name across all pages of a knowledge base.
 * Uses iterative pagination (while has_more) to scan beyond the first 200 items.
 * Returns undefined if not found or if the signal is aborted.
 */
async function findDocumentByName(
  knowledgeBaseId: number,
  documentName: string,
  signal?: AbortSignal
): Promise<KnowledgeDocument | undefined> {
  let offset = 0
  const batchSize = 200
  while (!signal?.aborted) {
    const response = await listDocuments(knowledgeBaseId, { limit: batchSize, offset })
    if (signal?.aborted) return undefined
    const found = response.items.find(doc => doc.name === documentName)
    if (found || !response.has_more) return found
    offset += response.items.length
  }
  return undefined
}

/**
 * Inner component that uses useSearchParams (must be inside Suspense boundary).
 * Reads the ?doc= URL parameter and auto-opens the matching document.
 * In paginated mode, falls back to an unpaginated API call to find documents
 * that may not be on the current page.
 */
function DocAutoOpener({
  documents,
  loading,
  onOpen,
  knowledgeBaseId,
  paginationEnabled,
}: {
  documents: KnowledgeDocument[]
  loading: boolean
  onOpen: (doc: KnowledgeDocument) => void
  knowledgeBaseId: number
  paginationEnabled: boolean
}) {
  const searchParams = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  const [done, setDone] = useState(false)

  useEffect(() => {
    if (done || loading) return
    const docParam = searchParams.get('doc')
    if (!docParam) {
      setDone(true)
      return
    }
    // Try to find document in current page
    const targetDoc = documents.find(doc => doc.name === docParam)
    if (targetDoc) {
      onOpen(targetDoc)
      // Remove the ?doc= param from URL without triggering navigation
      const params = new URLSearchParams(searchParams.toString())
      params.delete('doc')
      const newSearch = params.toString()
      router.replace(pathname + (newSearch ? `?${newSearch}` : ''), { scroll: false })
      setDone(true)
      return
    }

    // In paginated mode, the document might be on a different page.
    // Search across all documents via iterative pagination.
    if (paginationEnabled) {
      const controller = new AbortController()
      ;(async () => {
        try {
          const found = await findDocumentByName(knowledgeBaseId, docParam, controller.signal)
          if (!controller.signal.aborted && found) {
            onOpen(found)
            const params = new URLSearchParams(searchParams.toString())
            params.delete('doc')
            const newSearch = params.toString()
            router.replace(pathname + (newSearch ? `?${newSearch}` : ''), { scroll: false })
          }
        } catch {
          // Silently ignore - auto-open is best-effort
        } finally {
          if (!controller.signal.aborted) setDone(true)
        }
      })()
      return () => {
        controller.abort()
      }
    }

    setDone(true)
  }, [
    done,
    loading,
    documents,
    searchParams,
    onOpen,
    router,
    pathname,
    paginationEnabled,
    knowledgeBaseId,
  ])

  return null
}

// Re-export KbGroupInfo from types for backwards compatibility
export type { KbGroupInfo } from '@/types/knowledge'

interface DocumentListProps {
  knowledgeBase: KnowledgeBase
  onBack?: () => void
  canUpload?: boolean
  canManageAllDocuments?: boolean
  /** Compact mode for sidebar display - uses card layout instead of table */
  compact?: boolean
  /** Callback when document selection changes (for notebook mode context injection) */
  onSelectionChange?: (documentIds: number[]) => void
  /** Callback to refresh knowledge base details (used after summary retry) */
  onRefreshKnowledgeBase?: () => void
  /** Optional header actions to display next to the title (e.g., tabs) */
  headerActions?: React.ReactNode
  /** Group info for breadcrumb display */
  groupInfo?: KbGroupInfo
  /** Callback when group name is clicked */
  onGroupClick?: (groupId: string, groupType?: string) => void
  /** Initial document path to auto-open (from virtual URL path segments) */
  initialDocPath?: string
  /** Whether this KB belongs to an organization-level namespace (affects URL format in DocumentDetailDialog) */
  isOrganization?: boolean
  /** Whether server-side pagination is enabled */
  paginationEnabled?: boolean
}

/** Flatten folder tree into a flat list for select dropdowns */
function flattenFoldersForSelect(
  folders: KnowledgeFolder[],
  depth: number = 0
): Array<{ id: number; name: string; depth: number }> {
  let result: Array<{ id: number; name: string; depth: number }> = []
  for (const folder of folders) {
    result.push({ id: folder.id, name: folder.name, depth })
    result = result.concat(flattenFoldersForSelect(folder.children, depth + 1))
  }
  return result
}

function findFolderName(folders: KnowledgeFolder[], targetId: number | undefined): string | null {
  if (targetId === undefined) return null
  for (const folder of folders) {
    if (folder.id === targetId) return folder.name
    const childName = findFolderName(folder.children, targetId)
    if (childName) return childName
  }
  return null
}

export function DocumentList({
  knowledgeBase,
  onBack,
  canUpload = true,
  canManageAllDocuments = false,
  compact = false,
  onSelectionChange,
  onRefreshKnowledgeBase,
  headerActions,
  groupInfo,
  onGroupClick,
  initialDocPath,
  isOrganization = false,
  paginationEnabled = true,
}: DocumentListProps) {
  const { t } = useTranslation('knowledge')
  const [searchQuery, setSearchQuery] = useState('')
  const [sortField, setSortField] = useState<SortField>('createdAt')
  const [sortOrder, setSortOrder] = useState<SortOrder>('desc')
  const [activeFolderId, setActiveFolderId] = useState<number | undefined>(undefined)

  // Display mode: expand-all for small KBs, folder-nav for large ones.
  // Only applies to the normal (non-compact) view.
  const displayMode = useMemo<'expand-all' | 'folder-nav'>(() => {
    return knowledgeBase.document_count < EXPAND_ALL_THRESHOLD ? 'expand-all' : 'folder-nav'
  }, [knowledgeBase.document_count])

  const isFolderNavMode = displayMode === 'folder-nav'

  // Folder state
  const {
    folders,
    fetchFolders,
    createFolder,
    updateFolder,
    deleteFolder,
    moveDocument,
    batchMove,
  } = useFolders({ knowledgeBaseId: knowledgeBase.id })

  const folderResourceTree = useMemo(() => buildKnowledgeResourceTree(folders, []), [folders])

  const { navFolderId, breadcrumbs, directChildFolders, navigateTo } = useFolderNavigation(
    folders,
    knowledgeBase.id
  )

  const activeFolderScopeIds = useMemo(
    () =>
      activeFolderId === undefined
        ? undefined
        : Array.from(folderResourceTree.index.folderDescendantIds.get(activeFolderId) ?? []),
    [folderResourceTree, activeFolderId]
  )

  const {
    documents,
    loading,
    error,
    create,
    remove,
    refresh,
    batchDelete,
    transfer,
    // Pagination fields
    page,
    pageSize,
    totalCount,
    totalPages,
    goToPage,
    changePageSize,
  } = useDocuments({
    knowledgeBaseId: knowledgeBase.id,
    paginationEnabled,
    // folder-nav mode (no search): scope to current folder's direct documents only.
    // folder-nav mode (searching): folderId=undefined → global search across all docs.
    // expand-all / compact modes: use activeFolderId (legacy filter behavior).
    folderId: isFolderNavMode && !searchQuery ? (navFolderId ?? 0) : activeFolderId,
    includeSubfolders: isFolderNavMode ? false : activeFolderId !== undefined,
    folderScopeIds: isFolderNavMode ? undefined : activeFolderScopeIds,
    keyword: searchQuery,
    sortBy: sortField,
    sortOrder,
  })

  const resourceTree = useMemo(
    () => buildKnowledgeResourceTree(folders, documents),
    [folders, documents]
  )

  const [showCreateFolder, setShowCreateFolder] = useState(false)
  const [createFolderParentId, setCreateFolderParentId] = useState(0)
  const [renamingFolder, setRenamingFolder] = useState<{ id: number; name: string } | null>(null)
  const [deletingFolder, setDeletingFolder] = useState<{ id: number; name: string } | null>(null)

  // Load folders when knowledge base changes
  useEffect(() => {
    if (knowledgeBase.id) {
      fetchFolders()
      setSelectedUploadFolderId(0)
      setActiveFolderId(undefined)
    }
  }, [knowledgeBase.id, fetchFolders])

  // Flatten folder tree for select dropdowns
  const folderOptions = useMemo(() => flattenFoldersForSelect(folders), [folders])
  const activeFolderName = useMemo(
    () => findFolderName(folders, activeFolderId),
    [folders, activeFolderId]
  )
  const searchPlaceholder = activeFolderName
    ? t('document.document.searchInFolder', { folder: activeFolderName })
    : t('document.document.search')

  // Only show error on page for initial load failures (when documents list is empty)
  // Operation errors are shown via toast notifications
  const showLoadError = error && documents.length === 0

  const [showUpload, setShowUpload] = useState(false)
  const [showRetrievalTest, setShowRetrievalTest] = useState(false)
  const [viewingDoc, setViewingDoc] = useState<KnowledgeDocument | null>(null)
  const [editingDoc, setEditingDoc] = useState<KnowledgeDocument | null>(null)
  const [deletingDoc, setDeletingDoc] = useState<KnowledgeDocument | null>(null)
  const {
    selectedDocumentIds,
    selectedFolderIds,
    summary: selectionSummary,
    resetSelection,
    setDocumentSelection,
    selectDocument,
    selectFolderScope,
    selectVisibleDocuments,
    isDocumentIncludedInFolderScope,
    getPayload: getSelectionPayload,
  } = useKnowledgeResourceSelection({
    documents,
    treeIndex: resourceTree.index,
  })
  const [batchLoading, setBatchLoading] = useState(false)
  const [showSearchPopover, setShowSearchPopover] = useState(false)
  // Track if initialDocPath has been handled
  const [initialDocPathHandled, setInitialDocPathHandled] = useState(false)
  // Track which document is being refreshed
  const [refreshingDocId, setRefreshingDocId] = useState<number | null>(null)
  // Track which document is being reindexed
  const [reindexingDocId, setReindexingDocId] = useState<number | null>(null)
  // Track selected upload folder
  const [selectedUploadFolderId, setSelectedUploadFolderId] = useState(0)
  // Track document being moved
  const [movingDoc, setMovingDoc] = useState<KnowledgeDocument | null>(null)
  const [isMovingDoc, setIsMovingDoc] = useState(false)
  // Batch move state
  const [showBatchMove, setShowBatchMove] = useState(false)
  const [isBatchMoving, setIsBatchMoving] = useState(false)
  // Transfer state
  const [showTransfer, setShowTransfer] = useState(false)
  const [isTransferring, setIsTransferring] = useState(false)
  const transferProgressText = useMemo(() => {
    if (!isTransferring) return undefined
    const total = selectedDocumentIds.size + selectedFolderIds.size
    return t('document.document.batch.transferringProgress', {
      current: total,
      total,
    })
  }, [isTransferring, selectedDocumentIds.size, selectedFolderIds.size, t])

  // Track component mounted state to prevent updates after unmount
  const isMountedRef = useRef(true)
  const skipNextSelectionNotifyRef = useRef(false)

  useEffect(() => {
    return () => {
      isMountedRef.current = false
    }
  }, [])

  // Check if summary generation failed
  const summaryError = knowledgeBase.summary?.error
  const effectiveSummary = getEffectiveKnowledgeBaseLongSummary(knowledgeBase.summary)
  const hasManualSummary = hasManualSummaryOverride(knowledgeBase.summary)
  const hasVisibleSummary = shouldShowSummaryContent(knowledgeBase.summary)
  const showRetry = shouldShowRetryButton(knowledgeBase.summary, knowledgeBase.summary_enabled)
  const {
    isRetrying: isSummaryRetrying,
    retrySummary,
    openEditor: openSummaryEditor,
    editorDialogProps,
  } = useKnowledgeBaseSummaryEditor({
    knowledgeBase,
    onRefresh: onRefreshKnowledgeBase,
  })

  // Auto-open document from initialDocPath prop (from virtual URL path segments)
  // This runs once when documents are loaded, without modifying the URL
  useEffect(() => {
    if (!initialDocPath || initialDocPathHandled || loading || documents.length === 0) return
    const targetDoc = documents.find(doc => doc.name === initialDocPath)
    if (targetDoc) {
      setViewingDoc(targetDoc)
      setInitialDocPathHandled(true)
      return
    }

    // In paginated mode, the document might be on a different page.
    // Search across all documents via iterative pagination.
    if (paginationEnabled) {
      const controller = new AbortController()
      ;(async () => {
        try {
          const found = await findDocumentByName(
            knowledgeBase.id,
            initialDocPath,
            controller.signal
          )
          if (!controller.signal.aborted && found) {
            setViewingDoc(found)
          }
        } catch {
          // Silently ignore - auto-open is best-effort
        } finally {
          if (!controller.signal.aborted) setInitialDocPathHandled(true)
        }
      })()
      return () => {
        controller.abort()
      }
    }

    setInitialDocPathHandled(true)
  }, [
    initialDocPath,
    initialDocPathHandled,
    loading,
    documents,
    paginationEnabled,
    knowledgeBase.id,
  ])

  // Notebook view starts with no explicit document filter. Users can select
  // documents to narrow the chat context; otherwise the whole KB is available
  // through retrieval without injecting every document into context.
  useEffect(() => {
    if (onSelectionChange) {
      skipNextSelectionNotifyRef.current = true
      resetSelection()
      onSelectionChange([])
    }
  }, [knowledgeBase.id, onSelectionChange, resetSelection])

  // Notify parent when selection changes.
  useEffect(() => {
    if (onSelectionChange) {
      if (skipNextSelectionNotifyRef.current) {
        skipNextSelectionNotifyRef.current = false
        return
      }
      onSelectionChange(Array.from(selectedDocumentIds))
    }
  }, [selectedDocumentIds, onSelectionChange])

  useEffect(() => {
    resetSelection()
  }, [activeFolderId, searchQuery, sortField, sortOrder, resetSelection])

  useEffect(() => {
    if (!folderTreeContainsId(folders, activeFolderId)) {
      setActiveFolderId(undefined)
      resetSelection()
    }
  }, [folders, activeFolderId, resetSelection])

  // In folder-nav mode, navigate back to root if the current folder was deleted
  useEffect(() => {
    if (isFolderNavMode && navFolderId !== null && !folderTreeContainsId(folders, navFolderId)) {
      navigateTo(null)
    }
  }, [folders, isFolderNavMode, navFolderId, navigateTo])

  const canManageAnyDocuments = canUpload || canManageAllDocuments
  const canManageDocumentArea = canManageAnyDocuments
  const canManageFolderStructure = canManageDocumentArea

  const canManageDocument = (_document: KnowledgeDocument) => canManageDocumentArea

  const canSelectDocument = (document: KnowledgeDocument) =>
    Boolean(onSelectionChange) || canManageDocument(document)

  const folderSelectionBlocksDocumentBatchActions = selectionSummary.hasFolderScopeSelection
  const documentBatchActionsDisabled = shouldDisableDocumentBatchActions({
    selectedDocumentCount: selectedDocumentIds.size,
    selectedFolderCount: selectedFolderIds.size,
  })

  const handleOpenUpload = useCallback(() => {
    setSelectedUploadFolderId(isFolderNavMode ? (navFolderId ?? 0) : (activeFolderId ?? 0))
    setShowUpload(true)
  }, [activeFolderId, isFolderNavMode, navFolderId])

  const handleGoToPage = useCallback(
    (targetPage: number) => {
      resetSelection()
      goToPage(targetPage)
    },
    [resetSelection, goToPage]
  )

  const handlePageSizeChange = useCallback(
    (targetPageSize: number) => {
      resetSelection()
      changePageSize(targetPageSize)
    },
    [changePageSize, resetSelection]
  )

  const handleUploadComplete = async (
    attachments: { attachment: { id: number; filename: string }; file: File }[],
    splitterConfig?: Partial<SplitterConfig>
  ) => {
    // Track newly created document IDs for auto-selection
    const newDocumentIds: number[] = []

    // Create documents sequentially to ensure all are created
    for (const { attachment, file } of attachments) {
      // Use attachment.filename (which may have been renamed) instead of file.name
      const documentName = attachment.filename || file.name
      const extension = documentName.split('.').pop() || ''
      try {
        const created = await create({
          attachment_id: attachment.id,
          name: documentName,
          file_extension: extension,
          file_size: file.size,
          splitter_config: splitterConfig,
          source_type: 'file',
          folder_id: selectedUploadFolderId || 0,
        })
        // Collect newly created document ID
        if (created?.id) {
          newDocumentIds.push(created.id)
        }
      } catch {
        // Continue with next file even if one fails
      }
    }

    // Auto-select newly uploaded documents (for notebook mode context injection)
    if (onSelectionChange && newDocumentIds.length > 0) {
      const nextSelectedIds = new Set(selectedDocumentIds)
      newDocumentIds.forEach(id => nextSelectedIds.add(id))
      setDocumentSelection(nextSelectedIds)
    }

    setShowUpload(false)
  }

  const handleTableAdd = async (data: TableDocument) => {
    await create({
      name: data.name,
      file_extension: 'table',
      file_size: 0,
      source_type: 'table',
      source_config: data.source_config,
      folder_id: selectedUploadFolderId || 0,
    })
    setShowUpload(false)
  }

  const handleWebAdd = async (url: string, name?: string) => {
    // Import the API function
    const { createWebDocument } = await import('@/apis/knowledge')

    // Call backend API to scrape and create document
    const result = await createWebDocument(url, knowledgeBase.id, name, selectedUploadFolderId || 0)

    if (!result.success) {
      throw new Error(result.error_message || 'Failed to create web document')
    }

    // Refresh document list to show the new document with correct data
    // This ensures the document has the correct source_type from the backend
    await refresh()

    // Auto-select newly created document (for notebook mode context injection)
    if (onSelectionChange && result.document?.id) {
      const nextSelectedIds = new Set(selectedDocumentIds)
      nextSelectedIds.add(result.document.id)
      setDocumentSelection(nextSelectedIds)
    }

    setShowUpload(false)
  }

  const handleDelete = async () => {
    if (!deletingDoc) return
    try {
      await remove(deletingDoc.id)
      setDeletingDoc(null)
    } catch {
      // Error handled by hook
    }
  }
  // Batch selection handlers
  const handleSelectDoc = (doc: KnowledgeDocument, selected: boolean) => {
    selectDocument(doc, selected)
  }

  // Folder selection handler: folder checkbox represents a backend-resolved scope.
  const handleSelectFolder = useCallback(
    (folderId: number, selected: boolean) => {
      selectFolderScope(folderId, selected)
    },
    [selectFolderScope]
  )

  const handleSelectAll = (checked: boolean) => {
    selectVisibleDocuments(checked)
  }

  const isAllSelected =
    documents.length > 0 && documents.every(doc => selectedDocumentIds.has(doc.id))

  const isPartialSelected = documents.some(doc => selectedDocumentIds.has(doc.id)) && !isAllSelected

  // Batch operations using batch API
  const handleBatchDelete = async () => {
    const payload = getSelectionPayload()
    if (payload.documentIds.length === 0 || payload.folderIds.length > 0) return
    setBatchLoading(true)
    try {
      await batchDelete(payload.documentIds)
      resetSelection()
    } catch {
      // Error handled by hook
    } finally {
      setBatchLoading(false)
    }
  }

  // Handle web document re-fetch
  const handleRefreshWebDocument = async (doc: KnowledgeDocument) => {
    if (doc.source_type !== 'web') return

    setRefreshingDocId(doc.id)
    try {
      const { refreshWebDocument } = await import('@/apis/knowledge')
      const result = await refreshWebDocument(doc.id)

      if (!result.success) {
        throw new Error(result.error_message || t('document.upload.web.refetchFailed'))
      }

      // Refresh document list to show updated data
      await refresh()
    } catch {
      // Error will be shown via toast in the API layer
    } finally {
      setRefreshingDocId(null)
    }
  }

  // Handle document reindex
  const handleReindexDocument = async (doc: KnowledgeDocument) => {
    setReindexingDocId(doc.id)
    try {
      const { reindexDocument } = await import('@/apis/knowledge')
      const result = await reindexDocument(doc.id)

      if (!result.success) {
        throw new Error(t('document.document.reindexFailed'))
      }

      toast({
        description: t('document.document.reindexSuccess'),
      })

      // Refresh document list after a short delay to allow backend to start processing
      setTimeout(() => {
        if (isMountedRef.current) {
          refresh()
        }
      }, 2000)
    } catch (err) {
      // Use ApiError.errorCode for structured error handling
      let errorMessage = t('document.document.reindexFailed')
      if (err instanceof Error) {
        // Check if it's an ApiError with errorCode for structured error handling
        const apiError = err as { errorCode?: string; message: string }
        if (apiError.errorCode === 'EXCEL_FILE_SIZE_EXCEEDED') {
          // Format: EXCEL_FILE_SIZE_EXCEEDED|extension|limit|size
          const parts = apiError.message.split('|')
          if (parts.length === 4) {
            errorMessage = t('document.document.excelFileSizeExceeded', {
              extension: parts[1],
              limit: parts[2],
              size: parts[3],
            })
          }
        } else {
          // Use the original error message for other errors
          errorMessage = apiError.message
        }
      }
      toast({
        variant: 'destructive',
        description: errorMessage,
      })
    } finally {
      if (isMountedRef.current) {
        setReindexingDocId(null)
      }
    }
  }

  const longSummary = effectiveSummary || getKnowledgeBasePreviewSummary(knowledgeBase.summary)

  // Folder CRUD handlers
  const handleCreateFolder = async (parentId: number) => {
    setCreateFolderParentId(parentId)
    setShowCreateFolder(true)
  }

  const handleCreateFolderSubmit = async (name: string) => {
    await createFolder({ name, parent_id: createFolderParentId })
    setShowCreateFolder(false)
    refresh()
  }

  const handleRenameFolder = (folderId: number, currentName: string) => {
    setRenamingFolder({ id: folderId, name: currentName })
  }

  const handleRenameFolderSubmit = async (name: string) => {
    if (!renamingFolder) return
    await updateFolder(renamingFolder.id, { name })
    setRenamingFolder(null)
    refresh()
  }

  const handleDeleteFolderClick = (folderId: number, folderName: string) => {
    setDeletingFolder({ id: folderId, name: folderName })
  }

  const handleDeleteFolderConfirm = async () => {
    if (!deletingFolder) return
    if (deletedFolderAffectsActiveFolder(folders, deletingFolder.id, activeFolderId)) {
      setActiveFolderId(undefined)
      resetSelection()
    }
    await deleteFolder(deletingFolder.id)
    setDeletingFolder(null)
    refresh()
  }

  // Document move handlers
  const handleMoveDocument = useCallback((doc: KnowledgeDocument) => {
    setMovingDoc(doc)
  }, [])

  const handleMoveConfirm = useCallback(
    async (targetFolderId: number) => {
      if (!movingDoc) return
      setIsMovingDoc(true)
      try {
        const success = await moveDocument(movingDoc.id, targetFolderId)
        if (success) {
          setMovingDoc(null)
          refresh()
          fetchFolders()
        }
      } finally {
        setIsMovingDoc(false)
      }
    },
    [movingDoc, moveDocument, refresh, fetchFolders]
  )

  // Batch move handler
  const handleBatchMoveConfirm = useCallback(
    async (targetFolderId: number) => {
      setIsBatchMoving(true)
      try {
        const payload = getSelectionPayload()
        const result = await batchMove(payload.documentIds, targetFolderId)
        if (result.success_count > 0) {
          if (result.failed_count > 0) {
            const nextSelectedIds = new Set(result.failed_ids)
            setDocumentSelection(nextSelectedIds)
            toast({
              description: t('document.folder.batchMovePartial', {
                success: result.success_count,
                failed: result.failed_count,
              }),
              variant: 'destructive',
            })
          } else {
            resetSelection()
          }
          refresh()
          fetchFolders()
        }
      } finally {
        setIsBatchMoving(false)
        setShowBatchMove(false)
      }
    },
    [batchMove, getSelectionPayload, setDocumentSelection, resetSelection, refresh, fetchFolders, t]
  )

  // Transfer handler
  const handleTransferConfirm = useCallback(
    async (targetKbId: number) => {
      setIsTransferring(true)
      try {
        // Pass only folders that still represent complete subtree selections.
        // If a user deselects a descendant document, its selected ancestor folders
        // are removed so folder_ids cannot re-add that document during transfer.
        const payload = getSelectionPayload()
        const result = await transfer({
          document_ids: payload.documentIds,
          folder_ids: payload.folderIds,
          target_kb_id: targetKbId,
        })
        if (result !== null) {
          resetSelection()
          refresh()
          fetchFolders()
          setShowTransfer(false)
        }
      } finally {
        setIsTransferring(false)
      }
    },
    [getSelectionPayload, transfer, resetSelection, refresh, fetchFolders]
  )
  // Knowledge base type info
  const isNotebook = (knowledgeBase.kb_type || 'notebook') === 'notebook'
  // Check if RAG is configured (has retriever and embedding model)
  const ragConfigured = !!(
    knowledgeBase.retrieval_config?.retriever_name &&
    knowledgeBase.retrieval_config?.embedding_config?.model_name
  )

  return (
    <div className="space-y-4">
      {/* Header - Wegent style */}
      <div className="flex items-center gap-3">
        {onBack && (
          <button
            onClick={onBack}
            className="p-1.5 rounded-md text-text-muted hover:text-text-primary hover:bg-surface transition-colors"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
        )}
        {/* Type icon - based on current kb type */}
        {isNotebook ? (
          <BookOpen className="w-5 h-5 text-primary flex-shrink-0" />
        ) : (
          <Database className="w-5 h-5 text-text-secondary flex-shrink-0" />
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            {/* Group name prefix with click handler */}
            {groupInfo && (
              <>
                <button
                  onClick={() => onGroupClick?.(groupInfo.groupId, groupInfo.groupType)}
                  className="text-base font-medium text-text-secondary hover:text-primary transition-colors truncate max-w-[120px]"
                  title={groupInfo.groupName}
                >
                  {groupInfo.groupName}
                </button>
                <span className="text-text-muted">/</span>
              </>
            )}
            <h2 className="text-base font-medium text-text-primary truncate">
              {knowledgeBase.name}
            </h2>
            {/* Summary tooltip - keep visible when manual summary exists after AI failure */}
            {(hasVisibleSummary || canManageAllDocuments) && (
              <>
                <TooltipProvider>
                  <Tooltip delayDuration={200}>
                    <TooltipTrigger asChild>
                      <button
                        className="flex-shrink-0 h-11 min-w-[44px] inline-flex items-center justify-center rounded text-text-muted hover:text-primary hover:bg-surface transition-colors"
                        data-testid="summary-info-button"
                      >
                        <Info className="w-4 h-4" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" align="start" className="max-w-md">
                      {hasVisibleSummary ? (
                        <div className="space-y-2">
                          {hasManualSummary && (
                            <Badge variant="secondary" size="sm">
                              {t('chatPage.summaryManualBadge')}
                            </Badge>
                          )}
                          <p className="text-sm leading-relaxed">{longSummary}</p>
                        </div>
                      ) : (
                        <p className="text-sm leading-relaxed">
                          {t('chatPage.summaryEditPlaceholder')}
                        </p>
                      )}
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
                {canManageAllDocuments && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={openSummaryEditor}
                    className="h-11 min-w-[44px] px-2 text-xs"
                    data-testid="kb-summary-inline-edit-button"
                  >
                    <Pencil className="w-3 h-3 mr-1" />
                    {t('chatPage.summaryEdit')}
                  </Button>
                )}
              </>
            )}
            {/* Summary failed warning - with retry button */}
            {showRetry && (
              <TooltipProvider>
                <Tooltip delayDuration={200}>
                  <TooltipTrigger asChild>
                    <button className="flex-shrink-0 p-0.5 rounded text-amber-500 hover:bg-surface transition-colors">
                      <AlertTriangle className="w-4 h-4" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" align="start" className="max-w-md">
                    <p className="text-sm leading-relaxed">
                      {summaryError || t('chatPage.summaryFailedHint')}
                    </p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
            {showRetry && (
              <Button
                variant="ghost"
                size="sm"
                onClick={retrySummary}
                disabled={isSummaryRetrying}
                className="h-6 px-2 text-xs text-amber-500 hover:text-amber-600"
              >
                <RefreshCw className={`w-3 h-3 mr-1 ${isSummaryRetrying ? 'animate-spin' : ''}`} />
                {isSummaryRetrying ? t('chatPage.summaryRetrying') : t('chatPage.summaryRetry')}
              </Button>
            )}
          </div>
          {knowledgeBase.description && (
            <p className="text-xs text-text-muted truncate">{knowledgeBase.description}</p>
          )}
        </div>
        {/* Header actions (e.g., tabs) */}
        {headerActions}
      </div>
      {canManageAllDocuments && <EditKnowledgeBaseSummaryDialog {...editorDialogProps} />}

      {/* Search bar and action buttons */}
      <div className="flex items-center gap-3 flex-wrap">
        {/* Search - inline for normal mode, popover for compact mode */}
        {compact ? (
          <div className="relative">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowSearchPopover(!showSearchPopover)}
              className={searchQuery ? 'border-primary' : ''}
            >
              <Search className="w-4 h-4" />
              {searchQuery && (
                <span className="ml-1 max-w-[60px] truncate text-xs">{searchQuery}</span>
              )}
            </Button>
            {showSearchPopover && (
              <div className="absolute top-full left-0 mt-1 z-50 bg-base border border-border rounded-md shadow-lg p-2 min-w-[240px]">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted" />
                  <input
                    type="text"
                    autoFocus
                    className="w-full h-9 pl-9 pr-3 text-sm bg-surface border border-border rounded-md focus:outline-none focus:ring-1 focus:ring-primary"
                    placeholder={searchPlaceholder}
                    value={searchQuery}
                    onChange={e => setSearchQuery(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Escape') {
                        setShowSearchPopover(false)
                      }
                    }}
                    onBlur={() => {
                      // Delay to allow click events to fire
                      setTimeout(() => setShowSearchPopover(false), 150)
                    }}
                  />
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="relative flex-1 max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted" />
            <input
              type="text"
              className="w-full h-9 pl-9 pr-3 text-sm bg-surface border border-border rounded-md focus:outline-none focus:ring-1 focus:ring-primary"
              placeholder={searchPlaceholder}
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
            />
          </div>
        )}
        {activeFolderName && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setActiveFolderId(undefined)}
            className="min-h-11 min-w-11 max-w-[220px]"
            data-testid="active-folder-clear"
          >
            <span className="truncate">{activeFolderName}</span>
            <X className="w-3.5 h-3.5 ml-1 flex-shrink-0" />
          </Button>
        )}
        {/* Spacer to push buttons to the right */}
        <div className="flex-1" />

        {/* Refresh list button */}
        <TooltipProvider>
          <Tooltip delayDuration={200}>
            <TooltipTrigger asChild>
              <Button variant="outline" size="sm" onClick={() => refresh()} disabled={loading}>
                <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p>{t('common:actions.refresh')}</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>

        {/* Retrieval test button */}
        <TooltipProvider>
          <Tooltip delayDuration={200}>
            <TooltipTrigger asChild>
              <Button variant="outline" size="sm" onClick={() => setShowRetrievalTest(true)}>
                <Target className="w-4 h-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p>{t('document.retrievalTest.button')}</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>

        {/* Create folder button - in folder-nav mode, create inside current folder */}
        {canManageFolderStructure && (
          <Button
            variant="outline"
            className="h-11 min-w-[44px]"
            onClick={() => handleCreateFolder(isFolderNavMode ? (navFolderId ?? 0) : 0)}
          >
            <FolderPlus className="w-4 h-4 mr-1" />
            {t('document.folder.create')}
          </Button>
        )}

        {/* Upload button */}
        {canUpload && (
          <Button variant="primary" size="sm" onClick={handleOpenUpload}>
            <Upload className="w-4 h-4 mr-1" />
            {t('document.document.upload')}
          </Button>
        )}
      </div>

      {/* Document List */}
      {loading && documents.length === 0 ? (
        <div className="flex items-center justify-center py-12">
          <Spinner />
        </div>
      ) : showLoadError ? (
        <div className="flex flex-col items-center justify-center py-12 text-text-secondary">
          <p>{error}</p>
          <Button variant="outline" className="mt-4" onClick={() => refresh()}>
            {t('common:actions.retry')}
          </Button>
        </div>
      ) : documents.length > 0 || folders.length > 0 ? (
        <>
          {/* Batch action bar - shown when items are selected (not in notebook mode where selection is for context injection) */}
          {canManageDocumentArea && selectionSummary.canTransfer && !onSelectionChange && (
            <div
              className={`flex items-center gap-3 ${compact ? 'px-2 py-2' : 'px-4 py-2.5'} bg-primary/5 border border-primary/20 rounded-lg`}
            >
              <span className="text-sm text-text-primary">
                {formatSelectionSummary(
                  t,
                  'selected',
                  selectedDocumentIds.size,
                  selectedFolderIds.size
                )}
              </span>
              <div className="flex-1" />
              <TooltipProvider>
                <Tooltip delayDuration={200}>
                  <TooltipTrigger asChild>
                    <span>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setShowBatchMove(true)}
                        disabled={
                          documentBatchActionsDisabled ||
                          batchLoading ||
                          isBatchMoving ||
                          isTransferring
                        }
                        data-testid="batch-move-button"
                        aria-label={t('document.document.batch.move')}
                      >
                        <FolderInput className="w-4 h-4 mr-1" />
                        {compact ? '' : t('document.document.batch.move')}
                      </Button>
                    </span>
                  </TooltipTrigger>
                  {folderSelectionBlocksDocumentBatchActions && (
                    <TooltipContent>
                      <p>{t('document.document.batch.folderScopeTransferOnly')}</p>
                    </TooltipContent>
                  )}
                </Tooltip>
              </TooltipProvider>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowTransfer(true)}
                disabled={batchLoading || isBatchMoving || isTransferring}
                data-testid="batch-transfer-button"
                aria-label={t('document.document.batch.transfer')}
              >
                <ArrowRightLeft className="w-4 h-4 mr-1" />
                {compact ? '' : t('document.document.batch.transfer')}
              </Button>
              <TooltipProvider>
                <Tooltip delayDuration={200}>
                  <TooltipTrigger asChild>
                    <span>
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={handleBatchDelete}
                        disabled={documentBatchActionsDisabled || batchLoading}
                      >
                        <Trash2 className="w-4 h-4 mr-1" />
                        {compact ? '' : t('document.document.batch.delete')}
                      </Button>
                    </span>
                  </TooltipTrigger>
                  {folderSelectionBlocksDocumentBatchActions && (
                    <TooltipContent>
                      <p>{t('document.document.batch.folderScopeTransferOnly')}</p>
                    </TooltipContent>
                  )}
                </Tooltip>
              </TooltipProvider>
            </div>
          )}

          {/* Compact mode: Card layout — dual-mode same as normal mode */}
          {compact ? (
            <div className="space-y-2">
              {displayMode === 'expand-all' ? (
                /* Compact expand-all: all folders open, no pagination */
                <>
                  {onSelectionChange && documents.length > 0 && (
                    <div className="flex items-center gap-2 px-2 py-1.5 text-xs text-text-muted">
                      <button
                        onClick={() => handleSelectAll(!isAllSelected)}
                        className="flex items-center gap-1.5 hover:text-text-primary transition-colors"
                      >
                        {isAllSelected ? (
                          <CheckSquare className="w-3.5 h-3.5 text-primary" />
                        ) : (
                          <Square className="w-3.5 h-3.5" />
                        )}
                        <span>{t('document.document.batch.selectAll')}</span>
                      </button>
                      <span className="text-text-muted">
                        ({documents.filter(doc => selectedDocumentIds.has(doc.id)).length}/
                        {documents.length})
                      </span>
                    </div>
                  )}
                  <FolderTree
                    folders={folders}
                    documents={documents}
                    compact={true}
                    expandAll={true}
                    onViewDetail={setViewingDoc}
                    onEdit={setEditingDoc}
                    onDelete={setDeletingDoc}
                    onRefresh={handleRefreshWebDocument}
                    onReindex={handleReindexDocument}
                    onMove={handleMoveDocument}
                    refreshingDocId={refreshingDocId}
                    reindexingDocId={reindexingDocId}
                    canManage={canManageDocument}
                    canSelect={canSelectDocument}
                    selectedIds={selectedDocumentIds}
                    includedInFolderScope={isDocumentIncludedInFolderScope}
                    onSelect={handleSelectDoc}
                    ragConfigured={ragConfigured}
                    onCreateFolder={canManageFolderStructure ? handleCreateFolder : undefined}
                    onRenameFolder={canManageFolderStructure ? handleRenameFolder : undefined}
                    onDeleteFolder={canManageFolderStructure ? handleDeleteFolderClick : undefined}
                    canManageFolders={canManageFolderStructure}
                    canSelectFolders={canManageFolderStructure && !onSelectionChange}
                    selectedFolderIds={selectedFolderIds}
                    onSelectFolder={handleSelectFolder}
                  />
                </>
              ) : (
                /* Compact folder-nav: breadcrumb + direct children only */
                <>
                  <KnowledgeFolderBreadcrumb breadcrumbs={breadcrumbs} onNavigate={navigateTo} />
                  {onSelectionChange && documents.length > 0 && (
                    <div className="flex items-center gap-2 px-2 py-1.5 text-xs text-text-muted">
                      <button
                        onClick={() => handleSelectAll(!isAllSelected)}
                        className="flex items-center gap-1.5 hover:text-text-primary transition-colors"
                      >
                        {isAllSelected ? (
                          <CheckSquare className="w-3.5 h-3.5 text-primary" />
                        ) : (
                          <Square className="w-3.5 h-3.5" />
                        )}
                        <span>
                          {paginationEnabled
                            ? t('document.document.batch.selectCurrentPage')
                            : t('document.document.batch.selectAll')}
                        </span>
                      </button>
                      <span className="text-text-muted">
                        ({documents.filter(doc => selectedDocumentIds.has(doc.id)).length}/
                        {documents.length})
                      </span>
                    </div>
                  )}
                  <FolderTree
                    folders={
                      searchQuery ? [] : directChildFolders.map(f => ({ ...f, children: [] }))
                    }
                    documents={documents}
                    compact={true}
                    folderNavMode={true}
                    onViewDetail={setViewingDoc}
                    onEdit={setEditingDoc}
                    onDelete={setDeletingDoc}
                    onRefresh={handleRefreshWebDocument}
                    onReindex={handleReindexDocument}
                    onMove={handleMoveDocument}
                    refreshingDocId={refreshingDocId}
                    reindexingDocId={reindexingDocId}
                    canManage={canManageDocument}
                    canSelect={canSelectDocument}
                    selectedIds={selectedDocumentIds}
                    includedInFolderScope={isDocumentIncludedInFolderScope}
                    onSelect={handleSelectDoc}
                    ragConfigured={ragConfigured}
                    onCreateFolder={canManageFolderStructure ? handleCreateFolder : undefined}
                    onRenameFolder={canManageFolderStructure ? handleRenameFolder : undefined}
                    onDeleteFolder={canManageFolderStructure ? handleDeleteFolderClick : undefined}
                    canManageFolders={canManageFolderStructure}
                    canSelectFolders={canManageFolderStructure && !onSelectionChange}
                    selectedFolderIds={selectedFolderIds}
                    onSelectFolder={handleSelectFolder}
                    onActivateFolder={navigateTo}
                  />
                  {paginationEnabled && (
                    <Pagination
                      page={page}
                      totalPages={totalPages}
                      totalCount={totalCount}
                      pageSize={pageSize}
                      onGoToPage={handleGoToPage}
                      onPageSizeChange={handlePageSizeChange}
                      disabled={loading}
                    />
                  )}
                </>
              )}
            </div>
          ) : (
            /* Normal mode: dual-mode based on document count */
            <div className="border border-border rounded-lg overflow-x-auto">
              {displayMode === 'expand-all' ? (
                /* Expand-all mode: all folders open, no pagination */
                <KnowledgeDocumentTreeGrid
                  nodes={resourceTree.nodes}
                  treeIndex={resourceTree.index}
                  folders={folders}
                  documents={documents}
                  showSelectionColumn={canManageDocumentArea}
                  showActionsColumn={canManageAnyDocuments}
                  sortField={sortField}
                  sortOrder={sortOrder}
                  onSortChange={(field, order) => {
                    setSortField(field)
                    setSortOrder(order)
                  }}
                  isAllSelected={isAllSelected}
                  isPartialSelected={isPartialSelected}
                  onSelectAll={handleSelectAll}
                  selectAllLabel={t('document.document.batch.selectAll')}
                  onViewDetail={setViewingDoc}
                  onEdit={setEditingDoc}
                  onDelete={setDeletingDoc}
                  onRefresh={handleRefreshWebDocument}
                  onReindex={handleReindexDocument}
                  onMove={handleMoveDocument}
                  refreshingDocId={refreshingDocId}
                  reindexingDocId={reindexingDocId}
                  canManage={canManageDocument}
                  canSelect={canSelectDocument}
                  selectedDocumentIds={selectedDocumentIds}
                  includedInFolderScope={isDocumentIncludedInFolderScope}
                  onSelect={canManageDocumentArea ? handleSelectDoc : undefined}
                  ragConfigured={ragConfigured}
                  onCreateFolder={canManageFolderStructure ? handleCreateFolder : undefined}
                  onRenameFolder={canManageFolderStructure ? handleRenameFolder : undefined}
                  onDeleteFolder={canManageFolderStructure ? handleDeleteFolderClick : undefined}
                  canManageFolders={canManageFolderStructure}
                  canSelectFolders={canManageFolderStructure && !onSelectionChange}
                  selectedFolderIds={selectedFolderIds}
                  onSelectFolder={handleSelectFolder}
                  expandAll={true}
                />
              ) : (
                /* Folder-nav mode: breadcrumb + flat subfolder/document list */
                <>
                  {searchQuery ? (
                    <div className="flex items-center gap-2 px-4 h-9 border-b border-border bg-surface/50 text-sm text-text-secondary">
                      <Search className="w-3.5 h-3.5 flex-shrink-0" />
                      <span className="truncate">
                        {t('document.nav.searchResults')}: {searchQuery}
                      </span>
                    </div>
                  ) : (
                    <KnowledgeFolderBreadcrumb breadcrumbs={breadcrumbs} onNavigate={navigateTo} />
                  )}
                  <KnowledgeFolderNavView
                    subfolders={searchQuery ? [] : directChildFolders}
                    documents={documents}
                    onNavigateFolder={navigateTo}
                    showSelectionColumn={canManageDocumentArea}
                    showActionsColumn={canManageAnyDocuments}
                    sortField={sortField}
                    sortOrder={sortOrder}
                    onSortChange={(field, order) => {
                      setSortField(field)
                      setSortOrder(order)
                    }}
                    isAllSelected={isAllSelected}
                    isPartialSelected={isPartialSelected}
                    onSelectAll={handleSelectAll}
                    selectAllLabel={
                      paginationEnabled
                        ? t('document.document.batch.selectCurrentPage')
                        : t('document.document.batch.selectAll')
                    }
                    onViewDetail={setViewingDoc}
                    onEdit={setEditingDoc}
                    onDelete={setDeletingDoc}
                    onRefresh={handleRefreshWebDocument}
                    onReindex={handleReindexDocument}
                    onMove={handleMoveDocument}
                    refreshingDocId={refreshingDocId}
                    reindexingDocId={reindexingDocId}
                    canManage={canManageDocument}
                    canSelect={canSelectDocument}
                    selectedDocumentIds={selectedDocumentIds}
                    includedInFolderScope={isDocumentIncludedInFolderScope}
                    onSelect={canManageDocumentArea ? handleSelectDoc : undefined}
                    ragConfigured={ragConfigured}
                    onCreateFolder={canManageFolderStructure ? handleCreateFolder : undefined}
                    onRenameFolder={canManageFolderStructure ? handleRenameFolder : undefined}
                    onDeleteFolder={canManageFolderStructure ? handleDeleteFolderClick : undefined}
                    canManageFolders={canManageFolderStructure}
                  />
                  {paginationEnabled && (
                    <div className="min-w-[880px] bg-base">
                      <Pagination
                        page={page}
                        totalPages={totalPages}
                        totalCount={totalCount}
                        pageSize={pageSize}
                        onGoToPage={handleGoToPage}
                        onPageSizeChange={handlePageSizeChange}
                        disabled={loading}
                      />
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </>
      ) : searchQuery || activeFolderId !== undefined ? (
        <div className="flex flex-col items-center justify-center py-12 text-text-secondary">
          <FileText className="w-12 h-12 mb-4 opacity-50" />
          <p>{t('document.document.noResults')}</p>
          <p className="text-xs text-text-muted mt-2">{t('document.pagination.searchHint')}</p>
        </div>
      ) : canUpload ? (
        <div className="flex flex-col items-center justify-center py-16 text-text-secondary">
          <FileUp className="w-16 h-16 mb-4 text-text-muted opacity-60" />
          <p className="text-base text-text-primary mb-2">{t('document.document.emptyHint')}</p>
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center py-12 text-text-secondary">
          <FileText className="w-12 h-12 mb-4 opacity-50" />
          <p>{t('document.document.empty')}</p>
        </div>
      )}

      {/* Auto-open document from ?doc= URL parameter (wrapped in Suspense for useSearchParams) */}
      <Suspense fallback={null}>
        <DocAutoOpener
          documents={documents}
          loading={loading}
          onOpen={setViewingDoc}
          knowledgeBaseId={knowledgeBase.id}
          paginationEnabled={paginationEnabled}
        />
      </Suspense>

      {/* Dialogs */}
      <DocumentDetailDialog
        open={!!viewingDoc}
        onOpenChange={open => !open && setViewingDoc(null)}
        document={viewingDoc}
        knowledgeBaseId={knowledgeBase.id}
        kbType={knowledgeBase.kb_type}
        canEdit={viewingDoc ? canManageDocument(viewingDoc) : false}
        knowledgeBaseName={knowledgeBase.name}
        knowledgeBaseNamespace={knowledgeBase.namespace || 'default'}
        isOrganization={isOrganization}
      />
      <DocumentUpload
        open={showUpload}
        onOpenChange={setShowUpload}
        onUploadComplete={handleUploadComplete}
        onTableAdd={handleTableAdd}
        onWebAdd={handleWebAdd}
        kbType={knowledgeBase.kb_type}
        folderId={selectedUploadFolderId}
        folderOptions={folderOptions}
        onFolderChange={setSelectedUploadFolderId}
      />

      <EditDocumentDialog
        open={!!editingDoc}
        onOpenChange={open => !open && setEditingDoc(null)}
        document={editingDoc}
        onSuccess={() => {
          setEditingDoc(null)
          refresh()
        }}
      />

      <DeleteDocumentDialog
        open={!!deletingDoc}
        onOpenChange={open => !open && setDeletingDoc(null)}
        document={deletingDoc}
        onConfirm={handleDelete}
        loading={loading}
      />

      <RetrievalTestDialog
        open={showRetrievalTest}
        onOpenChange={setShowRetrievalTest}
        knowledgeBase={knowledgeBase}
      />

      {/* Folder dialogs */}
      <CreateFolderDialog
        open={showCreateFolder}
        onOpenChange={setShowCreateFolder}
        onSubmit={handleCreateFolderSubmit}
      />

      <CreateFolderDialog
        open={!!renamingFolder}
        onOpenChange={open => !open && setRenamingFolder(null)}
        onSubmit={handleRenameFolderSubmit}
        initialName={renamingFolder?.name}
      />

      <DeleteFolderDialog
        open={!!deletingFolder}
        onOpenChange={open => !open && setDeletingFolder(null)}
        folderName={deletingFolder?.name || ''}
        onConfirm={handleDeleteFolderConfirm}
      />

      <MoveDocumentDialog
        open={!!movingDoc}
        onOpenChange={open => !open && setMovingDoc(null)}
        documentName={movingDoc?.name || ''}
        folders={folderOptions}
        currentFolderId={movingDoc?.folder_id ?? 0}
        onConfirm={handleMoveConfirm}
        isSubmitting={isMovingDoc}
      />

      <MoveDocumentDialog
        open={showBatchMove}
        onOpenChange={setShowBatchMove}
        documentName=""
        folders={folderOptions}
        onConfirm={handleBatchMoveConfirm}
        isSubmitting={isBatchMoving}
        batchMode={true}
        selectedCount={selectedDocumentIds.size}
      />

      <TransferToKbDialog
        open={showTransfer}
        onOpenChange={setShowTransfer}
        selectedDocumentCount={selectedDocumentIds.size}
        selectedFolderCount={selectedFolderIds.size}
        currentKnowledgeBaseId={knowledgeBase.id}
        onConfirm={handleTransferConfirm}
        isSubmitting={isTransferring}
        currentKnowledgeBaseNamespace={knowledgeBase.namespace || 'default'}
        progressText={transferProgressText}
      />
    </div>
  )
}
