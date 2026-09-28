import {
  MAX_FILE_SIZE,
  isValidFileSize,
  toAttachmentResponse,
} from '@wegent/chat-core/attachment-response'
export { MAX_FILE_SIZE, isValidFileSize } from '@wegent/chat-core/attachment-response'
import type { Attachment } from '@/types/api'
import { getRuntimeConfig } from '@/config/runtime'
import { createHttpClient } from './http'

export interface AttachmentApi {
  uploadAttachment: (file: File, onProgress?: (progress: number) => void) => Promise<Attachment>
  deleteAttachment: (attachmentId: number) => Promise<void>
  fetchAttachmentBlob: (attachmentId: number) => Promise<Blob>
}

interface CreateAttachmentApiOptions {
  apiBaseUrl?: string
  getToken?: () => string | null
}

export function createAttachmentApi(options: CreateAttachmentApiOptions = {}): AttachmentApi {
  const apiBaseUrl = options.apiBaseUrl ?? getRuntimeConfig().apiBaseUrl
  const getToken = options.getToken ?? (() => localStorage.getItem('auth_token'))

  return {
    uploadAttachment(file, onProgress) {
      if (!isValidFileSize(file.size)) {
        return Promise.reject(new Error(`File size exceeds ${MAX_FILE_SIZE / (1024 * 1024)} MB`))
      }

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
        const token = getToken()
        if (token) {
          xhr.setRequestHeader('Authorization', `Bearer ${token}`)
        }
        xhr.send(formData)
      })
    },
    async deleteAttachment(attachmentId) {
      const client = createHttpClient({ baseUrl: apiBaseUrl, getToken })
      await client.delete(`/attachments/${attachmentId}`)
    },
    fetchAttachmentBlob(attachmentId) {
      const client = createHttpClient({ baseUrl: apiBaseUrl, getToken })
      return client.getBlob(`/attachments/${attachmentId}/download`)
    },
  }
}

export function uploadAttachment(
  file: File,
  onProgress?: (progress: number) => void
): Promise<Attachment> {
  return createAttachmentApi().uploadAttachment(file, onProgress)
}

export function deleteAttachment(attachmentId: number): Promise<void> {
  return createAttachmentApi().deleteAttachment(attachmentId)
}

export function fetchAttachmentBlob(attachmentId: number): Promise<Blob> {
  return createAttachmentApi().fetchAttachmentBlob(attachmentId)
}
