// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useState } from 'react'
import { Download, X, Code, Eye } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { FilePreview } from './FilePreview'
import { getPreviewType, formatFileSize } from './utils'
import { downloadAttachment } from '@/apis/attachments'
import { ShareButton } from './components'
import { useTranslation } from '@/hooks/useTranslation'

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
  /** Whether the user can share the attachment (owner only) */
  canShare?: boolean
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
  canShare,
}: FilePreviewPageProps) {
  const previewType = getPreviewType(mimeType, filename)
  const isHtml = previewType === 'html'
  const { t } = useTranslation('common')
  const [htmlIsSourceMode, setHtmlIsSourceMode] = useState(false)

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
      case 'html':
        return '🌐'
      case 'office':
        return '📊'
      default:
        return '📎'
    }
  }

  return (
    <div className="h-full bg-white dark:bg-gray-900 flex flex-col">
      {/* Header */}
      <header className="flex flex-col-reverse sm:flex-row sm:items-center justify-between px-4 py-3 border-b border-border dark:border-gray-700 bg-white dark:bg-gray-900 sticky top-0 z-10 gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <span className="text-2xl">{getFileIcon()}</span>
          <div className="min-w-0">
            <h1 className="font-medium text-text-primary truncate max-w-[200px] sm:max-w-[300px] md:max-w-[500px]">
              {filename}
            </h1>
            {fileSize && <p className="text-xs text-text-secondary">{formatFileSize(fileSize)}</p>}
          </div>
        </div>
        <div className="flex items-center justify-end sm:justify-start gap-2 flex-shrink-0 overflow-x-auto pb-1 sm:pb-0">
          {/* HTML Preview Controls - only show for HTML files */}
          {isHtml && (
            <div className="flex items-center bg-muted/50 rounded-md p-0.5">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setHtmlIsSourceMode(false)}
                className={`rounded-sm border-0 h-9 px-2 sm:px-3 text-sm font-medium gap-1.5 ${
                  !htmlIsSourceMode
                    ? 'bg-primary text-white shadow-sm hover:bg-primary'
                    : 'bg-white text-text-primary hover:bg-white'
                }`}
                title={t('actions.preview')}
              >
                <Eye className="w-4 h-4" />
                <span className="hidden sm:inline">{t('actions.preview')}</span>
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setHtmlIsSourceMode(true)}
                className={`rounded-sm border-0 h-9 px-2 sm:px-3 text-sm font-medium gap-1.5 ${
                  htmlIsSourceMode
                    ? 'bg-primary text-white shadow-sm hover:bg-primary'
                    : 'bg-white text-text-primary hover:bg-white'
                }`}
                title={t('attachment.html.source_mode')}
              >
                <Code className="w-4 h-4" />
                <span className="hidden sm:inline">{t('attachment.html.source_mode')}</span>
              </Button>
            </div>
          )}
          {/* Share button - only show if user can share (owner only) */}
          {canShare && attachmentId && (
            <ShareButton
              attachmentId={attachmentId}
              canShare={canShare}
              variant="outline"
              size="sm"
            />
          )}
          <Button
            variant="primary"
            size="sm"
            onClick={handleDownload}
            className="h-9 px-2 sm:px-3"
            title={t('actions.download')}
          >
            <Download className="w-4 h-4 sm:mr-2" />
            <span className="hidden sm:inline">{t('actions.download')}</span>
          </Button>
          {onClose && (
            <Button
              variant="ghost"
              size="icon"
              onClick={onClose}
              title={t('actions.close')}
              aria-label={t('actions.close')}
              className="h-9 w-9"
            >
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
          htmlIsSourceMode={htmlIsSourceMode}
          onHtmlViewModeChange={setHtmlIsSourceMode}
        />
      </main>
    </div>
  )
}
