// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useState, useCallback, useEffect } from 'react'
import { Download, X, ZoomIn, ZoomOut, RotateCw, Loader2, ImageOff, ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

interface ImagePreviewProps {
  /** The URL of the image to display */
  src: string
  /** Alt text for the image */
  alt?: string
  /** Optional CSS class name */
  className?: string
  /** Maximum width of the thumbnail in pixels */
  maxWidth?: number
  /** Maximum height of the thumbnail in pixels */
  maxHeight?: number
  /** Callback when image fails to load */
  onError?: () => void
}

/**
 * Full screen image preview modal component (Lightbox)
 */
function ImageLightbox({
  src,
  alt,
  onClose,
}: {
  src: string
  alt: string
  onClose: () => void
}) {
  const [scale, setScale] = useState(1)
  const [rotation, setRotation] = useState(0)

  const handleZoomIn = useCallback(() => {
    setScale((prev) => Math.min(prev + 0.25, 3))
  }, [])

  const handleZoomOut = useCallback(() => {
    setScale((prev) => Math.max(prev - 0.25, 0.5))
  }, [])

  const handleRotate = useCallback(() => {
    setRotation((prev) => (prev + 90) % 360)
  }, [])

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) {
        onClose()
      }
    },
    [onClose]
  )

  const handleDownload = useCallback(() => {
    const link = document.createElement('a')
    link.href = src
    link.download = alt || 'image'
    link.target = '_blank'
    link.rel = 'noopener noreferrer'
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
  }, [src, alt])

  const handleOpenInNewTab = useCallback(() => {
    window.open(src, '_blank', 'noopener,noreferrer')
  }, [src])

  // Handle keyboard events
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'Escape':
          onClose()
          break
        case '+':
        case '=':
          handleZoomIn()
          break
        case '-':
          handleZoomOut()
          break
        case 'r':
        case 'R':
          handleRotate()
          break
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    // Prevent body scroll when lightbox is open
    document.body.style.overflow = 'hidden'

    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      document.body.style.overflow = ''
    }
  }, [onClose, handleZoomIn, handleZoomOut, handleRotate])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
      onClick={handleBackdropClick}
    >
      {/* Toolbar */}
      <div className="absolute top-4 right-4 flex items-center gap-2 z-10">
        <Button
          variant="ghost"
          size="icon"
          onClick={handleZoomOut}
          className="h-10 w-10 bg-black/50 hover:bg-black/70 text-white"
          title="Zoom out (-)"
        >
          <ZoomOut className="h-5 w-5" />
        </Button>
        <span className="text-white text-sm bg-black/50 px-2 py-1 rounded">
          {Math.round(scale * 100)}%
        </span>
        <Button
          variant="ghost"
          size="icon"
          onClick={handleZoomIn}
          className="h-10 w-10 bg-black/50 hover:bg-black/70 text-white"
          title="Zoom in (+)"
        >
          <ZoomIn className="h-5 w-5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={handleRotate}
          className="h-10 w-10 bg-black/50 hover:bg-black/70 text-white"
          title="Rotate (R)"
        >
          <RotateCw className="h-5 w-5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={handleDownload}
          className="h-10 w-10 bg-black/50 hover:bg-black/70 text-white"
          title="Download"
        >
          <Download className="h-5 w-5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={handleOpenInNewTab}
          className="h-10 w-10 bg-black/50 hover:bg-black/70 text-white"
          title="Open in new tab"
        >
          <ExternalLink className="h-5 w-5" />
        </Button>
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

      {/* Image container */}
      <div className="max-w-[90vw] max-h-[90vh] overflow-auto">
        <img
          src={src}
          alt={alt}
          className="transition-transform duration-200 ease-out"
          style={{
            transform: `scale(${scale}) rotate(${rotation}deg)`,
            maxWidth: scale === 1 ? '90vw' : 'none',
            maxHeight: scale === 1 ? '90vh' : 'none',
          }}
          draggable={false}
        />
      </div>

      {/* Filename at bottom */}
      <div className="absolute bottom-4 left-1/2 -translate-x-1/2 text-white text-sm bg-black/50 px-4 py-2 rounded-lg max-w-[80vw] truncate">
        {alt || src}
      </div>
    </div>
  )
}

/**
 * Image preview component for inline display with Lightbox support
 * Used in chat messages to display image URLs
 */
export default function ImagePreview({
  src,
  alt,
  className,
  maxWidth = 300,
  maxHeight = 200,
  onError,
}: ImagePreviewProps) {
  const [showLightbox, setShowLightbox] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [hasError, setHasError] = useState(false)

  const handleImageClick = useCallback(() => {
    if (!hasError) {
      setShowLightbox(true)
    }
  }, [hasError])

  const handleCloseLightbox = useCallback(() => {
    setShowLightbox(false)
  }, [])

  const handleImageLoad = useCallback(() => {
    setIsLoading(false)
    setHasError(false)
  }, [])

  const handleImageError = useCallback(() => {
    setIsLoading(false)
    setHasError(true)
    onError?.()
  }, [onError])

  const handleOpenLink = useCallback(() => {
    window.open(src, '_blank', 'noopener,noreferrer')
  }, [src])

  // Show error fallback
  if (hasError) {
    return (
      <a
        href={src}
        target="_blank"
        rel="noopener noreferrer"
        className={cn(
          'inline-flex items-center gap-2 px-3 py-2 rounded-lg',
          'bg-surface border border-border hover:border-primary',
          'text-sm text-link hover:underline transition-colors',
          className
        )}
        onClick={(e) => {
          e.stopPropagation()
        }}
      >
        <ImageOff className="h-4 w-4 text-text-muted" />
        <span className="truncate max-w-[250px]">{alt || src}</span>
        <ExternalLink className="h-3 w-3 text-text-muted" />
      </a>
    )
  }

  return (
    <>
      <div
        className={cn(
          'relative inline-block rounded-lg overflow-hidden',
          'border border-border hover:border-primary',
          'cursor-pointer transition-colors',
          className
        )}
        style={{ maxWidth, maxHeight }}
        onClick={handleImageClick}
      >
        {/* Loading state */}
        {isLoading && (
          <div
            className="flex items-center justify-center bg-muted"
            style={{ width: 150, height: 100 }}
          >
            <Loader2 className="h-6 w-6 animate-spin text-text-muted" />
          </div>
        )}

        {/* Image */}
        <img
          src={src}
          alt={alt || 'Image preview'}
          className={cn(
            'object-contain bg-muted',
            isLoading && 'hidden'
          )}
          style={{ maxWidth, maxHeight }}
          onLoad={handleImageLoad}
          onError={handleImageError}
          draggable={false}
        />

        {/* Hover overlay */}
        {!isLoading && (
          <div className="absolute inset-0 bg-black/0 hover:bg-black/10 transition-colors flex items-center justify-center opacity-0 hover:opacity-100">
            <ZoomIn className="h-8 w-8 text-white drop-shadow-lg" />
          </div>
        )}
      </div>

      {/* Lightbox modal */}
      {showLightbox && (
        <ImageLightbox src={src} alt={alt || 'Image'} onClose={handleCloseLightbox} />
      )}
    </>
  )
}

// Also export the Lightbox component for direct use
export { ImageLightbox }
