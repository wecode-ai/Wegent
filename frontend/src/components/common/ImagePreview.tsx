// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useState, useCallback, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { Download, X, ZoomIn, ZoomOut, RotateCw, ExternalLink, AlertCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useShareToken } from '@/contexts/ShareTokenContext'
import { getToken } from '@/apis/user'

interface ImagePreviewProps {
  /** The image URL to display */
  src: string
  /** Alt text for the image */
  alt?: string
  /** Maximum width of the thumbnail */
  maxWidth?: number
  /** Maximum height of the thumbnail */
  maxHeight?: number
  /** Whether to show the image inline (true) or as a link (false) on error */
  showLinkOnError?: boolean
}

/**
 * Check if a URL is an attachment download URL
 * @param url - URL to check
 * @returns true if it's an attachment URL
 */
function isAttachmentUrl(url: string): boolean {
  return /^\/api\/attachments\/\d+\/download/.test(url)
}

/**
 * Fetch image with authentication and convert to Blob URL
 * For attachment URLs, adds Authorization header or share_token
 * @param url - Image URL
 * @param shareToken - Optional share token for public access
 * @returns Blob URL or original URL if fetch fails
 */
async function fetchAuthenticatedImage(url: string, shareToken?: string): Promise<string> {
  // Only handle attachment URLs
  if (!isAttachmentUrl(url)) {
    return url
  }

  try {
    const token = getToken()
    let fetchUrl = url

    // Build headers
    const headers: HeadersInit = {}

    if (shareToken) {
      // Use share token in URL query parameter
      fetchUrl = `${url}?share_token=${encodeURIComponent(shareToken)}`
    } else if (token) {
      // Use Authorization header
      headers.Authorization = `Bearer ${token}`
    }

    const response = await fetch(fetchUrl, {
      method: 'GET',
      headers,
    })

    if (!response.ok) {
      throw new Error(`Failed to fetch image: ${response.status}`)
    }

    const blob = await response.blob()
    return URL.createObjectURL(blob)
  } catch (error) {
    console.error('Failed to fetch authenticated image:', error)
    return url // Fallback to original URL
  }
}

/**
 * Full screen image preview modal component (Lightbox)
 */
function ImageLightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  const { shareToken } = useShareToken()
  const [scale, setScale] = useState(1)
  const [rotation, setRotation] = useState(0)
  const [blobUrl, setBlobUrl] = useState<string | null>(null)

  // Fetch authenticated image on mount
  useEffect(() => {
    let mounted = true
    let currentBlobUrl: string | null = null

    const loadImage = async () => {
      const url = await fetchAuthenticatedImage(src, shareToken)
      if (mounted) {
        currentBlobUrl = url
        setBlobUrl(url)
      }
    }

    loadImage()

    return () => {
      mounted = false
      // Clean up blob URL
      if (currentBlobUrl && currentBlobUrl.startsWith('blob:')) {
        URL.revokeObjectURL(currentBlobUrl)
      }
    }
  }, [src, shareToken])

  const displaySrc = blobUrl || src

  // For attachment URLs, wait for blobUrl before rendering image
  const shouldWaitForBlob = isAttachmentUrl(src) && !blobUrl

  const handleZoomIn = useCallback(() => {
    setScale(prev => Math.min(prev + 0.25, 3))
  }, [])

  const handleZoomOut = useCallback(() => {
    setScale(prev => Math.max(prev - 0.25, 0.5))
  }, [])

  const handleRotate = useCallback(() => {
    setRotation(prev => (prev + 90) % 360)
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
    link.href = displaySrc
    link.download = alt || 'image'
    link.target = '_blank'
    link.rel = 'noopener noreferrer'
    link.click()
  }, [displaySrc, alt])

  const handleOpenInNewTab = useCallback(() => {
    window.open(displaySrc, '_blank', 'noopener,noreferrer')
  }, [displaySrc])

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
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/80 backdrop-blur-sm"
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
        {/* Show loading state while waiting for blob */}
        {shouldWaitForBlob ? (
          <div className="flex items-center justify-center bg-muted animate-pulse rounded-lg" style={{ minWidth: 300, minHeight: 200 }}>
            <span className="text-text-secondary text-sm">Loading image...</span>
          </div>
        ) : (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            src={displaySrc}
            alt={alt}
            className="transition-transform duration-200 ease-out"
            style={{
              transform: `scale(${scale}) rotate(${rotation}deg)`,
              maxWidth: scale === 1 ? '90vw' : 'none',
              maxHeight: scale === 1 ? '90vh' : 'none',
            }}
            draggable={false}
          />
        )}
      </div>

      {/* Filename at bottom */}
      <div className="absolute bottom-4 left-1/2 -translate-x-1/2 text-white text-sm bg-black/50 px-4 py-2 rounded-lg max-w-[80vw] truncate">
        {alt || src}
      </div>
    </div>
  )
}

