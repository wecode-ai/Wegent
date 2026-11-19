import { DialogSurface } from '../controls/DialogSurface'
import { Button as ControlButton } from '../markdown/Button'
import {
  createAsyncResource,
  getIdleResourceSnapshot,
  subscribeIdleResource,
} from '@wegent/chat-core/async-resource'
import { useFocusRequest, useIntersectionEvent, useWindowEvent } from '../dom-events'
import { useCollaborationPortalTheme } from '../theme'
import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type SyntheticEvent,
} from 'react'
import { createPortal } from 'react-dom'
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
export interface ImageAttachment {
  filename: string
  image_width?: number | null
  image_height?: number | null
}

export interface AttachmentImageServices<T extends ImageAttachment> {
  identity(attachment: T): string
  load(attachment: T): Promise<{ url: string; release: (() => void) | null }>
  download(attachment: T, url: string, filename: string): Promise<void>
  localPath?(attachment: T): string | null
  onError?(attachment: T): void
  loadImmediately?: boolean
}

export interface AttachmentImageViewProps<T extends ImageAttachment> {
  services: AttachmentImageServices<T>
  attachment: T
  buttonTestId: string
  imageTestId: string
  loadingTestId: string
  errorTestId: string
  imageClassName: string
  placeholderClassName: string
  buttonClassName?: string
  disableLightbox?: boolean
  galleryAttachments?: T[]
  galleryIndex?: number
  resolveDownloadFilename?: (attachment: T, index: number) => string
  hideOnError?: boolean
}

const MIN_ZOOM = 0.5
const MAX_ZOOM = 4
const ZOOM_STEP = 0.25
function clampZoom(value: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value))
}

function clampIndex(value: number, length: number): number {
  if (length <= 0) return 0
  return Math.min(length - 1, Math.max(0, value))
}

function attachmentAspectRatio(attachment: ImageAttachment): number | undefined {
  const width = attachment.image_width
  const height = attachment.image_height
  if (
    typeof width !== 'number' ||
    !Number.isFinite(width) ||
    width <= 0 ||
    typeof height !== 'number' ||
    !Number.isFinite(height) ||
    height <= 0
  ) {
    return undefined
  }
  return width / height
}

export function AttachmentImageView<T extends ImageAttachment>(props: AttachmentImageViewProps<T>) {
  const immediate = Boolean(
    props.services.loadImmediately || typeof IntersectionObserver === 'undefined'
  )
  const key = JSON.stringify([props.services.identity(props.attachment), immediate])
  return <AttachmentImageContent key={key} {...props} />
}

function createAttachmentImageResource<T extends ImageAttachment>(
  services: AttachmentImageServices<T>,
  attachment: T
) {
  return createAsyncResource(services.identity(attachment), () => services.load(attachment), {
    release: image => image.release?.(),
    failure: () => services.onError?.(attachment),
  })
}

