import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { FileText, Loader2, RotateCcw, X, ZoomIn, ZoomOut } from 'lucide-react'
import type { Attachment } from '@/types/api'
import { getAttachmentImageUrl } from '@/lib/attachments'

interface AttachmentImagePreviewProps {
  attachment: Attachment
  buttonTestId: string
  imageTestId: string
  loadingTestId: string
  errorTestId: string
  imageClassName: string
  placeholderClassName: string
  buttonClassName?: string
}

const MIN_ZOOM = 0.5
const MAX_ZOOM = 4
const ZOOM_STEP = 0.25

function clampZoom(value: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value))
}

export function AttachmentImagePreview({
  attachment,
  buttonTestId,
  imageTestId,
  loadingTestId,
  errorTestId,
  imageClassName,
  placeholderClassName,
  buttonClassName = 'block max-w-full cursor-zoom-in p-0 text-left',
}: AttachmentImagePreviewProps) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [hasError, setHasError] = useState(false)
  const [isLightboxOpen, setIsLightboxOpen] = useState(false)
  const [zoom, setZoom] = useState(1)

  useEffect(() => {
    let isMounted = true
    let objectUrl: string | null = null

    async function loadPreview() {
      setPreviewUrl(null)
      setHasError(false)
      setIsLightboxOpen(false)
      setZoom(1)

      try {
        const token = localStorage.getItem('auth_token')
        const response = await fetch(getAttachmentImageUrl(attachment.id), {
          headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        })

        if (!response.ok) {
          throw new Error(`Failed to load attachment preview: ${response.status}`)
        }

        const blob = await response.blob()
        if (!blob.type.startsWith('image/')) {
          throw new Error(`Attachment preview is not an image: ${blob.type || 'unknown'}`)
        }

        objectUrl = URL.createObjectURL(blob)
        if (isMounted) {
          setPreviewUrl(objectUrl)
        } else {
          URL.revokeObjectURL(objectUrl)
        }
      } catch {
        if (isMounted) {
          setHasError(true)
        }
      }
    }

    void loadPreview()

    return () => {
      isMounted = false
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl)
      }
    }
  }, [attachment.id])

  useEffect(() => {
    if (!isLightboxOpen) return

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsLightboxOpen(false)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isLightboxOpen])

  if (previewUrl) {
    const lightbox =
      isLightboxOpen && typeof document !== 'undefined'
        ? createPortal(
            <div
              data-testid="attachment-image-lightbox"
              role="dialog"
              aria-modal="true"
              aria-label={attachment.filename}
              className="fixed inset-0 z-modal flex h-dvh w-dvw items-center justify-center overflow-hidden bg-black/90 p-0"
              onClick={() => setIsLightboxOpen(false)}
              onWheel={event => {
                event.stopPropagation()
                setZoom(current => clampZoom(current + (event.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP)))
              }}
            >
              <div
                data-testid="attachment-image-zoom-controls"
                className="absolute left-1/2 top-4 z-10 flex -translate-x-1/2 items-center gap-1 rounded-full bg-black/45 p-1 text-white shadow-[0_12px_36px_rgba(0,0,0,0.35)]"
                onClick={event => event.stopPropagation()}
              >
                <button
                  type="button"
                  data-testid="attachment-image-zoom-out"
                  className="flex h-10 w-10 items-center justify-center rounded-full text-white transition-colors hover:bg-white/15 disabled:cursor-not-allowed disabled:opacity-40"
                  onClick={() => setZoom(current => clampZoom(current - ZOOM_STEP))}
                  disabled={zoom <= MIN_ZOOM}
                  aria-label="Zoom out"
                >
                  <ZoomOut className="h-5 w-5" />
                </button>
                <button
                  type="button"
                  data-testid="attachment-image-zoom-reset"
                  className="flex h-10 w-10 items-center justify-center rounded-full text-white transition-colors hover:bg-white/15"
                  onClick={() => setZoom(1)}
                  aria-label="Reset zoom"
                >
                  <RotateCcw className="h-5 w-5" />
                </button>
                <button
                  type="button"
                  data-testid="attachment-image-zoom-in"
                  className="flex h-10 w-10 items-center justify-center rounded-full text-white transition-colors hover:bg-white/15 disabled:cursor-not-allowed disabled:opacity-40"
                  onClick={() => setZoom(current => clampZoom(current + ZOOM_STEP))}
                  disabled={zoom >= MAX_ZOOM}
                  aria-label="Zoom in"
                >
                  <ZoomIn className="h-5 w-5" />
                </button>
              </div>
              <button
                type="button"
                data-testid="attachment-image-lightbox-close"
                className="absolute right-4 top-4 z-20 flex h-10 w-10 items-center justify-center rounded-full bg-white/15 text-white transition-colors hover:bg-white/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
                onClick={event => {
                  event.stopPropagation()
                  setIsLightboxOpen(false)
                }}
                aria-label="Close image preview"
              >
                <X className="h-5 w-5" />
              </button>
              <img
                data-testid="attachment-image-lightbox-image"
                src={previewUrl}
                alt={attachment.filename}
                className="max-h-[calc(100dvh-6rem)] max-w-[calc(100dvw-2rem)] object-contain transition-transform duration-150 ease-out"
                style={{ transform: `scale(${zoom})` }}
                onClick={event => event.stopPropagation()}
              />
            </div>,
            document.body
          )
        : null

    return (
      <>
        <button
          type="button"
          data-testid={buttonTestId}
          className={buttonClassName}
          onClick={() => setIsLightboxOpen(true)}
          aria-label={attachment.filename}
        >
          <img
            data-testid={imageTestId}
            src={previewUrl}
            alt={attachment.filename}
            className={imageClassName}
          />
        </button>
        {lightbox}
      </>
    )
  }

  return (
    <div
      data-testid={hasError ? errorTestId : loadingTestId}
      className={placeholderClassName}
      aria-label={attachment.filename}
    >
      {hasError ? <FileText className="h-5 w-5" /> : <Loader2 className="h-5 w-5 animate-spin" />}
    </div>
  )
}
