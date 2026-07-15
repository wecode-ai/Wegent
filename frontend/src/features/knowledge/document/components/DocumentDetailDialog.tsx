// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import {
  FileText,
  Copy,
  Check,
  Pencil,
  X,
  Save,
  Eye,
  Code,
  Download,
  Maximize2,
  Minimize2,
} from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
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
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useDocumentDetail } from '../hooks/useDocumentDetail'
import { ChunksSection } from './ChunksSection'
import { DocumentSummarySection } from './DocumentSummarySection'
import { DocumentContentViewer } from './DocumentContentViewer'
import { KnowledgeSourcePreview } from './KnowledgeSourcePreview'
import { downloadAttachment, formatFileSize } from '@/apis/attachments'
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
import { parseUTCDate } from '@/lib/utils'
import { isDocumentEditable } from '../utils/documentUtils'
import { isKnowledgeSourcePreviewSupported } from '../utils/sourcePreview'

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
}: DocumentDetailDialogProps) {
  const { t, getCurrentLanguage } = useTranslation('knowledge')
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
    document && isKnowledgeSourcePreviewSupported(document) ? 'source' : 'parsed'
  )
  const [isSummaryOpen, setIsSummaryOpen] = useState(contentSourceMode === 'parsed')
  const summaryManuallyToggledRef = useRef(false)
  const [openedDocumentId, setOpenedDocumentId] = useState<number | null>(
    open ? (document?.id ?? null) : null
  )
  // Fullscreen mode for editing
  const [isFullscreen, setIsFullscreen] = useState(false)
  // Chunk storage configuration - controls whether chunks section is visible
  const [chunkStorageEnabled, setChunkStorageEnabled] = useState(false)

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
    () => isDocumentEditable(document?.source_type, document?.file_extension, canEdit),
    [document?.source_type, document?.file_extension, canEdit]
  )
  const canPreviewSource = useMemo(
    () => Boolean(document && isKnowledgeSourcePreviewSupported(document)),
    [document]
  )
  const isSourceView = contentSourceMode === 'source' && canPreviewSource

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
    ? `${typeof window !== 'undefined' ? window.location.origin : ''}${buildKbUrl(knowledgeBaseNamespace, knowledgeBaseName, isOrganization, document.name)}`
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

  const handleSourceDownload = useCallback(async () => {
    if (!document?.attachment_id) return
    try {
      await downloadAttachment(document.attachment_id, document.name)
    } catch {
      toast.error(t('document.document.detail.sourcePreview.downloadFailed'))
    }
  }, [document?.attachment_id, document?.name, t])

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
              <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                <div className="flex min-w-0 items-start gap-3">
                  <div className="mt-0.5 flex-shrink-0 rounded-lg bg-primary/10 p-2">
                    <FileText className="h-5 w-5 text-primary" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <DialogTitle className="truncate text-base font-medium text-text-primary">
                      {document.name}
                    </DialogTitle>
                    {!isFullscreen && (
                      <DialogDescription className="mt-1 flex items-center gap-2 text-xs text-text-muted">
                        <span>{document.file_extension.toUpperCase()}</span>
                        <span>•</span>
                        <span>{formatFileSize(document.file_size)}</span>
                        <span>•</span>
                        <span>
                          {new Date(document.created_at).toLocaleDateString(getCurrentLanguage(), {
                            year: 'numeric',
                            month: '2-digit',
                            day: '2-digit',
                          })}
                        </span>
                      </DialogDescription>
                    )}
                  </div>
                </div>

                <div className="flex flex-shrink-0 items-center gap-2 max-md:w-full">
                  {!isFullscreen && !isEditing && canPreviewSource && (
                    <Tabs
                      value={contentSourceMode}
                      onValueChange={value => {
                        const nextMode = value as 'parsed' | 'source'
                        setContentSourceMode(nextMode)
                        setIsFullscreen(false)
                        if (!summaryManuallyToggledRef.current) {
                          setIsSummaryOpen(nextMode === 'parsed')
                        }
                      }}
                      className="max-md:flex-1"
                    >
                      <TabsList className="h-8 max-md:grid max-md:h-11 max-md:w-full max-md:grid-cols-2">
                        <TabsTrigger
                          value="source"
                          className="h-7 px-3 text-xs max-md:min-h-[44px]"
                          data-testid="knowledge-document-source-tab"
                        >
                          {t('document.document.detail.sourceFile')}
                        </TabsTrigger>
                        <TabsTrigger
                          value="parsed"
                          className="h-7 px-3 text-xs max-md:min-h-[44px]"
                          data-testid="knowledge-document-parsed-tab"
                        >
                          {t('document.document.detail.parsedContent')}
                        </TabsTrigger>
                      </TabsList>
                    </Tabs>
                  )}

                  {isSourceView && (
                    <>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={handleSourceDownload}
                        className="max-md:min-h-[44px] max-md:min-w-[44px]"
                        aria-label={t('document.document.detail.sourcePreview.download')}
                        data-testid="knowledge-source-preview-download"
                      >
                        <Download className="h-3.5 w-3.5" />
                        <span className="hidden md:inline">
                          {t('document.document.detail.sourcePreview.download')}
                        </span>
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setIsFullscreen(!isFullscreen)}
                        className="max-md:min-h-[44px] max-md:min-w-[44px]"
                        aria-label={
                          isFullscreen
                            ? t('document.document.detail.exitFullscreen')
                            : t('document.document.detail.fullscreen')
                        }
                        data-testid="knowledge-source-preview-fullscreen"
                      >
                        {isFullscreen ? (
                          <Minimize2 className="h-3.5 w-3.5" />
                        ) : (
                          <Maximize2 className="h-3.5 w-3.5" />
                        )}
                      </Button>
                    </>
                  )}
                </div>
              </div>
            </DialogHeader>
          )}

          {/* Content */}
          <div
            className={cn(
              'flex-1 min-h-0 px-6 py-4',
              isSourceView || (isEditing && isFullscreen)
                ? 'flex flex-col overflow-hidden'
                : 'overflow-y-auto',
              isEditing && !isFullscreen && 'flex flex-col'
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

            {isSourceView ? (
              <KnowledgeSourcePreview
                document={document}
                active={open && isSourceView}
                onDownload={handleSourceDownload}
              />
            ) : loading ? (
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
                              {formatDateTime(parseUTCDate(document.updated_at)?.getTime())}
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
                            {documentFullUrl && (
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
                            {fullContent && (
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