/**
 * ImagePreview component for rendering image URLs in chat messages.
 * Shows an inline thumbnail that can be clicked to open a Lightbox.
 * Falls back to a clickable link on load error.
 */
export default function ImagePreview({
  src,
  alt,
  maxWidth = 600,
  maxHeight = 400,
  showLinkOnError = true,
}: ImagePreviewProps) {
  const { shareToken } = useShareToken()
  const [showLightbox, setShowLightbox] = useState(false)
  const [hasError, setHasError] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [blobUrl, setBlobUrl] = useState<string | null>(null)

  // Fetch authenticated image on mount
  useEffect(() => {
    let mounted = true
    let currentBlobUrl: string | null = null

    const loadImage = async () => {
      const url = await fetchAuthenticatedImage(src, shareToken)
      if (mounted) {
        currentBlobUrl = url
        setBlobUrl(url)
      }
    }

    loadImage()

    return () => {
      mounted = false
      // Clean up blob URL
      if (currentBlobUrl && currentBlobUrl.startsWith('blob:')) {
        URL.revokeObjectURL(currentBlobUrl)
      }
    }
  }, [src, shareToken])

  const displaySrc = blobUrl || src

  // For attachment URLs, wait for blobUrl before rendering image
  // Otherwise, img tag will try to load without auth and fail
  const shouldWaitForBlob = isAttachmentUrl(src) && !blobUrl

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
  }, [])

  // If there's an error loading the image, show a fallback link
  if (hasError && showLinkOnError) {
    return (
      <a
        href={displaySrc}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1.5 text-primary hover:underline text-sm"
      >
        <AlertCircle className="h-4 w-4" />
        <span className="truncate max-w-[200px]">{alt || src}</span>
        <ExternalLink className="h-3 w-3 flex-shrink-0" />
      </a>
    )
  }

  return (
    <>
      {/* Use span instead of div to avoid hydration error when rendered inside <p> tags */}
      <span className="relative inline-block my-2">
        {/* Loading skeleton - show while fetching blob or initial loading */}
        {(isLoading || shouldWaitForBlob) && (
          <span
            className="absolute inset-0 bg-muted animate-pulse rounded-lg block"
            style={{ maxWidth, maxHeight, minWidth: 100, minHeight: 60 }}
          />
        )}

        {/* Image thumbnail - only render when ready */}
        {!shouldWaitForBlob && (
          <span
            className={`cursor-pointer rounded-lg overflow-hidden border border-border hover:border-primary transition-colors block ${isLoading ? 'opacity-0' : 'opacity-100'
              }`}
            onClick={handleImageClick}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={displaySrc}
              alt={alt || 'Image preview'}
              className="object-contain bg-muted"
              style={{ maxWidth, maxHeight }}
              onLoad={handleImageLoad}
              onError={handleImageError}
              loading="lazy"
            />
          </span>
        )}
      </span>
      {/* Lightbox modal - rendered via Portal to avoid HTML nesting issues */}
      {showLightbox &&
        typeof document !== 'undefined' &&
        createPortal(
          <ImageLightbox src={src} alt={alt || 'Image'} onClose={handleCloseLightbox} />,
          document.body
        )}
    </>
  )
}
