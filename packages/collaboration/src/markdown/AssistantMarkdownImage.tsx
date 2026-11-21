import {
  createAsyncResource,
  getIdleResourceSnapshot,
  subscribeIdleResource,
} from '@wegent/chat-core/async-resource'
import { useContext, useMemo, useState, useSyncExternalStore } from 'react'
import { MarkdownLinkScope } from './markdownLinkScope'
import { useMarkdownServices } from './MarkdownServices'
import {
  classifyMarkdownLink,
  getAuthenticatedAttachmentId,
  getMarkdownAttachmentId,
  isAuthenticatedAttachmentImageSrc,
  localMarkdownImagePath,
  resolveDirectMarkdownImageSrc,
} from './assistantMarkdownLinks'
import { Button as ControlButton } from './Button'
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
  const insideLink = useContext(MarkdownLinkScope)
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
  const resource = useMemo(() => {
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
    if (!rawSrc || !requiresBlobPreview) return null
    return createAsyncResource(
      rawSrc,
      async signal => {
        if (!readOwnedImage && resolveImageUrl) {
          return { url: await resolveImageUrl(rawSrc), release: null }
        }
        let blob: Blob
        if (readOwnedImage) {
          blob = await readOwnedImage(rawSrc, alt)
        } else if (isAuthenticatedSrc) {
          const attachmentId = getAuthenticatedAttachmentId(rawSrc)
          if (attachmentId === null) throw new Error('Failed to resolve markdown attachment')
          if (!fetchAttachmentBlob) throw new Error('Attachment download is unavailable')
          blob = await fetchAttachmentBlob(attachmentId)
          if (!blob.type.startsWith('image/'))
            throw new Error(`Markdown image response is not an image: ${blob.type || 'unknown'}`)
        } else if (getMarkdownAttachmentId(rawSrc) !== null) {
          throw new Error('An Issue image reader is required for this resource')
        } else if (localPath && readLocalFile) {
          blob = await readLocalFile(localPath)
        } else {
          throw new Error('Failed to resolve local markdown image')
        }
        signal.throwIfAborted()
        const url = URL.createObjectURL(blob)
        return { url, release: () => URL.revokeObjectURL(url) }
      },
      { release: image => image.release?.() }
    )
  }, [request])
  const snapshot = useSyncExternalStore(
    resource?.subscribe ?? subscribeIdleResource,
    resource?.getSnapshot ?? getIdleResourceSnapshot,
    getIdleResourceSnapshot
  )
  const [failedRequest, setFailedRequest] = useState<typeof request | null>(null)
  const resolvedSrc = requiresBlobPreview
    ? (snapshot.data?.url ?? null)
    : rawSrc
      ? resolveDirectMarkdownImageSrc(rawSrc)
      : null
  const hasError = !rawSrc || failedRequest === request || snapshot.status === 'error'

  if (hasError) {
    return (
      <span
        role="alert"
        data-testid="assistant-markdown-image-error"
        className="my-2 inline-flex max-w-full rounded-xl border border-border bg-surface px-3 py-2 text-xs text-text-muted"
      >
        {translate('image.failed')}: {alt || rawSrc}
        {rawSrc && !insideLink ? (
          <ControlButton
            variant="unstyled"
            type="button"
            data-testid="assistant-markdown-image-retry"
            className="ml-2 min-h-11 min-w-11 underline md:min-h-0 md:min-w-0"
            onClick={event => {
              event.preventDefault()
              event.stopPropagation()
              setAttempt(value => value + 1)
            }}
          >
            {translate('image.retry')}
          </ControlButton>
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
  return openMarkdownImage && readOwnedImage && !insideLink ? (
    <ControlButton
      variant="unstyled"
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
    </ControlButton>
  ) : (
    image
  )
}
