// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useState, useCallback, useMemo, useEffect } from 'react'
import { X, ChevronDown, Paperclip, FileText, RefreshCw, Loader2, Database } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useToast } from '@/hooks/use-toast'
import {
  generateChatPdf,
  type ExportMessage,
  type ExportAttachment,
  type ExportKnowledgeBase,
} from '@/utils/pdf'
import { loadUnicodeFont } from '@/utils/pdf/font'
import { useTranslation } from '@/hooks/useTranslation'
import { getAttachmentPreviewUrl, isImageExtension } from '@/apis/attachments'
import { getToken } from '@/apis/user'
import { taskApis } from '@/apis/tasks'
import { subtaskApis } from '@/apis/subtasks'
import { formatDateTime } from '@/utils/dateTime'

/** Attachment info for selectable messages */
export interface SelectableAttachment {
  id: number
  filename: string
  file_size: number
  file_extension: string
}

/** Knowledge base info for selectable messages */
export interface SelectableKnowledgeBase {
  id: number
  name: string
  document_count?: number
}

export interface SelectableMessage {
  id: string | number
  type: 'user' | 'ai'
  content: string
  timestamp: number
  botName?: string
  userName?: string
  teamName?: string
  attachments?: SelectableAttachment[]
  knowledgeBases?: SelectableKnowledgeBase[]
}

export type ExportFormat = 'pdf' | 'docx' | 'markdown' | 'md'

interface ExportSelectModalProps {
  /** Whether the modal is open */
  open: boolean
  /** Callback when modal is closed */
  onClose: () => void
  /** All messages available for export */
  messages: SelectableMessage[]
  /** Task ID for DOCX export */
  taskId: number
  /** Task name for the export filename */
  taskName: string
  /** Export format */
  exportFormat: ExportFormat
}

/**
 * Export Selection Modal Component
 *
 * Provides a selection interface for users to choose which messages to export,
 * with options to select all, select from a specific message onwards,
 * and generate either PDF or DOCX.
 *
 * NOTE: This component fetches ALL messages from the backend when opened,
 * regardless of how many messages are currently loaded in the chat UI.
 * This ensures complete export of entire conversation history.
 */
