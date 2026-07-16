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
  ChevronRight,
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
import { ReanalyzeMultimodalDialog } from '@/features/knowledge/multimodal/components/ReanalyzeMultimodalDialog'
import { useDocuments } from '../hooks/useDocuments'
import { useFolders } from '../hooks/useFolders'
import { FolderTree, type SortField, type SortOrder } from './FolderTree'
import { KnowledgeDocumentTreeGrid } from './knowledge-document-tree-grid'
import { CreateFolderDialog } from './CreateFolderDialog'
import { DeleteFolderDialog } from './DeleteFolderDialog'
import { MoveDocumentDialog } from './MoveDocumentDialog'
import { TransferToKbDialog } from './transfer-to-kb-dialog'
import {
  useKnowledgeResourceSelection,
  shouldDisableDocumentBatchActions,
} from '../hooks/useKnowledgeResourceSelection'
import { Pagination } from '@/components/ui/pagination'
import { listDocuments } from '@/apis/knowledge'
import { toast } from '@/hooks/use-toast'
import { useDocumentIndexPolling } from '@/features/knowledge/multimodal/hooks/useDocumentIndexPolling'
import { useModelSupportsVideo } from '@/features/knowledge/multimodal/hooks/useModelSupportsVideo'
import { resolvePerFilePrompt } from '@/features/knowledge/multimodal/utils/resolvePerFilePrompt'
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
  // 0 = root level, positive number = subfolder id
  const [currentFolderId, setCurrentFolderId] = useState<number>(0)
  // Expand-all view: show full folder+document tree when KB document_count < 200
  const [isExpandAllView, setIsExpandAllView] = useState(false)

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

  // Full tree index (all folders) — used for selection scope and breadcrumb
  const fullTree = useMemo(() => buildKnowledgeResourceTree(folders, []), [folders])

  // Breadcrumb path from root to currentFolderId
  const folderBreadcrumb = useMemo(() => {
    if (currentFolderId === 0) return []
    const path: KnowledgeFolder[] = []
    let cur = fullTree.index.folderById.get(currentFolderId)
    while (cur) {
      path.unshift(cur)
      cur = cur.parent_id ? fullTree.index.folderById.get(cur.parent_id) : undefined
    }
    return path
  }, [currentFolderId, fullTree.index])

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
    loadAll: isExpandAllView,
    folderId: isExpandAllView || searchQuery ? undefined : currentFolderId,
    includeSubfolders: false,
    keyword: searchQuery,
    sortBy: sortField,
    sortOrder,
  })

  // When searching, build a filtered folder tree containing only ancestors of matching documents.
  // This lets deep documents show their full path without showing irrelevant folder rows.
  const searchResultFolders = useMemo(() => {
    if (!searchQuery || documents.length === 0) return null
    const relevantIds = new Set<number>()
    for (const doc of documents) {
      const pathIds = fullTree.index.folderPathIds.get(doc.folder_id ?? 0) ?? []
      pathIds.forEach(id => relevantIds.add(id))
    }
    function filterFolders(list: KnowledgeFolder[]): KnowledgeFolder[] {
      return list
        .filter(f => relevantIds.has(f.id))
        .map(f => ({ ...f, children: filterFolders(f.children) }))
    }
    return filterFolders(folders)
  }, [searchQuery, documents, folders, fullTree.index])

  // Direct child folders for display
  const directFolders = useMemo(() => {
    if (isExpandAllView) return folders
    if (searchQuery) return searchResultFolders ?? []
    if (currentFolderId === 0) return folders.map(f => ({ ...f, children: [] }))
    const parentFolder = fullTree.index.folderById.get(currentFolderId)
    return (parentFolder?.children ?? []).map(f => ({ ...f, children: [] }))
  }, [folders, currentFolderId, isExpandAllView, searchQuery, searchResultFolders, fullTree.index])

  // Display tree: direct children only in layered nav, full tree in expand-all
  const resourceTree = useMemo(
    () => buildKnowledgeResourceTree(directFolders, documents),
    [directFolders, documents]
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
      setCurrentFolderId(0)
      setIsExpandAllView(false)
    }
  }, [knowledgeBase.id, fetchFolders])

  // Flatten folder tree for select dropdowns
  const folderOptions = useMemo(() => flattenFoldersForSelect(folders), [folders])
  const searchPlaceholder = t('document.document.search')

  // Resolve whether the KB's multimodal analysis model supports video, so the
  // upload picker can reject video files early when an image-only model is
  // selected (UX early-rejection; the backend remains the correctness boundary).
  const modelSupportsVideo = useModelSupportsVideo(knowledgeBase)

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
    treeIndex: fullTree.index,
  })

  // Navigate into a subfolder (layered navigation)
  const handleNavigateIntoFolder = useCallback(
    (folderId: number) => {
      setCurrentFolderId(folderId)
      resetSelection()
    },
    [resetSelection]
  )

  // Toggle expand-all view
  const handleToggleExpandAll = useCallback(() => {
    setIsExpandAllView(prev => {
      resetSelection()
      return !prev
    })
  }, [resetSelection])
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

  // Track the document open in the "modify prompt & re-analyze" dialog
  const [reanalyzeDoc, setReanalyzeDoc] = useState<KnowledgeDocument | null>(null)

  // Track component mounted state to prevent updates after unmount
  const isMountedRef = useRef(true)
  const skipNextSelectionNotifyRef = useRef(false)

  useEffect(() => {
    return () => {
      isMountedRef.current = false
    }
  }, [])

  // Mirror documents in a ref so polling interval callbacks read the latest
  // statuses without re-creating the interval each render.
  const documentsRef = useRef(documents)
  documentsRef.current = documents

  // Poll the document list while any document is in an active indexing state
  // so live progress (pending_conversion → converting → indexing → terminal)
  // is reflected during slow background work like multimodal Gemini analysis.
  // See hooks/useDocumentIndexPolling for details.
  useDocumentIndexPolling(documents, () => {
    if (isMountedRef.current) refresh()
  })

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
  }, [currentFolderId, isExpandAllView, searchQuery, sortField, sortOrder, resetSelection])

  useEffect(() => {
    if (currentFolderId !== 0 && !folderTreeContainsId(folders, currentFolderId)) {
      setCurrentFolderId(0)
      resetSelection()
    }
  }, [folders, currentFolderId, resetSelection])

  // Auto-exit expand-all view if KB document count exceeds the threshold
  useEffect(() => {
    if (isExpandAllView && (knowledgeBase.document_count ?? 0) >= 200) {
      setIsExpandAllView(false)
      resetSelection()
    }
  }, [isExpandAllView, knowledgeBase.document_count, resetSelection])

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
    setSelectedUploadFolderId(currentFolderId)
    setShowUpload(true)
  }, [currentFolderId])

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
    splitterConfig?: Partial<SplitterConfig>,
    multimodalAnalysisPrompts?: {
      video?: string | null
      image?: string | null
    }
  ) => {
    // Track newly created document IDs for auto-selection
    const newDocumentIds: number[] = []

    // Create documents sequentially to ensure all are created
    for (const { attachment, file } of attachments) {
      // Use attachment.filename (which may have been renamed) instead of file.name
      const documentName = attachment.filename || file.name
      const extension = documentName.split('.').pop() || ''
      // Apply the per-media-type prompt override: video files get the video
      // prompt, image files get the image prompt, non-media files get none.
      // undefined → the document inherits the KB default for its type.
      const perFilePrompt = resolvePerFilePrompt(documentName, extension, multimodalAnalysisPrompts)
      try {
        const created = await create({
          attachment_id: attachment.id,
          name: documentName,
          file_extension: extension,
          file_size: file.size,
          splitter_config: splitterConfig,
          source_type: 'file',
          folder_id: selectedUploadFolderId || 0,
          // Forward the per-upload multimodal prompt override (undefined when
          // not customized or when the file is not multimodal → inherits KB default).
          multimodal_analysis_prompt: perFilePrompt,
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

      // Immediately refresh so the doc's new PENDING_CONVERSION/QUEUED status
      // lands in `documents` and kicks off the active-indexing poll above (which
      // keeps refreshing every 5s until the doc reaches a terminal state). The
      // backend has already committed the status change before returning, so this
      // refresh is guaranteed to see it. Mirrors how newly-uploaded docs (which
      // enter the list already in an active status) get live progress updates.
      await refresh()
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
    if (deletedFolderAffectsActiveFolder(folders, deletingFolder.id, currentFolderId)) {
      setCurrentFolderId(0)
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
        {/* Header actions (e.g., tabs) + expand-all toggle */}
        {(knowledgeBase.document_count ?? 0) < 200 && (
          <Button
            variant="outline"
            size="sm"
            onClick={handleToggleExpandAll}
            data-testid="expand-all-toggle"
          >
            {isExpandAllView ? t('document.tree.layeredNav') : t('document.tree.expandAll')}
          </Button>
        )}
        {headerActions}
      </div>
      {canManageAllDocuments && <EditKnowledgeBaseSummaryDialog {...editorDialogProps} />}

      {/* Folder breadcrumb navigation (layered nav only) */}
      {!isExpandAllView && (
        <div className="flex items-center gap-1 text-sm text-text-muted flex-wrap">
          <button
            onClick={() => {
              setCurrentFolderId(0)
              resetSelection()
            }}
            className={`hover:text-text-primary transition-colors ${currentFolderId === 0 ? 'text-text-primary font-medium' : ''}`}
            data-testid="breadcrumb-root"
          >
            {t('document.breadcrumb.root')}
          </button>
          {folderBreadcrumb.map((folder, i) => (
            <span key={folder.id} className="flex items-center gap-1">
              <ChevronRight className="w-3.5 h-3.5 flex-shrink-0" />
              {i < folderBreadcrumb.length - 1 ? (
                <button
                  onClick={() => {
                    setCurrentFolderId(folder.id)
                    resetSelection()
                  }}
                  className="hover:text-text-primary transition-colors"
                  data-testid={`breadcrumb-folder-${folder.id}`}
                >
                  {folder.name}
                </button>
              ) : (
                <span className="text-text-primary font-medium">{folder.name}</span>
              )}
            </span>
          ))}
        </div>
      )}

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
                        setSearchQuery('')
                        setShowSearchPopover(false)
                      }
                    }}
                    onBlur={() => {
                      // Delay to allow click events to fire before closing popover
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

        {/* Create folder button */}
        {canManageFolderStructure && (
          <Button
            variant="outline"
            className="h-11 min-w-[44px]"
            onClick={() => handleCreateFolder(currentFolderId)}
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

          {/* Compact mode: Card layout */}
          {compact ? (
            <div className="space-y-2">
              {/* Select all control bar for notebook mode */}
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
                folders={directFolders}
                documents={documents}
                compact={true}
                onViewDetail={setViewingDoc}
                onEdit={setEditingDoc}
                onDelete={setDeletingDoc}
                onRefresh={handleRefreshWebDocument}
                onReindex={handleReindexDocument}
                onReanalyze={setReanalyzeDoc}
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
                activeFolderId={isExpandAllView ? undefined : currentFolderId}
                onActivateFolder={isExpandAllView ? undefined : handleNavigateIntoFolder}
              />
              {paginationEnabled && !isExpandAllView && (
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
            </div>
          ) : (
            /* Normal mode: Table layout with folder tree - single bordered container */
            <div className="border border-border rounded-lg overflow-x-auto">
              <KnowledgeDocumentTreeGrid
                nodes={resourceTree.nodes}
                treeIndex={resourceTree.index}
                folders={directFolders}
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
                selectAllLabel={t('document.document.batch.selectCurrentPage')}
                onViewDetail={setViewingDoc}
                onEdit={setEditingDoc}
                onDelete={setDeletingDoc}
                onRefresh={handleRefreshWebDocument}
                onReindex={handleReindexDocument}
                onReanalyze={setReanalyzeDoc}
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
                activeFolderId={isExpandAllView ? undefined : currentFolderId}
                onActivateFolder={isExpandAllView ? undefined : handleNavigateIntoFolder}
                expandAllFolders={isExpandAllView}
              />
              {/* Pagination bar for classic mode */}
              {paginationEnabled && !isExpandAllView && (
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
            </div>
          )}
        </>
      ) : searchQuery || currentFolderId !== 0 ? (
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
        multimodalAnalysisEnabled={knowledgeBase.multimodal_analysis_enabled}
        multimodalModelSupportsVideo={modelSupportsVideo}
        multimodalVideoPrompt={knowledgeBase.multimodal_analysis_video_prompt}
        multimodalImagePrompt={knowledgeBase.multimodal_analysis_image_prompt}
      />

      <ReanalyzeMultimodalDialog
        open={!!reanalyzeDoc}
        onOpenChange={open => !open && setReanalyzeDoc(null)}
        document={reanalyzeDoc}
        kbVideoPrompt={knowledgeBase.multimodal_analysis_video_prompt}
        kbImagePrompt={knowledgeBase.multimodal_analysis_image_prompt}
        onReanalyzed={() => {
          // Immediately refresh so the doc's new PENDING_CONVERSION status lands
          // in `documents` and kicks off the active-indexing poll (same mechanism
          // as reindex). The poll then keeps the UI in sync through CONVERTING →
          // INDEXING → terminal state during the 1–2 min Gemini re-analysis.
          if (isMountedRef.current) refresh()
        }}
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
