// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useState, useCallback, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { X, AlertCircle, FileCode, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { getToken } from '@/apis/user'
import { getAttachmentDownloadUrl } from '@/apis/attachments'

interface HtmlPreviewProps {
  /** The attachment ID to download and preview */
  attachmentId: number
  /** Filename for display */
  filename?: string
  /** Maximum width of the thumbnail */
  maxWidth?: number
  /** Maximum height of the thumbnail */
  maxHeight?: number
}

/**
 * Full screen HTML preview modal component
 */
function HtmlLightbox({
  blobUrl,
  filename,
  onClose,
}: {
  blobUrl: string
  filename: string
  onClose: () => void
}) {
  const { t } = useTranslation('common')
  const [isLoading, setIsLoading] = useState(true)

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) {
        onClose()
      }
    },
    [onClose]
  )

  // Handle keyboard events
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    // Prevent body scroll when lightbox is open
    document.body.style.overflow = 'hidden'

    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      document.body.style.overflow = ''
    }
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/80 backdrop-blur-sm"
      onClick={handleBackdropClick}
    >
      {/* Toolbar */}
      <div className="absolute top-4 right-4 flex items-center gap-2 z-10">
        <Button
          variant="ghost"
          size="icon"
          onClick={onClose}
          className="h-10 w-10 bg-black/50 hover:bg-black/70 text-white"
          title="Close (Esc)"
        >
          <X className="h-5 w-5" />
        </Button>
      </div>

      {/* HTML Container - 16:9 aspect ratio by default */}
      <div className="w-[90vw] h-[80vh] max-w-[1600px]">
        {isLoading && (
          <div className="w-full h-full flex items-center justify-center bg-surface rounded-lg">
            <div className="flex flex-col items-center gap-2 text-text-secondary">
              <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
              <span className="text-sm">{t('loading')}</span>
            </div>
          </div>
        )}
        <iframe
          src={blobUrl}
          title={filename}
          className={`w-full h-full rounded-lg bg-white ${isLoading ? 'hidden' : 'block'}`}
          onLoad={() => setIsLoading(false)}
          sandbox="allow-scripts allow-same-origin"
        />
      </div>

      {/* Filename at bottom */}
      <div className="absolute bottom-4 left-1/2 -translate-x-1/2 text-white text-sm bg-black/50 px-4 py-2 rounded-lg max-w-[80vw] truncate">
        {filename || 'HTML Preview'}
      </div>
    </div>
  )
}

/**
 * HtmlPreview component for rendering HTML file URLs in chat messages.
 * Shows an inline thumbnail that can be clicked to open a preview modal.
 * Downloads HTML content on click to avoid authentication issues.
 */
export default function HtmlPreview({
  attachmentId,
  filename,
  maxWidth = 600,
  maxHeight = 400,
}: HtmlPreviewProps) {
  const { t } = useTranslation('common')
  const [showLightbox, setShowLightbox] = useState(false)
  const [isDownloading, setIsDownloading] = useState(false)
  const [blobUrl, setBlobUrl] = useState<string | null>(null)
  const [error, setError] = useState(false)
  const downloadStarted = useRef(false)

  // Cleanup blob URL on unmount
  useEffect(() => {
    return () => {
      if (blobUrl) {
        URL.revokeObjectURL(blobUrl)
      }
    }
  }, [blobUrl])

  const downloadHtml = useCallback(async () => {
    if (downloadStarted.current) return
    downloadStarted.current = true
    setIsDownloading(true)
    setError(false)

    try {
      const token = getToken()
      const response = await fetch(getAttachmentDownloadUrl(attachmentId), {
        headers: {
          ...(token && { Authorization: `Bearer ${token}` }),
        },
      })

      if (!response.ok) {
        throw new Error(`Failed to download HTML: ${response.status}`)
      }

      const blob = await response.blob()
      // Force text/html MIME type to ensure browser renders it instead of downloading
      const htmlBlob = new Blob([blob], { type: 'text/html' })
      const url = URL.createObjectURL(htmlBlob)
      setBlobUrl(url)
      setShowLightbox(true)
    } catch (err) {
      console.error('Failed to download HTML:', err)
      setError(true)
    } finally {
      setIsDownloading(false)
      downloadStarted.current = false
    }
  }, [attachmentId])

  const handleClick = useCallback(() => {
    if (error) return

    if (blobUrl) {
      // Already downloaded, just show
      setShowLightbox(true)
    } else {
      // Download first
      downloadHtml()
    }
  }, [blobUrl, error, downloadHtml])

  const handleCloseLightbox = useCallback(() => {
    setShowLightbox(false)
  }, [])

  // If there's an error, show a fallback
  if (error) {
    return (
      <div className="inline-flex items-center gap-1.5 text-text-secondary text-sm">
        <AlertCircle className="h-4 w-4" />
        <span className="truncate max-w-[200px]">{filename || 'HTML Preview'}</span>
        <span className="text-xs">({t('attachment.preview.unavailable')})</span>
      </div>
    )
  }

  return (
    <>
      {/* Thumbnail preview - similar to image preview style */}
      <span className="relative inline-block my-2">
        <span
          className={`cursor-pointer rounded-lg overflow-hidden border border-border hover:border-primary transition-colors block bg-surface ${
            isDownloading ? 'opacity-70' : ''
          }`}
          onClick={handleClick}
          style={{ maxWidth, maxHeight }}
        >
          {/* HTML thumbnail with aspect ratio 16:9 */}
          <div
            className="relative bg-gradient-to-br from-surface to-muted flex flex-col items-center justify-center"
            style={{
              width: '100%',
              aspectRatio: '16/9',
              minWidth: '200px',
              maxWidth: `${maxWidth}px`,
            }}
          >
            {/* Icon and filename */}
            <div className="flex flex-col items-center gap-2 p-4">
              {isDownloading ? (
                <Loader2 className="h-10 w-10 text-primary animate-spin" />
              ) : (
                <FileCode className="h-10 w-10 text-primary opacity-80" />
              )}
              <span className="text-xs text-text-secondary text-center truncate max-w-[150px]">
                {filename || t('attachment.html_preview')}
              </span>
              <span className="text-[10px] text-text-muted">
                {isDownloading ? t('loading') : t('attachment.click_to_preview')}
              </span>
            </div>
          </div>
        </span>
      </span>

      {/* Lightbox modal - rendered via Portal to avoid HTML nesting issues */}
      {showLightbox &&
        blobUrl &&
        typeof document !== 'undefined' &&
        createPortal(
          <HtmlLightbox
            blobUrl={blobUrl}
            filename={filename || 'HTML Preview'}
            onClose={handleCloseLightbox}
          />,
          document.body
        )}
    </>
  )
}
