// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useState, useCallback, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { X, AlertCircle, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { getToken } from '@/apis/user'
import { getAttachmentDownloadUrl } from '@/apis/attachments'

interface HtmlPreviewProps {
  /** The attachment ID to download and preview */
  attachmentId: number
  /** Filename for display */
  filename?: string
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
 * HtmlThumbnail component - Renders a live preview of HTML in a small iframe
 * Uses CSS transform to scale content to fit the thumbnail container
 */
function HtmlThumbnail({
  blobUrl,
  filename,
  onClick,
}: {
  blobUrl: string
  filename?: string
  onClick: () => void
}) {
  const [isLoading, setIsLoading] = useState(true)
  const [hasError, setHasError] = useState(false)
  const [scale, setScale] = useState(0.3125) // Default: 400 / 1280
  const containerRef = useRef<HTMLDivElement>(null)

  // Calculate scale based on container size
  useEffect(() => {
    const calculateScale = () => {
      if (containerRef.current) {
        const containerWidth = containerRef.current.clientWidth
        // Scale to fit container, assuming content is 1280px wide (common slide width)
        // Add a small margin by using slightly larger denominator
        const newScale = containerWidth / 1280
        setScale(newScale)
      }
    }

    calculateScale()

    // Recalculate on resize
    const observer = new ResizeObserver(calculateScale)
    if (containerRef.current) {
      observer.observe(containerRef.current)
    }

    return () => observer.disconnect()
  }, [])

  return (
    <div
      className="relative rounded-lg overflow-hidden border border-border hover:border-primary transition-colors cursor-pointer bg-white"
      onClick={onClick}
      style={{ width: '100%', maxWidth: '400px' }}
    >
      {/* Container with 16:9 aspect ratio */}
      <div ref={containerRef} className="relative w-full" style={{ aspectRatio: '16/9' }}>
        {isLoading && (
          <div className="absolute inset-0 flex items-center justify-center bg-surface">
            <Loader2 className="h-6 w-6 text-primary animate-spin" />
          </div>
        )}

        {hasError ? (
          <div className="absolute inset-0 flex items-center justify-center bg-surface">
            <div className="flex flex-col items-center gap-1 text-text-secondary">
              <AlertCircle className="h-8 w-8" />
              <span className="text-xs">Failed to load</span>
            </div>
          </div>
        ) : (
          <div
            className="absolute inset-0 overflow-hidden"
            style={
              {
                // Use CSS transform to scale the iframe content to fit the container
                // This allows fixed-size HTML content (like 1280x720 slides) to fit in a small thumbnail
              }
            }
          >
            <iframe
              src={blobUrl}
              title={filename || 'HTML Preview'}
              className={`border-0 bg-white ${isLoading ? 'opacity-0' : 'opacity-100'}`}
              onLoad={() => setIsLoading(false)}
              onError={() => {
                setHasError(true)
                setIsLoading(false)
              }}
              sandbox="allow-scripts allow-same-origin"
              style={{
                // Prevent interaction in thumbnail mode
                pointerEvents: 'none',
                backgroundColor: 'white',
                // Use transform scale to fit content into container
                // Content is assumed to be 1280x720 (standard slide size)
                transform: `scale(${scale})`,
                transformOrigin: 'top left',
                width: '1280px',
                height: '720px',
              }}
            />
          </div>
        )}
      </div>

      {/* Filename overlay at bottom */}
      <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/60 to-transparent px-3 py-2">
        <p className="text-white text-xs truncate">{filename || 'HTML Preview'}</p>
      </div>
    </div>
  )
}

/**
 * HtmlPreview component for rendering HTML file URLs in chat messages.
 * Shows an inline thumbnail with live HTML preview that can be clicked to open a preview modal.
 */
export default function HtmlPreview({ attachmentId, filename }: HtmlPreviewProps) {
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

  // Download HTML on component mount (for thumbnail preview)
  useEffect(() => {
    if (blobUrl || error || isDownloading) return

    const downloadHtml = async () => {
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
      } catch (err) {
        console.error('Failed to download HTML:', err)
        setError(true)
      } finally {
        setIsDownloading(false)
      }
    }

    downloadHtml()
  }, [attachmentId, blobUrl, error, isDownloading])

  const handleClick = useCallback(() => {
    if (error) return
    setShowLightbox(true)
  }, [error])

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

  // While downloading, show a placeholder
  if (!blobUrl) {
    return (
      <div
        className="relative rounded-lg overflow-hidden border border-border bg-surface"
        style={{ maxWidth: '400px' }}
      >
        <div
          className="relative w-full flex flex-col items-center justify-center"
          style={{ aspectRatio: '16/9' }}
        >
          <Loader2 className="h-8 w-8 text-primary animate-spin mb-2" />
          <span className="text-xs text-text-secondary">{t('loading')}</span>
        </div>
        <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/60 to-transparent px-3 py-2">
          <p className="text-white text-xs truncate">{filename || 'HTML Preview'}</p>
        </div>
      </div>
    )
  }

  return (
    <>
      {/* Thumbnail preview with live HTML rendering */}
      <div className="my-2">
        <HtmlThumbnail blobUrl={blobUrl} filename={filename} onClick={handleClick} />
      </div>

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
