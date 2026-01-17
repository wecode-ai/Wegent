// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { FileIcon, Download, ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { InteractiveAttachment } from './types'

interface AttachmentDisplayProps {
  attachments: InteractiveAttachment[]
}

/**
 * Display attachments in an interactive message.
 */
export function AttachmentDisplay({ attachments }: AttachmentDisplayProps) {
  if (!attachments || attachments.length === 0) {
    return null
  }

  const formatFileSize = (bytes?: number): string => {
    if (!bytes) return ''
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }

  const getFileIcon = (mimeType: string) => {
    if (mimeType.startsWith('image/')) {
      return '🖼️'
    } else if (mimeType.startsWith('video/')) {
      return '🎬'
    } else if (mimeType.startsWith('audio/')) {
      return '🎵'
    } else if (mimeType === 'application/pdf') {
      return '📄'
    } else if (
      mimeType.includes('spreadsheet') ||
      mimeType.includes('excel') ||
      mimeType === 'text/csv'
    ) {
      return '📊'
    } else if (mimeType.includes('document') || mimeType.includes('word')) {
      return '📝'
    } else if (mimeType.includes('zip') || mimeType.includes('archive')) {
      return '📦'
    }
    return <FileIcon className="w-4 h-4" />
  }

  return (
    <div className="mt-2 space-y-2">
      {attachments.map((attachment, index) => (
        <div
          key={`${attachment.name}-${index}`}
          className="flex items-center gap-3 p-2 rounded-lg bg-surface/50 border border-border"
        >
          <span className="text-lg">{getFileIcon(attachment.mime_type)}</span>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-text-primary truncate">{attachment.name}</p>
            {attachment.size && (
              <p className="text-xs text-text-muted">{formatFileSize(attachment.size)}</p>
            )}
          </div>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="sm" asChild className="h-8 w-8 p-0">
              <a
                href={attachment.url}
                target="_blank"
                rel="noopener noreferrer"
                title="Open in new tab"
              >
                <ExternalLink className="w-4 h-4" />
              </a>
            </Button>
            <Button variant="ghost" size="sm" asChild className="h-8 w-8 p-0">
              <a href={attachment.url} download={attachment.name} title="Download">
                <Download className="w-4 h-4" />
              </a>
            </Button>
          </div>
        </div>
      ))}
    </div>
  )
}
