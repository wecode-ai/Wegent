import { useEffect, useMemo, useState } from 'react'
import { useMarkdownServices } from './MarkdownServices'
import {
  getAuthenticatedAttachmentId,
  getMarkdownAttachmentId,
  classifyMarkdownLink,
  isAuthenticatedAttachmentImageSrc,
  localMarkdownImagePath,
  resolveDirectMarkdownImageSrc,
} from './assistantMarkdownLinks'
export function AssistantMarkdownImage({
  src,
  alt,
  sourceLine,
}: {
  src?: string | Blob
  alt?: string
  sourceLine?: number
}) {
  const {
    fetchAttachmentBlob,
    readLocalFile,
    readMarkdownImage,
    openMarkdownImage,
    resolveImageUrl,
    translate,
  } = useMarkdownServices()
  const rawSrc = typeof src === 'string' ? src.trim() : ''
  const [attempt, setAttempt] = useState(0)
  const isAuthenticatedSrc = rawSrc ? isAuthenticatedAttachmentImageSrc(rawSrc) : false
  const localPath = rawSrc ? localMarkdownImagePath(rawSrc) : null
  const readOwnedImage =
    readMarkdownImage &&
    rawSrc &&
    (getMarkdownAttachmentId(rawSrc) !== null || classifyMarkdownLink(rawSrc).kind === 'file')
      ? readMarkdownImage
      : undefined
  const requiresBlobPreview =
    Boolean(readOwnedImage) ||
    Boolean(resolveImageUrl) ||
    getMarkdownAttachmentId(rawSrc) !== null ||
    Boolean(localPath)
  const request = useMemo(
    () => ({
      rawSrc,
      alt,
      readOwnedImage,
      resolveImageUrl,
      fetchAttachmentBlob,
      readLocalFile,
      isAuthenticatedSrc,
      localPath,
      requiresBlobPreview,
      attempt,
    }),
    [
      rawSrc,
      alt,
      readOwnedImage,
      resolveImageUrl,
      fetchAttachmentBlob,
      readLocalFile,
      isAuthenticatedSrc,
      localPath,
      requiresBlobPreview,
      attempt,
    ]
  )
  const [loadedPreview, setLoadedPreview] = useState<{
    request: typeof request
    url: string
  } | null>(null)
  const [failedRequest, setFailedRequest] = useState<typeof request | null>(null)
  const resolvedSrc = requiresBlobPreview
    ? loadedPreview?.request === request
      ? loadedPreview.url
      : null
    : rawSrc
      ? resolveDirectMarkdownImageSrc(rawSrc)
      : null
  const hasError = !rawSrc || failedRequest === request

  useEffect(() => {
    const {
      rawSrc,
      alt,
      readOwnedImage,
      resolveImageUrl,
      fetchAttachmentBlob,
      readLocalFile,
      isAuthenticatedSrc,
      localPath,
      requiresBlobPreview,
    } = request
    let objectUrl: string | null = null
    let isMounted = true

    if (!rawSrc || !requiresBlobPreview) {
      return () => {
        isMounted = false
      }
    }

    async function loadImage() {
      try {
        if (!readOwnedImage && resolveImageUrl) {
          const url = await resolveImageUrl(rawSrc)
          if (isMounted) {
            setLoadedPreview({ request, url })
          }
          return
        }
        let blob: Blob
        if (readOwnedImage) {
          blob = await readOwnedImage(rawSrc, alt)
        } else if (isAuthenticatedSrc) {
          const attachmentId = getAuthenticatedAttachmentId(rawSrc)
          if (attachmentId === null) {
            throw new Error('Failed to resolve markdown attachment')
          }
          if (!fetchAttachmentBlob) throw new Error('Attachment download is unavailable')
          blob = await fetchAttachmentBlob(attachmentId)
          if (!blob.type.startsWith('image/')) {
            throw new Error(`Markdown image response is not an image: ${blob.type || 'unknown'}`)
          }
        } else if (localPath && readLocalFile) {
          blob = await readLocalFile(localPath)
        } else {
          throw new Error('Failed to resolve local markdown image')
        }

        objectUrl = URL.createObjectURL(blob)
        if (isMounted) {
          setLoadedPreview({ request, url: objectUrl })
        } else {
          URL.revokeObjectURL(objectUrl)
        }
      } catch {
        if (isMounted) {
          setFailedRequest(request)
        }
      }
    }

    void loadImage()

    return () => {
      isMounted = false
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl)
      }
    }
  }, [request])

  if (hasError) {
    return (
      <span
        role="alert"
        data-testid="assistant-markdown-image-error"
        className="my-2 inline-flex max-w-full rounded-xl border border-border bg-surface px-3 py-2 text-xs text-text-muted"
      >
        {translate('image.failed')}: {alt || rawSrc}
        {rawSrc ? (
          <button
            type="button"
            data-testid="assistant-markdown-image-retry"
            className="ml-2 min-h-11 min-w-11 underline md:min-h-0 md:min-w-0"
            onClick={() => {
              setAttempt(value => value + 1)
            }}
          >
            {translate('image.retry')}
          </button>
        ) : null}
      </span>
    )
  }

  if (!resolvedSrc) {
    return (
      <span
        data-testid="assistant-markdown-image-loading"
        className="my-2 inline-flex h-20 w-32 max-w-full items-center justify-center rounded-xl border border-border bg-surface text-xs text-text-muted"
      >
        {alt || 'Image'}
      </span>
    )
  }

  const image = (
    <img
      data-testid="assistant-markdown-image"
      data-scroll-anchor
      data-source-line={sourceLine}
      src={resolvedSrc}
      alt={alt || ''}
      className="my-2 block max-h-[360px] max-w-full rounded-xl border border-border bg-base object-contain"
      loading="lazy"
      onError={() => setFailedRequest(request)}
    />
  )
  return openMarkdownImage && readOwnedImage ? (
    <button
      type="button"
      data-testid="assistant-markdown-image-open"
      aria-label={translate('image.open')}
      className="block min-h-11 min-w-11 max-w-full text-left md:min-h-0 md:min-w-0"
      onClick={async () => {
        try {
          await openMarkdownImage(rawSrc, alt)
        } catch {
          setFailedRequest(request)
        }
      }}
    >
      {image}
    </button>
  ) : (
    image
  )
}
