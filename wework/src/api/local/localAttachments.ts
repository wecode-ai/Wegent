import { invoke } from '@tauri-apps/api/core'
import { isValidFileSize, MAX_FILE_SIZE } from '@/api/attachments'
import { isTauriRuntime } from '@/lib/runtime-environment'
import type { Attachment } from '@/types/api'

export interface LocalAttachmentUploadContext {
  workspacePath?: string | null
}

export interface LocalAttachmentApi {
  uploadAttachment: (
    file: File,
    onProgress?: (progress: number) => void,
    context?: LocalAttachmentUploadContext
  ) => Promise<Attachment>
  deleteAttachment: (attachmentId: number) => Promise<void>
}

let localAttachmentIdSeed = 0

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

export function createLocalAttachmentApi(): LocalAttachmentApi {
  return {
    async uploadAttachment(file, onProgress, context) {
      if (!isValidFileSize(file.size)) {
        throw new Error(`File size exceeds ${MAX_FILE_SIZE / (1024 * 1024)} MB`)
      }
      if (!isTauriRuntime()) {
        throw new Error('Local attachment storage requires the desktop app')
      }

      onProgress?.(0)
      const bytes = Array.from(new Uint8Array(await file.arrayBuffer()))
      const localPath = await invoke<string>('save_local_attachment_file', {
        workspacePath: context?.workspacePath ?? null,
        filename: file.name,
        bytes,
      })
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
      // Draft files are intentionally left in place so already-sent local tasks
      // can continue to resolve the absolute paths stored in their transcript.
    },
  }
}
