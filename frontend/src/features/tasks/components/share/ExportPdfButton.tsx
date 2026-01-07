// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useState, useCallback, useMemo } from 'react'
import { Download, X, ChevronDown, Paperclip } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { useToast } from '@/hooks/use-toast'
import { generateChatPdf, type ExportMessage, type ExportAttachment } from '@/utils/pdf'
import { useTranslation } from '@/hooks/useTranslation'
import { getAttachmentPreviewUrl, isImageExtension } from '@/apis/attachments'
import { getToken } from '@/apis/user'
import { formatDateTime } from '@/utils/dateTime'

/** Attachment info for selectable messages */
export interface SelectableAttachment {
  id: number
  filename: string
  file_size: number
  file_extension: string
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
}

interface ExportPdfButtonProps {
  /** All messages available for export */
  messages: SelectableMessage[]
  /** Task name for the PDF title and filename */
  taskName: string
  /** Whether the button should be disabled */
  disabled?: boolean
  /** Optional class name for styling */
  className?: string
}

/**
 * Export PDF Button Component
 *
 * Provides a selection mode for users to choose which messages to export,
 * with options to select all, select from a specific message onwards,
 * and generate a branded PDF.
 */
export default function ExportPdfButton({
  messages,
  taskName,
  disabled = false,
  className = '',
}: ExportPdfButtonProps) {
  const { t } = useTranslation()
  const { toast } = useToast()

  // Selection mode state
  const [isSelectionMode, setIsSelectionMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string | number>>(new Set())
  const [isExporting, setIsExporting] = useState(false)

  // Check if there are messages to export
  const hasMessages = messages.length > 0

  /**
   * Enter selection mode
   */
  const handleStartSelection = useCallback(() => {
    if (!hasMessages) {
      toast({
        variant: 'destructive',
        title: t('chat:export.no_messages') || 'No messages to export',
      })
      return
    }
    setIsSelectionMode(true)
    setSelectedIds(new Set())
  }, [hasMessages, toast, t])

  /**
   * Exit selection mode
   */
  const handleCancelSelection = useCallback(() => {
    setIsSelectionMode(false)
    setSelectedIds(new Set())
  }, [])

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
   * Confirm selection and generate PDF
   */
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
          // Remove data URL prefix to get pure base64
          const base64Data = base64.split('chat:,')[1]
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
   * Confirm selection and generate PDF
   */
  const handleConfirmExport = useCallback(async () => {
    if (selectedIds.size === 0) {
      toast({
        variant: 'destructive',
        title: t('chat:export.select_at_least_one') || 'Please select at least one message',
      })
      return
    }

    setIsExporting(true)

    try {
      // Filter selected messages and maintain order
      const selectedMessagesRaw = messages.filter(msg => selectedIds.has(msg.id))

      // Load image data for attachments
      const selectedMessages: ExportMessage[] = await Promise.all(
        selectedMessagesRaw.map(async msg => {
          let attachments: ExportAttachment[] | undefined

          if (msg.attachments && msg.attachments.length > 0) {
            attachments = await Promise.all(
              msg.attachments.map(async att => {
                const exportAtt: ExportAttachment = {
                  id: att.id,
                  filename: att.filename,
                  file_size: att.file_size,
                  file_extension: att.file_extension,
                }

                // Load image data for image attachments
                if (isImageExtension(att.file_extension)) {
                  exportAtt.imageData = await loadImageAsBase64(att.id)
                }

                return exportAtt
              })
            )
          }

          return {
            type: msg.type,
            content: msg.content,
            timestamp: msg.timestamp,
            botName: msg.botName,
            userName: msg.userName,
            teamName: msg.teamName,
            attachments,
          }
        })
      )

      await generateChatPdf({
        taskName: taskName || 'Chat Export',
        messages: selectedMessages,
      })

      toast({
        title: t('chat:export.success') || 'PDF exported successfully',
      })

      // Exit selection mode after successful export
      setIsSelectionMode(false)
      setSelectedIds(new Set())
    } catch (error) {
      console.error('Failed to export PDF:', error)
      toast({
        variant: 'destructive',
        title: t('chat:export.failed') || 'Failed to export PDF',
        description: error instanceof Error ? error.message : 'Unknown error',
      })
    } finally {
      setIsExporting(false)
    }
  }, [selectedIds, messages, taskName, toast, t])

  /**
   * Check if all messages are selected
   */
  const isAllSelected = useMemo(() => {
    return messages.length > 0 && selectedIds.size === messages.length
  }, [messages.length, selectedIds.size])

  /**
   * Selection count display
   */
  const selectionCount = selectedIds.size

  // If in selection mode, render the selection UI
  if (isSelectionMode) {
    return (
      <div className="w-full">
        {/* Selection toolbar */}
        <div className="flex items-center justify-between gap-3 p-3 bg-surface border border-border rounded-lg mb-3">
          <div className="flex items-center gap-3">
            <span className="text-sm text-text-secondary">
              {t('chat:export.selected_count', { count: selectionCount }) ||
                `Selected: ${selectionCount} message(s)`}
            </span>
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
            <Button variant="ghost" size="sm" onClick={handleCancelSelection} className="text-xs">
              <X className="w-4 h-4 mr-1" />
              {t('chat:export.cancel') || 'Cancel'}
            </Button>
            <Button
              variant="default"
              size="sm"
              onClick={handleConfirmExport}
              disabled={selectionCount === 0 || isExporting}
              className="text-xs bg-primary hover:bg-primary/90"
            >
              <Download className="w-4 h-4 mr-1" />
              {isExporting
                ? t('chat:export.exporting') || 'Exporting...'
                : t('chat:export.confirm') || 'Export PDF'}
            </Button>
          </div>
        </div>

        {/* Message selection list */}
        <div className="space-y-2 max-h-[60vh] overflow-y-auto">
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
                    <span className="text-xs text-text-muted">{formatDateTime(msg.timestamp)}</span>
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
      </div>
    )
  }

  // Default: render the export button
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={handleStartSelection}
      disabled={disabled || !hasMessages}
      className={`text-text-muted hover:text-primary ${className}`}
      title={t('chat:export.export_pdf') || 'Export PDF'}
    >
      <Download className="w-4 h-4 mr-1.5" />
      <span className="text-xs">{t('chat:export.export_pdf') || 'Export PDF'}</span>
    </Button>
  )
}
