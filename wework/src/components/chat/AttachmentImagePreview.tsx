import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { invoke } from '@tauri-apps/api/core'
import {
  ChevronLeft,
  ChevronRight,
  Download,
  FileText,
  Loader2,
  Minus,
  Plus,
  X,
} from 'lucide-react'
import type { Attachment } from '@/types/api'
import { getAttachmentImageUrl } from '@/lib/attachments'
import { isTauriRuntime } from '@/lib/runtime-environment'
import {
  localPathFromMarkdownImageSrc,
  resolveDirectMarkdownImageSrc,
} from './assistantMarkdownLinks'

interface AttachmentImagePreviewProps {
  attachment: Attachment
  buttonTestId: string
  imageTestId: string
  loadingTestId: string
  errorTestId: string
  imageClassName: string
  placeholderClassName: string
  buttonClassName?: string
  disableLightbox?: boolean
  galleryAttachments?: Attachment[]
  galleryIndex?: number
  hideOnError?: boolean
}

const MIN_ZOOM = 0.5
const MAX_ZOOM = 4
const ZOOM_STEP = 0.25
const failedAttachmentPreviewUrls = new Set<string>()
const resolvedLocalAttachmentPreviewUrls = new Map<string, string>()

function clampZoom(value: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value))
}

function clampIndex(value: number, length: number): number {
  if (length <= 0) return 0
  return Math.min(length - 1, Math.max(0, value))
}

async function loadAttachmentImageUrl(
  attachment: Attachment
): Promise<{ url: string; objectUrl: string | null }> {
  if (attachment.local_preview_url) {
    const cachedLocalPreviewUrl = resolvedLocalAttachmentPreviewUrls.get(
      attachment.local_preview_url
    )
    if (cachedLocalPreviewUrl) {
      return { url: cachedLocalPreviewUrl, objectUrl: null }
    }

    if (failedAttachmentPreviewUrls.has(attachment.local_preview_url)) {
      throw new Error('Local attachment preview already failed')
    }

    const localPath = getDownloadableLocalPath(attachment.local_preview_url)
    if (localPath && isTauriRuntime()) {
      try {
        const exists = await invoke<boolean>('local_path_exists', { path: localPath })
        if (!exists) {
          failedAttachmentPreviewUrls.add(attachment.local_preview_url)
          throw new Error('Local attachment preview no longer exists')
        }
      } catch (error) {
        if (failedAttachmentPreviewUrls.has(attachment.local_preview_url)) {
          throw error
        }
      }
    }

    const resolvedLocalPreviewUrl = resolveDirectMarkdownImageSrc(attachment.local_preview_url)
    if (!resolvedLocalPreviewUrl) {
      throw new Error('Failed to resolve local attachment preview')
    }
    resolvedLocalAttachmentPreviewUrls.set(attachment.local_preview_url, resolvedLocalPreviewUrl)
    return { url: resolvedLocalPreviewUrl, objectUrl: null }
  }

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

  const objectUrl = URL.createObjectURL(blob)
  return { url: objectUrl, objectUrl }
}

function rememberFailedAttachmentPreview(attachment: Attachment) {
  if (attachment.local_preview_url) {
    failedAttachmentPreviewUrls.add(attachment.local_preview_url)
  }
}

function triggerDownload(url: string, filename: string) {
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.rel = 'noopener'
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
}

async function downloadImage(url: string, filename: string) {
  try {
    const response = await fetch(url)
    if (!response.ok) {
      throw new Error(`Failed to download image: ${response.status}`)
    }

    const blob = await response.blob()
    const objectUrl = URL.createObjectURL(blob)
    triggerDownload(objectUrl, filename)
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0)
  } catch {
    triggerDownload(url, filename)
  }
}

function getDownloadableLocalPath(value?: string): string | null {
  if (!value) return null
  if (/^(asset|blob|data|https?):/i.test(value)) return null

  const localPath = localPathFromMarkdownImageSrc(value)
  if (localPath.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(localPath)) {
    return localPath
  }

  return null
}

