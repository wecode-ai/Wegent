import type { Attachment } from '@/types/api'
import { getRuntimeConfig } from '@/config/runtime'
import { createHttpClient, shouldUseTauriFetch } from './http'

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

function isImageFile(file: File): boolean {
  return (
    file.type.toLowerCase().startsWith('image/') ||
    ['.apng', '.avif', '.bmp', '.gif', '.jpeg', '.jpg', '.png', '.svg', '.webp'].includes(
      getFileExtension(file.name).toLowerCase()
    )
  )
}

function toAttachmentResponse(response: UploadAttachmentResponse, file: File): Attachment {
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
      isImageFile(file) && canCreateObjectUrl() ? URL.createObjectURL(file) : undefined,
  }
}

export function uploadAttachment(
  file: File,
  onProgress?: (progress: number) => void
): Promise<Attachment> {
  if (!isValidFileSize(file.size)) {
    return Promise.reject(new Error(`File size exceeds ${MAX_FILE_SIZE / (1024 * 1024)} MB`))
  }

  const { apiBaseUrl } = getRuntimeConfig()
  const token = localStorage.getItem('auth_token')
  const formData = new FormData()
  formData.append('file', file)

  if (shouldUseTauriFetch()) {
    onProgress?.(0)
    const client = createHttpClient({ baseUrl: apiBaseUrl })
    return client.post<UploadAttachmentResponse>('/attachments/upload', formData).then(response => {
      onProgress?.(100)
      return toAttachmentResponse(response, file)
    })
  }

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()

    xhr.upload.addEventListener('progress', event => {
      if (event.lengthComputable && onProgress) {
        onProgress(Math.round((event.loaded / event.total) * 100))
      }
    })

    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const response = JSON.parse(xhr.responseText)
          resolve(toAttachmentResponse(response, file))
        } catch {
          reject(new Error('Failed to parse upload response'))
        }
        return
      }

      try {
        const error = JSON.parse(xhr.responseText)
        reject(new Error(error.detail || 'Upload failed'))
      } catch {
        reject(new Error(`Upload failed: ${xhr.status}`))
      }
    })

    xhr.addEventListener('error', () => reject(new Error('Network error during upload')))
    xhr.addEventListener('abort', () => reject(new Error('Upload cancelled')))

    xhr.open('POST', `${apiBaseUrl}/attachments/upload`)
    if (token) {
      xhr.setRequestHeader('Authorization', `Bearer ${token}`)
    }
    xhr.send(formData)
  })
}

export async function deleteAttachment(attachmentId: number): Promise<void> {
  const { apiBaseUrl } = getRuntimeConfig()
  const client = createHttpClient({ baseUrl: apiBaseUrl })
  await client.delete(`/attachments/${attachmentId}`)
}
