import { useEffect, useMemo, useState } from 'react'
import { attachmentPreviewKind, normalizeAttachmentBlob } from './preview'

/** Shared resource lifetime for browser and desktop attachment viewers. */
export function useAttachmentPreview(
  read: () => Promise<Blob>,
  filename: string,
  contentType?: string | null
) {
  const [revision, setRevision] = useState(0)
  const request = useMemo(
    () => ({ read, filename, contentType, revision }),
    [read, filename, contentType, revision]
  )
  type Preview = {
    request: typeof request
    url: string
    size: number
    kind: ReturnType<typeof attachmentPreviewKind>
    text?: string
  }
  const [result, setResult] = useState<Preview | null>(null)
  const [failure, setFailure] = useState<{
    request: typeof request
    message?: string
  } | null>(null)
  const [decoded, setDecoded] = useState<typeof request | null>(null)
  useEffect(() => {
    let active = true
    let url: string | null = null
    void (async () => {
      try {
        const blob = normalizeAttachmentBlob(
          await request.read(),
          request.filename,
          request.contentType
        )
        const kind = attachmentPreviewKind(request.filename, blob.type)
        const text = kind === 'text' || kind === 'markdown' ? await blob.text() : undefined
        if (!active) return
        url = URL.createObjectURL(blob)
        setResult({ request, url, size: blob.size, kind, text })
      } catch (cause) {
        if (active)
          setFailure({
            request,
            message: cause instanceof Error ? cause.message : undefined,
          })
      }
    })()
    return () => {
      active = false
      if (url) URL.revokeObjectURL(url)
    }
  }, [request])
  const preview = result?.request === request ? result : null
  return {
    preview,
    failed: failure?.request === request,
    errorMessage: failure?.request === request ? failure.message : undefined,
    loading: !preview || (preview.kind === 'image' && decoded !== request),
    markLoaded: () => setDecoded(request),
    markFailed: (cause?: unknown) =>
      setFailure({
        request,
        message: cause instanceof Error ? cause.message : undefined,
      }),
    retry: () => setRevision(value => value + 1),
  }
}
