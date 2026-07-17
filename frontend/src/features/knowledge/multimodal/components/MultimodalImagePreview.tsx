// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Image viewer for image-type KB documents (multimodal pipeline).
 *
 * Encapsulates authenticated blob fetching, zoom/rotate overlay, and inline
 * preview rendering. Extracted from the open-source DocumentContentViewer so
 * that file stays free of multimodal UI (~250 lines).
 *
 * Pattern follows knowledge-permission-ui subcomponents.
 */

import { useCallback, useEffect, useState, type CSSProperties, type SyntheticEvent } from 'react'
import { createPortal } from 'react-dom'
import { ZoomIn, ZoomOut, RotateCw, X } from 'lucide-react'
import { Spinner } from '@/components/ui/spinner'
import { Button } from '@/components/ui/button'
import { isImageExtension, getAttachmentPreviewUrl } from '@/apis/attachments'
import { getToken } from '@/apis/user'

/**
 * Detect if a document is an image-type multimodal document.
 * document.file_extension is stored dot-less (e.g. "jpg"), while
 * isImageExtension expects a leading dot — normalize before checking.
 */
export function isImageDocument(
  document: { file_extension?: string; attachment_id?: number | null } | null | undefined
): boolean {
  if (!document || !document.attachment_id) return false
  const ext = document.file_extension?.trim().toLowerCase() || ''
  const dottedExt = ext.startsWith('.') ? ext : `.${ext}`
  return isImageExtension(dottedExt)
}

/** Fetch the authenticated image blob URL ONCE (stable, no re-fetch on re-render). */
function useImageBlob(
  attachmentId: number,
  enabled: boolean
): {
  blobUrl: string | null
  isLoading: boolean
  error: boolean
} {
  const [blobUrl, setBlobUrl] = useState<string | null>(null)
  // Start in the loading state when enabled so the spinner shows immediately,
  // instead of a brief error/placeholder flash before the effect runs.
  const [isLoading, setIsLoading] = useState(enabled)
  const [error, setError] = useState(false)

  useEffect(() => {
    if (!enabled) return
    let isMounted = true
    let createdUrl: string | null = null

    const fetchImage = async () => {
      setIsLoading(true)
      setError(false)
      try {
        const token = getToken()
        const response = await fetch(getAttachmentPreviewUrl(attachmentId), {
          headers: { ...(token && { Authorization: `Bearer ${token}` }) },
        })
        if (!response.ok) throw new Error(`Failed to fetch image: ${response.status}`)
        const blob = await response.blob()
        if (isMounted) {
          createdUrl = URL.createObjectURL(blob)
          setBlobUrl(createdUrl)
        }
      } catch {
        if (isMounted) setError(true)
      } finally {
        if (isMounted) setIsLoading(false)
      }
    }

    fetchImage()

    return () => {
      isMounted = false
      if (createdUrl) URL.revokeObjectURL(createdUrl)
    }
  }, [attachmentId, enabled])

  return { blobUrl, isLoading, error }
}

