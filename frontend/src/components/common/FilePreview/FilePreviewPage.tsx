// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React from 'react'
import { Download, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { FilePreview } from './FilePreview'
import { getPreviewType, formatFileSize } from './utils'
import { downloadAttachment } from '@/apis/attachments'

export interface FilePreviewPageProps {
  /** Attachment ID */
  attachmentId?: number
  /** Direct file blob */
  fileBlob?: Blob
  /** Filename */
  filename: string
  /** MIME type */
  mimeType: string
  /** File size */
  fileSize?: number
  /** Optional share token */
  shareToken?: string
  /** Callback when close is requested */
  onClose?: () => void
}

/**
 * FilePreviewPage - Fullscreen page wrapper for FilePreview
 * Used in /download/shared page
 */
export function FilePreviewPage({
  attachmentId,
  fileBlob,
  filename,
  mimeType,
  fileSize,
  shareToken,
  onClose,
}: FilePreviewPageProps) {
  const previewType = getPreviewType(mimeType, filename)

  const handleDownload = async () => {
    if (attachmentId) {
      try {
        await downloadAttachment(attachmentId, filename, shareToken)
      } catch (err) {
        console.error('Failed to download:', err)
      }
    } else if (fileBlob) {
      // Download from blob
      const url = URL.createObjectURL(fileBlob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    }
  }

  // Get file icon
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
    <div className="min-h-screen bg-white dark:bg-gray-900 flex flex-col">
      {/* Header */}
      <header className="flex items-center justify-between px-4 py-3 border-b border-border dark:border-gray-700 bg-white dark:bg-gray-900 sticky top-0 z-10">
        <div className="flex items-center gap-3 min-w-0">
          <span className="text-2xl">{getFileIcon()}</span>
          <div className="min-w-0">
            <h1 className="font-medium text-text-primary truncate max-w-[200px] sm:max-w-[300px] md:max-w-[500px]">
              {filename}
            </h1>
            {fileSize && <p className="text-xs text-text-secondary">{formatFileSize(fileSize)}</p>}
          </div>
        </div>

        <div className="flex items-center gap-2 flex-shrink-0">
          <Button variant="primary" size="sm" onClick={handleDownload}>
            <Download className="w-4 h-4 mr-2" />
            下载
          </Button>
          {onClose && (
            <Button variant="ghost" size="icon" onClick={onClose} title="关闭">
              <X className="w-5 h-5" />
            </Button>
          )}
        </div>
      </header>

      {/* Preview Area */}
      <main className="flex-1 overflow-hidden">
        <FilePreview
          attachmentId={attachmentId}
          fileBlob={fileBlob}
          filename={filename}
          mimeType={mimeType}
          fileSize={fileSize}
          shareToken={shareToken}
          onDownload={handleDownload}
          onClose={onClose}
          showToolbar={true}
        />
      </main>
    </div>
  )
}
