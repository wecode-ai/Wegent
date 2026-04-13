// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useState, useRef, useEffect, useCallback } from 'react'
import { Download, X, Code, Eye } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { FilePreview } from './FilePreview'
import { getPreviewType, formatFileSize } from './utils'
import { downloadAttachment } from '@/apis/attachments'
import { ShareButton } from './components'
import { useTranslation } from '@/hooks/useTranslation'
import { useIsMobile } from '@/features/layout/hooks/useMediaQuery'

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
 * Mobile: auto-hide header on scroll for more content space
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
  const isMobile = useIsMobile()
  const [htmlIsSourceMode, setHtmlIsSourceMode] = useState(false)

  // Mobile auto-hide header state
  const [isHeaderVisible, setIsHeaderVisible] = useState(true)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const lastScrollTop = useRef(0)

  /**
   * Handle scroll event for auto-hide header
   */
  const handleScroll = useCallback(() => {
    if (!scrollContainerRef.current || !isMobile) return

    const container = scrollContainerRef.current
    const scrollTop = container.scrollTop
    const scrollHeight = container.scrollHeight
    const clientHeight = container.clientHeight

    // Always show header at the top
    if (scrollTop < 10) {
      setIsHeaderVisible(true)
      lastScrollTop.current = scrollTop
      return
    }

    // Always show header at the bottom (allow access to actions)
    if (scrollTop + clientHeight >= scrollHeight - 10) {
      setIsHeaderVisible(true)
      lastScrollTop.current = scrollTop
      return
    }

    const scrollDelta = scrollTop - lastScrollTop.current

    // Hide header when scrolling down significantly (> 5px)
    if (scrollDelta > 5) {
      setIsHeaderVisible(false)
    }
    // Show header when scrolling up
    else if (scrollDelta < -5) {
      setIsHeaderVisible(true)
    }

    lastScrollTop.current = scrollTop
  }, [isMobile])

  // Reset header visibility when switching between mobile/desktop
  useEffect(() => {
    setIsHeaderVisible(true)
    lastScrollTop.current = 0
  }, [isMobile])

  // Attach scroll listener to container
  useEffect(() => {
    const container = scrollContainerRef.current
    if (!container || !isMobile) return

    container.addEventListener('scroll', handleScroll, { passive: true })

    return () => {
      container.removeEventListener('scroll', handleScroll, {
        passive: true,
      } as EventListenerOptions)
    }
  }, [isMobile, handleScroll])

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
    <div className="h-full bg-white dark:bg-gray-900 flex flex-col overflow-hidden">
      {/* Header - Auto-hide on mobile when scrolling down */}
      <header
        className={`
          flex-none flex items-center px-4 py-2
          border-b border-border dark:border-gray-700
          bg-white dark:bg-gray-900 gap-2 z-20
          ${
            isMobile
              ? 'absolute top-0 left-0 right-0 z-50 shadow-sm justify-end'
              : 'sticky top-0 justify-between'
          }
        `}
        style={
          isMobile
            ? {
                transform: `translateY(${isHeaderVisible ? 0 : -100}%)`,
                transition: 'transform 250ms ease-out',
              }
            : undefined
        }
      >
        {/* File info - desktop only (>=768px) */}
        <div className={`items-center gap-3 min-w-0 ${isMobile ? 'hidden' : 'flex'}`}>
          <span className="text-2xl">{getFileIcon()}</span>
          <div className="min-w-0">
            <h1 className="font-medium text-text-primary truncate max-w-[200px] md:max-w-[300px] lg:max-w-[500px]">
              {filename}
            </h1>
            {fileSize && <p className="text-xs text-text-secondary">{formatFileSize(fileSize)}</p>}
          </div>
        </div>

        <div className="flex items-center gap-2 flex-shrink-0 overflow-x-auto">
          {/* HTML Preview Controls - Segmented toggle for preview/source mode */}
          {isHtml && (
            <div className="relative flex items-center bg-muted/50 rounded-lg p-1">
              {/* Sliding background indicator */}
              <div
                className="absolute h-[calc(100%-8px)] bg-primary rounded-md shadow-sm will-change-transform"
                style={{
                  width: 'calc(50% - 4px)',
                  left: htmlIsSourceMode ? 'calc(50% + 2px)' : '4px',
                  transition: 'left 200ms ease-out',
                }}
              />
              {/* Preview button */}
              <button
                type="button"
                onClick={() => setHtmlIsSourceMode(false)}
                className={`relative z-10 flex items-center gap-1.5 h-8 px-3 text-sm font-medium rounded-md transition-colors duration-200 ${
                  !htmlIsSourceMode ? 'text-white' : 'text-text-primary hover:text-text-primary'
                }`}
                title={t('actions.preview')}
              >
                <Eye className="w-4 h-4" />
                <span className="hidden sm:inline">{t('actions.preview')}</span>
              </button>
              {/* Source button */}
              <button
                type="button"
                onClick={() => setHtmlIsSourceMode(true)}
                className={`relative z-10 flex items-center gap-1.5 h-8 px-3 text-sm font-medium rounded-md transition-colors duration-200 ${
                  htmlIsSourceMode ? 'text-white' : 'text-text-primary hover:text-text-primary'
                }`}
                title={t('attachment.html.source_mode')}
              >
                <Code className="w-4 h-4" />
                <span className="hidden sm:inline">{t('attachment.html.source_mode')}</span>
              </button>
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

      {/* Spacer for mobile absolute header - collapses when header is hidden */}
      {isMobile && (
        <div
          className="flex-shrink-0 transition-[height] duration-250 ease-out"
          style={{ height: isHeaderVisible ? 52 : 0 }}
        />
      )}

      {/* Preview Area */}
      <div ref={scrollContainerRef} className="flex-1 overflow-y-auto">
        <FilePreview
          attachmentId={attachmentId}
          fileBlob={fileBlob}
          filename={filename}
          mimeType={mimeType}
          fileSize={fileSize}
          shareToken={shareToken}
          onDownload={handleDownload}
          onClose={onClose}
          showToolbar={!isMobile}
          htmlIsSourceMode={htmlIsSourceMode}
          onHtmlViewModeChange={setHtmlIsSourceMode}
        />
      </div>
    </div>
  )
}