export default function ExportSelectModal({
  open,
  onClose,
  messages: initialMessages,
  taskId,
  taskName,
  exportFormat,
}: ExportSelectModalProps) {
  const { t } = useTranslation('chat')
  const { toast } = useToast()

  // All messages for export (fetched from backend when modal opens)
  const [allMessages, setAllMessages] = useState<SelectableMessage[]>([])
  const [isLoadingAllMessages, setIsLoadingAllMessages] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  // Selection state
  const [selectedIds, setSelectedIds] = useState<Set<string | number>>(new Set())
  const [isExporting, setIsExporting] = useState(false)

  // Font loading state for PDF export
  const [isFontLoading, setIsFontLoading] = useState(false)
  const [fontLoadError, setFontLoadError] = useState(false)

  // Fetch all messages when modal opens
  useEffect(() => {
    if (!open || !taskId) {
      setAllMessages([])
      setLoadError(null)
      return
    }

    const controller = new AbortController()

    const fetchAllMessages = async () => {
      setIsLoadingAllMessages(true)
      setLoadError(null)

      try {
        // Fetch all messages from backend (use large limit to get all)
        const response = await subtaskApis.listSubtasks({
          taskId,
          limit: 10000, // Large limit to get all messages
          fromLatest: false, // Get in chronological order
        })

        // Check if aborted before updating state
        if (controller.signal.aborted) return

        // Convert subtasks to SelectableMessage format
        const messages: SelectableMessage[] = response.items.map(subtask => {
          const isUserMessage = subtask.role === 'USER' || subtask.role?.toUpperCase() === 'USER'
          const content = isUserMessage
            ? subtask.prompt || ''
            : typeof subtask.result?.value === 'string'
              ? subtask.result.value
              : ''

          // Extract attachments from contexts
          const attachments: SelectableAttachment[] = []
          const knowledgeBases: SelectableKnowledgeBase[] = []

          if (subtask.contexts && subtask.contexts.length > 0) {
            for (const ctx of subtask.contexts) {
              if (ctx.context_type === 'attachment') {
                attachments.push({
                  id: ctx.id,
                  filename: ctx.name,
                  file_size: ctx.file_size || 0,
                  file_extension: ctx.file_extension || '',
                })
              } else if (ctx.context_type === 'knowledge_base') {
                knowledgeBases.push({
                  id: ctx.id,
                  name: ctx.name,
                  document_count: ctx.document_count ?? undefined,
                })
              }
            }
          }

          // Fallback to legacy attachments field
          if (attachments.length === 0 && subtask.attachments && subtask.attachments.length > 0) {
            for (const att of subtask.attachments) {
              attachments.push({
                id: att.id,
                filename: att.filename,
                file_size: att.file_size,
                file_extension: att.file_extension,
              })
            }
          }

          return {
            id: subtask.id.toString(),
            type: isUserMessage ? 'user' : 'ai',
            content,
            timestamp: new Date(subtask.created_at).getTime(),
            botName: subtask.bots?.[0]?.name,
            userName: subtask.sender_user_name,
            attachments: attachments.length > 0 ? attachments : undefined,
            knowledgeBases: knowledgeBases.length > 0 ? knowledgeBases : undefined,
          } as SelectableMessage
        })

        // Filter out empty content messages
        const validMessages = messages.filter(msg => msg.content.trim() !== '')
        setAllMessages(validMessages)

        // Select all by default
        setSelectedIds(new Set(validMessages.map(msg => msg.id)))
      } catch (error) {
        // Check if aborted before updating state
        if (controller.signal.aborted) return

        console.error('[ExportSelectModal] Failed to fetch all messages:', error)
        setLoadError(error instanceof Error ? error.message : 'Failed to load messages')
        // Fallback to initial messages from props
        setAllMessages(initialMessages)
        setSelectedIds(new Set(initialMessages.map(msg => msg.id)))
      } finally {
        if (!controller.signal.aborted) {
          setIsLoadingAllMessages(false)
        }
      }
    }

    fetchAllMessages()

    return () => controller.abort()
  }, [open, taskId, initialMessages])

  // Use allMessages (fetched) or initialMessages (fallback)
  const messages = allMessages.length > 0 ? allMessages : initialMessages

  // Preload font when modal opens for PDF export
  useEffect(() => {
    if (open && exportFormat === 'pdf') {
      setIsFontLoading(true)
      setFontLoadError(false)
      loadUnicodeFont()
        .then(() => {
          setIsFontLoading(false)
        })
        .catch(() => {
          setIsFontLoading(false)
          setFontLoadError(true)
          toast({
            variant: 'destructive',
            title: t('export.font_load_failed'),
          })
        })
    }
  }, [open, exportFormat, toast, t])

  /**
   * Retry loading font if it failed
   */
  const handleRetryFontLoad = useCallback(() => {
    setIsFontLoading(true)
    setFontLoadError(false)
    loadUnicodeFont()
      .then(() => {
        setIsFontLoading(false)
      })
      .catch(() => {
        setIsFontLoading(false)
        setFontLoadError(true)
        toast({
          variant: 'destructive',
          title: t('export.font_load_failed'),
        })
      })
  }, [toast, t])

  /**
   * Toggle single message selection
   */
  const handleToggleMessage = useCallback((id: string | number) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }, [])

  /**
   * Select all messages from a specific index onwards
   */
  const handleSelectFromHere = useCallback(
    (startIndex: number) => {
      const idsToSelect = messages.slice(startIndex).map(msg => msg.id)
      setSelectedIds(prev => {
        const next = new Set(prev)
        idsToSelect.forEach(id => next.add(id))
        return next
      })
    },
    [messages]
  )

  /**
   * Select all messages
   */
  const handleSelectAll = useCallback(() => {
    setSelectedIds(new Set(messages.map(msg => msg.id)))
  }, [messages])

  /**
   * Deselect all messages
   */
  const handleDeselectAll = useCallback(() => {
    setSelectedIds(new Set())
  }, [])

  /**
   * Load image data as base64 for embedding in PDF
   */
  const loadImageAsBase64 = async (attachmentId: number): Promise<string | undefined> => {
    try {
      const token = getToken()
      const response = await fetch(getAttachmentPreviewUrl(attachmentId), {
        headers: {
          ...(token && { Authorization: `Bearer ${token}` }),
        },
      })

      if (!response.ok) {
        console.warn(`Failed to load image ${attachmentId}: ${response.status}`)
        return undefined
      }

      const blob = await response.blob()
      return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onloadend = () => {
          const base64 = reader.result as string
          const base64Data = base64.split(',')[1]
          resolve(base64Data)
        }
        reader.onerror = reject
        reader.readAsDataURL(blob)
      })
    } catch (error) {
      console.warn(`Failed to load image ${attachmentId}:`, error)
      return undefined
    }
  }

  /**
   * Export as PDF (client-side generation)
   */
  const exportPdf = async (selectedMessages: SelectableMessage[]) => {
    // Load image data for attachments
    const messagesWithImages: ExportMessage[] = await Promise.all(
      selectedMessages.map(async msg => {
        let attachments: ExportAttachment[] | undefined
        let knowledgeBases: ExportKnowledgeBase[] | undefined

        if (msg.attachments && msg.attachments.length > 0) {
          attachments = await Promise.all(
            msg.attachments.map(async att => {
              const exportAtt: ExportAttachment = {
                id: att.id,
                filename: att.filename,
                file_size: att.file_size,
                file_extension: att.file_extension,
              }

              if (isImageExtension(att.file_extension)) {
                exportAtt.imageData = await loadImageAsBase64(att.id)
              }

              return exportAtt
            })
          )
        }

        // Convert knowledge bases to export format
        if (msg.knowledgeBases && msg.knowledgeBases.length > 0) {
          knowledgeBases = msg.knowledgeBases.map(kb => ({
            id: kb.id,
            name: kb.name,
            document_count: kb.document_count,
          }))
        }

        return {
          type: msg.type,
          content: msg.content,
          timestamp: msg.timestamp,
          botName: msg.botName,
          userName: msg.userName,
          teamName: msg.teamName,
          attachments,
          knowledgeBases,
        }
      })
    )

    await generateChatPdf({
      taskName: taskName || 'Chat Export',
      messages: messagesWithImages,
    })
  }

  /**
   * Export as DOCX (server-side generation with message filter)
   */
  const exportDocx = async (selectedMessages: SelectableMessage[]) => {
    // Extract numeric message IDs for the API call
    const messageIds = selectedMessages
      .map(msg => {
        const id = typeof msg.id === 'string' ? parseInt(msg.id, 10) : msg.id
        return isNaN(id) ? null : id
      })
      .filter((id): id is number => id !== null)

    const blob = await taskApis.exportTaskDocx(taskId, messageIds)

    // Trigger download
    const url = window.URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `${taskName || 'Chat_Export'}_${new Date().toISOString().split('T')[0]}.docx`
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    window.URL.revokeObjectURL(url)
  }

  /**
   * Perform the actual export operation
   */
  const performExport = useCallback(async () => {
    try {
      // Filter selected messages and maintain order
      const selectedMessages = messages.filter(msg => selectedIds.has(msg.id))

      if (exportFormat === 'pdf') {
        await exportPdf(selectedMessages)
        toast({
          title: t('chat:export.success') || 'PDF exported successfully',
        })
      } else {
        await exportDocx(selectedMessages)
        toast({
          title: t('chat:export.docx_success') || 'DOCX exported successfully',
        })
      }

      onClose()
    } catch (error) {
      console.error(`Failed to export ${exportFormat.toUpperCase()}:`, error)
      toast({
        variant: 'destructive',
        title:
          exportFormat === 'pdf'
            ? t('chat:export.failed') || 'Failed to export PDF'
            : t('chat:export.docx_failed') || 'Failed to export DOCX',
        description: error instanceof Error ? error.message : 'Unknown error',
      })
    } finally {
      setIsExporting(false)
    }
  }, [selectedIds, messages, exportFormat, taskId, taskName, toast, t, onClose])

  /**
   * Confirm selection and export
   */
  const handleConfirmExport = useCallback(() => {
    if (selectedIds.size === 0) {
      toast({
        variant: 'destructive',
        title: t('chat:export.select_at_least_one') || 'Please select at least one message',
      })
      return
    }

    // Set exporting state first
    setIsExporting(true)

    // Use requestAnimationFrame to ensure UI updates before starting export
    // This allows the browser to repaint and show "exporting" state immediately
    requestAnimationFrame(() => {
      // Use setTimeout to ensure the state update is rendered
      setTimeout(() => {
        performExport()
      }, 0)
    })
  }, [selectedIds, toast, t, performExport])

  /**
   * Check if all messages are selected
   */
  const isAllSelected = useMemo(() => {
    return messages.length > 0 && selectedIds.size === messages.length
  }, [messages.length, selectedIds.size])

  const selectionCount = selectedIds.size
  const formatLabel = exportFormat === 'pdf' ? 'PDF' : 'DOCX'

  return (
    <Dialog open={open} onOpenChange={open => !open && onClose()}>
      <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileText className="w-5 h-5" />
            {t('chat:export.export')} {formatLabel}
          </DialogTitle>
        </DialogHeader>

        {/* Loading state when fetching all messages */}
        {isLoadingAllMessages && (
          <div className="flex items-center justify-center py-8">
            <div className="flex flex-col items-center gap-3">
              <Loader2 className="w-8 h-8 animate-spin text-primary" />
              <span className="text-sm text-text-secondary">
                {t('chat:export.loading_all_messages') || 'Loading all messages...'}
              </span>
            </div>
          </div>
        )}

        {/* Error state */}
        {loadError && !isLoadingAllMessages && (
          <div className="flex items-center justify-center py-4 text-sm text-amber-600">
            {t('chat:export.load_error_fallback') || 'Using currently loaded messages'}
          </div>
        )}

        {/* Selection toolbar */}
        {!isLoadingAllMessages && (
          <div className="flex items-center justify-between gap-3 p-3 bg-surface border border-border rounded-lg">
            <div className="flex items-center gap-3">
              <span className="text-sm text-text-secondary">
                {t('chat:export.selected_count', { count: selectionCount }) ||
                  `Selected: ${selectionCount} message(s)`}
              </span>
              {allMessages.length > 0 && (
                <span className="text-xs text-text-muted">
                  (
                  {t('chat:export.total_messages', { count: messages.length }) ||
                    `${messages.length} total`}
                  )
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={isAllSelected ? handleDeselectAll : handleSelectAll}
                className="text-xs"
              >
                {isAllSelected
                  ? t('chat:export.deselect_all') || 'Deselect All'
                  : t('chat:export.select_all') || 'Select All'}
              </Button>
            </div>
          </div>
        )}

        {/* Message selection list */}
        {!isLoadingAllMessages && (
          <div className="flex-1 overflow-y-auto space-y-2 min-h-0 pr-1">
            {messages.map((msg, index) => {
              const isSelected = selectedIds.has(msg.id)
              return (
                <div
                  key={msg.id}
                  className={`flex items-start gap-3 p-3 rounded-lg border transition-colors cursor-pointer ${
                    isSelected
                      ? 'border-primary bg-primary/5'
                      : 'border-border bg-surface hover:bg-muted'
                  }`}
                  onClick={() => handleToggleMessage(msg.id)}
                >
                  <div className="flex-shrink-0 pt-0.5" onClick={e => e.stopPropagation()}>
                    <Checkbox
                      checked={isSelected}
                      onCheckedChange={() => handleToggleMessage(msg.id)}
                      className="data-[state=checked]:bg-primary data-[state=checked]:border-primary"
                    />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span
                        className={`text-xs font-medium ${
                          msg.type === 'user' ? 'text-text-secondary' : 'text-primary'
                        }`}
                      >
                        {msg.type === 'user'
                          ? msg.userName || 'User'
                          : msg.teamName || msg.botName || 'AI'}
                      </span>
                      <span className="text-xs text-text-muted">
                        {formatDateTime(msg.timestamp)}
                      </span>
                    </div>
                    <p className="text-sm text-text-primary line-clamp-2">
                      {msg.content.slice(0, 200)}
                      {msg.content.length > 200 ? '...' : ''}
                    </p>
                    {/* Show attachment indicator */}
                    {msg.attachments && msg.attachments.length > 0 && (
                      <div className="flex items-center gap-1 mt-1 text-xs text-text-muted">
                        <Paperclip className="w-3 h-3" />
                        <span>
                          {msg.attachments.length} {t('chat:export.attachments') || 'attachment(s)'}
                        </span>
                      </div>
                    )}
                    {/* Show knowledge base indicator */}
                    {msg.knowledgeBases && msg.knowledgeBases.length > 0 && (
                      <div className="flex items-center gap-1 mt-1 text-xs text-text-muted">
                        <Database className="w-3 h-3" />
                        <span>
                          {msg.knowledgeBases.length}{' '}
                          {t('chat:export.knowledge_bases') || 'knowledge base(s)'}
                        </span>
                      </div>
                    )}
                  </div>
                  <div className="flex-shrink-0">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={e => {
                        e.stopPropagation()
                        handleSelectFromHere(index)
                      }}
                      className="text-xs text-text-muted hover:text-primary"
                      title={t('chat:export.select_from_here') || 'Select from here'}
                    >
                      <ChevronDown className="w-3 h-3 mr-1" />
                      {t('chat:export.select_below') || 'Select below'}
                    </Button>
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {/* Footer actions */}
        <div className="flex items-center justify-end gap-3 pt-4 border-t border-border">
          <Button variant="ghost" size="sm" onClick={onClose} className="text-sm">
            <X className="w-4 h-4 mr-1" />
            {t('chat:export.cancel') || 'Cancel'}
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={fontLoadError ? handleRetryFontLoad : handleConfirmExport}
            disabled={
              isLoadingAllMessages ||
              (exportFormat === 'pdf' && isFontLoading) ||
              selectionCount === 0 ||
              isExporting
            }
            className="text-sm"
          >
            {fontLoadError ? (
              <RefreshCw className="w-4 h-4 mr-1" />
            ) : isExporting ? (
              <Loader2 className="w-4 h-4 mr-1 animate-spin" />
            ) : (
              <FileText className="w-4 h-4 mr-1" />
            )}
            {fontLoadError
              ? t('export.retry')
              : exportFormat === 'pdf' && isFontLoading
                ? t('export.preparing')
                : isExporting
                  ? exportFormat === 'pdf'
                    ? t('export.exporting')
                    : t('export.exporting_docx')
                  : t('export.confirm')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
