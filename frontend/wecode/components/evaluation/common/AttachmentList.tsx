// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState } from 'react'
import { File, Download, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { downloadEvaluationFile } from '@wecode/api/evaluation-shared'
import type { EvalAttachment } from '@wecode/types/evaluation'

// Generic attachment interface that works with both EvalAttachment and custom Attachment types
export interface GenericAttachment {
  key: string
  filename: string
  file_size?: number
  size?: number
  content_type?: string
}

export interface AttachmentListProps {
  /** Array of attachments to display */
  attachments: GenericAttachment[]
  /** Function to generate download filename with prefix */
  generatePrefixedFilename: (attachment: GenericAttachment, index: number) => string
  /** Optional callback when download completes */
  onDownloadSuccess?: (attachment: GenericAttachment) => void
  /** Optional callback when download fails */
  onDownloadError?: (attachment: GenericAttachment, error: unknown) => void
}

/**
 * Format file size to human-readable string
 * Supports both file_size (EvalAttachment) and size (custom Attachment) properties
 */
export function formatFileSize(attachment: GenericAttachment): string {
  const bytes = attachment.file_size ?? attachment.size ?? 0
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
}

/**
 * AttachmentList - Reusable component for displaying and downloading attachments
 *
 * Used in grader and author pages to display attachment lists with consistent
 * download behavior and prefixed filenames.
 */
export function AttachmentList({
  attachments,
  generatePrefixedFilename,
  onDownloadSuccess,
  onDownloadError,
}: AttachmentListProps) {
  const [downloadingKey, setDownloadingKey] = useState<string | null>(null)

  const handleDownload = async (attachment: EvalAttachment, index: number) => {
    const downloadKey = `${attachment.key}_${index}`
    setDownloadingKey(downloadKey)

    try {
      const prefixedFilename = generatePrefixedFilename(attachment, index)
      await downloadEvaluationFile(attachment.key, prefixedFilename)
      onDownloadSuccess?.(attachment)
    } catch (error) {
      onDownloadError?.(attachment, error)
    } finally {
      setDownloadingKey(null)
    }
  }

  if (!attachments || attachments.length === 0) {
    return null
  }

  return (
    <div className="space-y-2">
      {attachments.map((attachment, index) => {
        const downloadKey = `${attachment.key}_${index}`
        const isDownloading = downloadingKey === downloadKey

        return (
          <div
            key={attachment.key || index}
            className="flex items-center gap-3 rounded-lg border border-border bg-surface p-2"
          >
            <File className="h-4 w-4 text-text-secondary" />
            <span className="min-w-0 flex-1 truncate text-sm">{attachment.filename}</span>
            {(attachment.file_size || attachment.size) && (
              <span className="text-xs text-text-muted">{formatFileSize(attachment)}</span>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => handleDownload(attachment, index)}
              disabled={isDownloading}
            >
              {isDownloading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Download className="h-4 w-4" />
              )}
            </Button>
          </div>
        )
      })}
    </div>
  )
}

/**
 * Generate prefixed filename for evaluation attachments
 *
 * Format: {userId}_{topicId}_{questionId}_{slot}_{index}_{originalFilename}
 */
export function generateEvaluationPrefixedFilename(
  attachment: GenericAttachment,
  options: {
    userId: number
    topicId: number
    questionId: number
    slot?: string
    fileIndex?: number
  }
): string {
  const { userId, topicId, questionId, slot, fileIndex } = options
  const slotName = slot || 'attachment'
  const index = fileIndex !== undefined ? fileIndex + 1 : 1
  const originalFilename = attachment.filename || 'download'

  return `${userId}_${topicId}_${questionId}_${slotName}_${index}_${originalFilename}`
}
