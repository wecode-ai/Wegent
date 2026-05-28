import type { Attachment } from '@/types/api'
import { getRuntimeConfig } from '@/config/runtime'

export const MAX_FILE_SIZE = 100 * 1024 * 1024

export const SUPPORTED_EXTENSIONS = [
  '.pdf',
  '.doc',
  '.docx',
  '.ppt',
  '.pptx',
  '.xls',
  '.xlsx',
  '.csv',
  '.xmind',
  '.txt',
  '.md',
  '.html',
  '.htm',
  '.html5',
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.bmp',
  '.webp',
]

export function isValidFileSize(size: number): boolean {
  return size <= MAX_FILE_SIZE
}

export function isSupportedExtension(fileName: string): boolean {
  const lowerName = fileName.toLowerCase()
  return SUPPORTED_EXTENSIONS.some(extension => lowerName.endsWith(extension))
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
          resolve({
            id: response.id,
            filename: response.filename,
            file_size: response.file_size,
            mime_type: response.mime_type,
            status: response.status,
            text_length: response.text_length,
            error_message: response.error_message,
            error_code: response.error_code,
            subtask_id: null,
            file_extension: file.name.substring(file.name.lastIndexOf('.')),
            created_at: new Date().toISOString(),
          })
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
  const token = localStorage.getItem('auth_token')
  const response = await fetch(`${apiBaseUrl}/attachments/${attachmentId}`, {
    method: 'DELETE',
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  })

  if (!response.ok) {
    throw new Error(`Failed to delete attachment: ${response.status}`)
  }
}
