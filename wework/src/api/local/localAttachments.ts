import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import { getNativeFilePath } from '@/desktop/nativeFilePaths'
import type { Attachment } from '@/types/api'

export interface LocalAttachmentApi {
  uploadAttachment: (file: File, onProgress?: (progress: number) => void) => Promise<Attachment>
  deleteAttachment: (attachmentId: number) => Promise<void>
}

let localAttachmentIdSeed = 0
const FALLBACK_ATTACHMENT_CHUNK_BYTES = 384 * 1024
const MAX_ATTACHMENT_CHUNK_BYTES = 2 * 1024 * 1024
const ATTACHMENT_RETRY_DELAYS_MS = [100, 250, 500, 1_000]

function nextLocalAttachmentId(): number {
  localAttachmentIdSeed += 1
  return -(Date.now() * 1000 + localAttachmentIdSeed)
}

function fileExtension(fileName: string): string {
  const dotIndex = fileName.lastIndexOf('.')
  return dotIndex >= 0 ? fileName.substring(dotIndex) : ''
}

function fileMimeType(file: File): string {
  return file.type || 'application/octet-stream'
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const stride = 32 * 1024
  for (let offset = 0; offset < bytes.byteLength; offset += stride) {
    const block = bytes.subarray(offset, offset + stride)
    binary += Reflect.apply(String.fromCharCode, undefined, block)
  }
  return btoa(binary)
}

function isTransientDesktopHostTransportError(error: unknown): boolean {
  return error instanceof Error && error.name === 'DesktopHostTransportError'
}

async function invokeAttachmentWithRetry<Result>(
  diagnostic: ReturnType<typeof createAttachmentStagingDiagnostic>,
  capability: string,
  params: Record<string, unknown>
): Promise<Result> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await diagnostic.invoke<Result>(capability, params)
    } catch (error) {
      const retryDelay = ATTACHMENT_RETRY_DELAYS_MS[attempt]
      if (!isTransientDesktopHostTransportError(error) || retryDelay === undefined) {
        throw error
      }
      await new Promise(resolve => window.setTimeout(resolve, retryDelay))
    }
  }
}

function createAttachmentStagingDiagnostic() {
  const metrics =
    import.meta.env.MODE === 'e2e' || import.meta.env.VITE_WEWORK_E2E === 'true'
      ? { readMs: 0, encodeMs: 0, invokeMs: 0, chunkCount: 0, progressChangeCount: 0 }
      : null
  const startedAt = metrics ? performance.now() : 0
  let previousProgress = 0
  function measure<Result>(
    metric: 'readMs' | 'invokeMs',
    operation: () => Promise<Result>
  ): Promise<Result> {
    if (!metrics) return operation()
    const before = performance.now()
    return (async () => {
      try {
        return await operation()
      } finally {
        metrics[metric] += performance.now() - before
      }
    })()
  }
  return {
    read(file: File, offset: number, chunkSize: number) {
      if (metrics) metrics.chunkCount += 1
      return measure('readMs', () =>
        file.slice(offset, Math.min(file.size, offset + chunkSize)).arrayBuffer()
      )
    },
    encode(chunk: Uint8Array): string {
      const before = metrics ? performance.now() : 0
      try {
        return bytesToBase64(chunk)
      } finally {
        if (metrics) metrics.encodeMs += performance.now() - before
      }
    },
    invoke<Result>(capability: string, params: Record<string, unknown>): Promise<Result> {
      return measure('invokeMs', () => invokeDesktopHost<Result>(capability, params))
    },
    progress(value: number) {
      if (metrics && value !== previousProgress) metrics.progressChangeCount += 1
      previousProgress = value
    },
    report(completed: boolean) {
      if (!metrics) return
      try {
        console.debug(
          '[Wework] Electron host diagnostic ' +
            JSON.stringify({
              capability: 'attachment.staging',
              phase: completed ? 'completed' : 'failed',
              elapsedMs: Math.round(performance.now() - startedAt),
              ...Object.fromEntries(
                Object.entries(metrics).map(([metric, value]) => [metric, Math.round(value)])
              ),
            })
        )
      } catch {
        // Diagnostics must not change attachment results or hide the original failure.
      }
    },
  }
}

async function saveElectronAttachment(
  file: File,
  onProgress?: (progress: number) => void
): Promise<string> {
  const diagnostic = createAttachmentStagingDiagnostic()
  let completed = false
  try {
    const started = await invokeAttachmentWithRetry<{
      uploadId: string
      chunkSize: number
    }>(diagnostic, 'attachment.begin', {
      uploadId: crypto.randomUUID(),
      filename: file.name,
      size: file.size,
    })
    const chunkSize =
      Number.isSafeInteger(started.chunkSize) && started.chunkSize > 0
        ? Math.min(started.chunkSize, MAX_ATTACHMENT_CHUNK_BYTES)
        : FALLBACK_ATTACHMENT_CHUNK_BYTES
    let offset = 0
    try {
      while (offset < file.size) {
        const chunk = new Uint8Array(await diagnostic.read(file, offset, chunkSize))
        offset = await invokeAttachmentWithRetry<number>(diagnostic, 'attachment.append', {
          uploadId: started.uploadId,
          offset,
          appendId: crypto.randomUUID(),
          chunkBase64: diagnostic.encode(chunk),
        })
        const progress = Math.round((offset / file.size) * 100)
        diagnostic.progress(progress)
        onProgress?.(progress)
      }
      const path = await invokeAttachmentWithRetry<string>(diagnostic, 'attachment.finish', {
        uploadId: started.uploadId,
      })
      completed = true
      return path
    } catch (error) {
      await diagnostic
        .invoke<void>('attachment.abort', {
          uploadId: started.uploadId,
        })
        .catch(() => undefined)
      throw error
    }
  } finally {
    diagnostic.report(completed)
  }
}

export function createLocalAttachmentApi(): LocalAttachmentApi {
  return {
    async uploadAttachment(file, onProgress) {
      onProgress?.(0)
      const localPath = getNativeFilePath(file) ?? (await saveElectronAttachment(file, onProgress))
      onProgress?.(100)

      return {
        id: nextLocalAttachmentId(),
        filename: file.name,
        file_size: file.size,
        mime_type: fileMimeType(file),
        status: 'ready',
        text_length: null,
        file_extension: fileExtension(file.name),
        created_at: new Date().toISOString(),
        local_path: localPath,
        local_preview_url: localPath,
      }
    },
    async deleteAttachment() {
      // Source files belong to the user. Generated draft files remain available
      // to runtime tasks through the paths stored in their transcript.
    },
  }
}
