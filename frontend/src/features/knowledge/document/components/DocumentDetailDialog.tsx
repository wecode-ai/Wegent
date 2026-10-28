// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import {
  Copy,
  Check,
  Pencil,
  X,
  Save,
  Eye,
  Code,
  Maximize2,
  Minimize2,
  CircleAlert,
} from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { Dialog, DialogContent, DialogHeader } from '@/components/ui/dialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Spinner } from '@/components/ui/spinner'
import { useDocumentDetail } from '../hooks/useDocumentDetail'
import { ChunksSection } from './ChunksSection'
import { DocumentSummarySection } from './DocumentSummarySection'
import { DocumentContentViewer } from './DocumentContentViewer'
import { KnowledgeSourcePreview } from './KnowledgeSourcePreview'
import { getProcessingErrorMessage } from '../utils/processing-error'
import { knowledgeBaseApi } from '@/apis/knowledge-base'
import { getKnowledgeConfig } from '@/apis/knowledge'
import { buildKbUrl } from '@/utils/knowledgeUrl'
import type { KnowledgeDocument } from '@/types/knowledge'
import { useTranslation } from '@/hooks/useTranslation'
import { toast } from 'sonner'
import dynamic from 'next/dynamic'
import {
  getEditorLanguage,
  formatJsonContent,
  isJsonFileExtension,
} from '@/utils/languageDetection'
import { formatDateTime } from '@/utils/dateTime'
import {
  isDocumentEditable,
  isDocumentIndexInFlight,
  isDingtalkCopyDocument,
} from '../utils/documentUtils'
import { isKnowledgeSourcePreviewSupported } from '../utils/sourcePreview'
import { DocumentProtectionBoundary } from './DocumentProtectionBoundary'
import { useKnowledgeDocumentDownload } from '../hooks/useKnowledgeDocumentDownload'
import { useDingtalkSyncLabel } from '../hooks/useDingtalkSyncLabel'
import { useExternalDocumentSync } from '../hooks/useExternalDocumentSync'
import { DocumentDetailDialogHeader } from './DocumentDetailDialogHeader'

// Dynamically import the WYSIWYG editor to avoid SSR issues
const WysiwygEditor = dynamic(
  () => import('@/components/common/WysiwygEditor').then(mod => mod.WysiwygEditor),
  {
    ssr: false,
    loading: () => (
      <div className="min-h-[300px] animate-pulse rounded-lg bg-surface flex items-center justify-center">
        <Spinner />
      </div>
    ),
  }
)

interface DocumentDetailDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  document: KnowledgeDocument | null
  knowledgeBaseId: number
  /** Knowledge base type (reserved for future use) */
  kbType?: 'notebook' | 'classic'
  /** Whether the current user can edit this document */
  canEdit?: boolean
  /** Current knowledge base name - used for resolving cross-KB relative links */
  knowledgeBaseName?: string
  /** Current knowledge base namespace - used for resolving cross-namespace relative links */
  knowledgeBaseNamespace?: string
  /** Whether this KB belongs to an organization-level namespace (affects URL format) */
  isOrganization?: boolean
  /** Whether the KB may deliver original document files. */
  allowDownload?: boolean
  /** Server-supplied display text for the preview watermark. */
  watermarkText?: string | null
  /**
   * Refetch the owning document list after a manual source sync is queued.
   * Passing it opts this preview into the manual sync entry; surfaces without
   * a document list (for example the chat preview) omit it.
   */
  onDocumentSynced?: (document: KnowledgeDocument) => void
}

