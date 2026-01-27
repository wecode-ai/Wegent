// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useCallback, useEffect, useMemo } from 'react'
import {
  FileText,
  RefreshCw,
  Copy,
  Check,
  Pencil,
  X,
  Save,
  Eye,
  Code,
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
import { useDocumentDetail } from '../hooks/useDocumentDetail'
import { knowledgeBaseApi } from '@/apis/knowledge-base'
import type { KnowledgeDocument } from '@/types/knowledge'
import { useTranslation } from '@/hooks/useTranslation'
import { toast } from 'sonner'
import dynamic from 'next/dynamic'
import { useTheme } from '@/features/theme/ThemeProvider'
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

// Dynamically import EnhancedMarkdown for markdown preview
const EnhancedMarkdown = dynamic(() => import('@/components/common/EnhancedMarkdown'), {
  ssr: false,
  loading: () => (
    <div className="min-h-[100px] animate-pulse rounded-lg bg-surface flex items-center justify-center">
      <Spinner />
    </div>
  ),
})

/**
 * Check if content contains markdown syntax
 * Returns true if the content appears to be markdown
 */
function containsMarkdownSyntax(content: string): boolean {
  if (!content) return false

  // Check for common markdown patterns
  // Note: Table separator regex uses string concatenation to avoid Tailwind CSS
  // scanner misinterpreting the pattern as an arbitrary value class
  const markdownPatterns = [
    /^#{1,6}\s+.+$/m, // Headers: # Header
    /\*\*[^*]+\*\*/, // Bold: **text**
    /\*[^*]+\*/, // Italic: *text*
    /__[^_]+__/, // Bold: __text__
    /_[^_]+_/, // Italic: _text_
    /\[.+\]\(.+\)/, // Links: [text](url)
    /!\[.*\]\(.+\)/, // Images: ![alt](url)
    /^[-*+]\s+.+$/m, // Unordered lists: - item or * item
    /^\d+\.\s+.+$/m, // Ordered lists: 1. item
    /^>\s+.+$/m, // Blockquotes: > quote
    /`[^`]+`/, // Inline code: `code`
    /^```[\s\S]*?```$/m, // Code blocks: ```code```
    /^\|.+\|$/m, // Tables: | col1 | col2 |
    // Table separators: |---|---| - split pattern to avoid Tailwind scanner
    new RegExp('^' + '[-' + ':]+\\|' + '[-' + ':|\\s]+$', 'm'),
    /^---+$/m, // Horizontal rules: ---
    /^\*\*\*+$/m, // Horizontal rules: ***
  ]

  return markdownPatterns.some(pattern => pattern.test(content))
}

/**
 * Check if file extension indicates markdown content
 */
function isMarkdownFileExtension(extension: string | undefined): boolean {
  if (!extension) return false
  const mdExtensions = ['md', 'markdown', 'mdx', 'mdown', 'mkd', 'mkdn']
  return mdExtensions.includes(extension.toLowerCase())
}

interface DocumentDetailDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  document: KnowledgeDocument | null
  knowledgeBaseId: number
  /** Knowledge base type - edit is only available for 'notebook' type */
  kbType?: 'notebook' | 'classic'
}

export function DocumentDetailDialog({
  open,
  onOpenChange,
  document,
  knowledgeBaseId,
  kbType,
}: DocumentDetailDialogProps) {
  const { t, getCurrentLanguage } = useTranslation('knowledge')
  const { theme } = useTheme()
  const [copiedContent, setCopiedContent] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const [editedContent, setEditedContent] = useState('')
  const [isSaving, setIsSaving] = useState(false)
  const [showDiscardDialog, setShowDiscardDialog] = useState(false)
  // View mode: 'preview' for markdown rendering, 'raw' for plain text
  const [viewMode, setViewMode] = useState<'preview' | 'raw'>('preview')
  // Fullscreen mode for editing
  const [isFullscreen, setIsFullscreen] = useState(false)

  const { detail, loading, error, refresh } = useDocumentDetail({
    kbId: knowledgeBaseId,
    docId: document?.id || 0,
    enabled: open && !!document,
  })

  // Check if document is editable (only for notebook type knowledge base, and TEXT type or plain text files)
  const isEditable =
    kbType === 'notebook' &&
    (document?.source_type === 'text' ||
      (document?.source_type === 'file' &&
        ['txt', 'md', 'markdown'].includes(document?.file_extension?.toLowerCase() || '')))

  // Track if content has changed
  const hasChanges = editedContent !== (detail?.content || '')

  // Check if content should be rendered as markdown (based on file extension or content detection)
  const isMarkdownContent = useMemo(() => {
    if (!detail?.content) return false
    return (
      isMarkdownFileExtension(document?.file_extension) || containsMarkdownSyntax(detail.content)
    )
  }, [detail?.content, document?.file_extension])

  // Reset editing state when dialog closes or document changes
  useEffect(() => {
    if (!open) {
      setIsEditing(false)
      setEditedContent('')
      setIsFullscreen(false)
    }
  }, [open])

  // Reset fullscreen when exiting edit mode
  useEffect(() => {
    if (!isEditing) {
      setIsFullscreen(false)
    }
  }, [isEditing])

  // Initialize edited content when entering edit mode
  useEffect(() => {
    if (isEditing && detail?.content) {
      setEditedContent(detail.content)
    }
  }, [isEditing, detail?.content])

  const handleCopyContent = async () => {
    if (!detail?.content) return
    try {
      await navigator.clipboard.writeText(detail.content)
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

  const handleEdit = () => {
    setEditedContent(detail?.content || '')
    setIsEditing(true)
  }

  const handleSave = async () => {
    if (!document) return

    setIsSaving(true)
    try {
      await knowledgeBaseApi.updateDocumentContent(document.id, editedContent)
      toast.success(t('document.document.detail.saveSuccess'))
      setIsEditing(false)
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
      if (!document) return

      setIsSaving(true)
      try {
        await knowledgeBaseApi.updateDocumentContent(document.id, content)
        // Update local state to match saved content
        setEditedContent(content)
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
    [document, t, refresh]
  )

  const handleCancel = useCallback(() => {
    if (hasChanges) {
      setShowDiscardDialog(true)
    } else {
      setIsEditing(false)
    }
  }, [hasChanges])

  const handleDiscardChanges = () => {
    setShowDiscardDialog(false)
    setIsEditing(false)
    setEditedContent('')
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
              : 'max-w-4xl max-h-[85vh]'
          )}
          hideCloseButton={isFullscreen}
          preventEscapeClose={isEditing}
          preventOutsideClick={true}
        >
          {/* Header - hidden in fullscreen mode */}
          {!isFullscreen && (
            <DialogHeader className="px-6 py-4 border-b border-border flex-shrink-0">
              <div className="flex items-start gap-3">
                <div className="p-2 bg-primary/10 rounded-lg flex-shrink-0 mt-0.5">
                  <FileText className="w-5 h-5 text-primary" />
                </div>
                <div className="flex-1 min-w-0">
                  <DialogTitle className="text-base font-medium text-text-primary truncate">
                    {document.name}
                  </DialogTitle>
                  <DialogDescription className="flex items-center gap-2 mt-1 text-xs text-text-muted">
                    <span>{document.file_extension.toUpperCase()}</span>
                    <span>•</span>
                    <span>
                      {new Date(document.created_at).toLocaleDateString(getCurrentLanguage(), {
                        year: 'numeric',
                        month: '2-digit',
                        day: '2-digit',
                      })}
                    </span>
                  </DialogDescription>
                </div>
              </div>
            </DialogHeader>
          )}

          {/* Content */}
          <div
            className={cn(
              'flex-1 px-6 py-4',
              isEditing && isFullscreen ? 'flex flex-col overflow-hidden' : 'overflow-y-auto',
              isEditing && !isFullscreen && 'flex flex-col'
            )}
          >
            {loading ? (
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
                {/* Summary Section - only show when not editing */}
                {!isEditing && detail?.summary && (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <h3 className="text-sm font-medium text-text-primary">
                        {t('document.document.detail.summary')}
                      </h3>
                      <Button variant="ghost" size="sm" onClick={handleRefresh}>
                        <RefreshCw className="w-3.5 h-3.5" />
                      </Button>
                    </div>

                    {/* Summary Status */}
                    {detail.summary.status && (
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-text-muted">
                          {t('document.document.detail.status')}:
                        </span>
                        <Badge
                          variant={
                            detail.summary.status === 'completed'
                              ? 'success'
                              : detail.summary.status === 'generating'
                                ? 'warning'
                                : 'default'
                          }
                          size="sm"
                        >
                          {t(`document.document.detail.statusValues.${detail.summary.status}`)}
                        </Badge>
                      </div>
                    )}

                    {/* Short Summary */}
                    {detail.summary.short_summary && (
                      <div className="p-3 bg-surface rounded-lg">
                        <p className="text-sm text-text-primary">{detail.summary.short_summary}</p>
                      </div>
                    )}

                    {/* Long Summary */}
                    {detail.summary.long_summary && (
                      <div className="p-3 bg-surface rounded-lg">
                        <p className="text-sm text-text-secondary leading-relaxed whitespace-pre-wrap">
                          {detail.summary.long_summary}
                        </p>
                      </div>
                    )}

                    {/* Topics */}
                    {detail.summary.topics && detail.summary.topics.length > 0 && (
                      <div className="space-y-2">
                        <span className="text-xs text-text-muted">
                          {t('document.document.detail.topics')}:
                        </span>
                        <div className="flex flex-wrap gap-2">
                          {detail.summary.topics.map((topic, index) => (
                            <Badge key={index} variant="secondary" size="sm">
                              {topic}
                            </Badge>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* Content Section */}
                {detail?.content !== undefined && (
                  <div
                    className={cn(
                      isEditing && isFullscreen ? 'flex-1 flex flex-col h-full' : 'space-y-3',
                      isEditing && !isFullscreen && 'space-y-3 flex-1 flex flex-col'
                    )}
                  >
                    <div className="flex items-center justify-between flex-shrink-0">
                      {/* Content title - hidden in fullscreen mode */}
                      {!isFullscreen && (
                        <h3 className="text-sm font-medium text-text-primary">
                          {t('document.document.detail.content')}
                        </h3>
                      )}
                      {/* In fullscreen mode, show document name instead */}
                      {isFullscreen && (
                        <span className="text-sm font-medium text-text-primary truncate max-w-[50%]">
                          {document.name}
                        </span>
                      )}
                      <div className="flex items-center gap-2">
                        {!isEditing && detail.truncated && (
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
                            {/* View mode toggle - only show when content is markdown */}
                            {isMarkdownContent && detail.content && (
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
                            {isEditable && (
                              <Button variant="outline" size="sm" onClick={handleEdit}>
                                <Pencil className="w-3.5 h-3.5 mr-1" />
                                {t('document.document.detail.edit')}
                              </Button>
                            )}
                            {detail.content && (
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
                        />
                      </div>
                    ) : detail.content ? (
                      <div className="p-4 bg-white rounded-lg border border-border">
                        {/* Use markdown preview if content is markdown and viewMode is preview */}
                        {isMarkdownContent && viewMode === 'preview' ? (
                          <EnhancedMarkdown source={detail.content} theme={theme} />
                        ) : (
                          <pre className="text-xs text-text-secondary whitespace-pre-wrap break-words font-mono leading-relaxed">
                            {detail.content}
                          </pre>
                        )}
                        {detail.content_length !== undefined && (
                          <div className="mt-3 pt-3 border-t border-border text-xs text-text-muted">
                            {t('document.document.detail.contentLength')}:{' '}
                            {detail.content_length.toLocaleString()}{' '}
                            {t('document.document.detail.characters')}
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="p-4 bg-surface rounded-lg border border-border text-center text-sm text-text-muted">
                        {t('document.document.detail.noContent')}
                      </div>
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
