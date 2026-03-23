// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useEffect } from 'react'
import { Download, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { FilePreview } from './FilePreview'
import { getPreviewType, formatFileSize } from './utils'
import { downloadAttachment } from '@/apis/attachments'

export interface FilePreviewDialogProps {
  /** Whether dialog is open */
  open: boolean
  /** Callback when dialog is closed */
  onClose: () => void
  /** Attachment ID */
  attachmentId: number
  /** Filename */
  filename: string
  /** MIME type */
  mimeType: string
  /** File size */
  fileSize?: number
  /** Optional share token */
  shareToken?: string
}

/**
 * FilePreviewDialog - Dialog wrapper for FilePreview
 * Used in task pages for clicking to preview files
 */
export function FilePreviewDialog({
  open,
  onClose,
  attachmentId,
  filename,
  mimeType,
  fileSize,
  shareToken,
}: FilePreviewDialogProps) {
  const previewType = getPreviewType(mimeType, filename)

  // Handle keyboard shortcut (Escape to close)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && open) {
        onClose()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [open, onClose])

  const handleDownload = async () => {
    try {
      await downloadAttachment(attachmentId, filename, shareToken)
    } catch (err) {
      console.error('Failed to download:', err)
    }
  }

  // Get file icon based on type
  const getFileIcon = () => {
    switch (previewType) {
      case 'image':
        return '🖼️'
      case 'pdf':
        return '📄'
      case 'video':
        return '🎬'
      case 'audio':
        return '🎵'
      case 'text':
        return '📃'
      case 'office':
        return '📊'
      default:
        return '📎'
    }
  }

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-5xl w-[90vw] h-[80vh] p-0 flex flex-col">
        <DialogHeader className="px-4 py-3 border-b border-border flex flex-row items-center justify-between">
          <div className="flex items-center gap-3 min-w-0">
            <span className="text-2xl">{getFileIcon()}</span>
            <div className="min-w-0">
              <DialogTitle className="text-base font-medium truncate max-w-[300px] sm:max-w-[400px]">
                {filename}
              </DialogTitle>
              {fileSize && (
                <p className="text-xs text-text-secondary">{formatFileSize(fileSize)}</p>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <Button variant="outline" size="sm" onClick={handleDownload}>
              <Download className="w-4 h-4 mr-2" />
              下载
            </Button>
            <Button variant="ghost" size="icon" onClick={onClose}>
              <X className="w-5 h-5" />
            </Button>
          </div>
        </DialogHeader>

        <div className="flex-1 overflow-hidden">
          <FilePreview
            attachmentId={attachmentId}
            filename={filename}
            mimeType={mimeType}
            fileSize={fileSize}
            shareToken={shareToken}
            onDownload={handleDownload}
            onClose={onClose}
            showToolbar={false} // Hide toolbar in dialog mode (we have header)
          />
        </div>
      </DialogContent>
    </Dialog>
  )
}
