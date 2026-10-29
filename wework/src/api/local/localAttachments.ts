import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import { getNativeFilePath } from '@/desktop/nativeFilePaths'
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
