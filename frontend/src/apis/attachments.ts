// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Attachment API client for file upload and management.
 */

import { getToken } from './user'

// API base URL
const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || ''

/**
 * Attachment status enum
 */
export type AttachmentStatus = 'uploading' | 'parsing' | 'ready' | 'failed'

/**
 * Attachment response from API
 */
export interface AttachmentResponse {
  id: number
  filename: string
  file_size: number
  mime_type: string
  status: AttachmentStatus
  text_length?: number | null
  error_message?: string | null
}

/**
 * Detailed attachment response
 */
export interface AttachmentDetailResponse extends AttachmentResponse {
  subtask_id?: number | null
  file_extension: string
  created_at: string
}

/**
 * Supported file extensions
 */
export const SUPPORTED_EXTENSIONS = [
  '.pdf',
  '.doc',
  '.docx',
  '.ppt',
  '.pptx',
  '.xls',
  '.xlsx',
  '.csv',
  '.txt',
  '.md',
]

/**
 * Supported MIME types
 */
export const SUPPORTED_MIME_TYPES = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/csv',
  'text/plain',
  'text/markdown',
]

/**
 * Maximum file size (5 MB)
 */
export const MAX_FILE_SIZE = 5 * 1024 * 1024

/**
 * Check if a file extension is supported
 */
export function isSupportedExtension(filename: string): boolean {
  const ext = filename.toLowerCase().substring(filename.lastIndexOf('.'))
  return SUPPORTED_EXTENSIONS.includes(ext)
}

/**
 * Check if file size is within limits
 */
export function isValidFileSize(size: number): boolean {
  return size <= MAX_FILE_SIZE
}

/**
 * Get file extension from filename
 */
export function getFileExtension(filename: string): string {
  return filename.toLowerCase().substring(filename.lastIndexOf('.'))
}

/**
 * Format file size for display
 */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`
  } else if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`
  } else {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }
}

/**
 * Get file icon based on extension
 */
export function getFileIcon(extension: string): string {
  const ext = extension.toLowerCase()
  switch (ext) {
    case '.pdf':
      return '📄'
    case '.doc':
    case '.docx':
      return '📝'
    case '.ppt':
    case '.pptx':
      return '📊'
    case '.xls':
    case '.xlsx':
    case '.csv':
      return '📈'
    case '.txt':
    case '.md':
      return '📃'
    default:
      return '📎'
  }
}

/**
 * Upload a file attachment
 *
 * @param file - File to upload
 * @param onProgress - Optional progress callback (0-100)
 * @returns Attachment response
 */
export async function uploadAttachment(
  file: File,
  onProgress?: (progress: number) => void
): Promise<AttachmentResponse> {
  const token = getToken()

  // Validate file before upload
  if (!isSupportedExtension(file.name)) {
    throw new Error(
      `不支持的文件类型。支持的类型: ${SUPPORTED_EXTENSIONS.join(', ')}`
    )
  }

  if (!isValidFileSize(file.size)) {
    throw new Error(`文件大小超过 ${MAX_FILE_SIZE / (1024 * 1024)} MB 限制`)
  }

  const formData = new FormData()
  formData.append('file', file)

  // Use XMLHttpRequest for progress tracking
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()

    xhr.upload.addEventListener('progress', event => {
      if (event.lengthComputable && onProgress) {
        const progress = Math.round((event.loaded / event.total) * 100)
        onProgress(progress)
      }
    })

    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const response = JSON.parse(xhr.responseText)
          resolve(response)
        } catch {
          reject(new Error('Failed to parse response'))
        }
      } else {
        try {
          const error = JSON.parse(xhr.responseText)
          reject(new Error(error.detail || 'Upload failed'))
        } catch {
          reject(new Error(`Upload failed: ${xhr.status}`))
        }
      }
    })

    xhr.addEventListener('error', () => {
      reject(new Error('Network error during upload'))
    })

    xhr.addEventListener('abort', () => {
      reject(new Error('Upload cancelled'))
    })

    xhr.open('POST', `${API_BASE_URL}/api/attachments/upload`)
    if (token) {
      xhr.setRequestHeader('Authorization', `Bearer ${token}`)
    }
    xhr.send(formData)
  })
}

/**
 * Get attachment details by ID
 *
 * @param attachmentId - Attachment ID
 * @returns Attachment details
 */
export async function getAttachment(
  attachmentId: number
): Promise<AttachmentDetailResponse> {
  const token = getToken()

  const response = await fetch(`${API_BASE_URL}/api/attachments/${attachmentId}`, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(token && { Authorization: `Bearer ${token}` }),
    },
  })

  if (!response.ok) {
    const error = await response.json().catch(() => ({}))
    throw new Error(error.detail || 'Failed to get attachment')
  }

  return response.json()
}

/**
 * Get attachment download URL
 *
 * @param attachmentId - Attachment ID
 * @returns Download URL
 */
export function getAttachmentDownloadUrl(attachmentId: number): string {
  return `${API_BASE_URL}/api/attachments/${attachmentId}/download`
}

/**
 * Download attachment file
 *
 * @param attachmentId - Attachment ID
 * @param filename - Filename for download
 */
export async function downloadAttachment(
  attachmentId: number,
  filename: string
): Promise<void> {
  const token = getToken()

  const response = await fetch(
    `${API_BASE_URL}/api/attachments/${attachmentId}/download`,
    {
      method: 'GET',
      headers: {
        ...(token && { Authorization: `Bearer ${token}` }),
      },
    }
  )

  if (!response.ok) {
    throw new Error('Failed to download attachment')
  }

  const blob = await response.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

/**
 * Delete an attachment
 *
 * @param attachmentId - Attachment ID
 */
export async function deleteAttachment(attachmentId: number): Promise<void> {
  const token = getToken()

  const response = await fetch(`${API_BASE_URL}/api/attachments/${attachmentId}`, {
    method: 'DELETE',
    headers: {
      'Content-Type': 'application/json',
      ...(token && { Authorization: `Bearer ${token}` }),
    },
  })

  if (!response.ok) {
    const error = await response.json().catch(() => ({}))
    throw new Error(error.detail || 'Failed to delete attachment')
  }
}

/**
 * Get attachment by subtask ID
 *
 * @param subtaskId - Subtask ID
 * @returns Attachment details or null
 */
export async function getAttachmentBySubtask(
  subtaskId: number
): Promise<AttachmentDetailResponse | null> {
  const token = getToken()

  const response = await fetch(
    `${API_BASE_URL}/api/attachments/subtask/${subtaskId}`,
    {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(token && { Authorization: `Bearer ${token}` }),
      },
    }
  )

  if (!response.ok) {
    if (response.status === 404) {
      return null
    }
    const error = await response.json().catch(() => ({}))
    throw new Error(error.detail || 'Failed to get attachment')
  }

  const data = await response.json()
  return data || null
}

/**
 * Attachment API exports
 */
export const attachmentApis = {
  uploadAttachment,
  getAttachment,
  getAttachmentDownloadUrl,
  downloadAttachment,
  deleteAttachment,
  getAttachmentBySubtask,
}