export function DocumentDetailDialog({
  open,
  onOpenChange,
  document,
  knowledgeBaseId,
  kbType: _kbType,
  canEdit = false,
  knowledgeBaseName = '',
  knowledgeBaseNamespace = 'default',
  isOrganization = false,
  allowDownload = true,
  watermarkText,
  onDocumentSynced,
}: DocumentDetailDialogProps) {
  const { t, getCurrentLanguage } = useTranslation('knowledge')
  const downloadDocument = useKnowledgeDocumentDownload()
  const { isSyncing: isDocumentSyncing, syncDocument } = useExternalDocumentSync()
  const getDingtalkSyncLabel = useDingtalkSyncLabel()
  const protectedPreview = !allowDownload
  const effectiveWatermarkText = watermarkText || t('document.document.detail.protectedWatermark')
  const [copiedContent, setCopiedContent] = useState(false)
  const [copiedLink, setCopiedLink] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const [editedContent, setEditedContent] = useState('')
  const [isSaving, setIsSaving] = useState(false)
  const [showDiscardDialog, setShowDiscardDialog] = useState(false)
  // Loading state for loading full content before editing
  const [isLoadingFullContent, setIsLoadingFullContent] = useState(false)
  // Ref to store the content at the start of editing for accurate change detection
  const editStartContentRef = useRef<string>('')
  // View mode: 'preview' for markdown rendering/formatted JSON, 'raw' for plain text
  const [viewMode, setViewMode] = useState<'preview' | 'raw'>('preview')
  const [contentSourceMode, setContentSourceMode] = useState<'parsed' | 'source'>(() =>
    document && allowDownload && isKnowledgeSourcePreviewSupported(document) ? 'source' : 'parsed'
  )
  const [isSummaryOpen, setIsSummaryOpen] = useState(contentSourceMode === 'parsed')
  const summaryManuallyToggledRef = useRef(false)
  const renderedDocumentVersionRef = useRef<string | null>(null)
  const [openedDocumentId, setOpenedDocumentId] = useState<number | null>(
    open ? (document?.id ?? null) : null
  )
  // Fullscreen mode for editing
  const [isFullscreen, setIsFullscreen] = useState(false)
  // Chunk storage configuration - controls whether chunks section is visible
  const [chunkStorageEnabled, setChunkStorageEnabled] = useState(false)
  // Extraction guards apply to the read-only protected preview, never the editor.
  const protectedContent = protectedPreview && !isEditing

  // Fetch knowledge config on mount to check if chunk storage is enabled
  useEffect(() => {
    getKnowledgeConfig()
      .then(config => {
        setChunkStorageEnabled(config.chunk_storage_enabled)
      })
      .catch(() => {
        // If config fetch fails, default to hiding chunks section
        setChunkStorageEnabled(false)
      })
  }, [])

  const {
    detail,
    loading,
    error,
    refresh,
    loadingMore,
    hasMoreContent,
    fullContent,
    loadMore,
    loadAllContent,
  } = useDocumentDetail({
    kbId: knowledgeBaseId,
    docId: document?.id || 0,
    enabled: open && !!document,
  })

  // Check if document is editable
  const isEditable = useMemo(
    // Editing loads the full raw document into an editable view, which would
    // bypass the download protection of a protected knowledge base. Hide the
    // edit entry whenever original-file download is not allowed.
    () =>
      allowDownload && isDocumentEditable(document?.source_type, document?.file_extension, canEdit),
    [allowDownload, document?.source_type, document?.file_extension, canEdit]
  )
  const canPreviewSource = useMemo(
    () => Boolean(document && allowDownload && isKnowledgeSourcePreviewSupported(document)),
    [allowDownload, document]
  )
  const isSourceView = contentSourceMode === 'source' && canPreviewSource
  // Manual source refresh of a DingTalk copy: the same entry the document list
  // offers, so the preview can queue it without leaving the dialog.
  const canSyncSource =
    !!onDocumentSynced && canEdit && !!document && isDingtalkCopyDocument(document)
  const sourceSyncBusy =
    !!document && (isDocumentSyncing(document.id) || isDocumentIndexInFlight(document))
  const sourceSyncLabel = document ? getDingtalkSyncLabel(document, sourceSyncBusy) : ''

  // Track if content has changed (compare against content at edit start)
  const hasChanges = editedContent !== (editStartContentRef.current || fullContent || '')

  // Reset before rendering children on each open cycle or document switch.
  const activeDocumentId = open ? (document?.id ?? null) : null
  if (openedDocumentId !== activeDocumentId) {
    setOpenedDocumentId(activeDocumentId)
    if (activeDocumentId !== null) {
      const nextContentSourceMode = canPreviewSource ? 'source' : 'parsed'
      setIsEditing(false)
      setEditedContent('')
      setIsFullscreen(false)
      setContentSourceMode(nextContentSourceMode)
      summaryManuallyToggledRef.current = false
      setIsSummaryOpen(nextContentSourceMode === 'parsed')
    }
  }

  // Build the full accessible URL using virtual path
  const documentFullUrl = document
    ? `${typeof window !== 'undefined' ? window.location.origin : ''}${buildKbUrl(knowledgeBaseNamespace, knowledgeBaseName, isOrganization, document.name)}?documentId=${document.id}`
    : null

  const handleCopyLink = async () => {
    if (!documentFullUrl) return
    try {
      await navigator.clipboard.writeText(documentFullUrl)
      setCopiedLink(true)
      toast.success(t('document.document.detail.copyLinkSuccess', { defaultValue: 'Link copied' }))
      setTimeout(() => setCopiedLink(false), 2000)
    } catch {
      toast.error(
        t('document.document.detail.copyLinkError', { defaultValue: 'Failed to copy link' })
      )
    }
  }

  const handleCopyContent = async () => {
    const contentToCopy = fullContent
    if (!contentToCopy) return
    try {
      await navigator.clipboard.writeText(contentToCopy)
      setCopiedContent(true)
      toast.success(t('document.document.detail.copySuccess'))
      setTimeout(() => setCopiedContent(false), 2000)
    } catch {
      toast.error(t('document.document.detail.copyError'))
    }
  }

  const handleRefresh = () => {
    refresh()
  }

  const handleSourceSync = useCallback(async () => {
    if (!document) return
    // A failed request keeps the existing copy and reports the reason through
    // the shared entry, so the preview only reacts to a queued refresh.
    const synchronizedDocument = await syncDocument(document)
    if (!synchronizedDocument) return
    onDocumentSynced?.(synchronizedDocument)
  }, [document, onDocumentSynced, syncDocument])

  useEffect(() => {
    if (!open || !document) {
      renderedDocumentVersionRef.current = null
      return
    }
    const version = `${document.id}:${document.index_generation}:${document.index_status}:${document.updated_at}`
    const previousVersion = renderedDocumentVersionRef.current
    renderedDocumentVersionRef.current = version
    if (previousVersion && previousVersion !== version && document.index_status === 'success') {
      void refresh()
    }
  }, [document, open, refresh])

  const handleSourceDownload = useCallback(async () => {
    if (!allowDownload) return
    if (!document) return
    try {
      await downloadDocument(document)
    } catch {
      toast.error(t('document.document.detail.sourcePreview.downloadFailed'))
    }
  }, [allowDownload, document, downloadDocument, t])

  const handleEdit = useCallback(async () => {
    if (!isEditable) return

    // If there's more content to load, load it first before editing
    let contentToEdit = fullContent || ''
    if (hasMoreContent) {
      setIsLoadingFullContent(true)
      try {
        const result = await loadAllContent()
        if (result) {
          // Use fresh values from result to avoid stale closure issues
          if (result.hasMore || result.loading) {
            // Content is still incomplete, bail out without opening editor
            return
          }
          contentToEdit = result.content
        }
      } finally {
        setIsLoadingFullContent(false)
      }
    }

    // Format JSON content for editing to match preview formatting
    if (document?.file_extension && isJsonFileExtension(document.file_extension)) {
      const formatted = formatJsonContent(contentToEdit)
      if (formatted) {
        contentToEdit = formatted
      }
    }

    setEditedContent(contentToEdit)

    // Store the content at edit start for accurate change detection
    editStartContentRef.current = contentToEdit
    setIsEditing(true)
  }, [document?.file_extension, isEditable, hasMoreContent, loadAllContent, fullContent])

  const handleSave = async () => {
    if (!document || !isEditable) return

    setIsSaving(true)
    try {
      await knowledgeBaseApi.updateDocumentContent(document.id, editedContent)
      toast.success(t('document.document.detail.saveSuccess'))
      setIsEditing(false)
      setIsFullscreen(false)
      // Refresh to get the updated content
      refresh()
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : t('document.document.detail.saveFailed')
      toast.error(errorMessage)
    } finally {
      setIsSaving(false)
    }
  }

  // Handle save from Vim :w command - receives content from WysiwygEditor
  const handleVimSave = useCallback(
    async (content: string) => {
      if (!document || !isEditable) return

      setIsSaving(true)
      try {
        await knowledgeBaseApi.updateDocumentContent(document.id, content)
        // Update local state to match saved content
        setEditedContent(content)
        // Update the edit start content ref so hasChanges becomes false
        editStartContentRef.current = content
        toast.success(t('document.document.detail.saveSuccess'))
        // Refresh to get the updated content
        refresh()
      } catch (err) {
        const errorMessage =
          err instanceof Error ? err.message : t('document.document.detail.saveFailed')
        toast.error(errorMessage)
      } finally {
        setIsSaving(false)
      }
    },
    [document, isEditable, t, refresh]
  )

  const handleCancel = useCallback(() => {
    if (hasChanges) {
      setShowDiscardDialog(true)
    } else {
      setIsEditing(false)
      setIsFullscreen(false)
    }
  }, [hasChanges])

  const handleDiscardChanges = () => {
    setShowDiscardDialog(false)
    setIsEditing(false)
    setIsFullscreen(false)
    setEditedContent('')
    editStartContentRef.current = ''
  }

  const handleContentChange = useCallback((content: string) => {
    setEditedContent(content)
  }, [])

  if (!document) return null

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          className={cn(
            'flex flex-col p-0',
            isFullscreen
              ? 'max-w-[100vw] w-[100vw] max-h-[100vh] h-[100vh] rounded-none'
              : canPreviewSource
                ? 'max-w-6xl w-[96vw] max-h-[90vh] h-[90vh]'
                : 'max-w-4xl max-h-[85vh]'
          )}
          hideCloseButton={isFullscreen}
          preventEscapeClose={isEditing || isFullscreen}
          preventOutsideClick={true}
        >
          {/* Keep source controls available so fullscreen always has an exit path. */}
          {(!isFullscreen || isSourceView) && (
            <DialogHeader
              className={cn(
                'flex-shrink-0 border-b border-border',
                isFullscreen ? 'px-4 py-2' : 'py-4 pl-6 pr-12'
              )}
            >
              <DocumentDetailDialogHeader
                document={document}
                isFullscreen={isFullscreen}
                canSyncSource={canSyncSource}
                sourceSyncBusy={sourceSyncBusy}
                sourceSyncLabel={sourceSyncLabel}
                onSourceSync={handleSourceSync}
                canPreviewSource={canPreviewSource}
                isSourceView={isSourceView}
                isEditing={isEditing}
                contentSourceMode={contentSourceMode}
                onContentSourceModeChange={nextMode => {
                  setContentSourceMode(nextMode)
                  setIsFullscreen(false)
                  if (!summaryManuallyToggledRef.current) {
                    setIsSummaryOpen(nextMode === 'parsed')
                  }
                }}
                onToggleFullscreen={() => setIsFullscreen(!isFullscreen)}
                allowDownload={allowDownload}
                onSourceDownload={handleSourceDownload}
                getCurrentLanguage={getCurrentLanguage}
              />
            </DialogHeader>
          )}

          {!isFullscreen && document.processing_error && (
            <div
              className="mx-6 mt-4 flex gap-2 rounded-md border border-error/30 bg-error/5 p-3 text-sm"
              data-testid={`document-processing-error-detail-${document.id}`}
            >
              <CircleAlert className="mt-0.5 h-4 w-4 flex-none text-error" />
              <div className="min-w-0">
                <p className="font-medium text-error">
                  {t(`document.document.processingError.stage.${document.processing_error.stage}`)}
                </p>
                <p className="mt-1 break-words text-text-secondary">
                  {getProcessingErrorMessage(document.processing_error, t)}
                </p>
                {document.processing_error.model && (
                  <p className="mt-1 text-xs text-text-muted">
                    {t('document.document.processingError.model')}:{' '}
                    {document.processing_error.model}
                  </p>
                )}
              </div>
            </div>
          )}

          {/* Content */}
          <div
            className={cn(
              'flex-1 min-h-0 px-6 py-4',
              isSourceView || (isEditing && isFullscreen)
                ? 'flex flex-col overflow-hidden'
                : 'overflow-y-auto',
              isEditing && !isFullscreen && 'flex flex-col',
              protectedContent && 'select-none'
            )}
          >
            {!isEditing && !isFullscreen && detail?.summary && (
              <DocumentSummarySection
                summary={detail.summary}
                onRefresh={handleRefresh}
                open={isSummaryOpen}
                onOpenChange={nextOpen => {
                  summaryManuallyToggledRef.current = true
                  setIsSummaryOpen(nextOpen)
                }}
                className="mb-4 flex-shrink-0"
                contentClassName={isSourceView ? 'max-h-[35vh] overflow-y-auto pr-1' : undefined}
              />
            )}

            {canPreviewSource && (
              <KnowledgeSourcePreview
                key={`${document.id}:${document.attachment_id}`}
                document={document}
                active={open}
                onDownload={handleSourceDownload}
                className={cn(!isSourceView && 'hidden')}
              />
            )}

            {isSourceView ? null : loading ? (
              <div className="flex items-center justify-center py-12">
                <Spinner />
              </div>
            ) : error ? (
              <div className="flex flex-col items-center justify-center py-12 text-text-secondary">
                <p className="mb-4">{error}</p>
                <Button variant="outline" onClick={handleRefresh}>
                  {t('common:actions.retry')}
                </Button>
              </div>
            ) : (
              <div
                className={cn(
                  isEditing && isFullscreen ? 'flex-1 flex flex-col h-full' : 'space-y-6',
                  isEditing && !isFullscreen && 'flex-1 flex flex-col space-y-6'
                )}
              >
                {/* Chunks Section - only show when not editing and chunk storage is enabled */}
                {!isEditing && document && chunkStorageEnabled && (
                  <ChunksSection documentId={document.id} enabled={open && !loading} />
                )}

                {/* Content Section */}
                {fullContent !== undefined && (
                  <div
                    className={cn(
                      isEditing && isFullscreen ? 'flex-1 flex flex-col h-full' : 'space-y-3',
                      isEditing && !isFullscreen && 'space-y-3 flex-1 flex flex-col'
                    )}
                  >
                    <div className="flex items-center justify-between flex-shrink-0">
                      {/* Content title - hidden in fullscreen mode */}
                      {!isFullscreen && (
                        <div className="flex items-center gap-2 min-w-0">
                          <h3 className="text-sm font-medium text-text-primary flex-shrink-0">
                            {t('document.document.detail.content')}
                          </h3>
                          {document.updated_at && (
                            <span className="text-xs text-text-muted truncate">
                              {t('document.document.detail.contentUpdatedAt')}:{' '}
                              {formatDateTime(new Date(document.updated_at).getTime())}
                            </span>
                          )}
                        </div>
                      )}
                      {/* In fullscreen mode, show document name instead */}
                      {isFullscreen && (
                        <span className="text-sm font-medium text-text-primary truncate max-w-[50%]">
                          {document.name}
                        </span>
                      )}
                      <div className="flex items-center gap-2">
                        {!isEditing && hasMoreContent && (
                          <Badge variant="warning" size="sm">
                            {t('document.document.detail.truncated')}
                          </Badge>
                        )}
                        {isEditing ? (
                          <>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() => setIsFullscreen(!isFullscreen)}
                                >
                                  {isFullscreen ? (
                                    <Minimize2 className="w-3.5 h-3.5" />
                                  ) : (
                                    <Maximize2 className="w-3.5 h-3.5" />
                                  )}
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>
                                {isFullscreen
                                  ? t('document.document.detail.exitFullscreen')
                                  : t('document.document.detail.fullscreen')}
                              </TooltipContent>
                            </Tooltip>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={handleCancel}
                              disabled={isSaving}
                            >
                              <X className="w-3.5 h-3.5 mr-1" />
                              {t('document.document.detail.cancel')}
                            </Button>
                            <Button size="sm" onClick={handleSave} disabled={isSaving}>
                              {isSaving ? (
                                <>
                                  <Spinner className="w-3.5 h-3.5 mr-1" />
                                  {t('document.document.detail.saving')}
                                </>
                              ) : (
                                <>
                                  <Save className="w-3.5 h-3.5 mr-1" />
                                  {t('document.document.detail.save')}
                                </>
                              )}
                            </Button>
                          </>
                        ) : (
                          <>
                            {/* View mode toggle - show for markdown or JSON content */}
                            {fullContent && (
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() =>
                                      setViewMode(viewMode === 'preview' ? 'raw' : 'preview')
                                    }
                                  >
                                    {viewMode === 'preview' ? (
                                      <Code className="w-3.5 h-3.5" />
                                    ) : (
                                      <Eye className="w-3.5 h-3.5" />
                                    )}
                                  </Button>
                                </TooltipTrigger>
                                <TooltipContent>
                                  {viewMode === 'preview'
                                    ? t('document.document.detail.viewRaw')
                                    : t('document.document.detail.viewPreview')}
                                </TooltipContent>
                              </Tooltip>
                            )}
                            {/* Copy link button - always visible in preview mode */}
                            {documentFullUrl && !protectedPreview && (
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={handleCopyLink}
                                    disabled={copiedLink}
                                  >
                                    {copiedLink ? (
                                      <Check className="w-3.5 h-3.5" />
                                    ) : (
                                      <svg
                                        className="w-3.5 h-3.5"
                                        viewBox="0 0 24 24"
                                        fill="none"
                                        stroke="currentColor"
                                        strokeWidth="2"
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                      >
                                        <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                                        <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                                      </svg>
                                    )}
                                  </Button>
                                </TooltipTrigger>
                                <TooltipContent>
                                  <p className="max-w-xs break-all">
                                    {copiedLink
                                      ? t('document.document.detail.copied')
                                      : documentFullUrl}
                                  </p>
                                </TooltipContent>
                              </Tooltip>
                            )}
                            {isEditable && (
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={handleEdit}
                                disabled={isLoadingFullContent || loadingMore}
                              >
                                {isLoadingFullContent || loadingMore ? (
                                  <>
                                    <Spinner className="w-3.5 h-3.5 mr-1" />
                                    {t('document.document.detail.loading', {
                                      defaultValue: 'Loading...',
                                    })}
                                  </>
                                ) : (
                                  <>
                                    <Pencil className="w-3.5 h-3.5 mr-1" />
                                    {t('document.document.detail.edit')}
                                  </>
                                )}
                              </Button>
                            )}
                            {fullContent && !protectedPreview && (
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={handleCopyContent}
                                disabled={copiedContent}
                              >
                                {copiedContent ? (
                                  <>
                                    <Check className="w-3.5 h-3.5 mr-1" />
                                    {t('document.document.detail.copied')}
                                  </>
                                ) : (
                                  <>
                                    <Copy className="w-3.5 h-3.5 mr-1" />
                                    {t('document.document.detail.copy')}
                                  </>
                                )}
                              </Button>
                            )}
                          </>
                        )}
                      </div>
                    </div>

                    {isEditing ? (
                      <div
                        className={cn(
                          'flex-1 flex flex-col',
                          isFullscreen ? 'h-full mt-3' : 'mt-3'
                        )}
                      >
                        <WysiwygEditor
                          initialContent={editedContent}
                          onChange={handleContentChange}
                          onSave={handleVimSave}
                          className={cn(isFullscreen ? 'flex-1' : 'min-h-[400px]')}
                          language={getEditorLanguage(document.file_extension)}
                        />
                      </div>
                    ) : (
                      <DocumentProtectionBoundary
                        enabled={protectedPreview}
                        knowledgeBaseId={knowledgeBaseId}
                        preferExtension={isOrganization}
                        watermarkText={effectiveWatermarkText}
                      >
                        <DocumentContentViewer
                          content={fullContent}
                          document={document}
                          knowledgeBaseId={knowledgeBaseId}
                          knowledgeBaseName={knowledgeBaseName}
                          knowledgeBaseNamespace={knowledgeBaseNamespace}
                          isOrganization={isOrganization}
                          viewMode={viewMode}
                          hasMoreContent={hasMoreContent}
                          loadingMore={loadingMore}
                          contentLength={detail?.content_length}
                          onLoadMore={loadMore}
                          onOpenChange={onOpenChange}
                        />
                      </DocumentProtectionBoundary>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Discard Changes Confirmation Dialog */}
      <AlertDialog open={showDiscardDialog} onOpenChange={setShowDiscardDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('document.document.detail.discardChanges')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('document.document.detail.unsavedChanges')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={handleDiscardChanges}>
              {t('document.document.detail.discardChanges')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
