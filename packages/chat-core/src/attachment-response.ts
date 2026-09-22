import type { Attachment } from './runtime'
export const MAX_FILE_SIZE = 100 * 1024 * 1024
type UploadAttachmentResponse = Omit<Attachment, 'created_at' | 'file_extension' | 'subtask_id'> &
  Partial<Pick<Attachment, 'created_at' | 'file_extension' | 'subtask_id'>>

export function isValidFileSize(size: number): boolean {
  return size <= MAX_FILE_SIZE
}

function getFileExtension(fileName: string): string {
  const dotIndex = fileName.lastIndexOf('.')
  return dotIndex >= 0 ? fileName.substring(dotIndex) : ''
}

function canCreateObjectUrl(): boolean {
  return typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function'
}

export function isWorkspaceImageFile(file: File): boolean {
  return (
    file.type.toLowerCase().startsWith('image/') ||
    ['.apng', '.avif', '.bmp', '.gif', '.jpeg', '.jpg', '.png', '.svg', '.webp'].includes(
      getFileExtension(file.name).toLowerCase()
    )
  )
}

export function toAttachmentResponse(response: UploadAttachmentResponse, file: File): Attachment {
  return {
    id: response.id,
    filename: response.filename,
    file_size: response.file_size,
    mime_type: response.mime_type,
    status: response.status,
    text_length: response.text_length,
    error_message: response.error_message,
    error_code: response.error_code,
    subtask_id: response.subtask_id ?? null,
    file_extension: response.file_extension || getFileExtension(file.name),
    created_at: response.created_at || new Date().toISOString(),
    local_preview_url:
      isWorkspaceImageFile(file) && canCreateObjectUrl() ? URL.createObjectURL(file) : undefined,
  }
}
