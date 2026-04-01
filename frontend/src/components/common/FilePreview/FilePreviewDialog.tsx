// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useEffect, useState } from 'react'
import { Download, X, Code, Eye } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { FilePreview } from './FilePreview'
import { getPreviewType, formatFileSize } from './utils'
import { downloadAttachment } from '@/apis/attachments'
import { ShareButton } from './components'
import { useTranslation } from '@/hooks/useTranslation'

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
  /** Whether the user can share the attachment (owner only) */
  canShare?: boolean
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
  canShare,
}: FilePreviewDialogProps) {
  const previewType = getPreviewType(mimeType, filename)
  const isHtml = previewType === 'html'
  const { t } = useTranslation('common')
  const [htmlIsSourceMode, setHtmlIsSourceMode] = useState(false)

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
      case 'html':
        return '🌐'
      case 'office':
        return '📊'
      default:
        return '📎'
    }
  }

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent
        className="max-w-5xl w-[90vw] h-[80vh] p-0 flex flex-col gap-0"
        hideCloseButton
      >
        <DialogHeader className="px-4 py-3 border-b border-border flex flex-col-reverse sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <span className="text-2xl">{getFileIcon()}</span>
            <div className="min-w-0">
              <DialogTitle className="text-base font-medium truncate max-w-[200px] sm:max-w-[300px] md:max-w-[400px]">
                {filename}
              </DialogTitle>
              {fileSize && (
                <p className="text-xs text-text-secondary">{formatFileSize(fileSize)}</p>
              )}
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
            {canShare && (
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
            <Button
              variant="ghost"
              size="icon"
              onClick={onClose}
              className="h-9 w-9"
              aria-label={t('actions.close')}
              title={t('actions.close')}
            >
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
            htmlIsSourceMode={htmlIsSourceMode}
            onHtmlViewModeChange={setHtmlIsSourceMode}
          />
        </div>
      </DialogContent>
    </Dialog>
  )
}