async function downloadAttachmentImage(attachment: Attachment, imageUrl: string) {
  const sourcePath = getDownloadableLocalPath(attachment.local_preview_url)
  if (sourcePath && isTauriRuntime()) {
    await invoke<string>('download_local_file_to_downloads', {
      sourcePath,
      filename: attachment.filename,
    })
    return
  }

  await downloadImage(imageUrl, attachment.filename)
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
  disableLightbox = false,
  galleryAttachments,
  galleryIndex = 0,
  hideOnError = false,
}: AttachmentImagePreviewProps) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [hasError, setHasError] = useState(false)
  const [isLightboxOpen, setIsLightboxOpen] = useState(false)
  const [lightboxIndex, setLightboxIndex] = useState(galleryIndex)
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null)
  const [isLightboxLoading, setIsLightboxLoading] = useState(false)
  const [hasLightboxError, setHasLightboxError] = useState(false)
  const [zoom, setZoom] = useState(1)
  const [shouldLoadPreview, setShouldLoadPreview] = useState(false)
  const previewContainerRef = useRef<HTMLElement | null>(null)
  const previewIdentity = `${attachment.id}:${attachment.local_preview_url ?? ''}`
  const setPreviewContainerRef = useCallback((element: HTMLElement | null) => {
    previewContainerRef.current = element
  }, [])
  const gallery = useMemo(
    () => (galleryAttachments?.length ? galleryAttachments : [attachment]),
    [attachment, galleryAttachments]
  )
  const currentLightboxAttachment = gallery[clampIndex(lightboxIndex, gallery.length)] ?? attachment
  const canNavigateLightbox = gallery.length > 1

  /* eslint-disable react-hooks/set-state-in-effect -- Attachment identity changes must clear stale preview UI before loading the next image. */
  useEffect(() => {
    setShouldLoadPreview(false)
    setPreviewUrl(null)
    setHasError(false)
    setIsLightboxOpen(false)
    setLightboxUrl(null)
    setZoom(1)
  }, [previewIdentity])
  /* eslint-enable react-hooks/set-state-in-effect */

  useEffect(() => {
    if (shouldLoadPreview) return undefined

    const element = previewContainerRef.current
    if (!element || typeof IntersectionObserver === 'undefined') {
      setShouldLoadPreview(true)
      return undefined
    }

    const observer = new IntersectionObserver(
      entries => {
        if (entries.some(entry => entry.isIntersecting || entry.intersectionRatio > 0)) {
          setShouldLoadPreview(true)
          observer.disconnect()
        }
      },
      { root: null, rootMargin: '320px 0px' }
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [previewIdentity, shouldLoadPreview])

  useEffect(() => {
    if (!shouldLoadPreview) return undefined

    let isMounted = true
    let objectUrl: string | null = null

    async function loadPreview() {
      setPreviewUrl(null)
      setHasError(false)
      setIsLightboxOpen(false)
      setLightboxUrl(null)
      setZoom(1)

      try {
        const loaded = await loadAttachmentImageUrl(attachment)
        objectUrl = loaded.objectUrl
        if (isMounted) {
          setPreviewUrl(loaded.url)
        } else if (objectUrl) {
          URL.revokeObjectURL(objectUrl)
        }
      } catch {
        if (isMounted) {
          rememberFailedAttachmentPreview(attachment)
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
  }, [attachment, shouldLoadPreview])

  useEffect(() => {
    if (!isLightboxOpen || disableLightbox) return

    let isMounted = true
    let objectUrl: string | null = null
    const nextIndex = clampIndex(lightboxIndex, gallery.length)
    const selectedAttachment = gallery[nextIndex] ?? attachment
    const reusablePreviewUrl =
      selectedAttachment.id === attachment.id &&
      selectedAttachment.local_preview_url === attachment.local_preview_url
        ? previewUrl
        : null

    async function loadLightboxImage() {
      setZoom(1)
      setHasLightboxError(false)

      if (reusablePreviewUrl) {
        setIsLightboxLoading(false)
        setLightboxUrl(reusablePreviewUrl)
        return
      }

      setIsLightboxLoading(true)
      setLightboxUrl(null)

      try {
        const loaded = await loadAttachmentImageUrl(selectedAttachment)
        objectUrl = loaded.objectUrl
        if (isMounted) {
          setLightboxUrl(loaded.url)
          setIsLightboxLoading(false)
        } else if (objectUrl) {
          URL.revokeObjectURL(objectUrl)
        }
      } catch {
        if (isMounted) {
          rememberFailedAttachmentPreview(selectedAttachment)
          setIsLightboxLoading(false)
          setHasLightboxError(true)
        }
      }
    }

    void loadLightboxImage()

    return () => {
      isMounted = false
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl)
      }
    }
  }, [attachment, disableLightbox, gallery, isLightboxOpen, lightboxIndex, previewUrl])

  useEffect(() => {
    if (!isLightboxOpen || disableLightbox) return

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsLightboxOpen(false)
        return
      }

      if (event.key === 'ArrowLeft' && canNavigateLightbox) {
        event.preventDefault()
        setLightboxIndex(current => (current <= 0 ? gallery.length - 1 : current - 1))
        return
      }

      if (event.key === 'ArrowRight' && canNavigateLightbox) {
        event.preventDefault()
        setLightboxIndex(current => (current >= gallery.length - 1 ? 0 : current + 1))
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [canNavigateLightbox, disableLightbox, gallery.length, isLightboxOpen])

  const openLightbox = () => {
    setLightboxIndex(clampIndex(galleryIndex, gallery.length))
    setLightboxUrl(null)
    setHasLightboxError(false)
    setIsLightboxOpen(true)
  }

  const goToPreviousImage = () => {
    setLightboxIndex(current => (current <= 0 ? gallery.length - 1 : current - 1))
  }

  const goToNextImage = () => {
    setLightboxIndex(current => (current >= gallery.length - 1 ? 0 : current + 1))
  }

  if (previewUrl) {
    const lightbox =
      !disableLightbox && isLightboxOpen && typeof document !== 'undefined'
        ? createPortal(
            <div
              data-testid="attachment-image-lightbox"
              role="dialog"
              aria-modal="true"
              aria-label={currentLightboxAttachment.filename}
              className="fixed inset-0 z-modal flex h-dvh w-dvw items-center justify-center overflow-hidden bg-black/90 p-0"
              onClick={() => setIsLightboxOpen(false)}
              onWheel={event => {
                event.stopPropagation()
                setZoom(current => clampZoom(current + (event.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP)))
              }}
            >
              <div className="absolute right-4 top-4 z-20 flex items-center gap-2.5">
                <button
                  type="button"
                  data-testid="attachment-image-download"
                  className="flex h-12 w-12 items-center justify-center rounded-full bg-white/15 text-white transition-colors hover:bg-white/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 disabled:cursor-not-allowed disabled:opacity-50"
                  onClick={event => {
                    event.stopPropagation()
                    if (lightboxUrl) {
                      void downloadAttachmentImage(currentLightboxAttachment, lightboxUrl)
                    }
                  }}
                  disabled={!lightboxUrl}
                  aria-label="Download image"
                >
                  <Download className="h-5 w-5" />
                </button>
                <button
                  type="button"
                  data-testid="attachment-image-lightbox-close"
                  className="flex h-12 w-12 items-center justify-center rounded-full bg-white/15 text-white transition-colors hover:bg-white/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
                  onClick={event => {
                    event.stopPropagation()
                    setIsLightboxOpen(false)
                  }}
                  aria-label="Close image preview"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
              {canNavigateLightbox && (
                <>
                  <button
                    type="button"
                    data-testid="attachment-image-previous"
                    className="absolute left-5 top-1/2 z-20 flex h-12 w-12 -translate-y-1/2 items-center justify-center rounded-full bg-white/15 text-white transition-colors hover:bg-white/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
                    onClick={event => {
                      event.stopPropagation()
                      goToPreviousImage()
                    }}
                    aria-label="Previous image"
                  >
                    <ChevronLeft className="h-7 w-7" />
                  </button>
                  <button
                    type="button"
                    data-testid="attachment-image-next"
                    className="absolute right-5 top-1/2 z-20 flex h-12 w-12 -translate-y-1/2 items-center justify-center rounded-full bg-white/15 text-white transition-colors hover:bg-white/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
                    onClick={event => {
                      event.stopPropagation()
                      goToNextImage()
                    }}
                    aria-label="Next image"
                  >
                    <ChevronRight className="h-7 w-7" />
                  </button>
                </>
              )}
              <div
                data-testid="attachment-image-zoom-controls"
                className="absolute bottom-6 left-1/2 z-20 flex h-11 -translate-x-1/2 items-center gap-2.5 rounded-full bg-white/15 px-1.5 text-white shadow-[0_12px_36px_rgba(0,0,0,0.35)]"
                onClick={event => event.stopPropagation()}
              >
                <button
                  type="button"
                  data-testid="attachment-image-zoom-out"
                  className="flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20 disabled:cursor-not-allowed disabled:opacity-40"
                  onClick={() => setZoom(current => clampZoom(current - ZOOM_STEP))}
                  disabled={zoom <= MIN_ZOOM}
                  aria-label="Zoom out"
                >
                  <Minus className="h-[18px] w-[18px]" />
                </button>
                <span
                  data-testid="attachment-image-zoom-value"
                  className="min-w-14 select-none text-center text-base font-medium tabular-nums text-white"
                >
                  {Math.round(zoom * 100)}%
                </span>
                <button
                  type="button"
                  data-testid="attachment-image-zoom-in"
                  className="flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20 disabled:cursor-not-allowed disabled:opacity-40"
                  onClick={() => setZoom(current => clampZoom(current + ZOOM_STEP))}
                  disabled={zoom >= MAX_ZOOM}
                  aria-label="Zoom in"
                >
                  <Plus className="h-[18px] w-[18px]" />
                </button>
              </div>
              {lightboxUrl ? (
                <img
                  data-testid="attachment-image-lightbox-image"
                  src={lightboxUrl}
                  alt={currentLightboxAttachment.filename}
                  className="max-h-[calc(100dvh-9rem)] max-w-[calc(100dvw-8rem)] rounded-2xl object-contain transition-transform duration-150 ease-out"
                  style={{ transform: `scale(${zoom})` }}
                  onClick={event => event.stopPropagation()}
                  onError={() => {
                    setLightboxUrl(null)
                    setHasLightboxError(true)
                  }}
                />
              ) : (
                <div
                  data-testid={
                    hasLightboxError
                      ? 'attachment-image-lightbox-error'
                      : 'attachment-image-lightbox-loading'
                  }
                  className="flex h-36 w-36 items-center justify-center rounded-2xl bg-white/10 text-white"
                  onClick={event => event.stopPropagation()}
                >
                  {isLightboxLoading ? (
                    <Loader2 className="h-7 w-7 animate-spin" />
                  ) : (
                    <FileText className="h-7 w-7" />
                  )}
                </div>
              )}
            </div>,
            document.body
          )
        : null

    if (disableLightbox) {
      return (
        <div
          ref={setPreviewContainerRef}
          data-testid={buttonTestId}
          className={buttonClassName}
          aria-label={attachment.filename}
        >
          <img
            data-testid={imageTestId}
            src={previewUrl}
            alt={attachment.filename}
            loading="lazy"
            className={imageClassName}
            onError={() => {
              rememberFailedAttachmentPreview(attachment)
              setPreviewUrl(null)
              setHasError(true)
            }}
          />
        </div>
      )
    }

    return (
      <>
        <button
          ref={setPreviewContainerRef}
          type="button"
          data-testid={buttonTestId}
          className={buttonClassName}
          onClick={openLightbox}
          aria-label={attachment.filename}
        >
          <img
            data-testid={imageTestId}
            src={previewUrl}
            alt={attachment.filename}
            loading="lazy"
            className={imageClassName}
            onError={() => {
              rememberFailedAttachmentPreview(attachment)
              setPreviewUrl(null)
              setHasError(true)
            }}
          />
        </button>
        {lightbox}
      </>
    )
  }

  if (hasError && hideOnError) {
    return null
  }

  return (
    <div
      ref={setPreviewContainerRef}
      data-testid={hasError ? errorTestId : loadingTestId}
      className={placeholderClassName}
      aria-label={attachment.filename}
    >
      {hasError ? <FileText className="h-5 w-5" /> : <Loader2 className="h-5 w-5 animate-spin" />}
    </div>
  )
}
