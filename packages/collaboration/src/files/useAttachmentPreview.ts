import { useMemo, useState, useSyncExternalStore } from 'react'
import { createAsyncResource, getIdleResourceSnapshot } from '@wegent/chat-core/async-resource'
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
  const resource = useMemo(
    () =>
      createAsyncResource(
        request.filename,
        async signal => {
          const blob = normalizeAttachmentBlob(
            await request.read(),
            request.filename,
            request.contentType
          )
          const kind = attachmentPreviewKind(request.filename, blob.type)
          const text = kind === 'text' || kind === 'markdown' ? await blob.text() : undefined
          signal.throwIfAborted()
          return { request, url: URL.createObjectURL(blob), size: blob.size, kind, text }
        },
        { release: preview => URL.revokeObjectURL(preview.url) }
      ),
    [request]
  )
  const snapshot = useSyncExternalStore(
    resource.subscribe,
    resource.getSnapshot,
    getIdleResourceSnapshot
  )
  const [failure, setFailure] = useState<{ request: typeof request; message?: string } | null>(null)
  const [decoded, setDecoded] = useState<typeof request | null>(null)
  const preview = snapshot.data ?? null
  const failed = failure?.request === request || snapshot.status === 'error'
  const errorMessage =
    failure?.request === request
      ? failure.message
      : snapshot.status === 'error' && snapshot.error instanceof Error
        ? snapshot.error.message
        : undefined
  return {
    preview,
    failed,
    errorMessage,
    loading: !preview || (preview.kind === 'image' && decoded !== request),
    markLoaded: () => setDecoded(request),
    markFailed: (cause?: unknown) =>
      setFailure({ request, message: cause instanceof Error ? cause.message : undefined }),
    retry: () => setRevision(value => value + 1),
  }
}
