// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useCallback } from 'react'
import { Download } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  formatFileSize,
  getFileIcon,
  downloadAttachment,
} from '@/apis/attachments'
import type { Attachment } from '@/types/api'

interface AttachmentPreviewProps {
  /** Attachment data */
  attachment: Attachment
  /** Whether to show download button */
  showDownload?: boolean
  /** Compact mode (smaller size) */
  compact?: boolean
}

export default function AttachmentPreview({
  attachment,
  showDownload = true,
  compact = false,
}: AttachmentPreviewProps) {
  const handleDownload = useCallback(async () => {
    try {
      await downloadAttachment(attachment.id, attachment.filename)
    } catch (err) {
      console.error('Failed to download attachment:', err)
    }
  }, [attachment.id, attachment.filename])

  const icon = getFileIcon(attachment.file_extension)

  if (compact) {
    return (
      <div className="inline-flex items-center gap-1.5 px-2 py-1 bg-muted rounded-md border border-border text-xs">
        <span>{icon}</span>
        <span className="truncate max-w-[120px]" title={attachment.filename}>
          {attachment.filename}
        </span>
        {showDownload && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={handleDownload}
            className="h-4 w-4 p-0 hover:bg-transparent"
            title="下载"
          >
            <Download className="h-3 w-3 text-text-muted" />
          </Button>
        )}
      </div>
    )
  }

  return (
    <div className="flex items-center gap-3 p-3 bg-muted rounded-lg border border-border mb-2">
      <span className="text-2xl">{icon}</span>
      <div className="flex-1 min-w-0">
        <div className="font-medium text-sm truncate" title={attachment.filename}>
          {attachment.filename}
        </div>
        <div className="text-xs text-text-muted">
          {formatFileSize(attachment.file_size)}
          {showDownload && (
            <button
              onClick={handleDownload}
              className="ml-2 text-link hover:underline"
            >
              点击下载
            </button>
          )}
        </div>
      </div>
    </div>
  )
}