function AttachmentImageContent<T extends ImageAttachment>({
  services,
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
  resolveDownloadFilename,
  hideOnError = false,
}: AttachmentImageViewProps<T>) {
  const portalTheme = useCollaborationPortalTheme()
  const [isLightboxOpen, setIsLightboxOpen] = useState(false)
  const [lightboxIndex, setLightboxIndex] = useState(galleryIndex)
  const [zoom, setZoom] = useState(1)
  const [previewFailed, setPreviewFailed] = useState(false)
  const [lightboxFailed, setLightboxFailed] = useState(false)
  const [preview, setPreview] = useState(() => ({
    services,
    load: Boolean(services.loadImmediately || typeof IntersectionObserver === 'undefined'),
    resource: createAttachmentImageResource(services, attachment),
  }))
  if (preview.services !== services) {
    setPreview({
      services,
      load: preview.load,
      resource: createAttachmentImageResource(services, attachment),
    })
    setPreviewFailed(false)
    setIsLightboxOpen(false)
  }
  const previewSnapshot = useSyncExternalStore(
    preview.load ? preview.resource.subscribe : subscribeIdleResource,
    preview.resource.getSnapshot,
    getIdleResourceSnapshot
  )
  const hasError = previewFailed || previewSnapshot.status === 'error'
  const previewUrl = hasError ? null : (previewSnapshot.data?.url ?? null)
  const previewIdentity = services.identity(attachment)
  const previewContainerRef = useRef<HTMLElement | null>(null)
  const previewUrlRef = useRef(previewUrl)
  const previewAspectRatio = attachmentAspectRatio(attachment)
  const previewContainerStyle =
    previewAspectRatio === undefined ? undefined : { aspectRatio: previewAspectRatio }
  const setPreviewContainerRef = useCallback((element: HTMLElement | null) => {
    previewContainerRef.current = element
  }, [])
  const revealPreview = useCallback(
    (entries: IntersectionObserverEntry[]) => {
      if (!entries.some(entry => entry.isIntersecting || entry.intersectionRatio > 0)) return
      setPreview(current =>
        current.load || current.services !== services
          ? current
          : { services, load: true, resource: createAttachmentImageResource(services, attachment) }
      )
    },
    [services, attachment]
  )
  useIntersectionEvent(previewContainerRef, revealPreview, {
    enabled: !preview.load,
    rootMargin: '320px 0px',
  })
  const gallery = useMemo(
    () => (galleryAttachments?.length ? galleryAttachments : [attachment]),
    [attachment, galleryAttachments]
  )
  const currentLightboxIndex = clampIndex(lightboxIndex, gallery.length)
  const currentLightboxAttachment = gallery[currentLightboxIndex] ?? attachment
  const canNavigateLightbox = gallery.length > 1
  const previewLocalPath = services.localPath?.(attachment)
  const lightboxLocalPath = services.localPath?.(currentLightboxAttachment)
  const lightboxRequest = useMemo(() => {
    if (!isLightboxOpen || disableLightbox || !previewUrl)
      return { resource: null, reusedUrl: null }
    const selected = gallery[clampIndex(lightboxIndex, gallery.length)]!
    if (services.identity(selected) === previewIdentity)
      return { resource: null, reusedUrl: previewUrl }
    return { resource: createAttachmentImageResource(services, selected), reusedUrl: null }
  }, [
    isLightboxOpen,
    disableLightbox,
    previewUrl,
    gallery,
    lightboxIndex,
    services,
    previewIdentity,
  ])
  const [previousLightboxRequest, setPreviousLightboxRequest] = useState(lightboxRequest)
  if (previousLightboxRequest !== lightboxRequest) {
    setPreviousLightboxRequest(lightboxRequest)
    setLightboxFailed(false)
    setZoom(1)
  }
  const lightboxSnapshot = useSyncExternalStore(
    lightboxRequest.resource?.subscribe ?? subscribeIdleResource,
    lightboxRequest.resource?.getSnapshot ?? getIdleResourceSnapshot,
    getIdleResourceSnapshot
  )
  const hasLightboxError = lightboxFailed || lightboxSnapshot.status === 'error'
  const lightboxUrl = hasLightboxError
    ? null
    : (lightboxRequest.reusedUrl ?? lightboxSnapshot.data?.url ?? null)
  const isLightboxLoading =
    Boolean(lightboxRequest.resource) &&
    (lightboxSnapshot.status === 'idle' || lightboxSnapshot.status === 'loading')
  const lightboxUrlRef = useRef(lightboxUrl)
  useLayoutEffect(() => {
    previewUrlRef.current = previewUrl
    lightboxUrlRef.current = lightboxUrl
  }, [lightboxUrl, previewUrl])
  useWindowEvent(
    'keydown',
    event => {
      if (event.key === 'Escape') {
        setIsLightboxOpen(false)
        return
      }
      if (event.key === 'ArrowLeft' && canNavigateLightbox) {
        event.preventDefault()
        setLightboxIndex(current => (current <= 0 ? gallery.length - 1 : current - 1))
      }
      if (event.key === 'ArrowRight' && canNavigateLightbox) {
        event.preventDefault()
        setLightboxIndex(current => (current >= gallery.length - 1 ? 0 : current + 1))
      }
    },
    { enabled: isLightboxOpen && !disableLightbox }
  )
  const lightboxRef = useRef<HTMLDivElement>(null)
  useFocusRequest(lightboxRef, undefined, {
    enabled: isLightboxOpen && !disableLightbox,
    selector: '[data-testid="attachment-image-lightbox-close"]',
    restoreFocus: true,
  })
  const openLightbox = () => {
    setLightboxIndex(clampIndex(galleryIndex, gallery.length))
    setLightboxFailed(false)
    setIsLightboxOpen(true)
  }

  const goToPreviousImage = () => {
    setLightboxIndex(current => (current <= 0 ? gallery.length - 1 : current - 1))
  }

  const goToNextImage = () => {
    setLightboxIndex(current => (current >= gallery.length - 1 ? 0 : current + 1))
  }

  const handlePreviewError = (event: SyntheticEvent<HTMLImageElement>) => {
    const failedUrl = event.currentTarget.currentSrc || event.currentTarget.src
    if (!(previewUrlRef.current && failedUrl === previewUrlRef.current)) return
    services.onError?.(attachment)
    setPreviewFailed(true)
  }

  const handleLightboxError = (event: SyntheticEvent<HTMLImageElement>) => {
    const failedUrl = event.currentTarget.currentSrc || event.currentTarget.src
    if (!(lightboxUrlRef.current && failedUrl === lightboxUrlRef.current)) return
    setLightboxFailed(true)
  }

  if (previewUrl) {
    const lightbox =
      !disableLightbox && isLightboxOpen && typeof document !== 'undefined'
        ? createPortal(
            <DialogSurface
              onClose={() => setIsLightboxOpen(false)}
              initialFocus='[data-testid="attachment-image-lightbox-close"]'
              render={
            <div
              {...portalTheme}
              ref={lightboxRef}
              data-testid="attachment-image-lightbox"
              aria-label={currentLightboxAttachment.filename}
              className={`${portalTheme.className} fixed inset-0 z-modal flex h-dvh w-dvw items-center justify-center overflow-hidden bg-black/90 p-0`}
              onClick={() => setIsLightboxOpen(false)}
              onWheel={event => {
                event.stopPropagation()
                setZoom(current => clampZoom(current + (event.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP)))
              }}
            />
              }
            >
              <div className="absolute right-4 top-4 z-20 flex items-center gap-2.5">
                <ControlButton variant="unstyled"
                  type="button"
                  data-testid="attachment-image-download"
                  className="flex h-12 w-12 items-center justify-center rounded-full bg-white/15 text-white transition-colors hover:bg-white/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 disabled:cursor-not-allowed disabled:opacity-50"
                  onClick={event => {
                    event.stopPropagation()
                    if (lightboxUrl) {
                      void services.download(
                        currentLightboxAttachment,
                        lightboxUrl,
                        resolveDownloadFilename?.(
                          currentLightboxAttachment,
                          currentLightboxIndex
                        ) ?? currentLightboxAttachment.filename
                      )
                    }
                  }}
                  disabled={!lightboxUrl}
                  aria-label="Download image"
                >
                  <Download className="h-5 w-5" />
                </ControlButton>
                <ControlButton variant="unstyled"
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
                </ControlButton>
              </div>
              {canNavigateLightbox && (
                <>
                  <ControlButton variant="unstyled"
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
                  </ControlButton>
                  <ControlButton variant="unstyled"
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
                  </ControlButton>
                </>
              )}
              <div
                data-testid="attachment-image-zoom-controls"
                className="absolute bottom-6 left-1/2 z-20 flex h-11 -translate-x-1/2 items-center gap-2.5 rounded-full bg-white/15 px-1.5 text-white shadow-[0_12px_36px_rgba(0,0,0,0.35)]"
                onClick={event => event.stopPropagation()}
              >
                <ControlButton variant="unstyled"
                  type="button"
                  data-testid="attachment-image-zoom-out"
                  className="flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20 disabled:cursor-not-allowed disabled:opacity-40"
                  onClick={() => setZoom(current => clampZoom(current - ZOOM_STEP))}
                  disabled={zoom <= MIN_ZOOM}
                  aria-label="Zoom out"
                >
                  <Minus className="h-[18px] w-[18px]" />
                </ControlButton>
                <span
                  data-testid="attachment-image-zoom-value"
                  className="min-w-14 select-none text-center text-base font-medium tabular-nums text-white"
                >
                  {Math.round(zoom * 100)}%
                </span>
                <ControlButton variant="unstyled"
                  type="button"
                  data-testid="attachment-image-zoom-in"
                  className="flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20 disabled:cursor-not-allowed disabled:opacity-40"
                  onClick={() => setZoom(current => clampZoom(current + ZOOM_STEP))}
                  disabled={zoom >= MAX_ZOOM}
                  aria-label="Zoom in"
                >
                  <Plus className="h-[18px] w-[18px]" />
                </ControlButton>
              </div>
              {lightboxUrl ? (
                <img
                  data-testid="attachment-image-lightbox-image"
                  src={lightboxUrl}
                  alt={currentLightboxAttachment.filename}
                  data-context-image-filename={currentLightboxAttachment.filename}
                  data-context-image-local-path={lightboxLocalPath ?? undefined}
                  className="max-h-[calc(100dvh-9rem)] max-w-[calc(100dvw-8rem)] rounded-2xl object-contain transition-transform duration-150 ease-out"
                  style={{ transform: `scale(${zoom})` }}
                  onClick={event => event.stopPropagation()}
                  onError={handleLightboxError}
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
            </DialogSurface>,
            document.body
          )
        : null

    if (disableLightbox) {
      return (
        <div
          ref={setPreviewContainerRef}
          data-testid={buttonTestId}
          className={buttonClassName}
          style={previewContainerStyle}
          aria-label={attachment.filename}
        >
          <img
            data-testid={imageTestId}
            src={previewUrl}
            alt={attachment.filename}
            data-context-image-filename={attachment.filename}
            data-context-image-local-path={previewLocalPath ?? undefined}
            loading="lazy"
            className={imageClassName}
            onError={handlePreviewError}
          />
        </div>
      )
    }

    return (
      <>
        <ControlButton variant="unstyled"
          ref={setPreviewContainerRef}
          type="button"
          data-testid={buttonTestId}
          className={buttonClassName}
          style={previewContainerStyle}
          onClick={openLightbox}
          aria-label={attachment.filename}
        >
          <img
            data-testid={imageTestId}
            src={previewUrl}
            alt={attachment.filename}
            data-context-image-filename={attachment.filename}
            data-context-image-local-path={previewLocalPath ?? undefined}
            loading="lazy"
            className={imageClassName}
            onError={handlePreviewError}
          />
        </ControlButton>
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
      style={previewContainerStyle}
      aria-label={attachment.filename}
    >
      {hasError ? <FileText className="h-5 w-5" /> : <Loader2 className="h-5 w-5 animate-spin" />}
    </div>
  )
}
