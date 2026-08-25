import { isValidFileSize, MAX_FILE_SIZE } from '@/api/attachments'
import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import type { Attachment } from '@/types/api'

export interface LocalAttachmentApi {
  uploadAttachment: (file: File, onProgress?: (progress: number) => void) => Promise<Attachment>
  deleteAttachment: (attachmentId: number) => Promise<void>
}

let localAttachmentIdSeed = 0
const FALLBACK_ATTACHMENT_CHUNK_BYTES = 384 * 1024

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

function canReadTextLength(file: File): boolean {
  const mimeType = fileMimeType(file).toLowerCase()
  return mimeType.startsWith('text/') || fileExtension(file.name).toLowerCase() === '.txt'
}

async function maybeTextLength(file: File): Promise<number | null> {
  if (!canReadTextLength(file)) return null
  try {
    return (await file.text()).length
  } catch {
    return null
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const stride = 32 * 1024
  for (let offset = 0; offset < bytes.byteLength; offset += stride) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + stride))
  }
  return btoa(binary)
}

async function saveElectronAttachment(
  file: File,
  onProgress?: (progress: number) => void
): Promise<string> {
  const started = await invokeDesktopHost<{
    uploadId: string
    chunkSize: number
  }>('attachment.begin', {
    filename: file.name,
    size: file.size,
  })
  const chunkSize =
    Number.isSafeInteger(started.chunkSize) && started.chunkSize > 0
      ? Math.min(started.chunkSize, FALLBACK_ATTACHMENT_CHUNK_BYTES)
      : FALLBACK_ATTACHMENT_CHUNK_BYTES
  let offset = 0
  try {
    while (offset < file.size) {
      const chunk = new Uint8Array(
        await file.slice(offset, Math.min(file.size, offset + chunkSize)).arrayBuffer()
      )
      offset = await invokeDesktopHost<number>('attachment.append', {
        uploadId: started.uploadId,
        offset,
        chunkBase64: bytesToBase64(chunk),
      })
      onProgress?.(Math.round((offset / file.size) * 100))
    }
    return await invokeDesktopHost<string>('attachment.finish', {
      uploadId: started.uploadId,
    })
  } catch (error) {
    await invokeDesktopHost<void>('attachment.abort', {
      uploadId: started.uploadId,
    }).catch(() => undefined)
    throw error
  }
}

export function createLocalAttachmentApi(): LocalAttachmentApi {
  return {
    async uploadAttachment(file, onProgress) {
      if (!isValidFileSize(file.size)) {
        throw new Error(`File size exceeds ${MAX_FILE_SIZE / (1024 * 1024)} MB`)
      }
      onProgress?.(0)
      const localPath = await saveElectronAttachment(file, onProgress)
      onProgress?.(100)

      const textLength = await maybeTextLength(file)
      return {
        id: nextLocalAttachmentId(),
        filename: file.name,
        file_size: file.size,
        mime_type: fileMimeType(file),
        status: 'ready',
        text_length: textLength,
        file_extension: fileExtension(file.name),
        created_at: new Date().toISOString(),
        local_path: localPath,
        local_preview_url: localPath,
      }
    },
    async deleteAttachment() {
      // Draft files are intentionally left in place so already-sent runtime tasks
      // can continue to resolve the absolute paths stored in their transcript.
    },
  }
}