/** Self-contained zoom overlay portaled to document.body. */
function ImageZoomOverlay({
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
  const [naturalSize, setNaturalSize] = useState<{ width: number; height: number } | null>(null)

  const handleZoomIn = useCallback(
    () => setScale(prev => Math.min(+(prev + 0.05).toFixed(2), 5)),
    []
  )
  const handleZoomOut = useCallback(
    () => setScale(prev => Math.max(+(prev - 0.05).toFixed(2), 0.1)),
    []
  )
  const handleRotate = useCallback(() => setRotation(prev => (prev + 90) % 360), [])

  const handleImgLoad = useCallback((e: SyntheticEvent<HTMLImageElement>) => {
    const t = e.currentTarget
    setNaturalSize({ width: t.naturalWidth, height: t.naturalHeight })
  }, [])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [onClose])

  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [])

  if (typeof document === 'undefined') return null

  const maxW = window.innerWidth * 0.9
  const maxH = window.innerHeight * 0.9
  const fitRatio = naturalSize
    ? Math.min(maxW / naturalSize.width, maxH / naturalSize.height, 1)
    : 0
  const imgStyle: CSSProperties = naturalSize
    ? {
        width: naturalSize.width * fitRatio * scale,
        height: naturalSize.height * fitRatio * scale,
        transform: `rotate(${rotation}deg)`,
        transformOrigin: 'center center',
      }
    : {
        maxWidth: '90vw',
        maxHeight: '90vh',
        transform: `rotate(${rotation}deg)`,
        transformOrigin: 'center center',
      }

  return createPortal(
    <div
      className="fixed inset-0 z-[9999] flex bg-black/80 backdrop-blur-sm overflow-auto"
      style={{ pointerEvents: 'auto' }}
      role="dialog"
      aria-modal="true"
      aria-label={alt}
      onPointerDown={e => e.stopPropagation()}
      onClick={onClose}
      onWheel={e => e.stopPropagation()}
    >
      <div
        className="fixed top-4 right-4 flex items-center gap-2 z-10"
        onClick={e => e.stopPropagation()}
      >
        <Button
          variant="ghost"
          size="icon"
          onClick={handleZoomOut}
          className="h-10 w-10 bg-black/50 hover:bg-black/70 text-white"
          title="Zoom out"
          data-testid="image-zoom-out"
        >
          <ZoomOut className="h-5 w-5" />
        </Button>
        <span className="text-white text-sm bg-black/50 px-2 py-1 rounded min-w-[3rem] text-center">
          {Math.round(scale * 100)}%
        </span>
        <Button
          variant="ghost"
          size="icon"
          onClick={handleZoomIn}
          className="h-10 w-10 bg-black/50 hover:bg-black/70 text-white"
          title="Zoom in"
          data-testid="image-zoom-in"
        >
          <ZoomIn className="h-5 w-5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={handleRotate}
          className="h-10 w-10 bg-black/50 hover:bg-black/70 text-white"
          title="Rotate"
          data-testid="image-rotate"
        >
          <RotateCw className="h-5 w-5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={onClose}
          className="h-10 w-10 bg-black/50 hover:bg-black/70 text-white"
          title="Close"
          data-testid="image-zoom-close"
        >
          <X className="h-5 w-5" />
        </Button>
      </div>

      <div className="m-auto shrink-0 p-4" onClick={e => e.stopPropagation()}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt={alt}
          draggable={false}
          onLoad={handleImgLoad}
          className="transition-transform duration-150 ease-out select-none"
          style={imgStyle}
        />
      </div>

      <div className="fixed bottom-4 left-1/2 -translate-x-1/2 text-white text-sm bg-black/50 px-4 py-2 rounded-lg max-w-[80vw] truncate">
        {alt}
      </div>
    </div>,
    document.body
  )
}

/**
 * Inline image preview for image-type documents.
 * Renders the image with a zoom-on-click overlay.
 */
export function MultimodalImagePreview({
  attachmentId,
  alt,
}: {
  attachmentId: number
  alt: string
}) {
  const { blobUrl, isLoading, error } = useImageBlob(attachmentId, true)
  const [showZoom, setShowZoom] = useState(false)

  if (isLoading) {
    return (
      <div
        className="flex items-center justify-center bg-surface animate-pulse rounded-lg"
        style={{ minWidth: 200, minHeight: 120 }}
      >
        <Spinner />
      </div>
    )
  }
  if (error || !blobUrl) {
    return (
      <div className="flex items-center justify-center bg-surface rounded-lg text-xs text-text-muted p-4">
        <span>{alt}</span>
      </div>
    )
  }

  return (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={blobUrl}
        alt={alt}
        tabIndex={0}
        role="button"
        data-testid="multimodal-image-preview"
        onKeyDown={e => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            setShowZoom(true)
          }
        }}
        onClick={() => setShowZoom(true)}
        loading="lazy"
        className="cursor-zoom-in rounded-lg border border-border max-h-[600px] max-w-full h-auto hover:border-primary transition-colors"
      />
      {showZoom && <ImageZoomOverlay src={blobUrl} alt={alt} onClose={() => setShowZoom(false)} />}
    </>
  )
}
