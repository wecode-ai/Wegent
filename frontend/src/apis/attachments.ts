// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Attachment API client for file upload and management.
 */

import { getToken } from './user'
import type { TruncationInfo } from '@/types/api'

// API base URL - use relative path for browser compatibility
const API_BASE_URL = ''

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
  error_code?: string | null
  truncation_info?: TruncationInfo | null
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
 * Error code to i18n key mapping
 */
const ERROR_CODE_MAPPING: Record<
  string,
  { titleKey: string; hintKey: string; hintParams?: Record<string, string | number> }
> = {
  unsupported_type: {
    titleKey: 'attachment.errors.unsupported_type',
    hintKey: 'attachment.errors.unsupported_type_hint',
  },
  unrecognized_type: {
    titleKey: 'attachment.errors.unrecognized_type',
    hintKey: 'attachment.errors.unrecognized_type_hint',
  },
  file_too_large: {
    titleKey: 'attachment.errors.file_too_large',
    hintKey: 'attachment.errors.file_too_large_hint',
    hintParams: { size: 100 },
  },
  parse_failed: {
    titleKey: 'attachment.errors.parse_failed',
    hintKey: 'attachment.errors.parse_failed_hint',
  },
  encrypted_pdf: {
    titleKey: 'attachment.errors.encrypted_pdf',
    hintKey: 'attachment.errors.encrypted_pdf_hint',
  },
  legacy_doc: {
    titleKey: 'attachment.errors.legacy_doc',
    hintKey: 'attachment.errors.legacy_doc_hint',
  },
  legacy_ppt: {
    titleKey: 'attachment.errors.legacy_ppt',
    hintKey: 'attachment.errors.legacy_ppt_hint',
  },
  legacy_xls: {
    titleKey: 'attachment.errors.legacy_xls',
    hintKey: 'attachment.errors.legacy_xls_hint',
  },
}

/**
 * Get localized error message from error code
 * @param errorCode - Backend error code
 * @param t - i18n translation function
 * @returns Localized error message or undefined
 */
export function getErrorMessageFromCode(
  errorCode: string | null | undefined,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  t: (key: string, params?: Record<string, any>) => string
): string | undefined {
  if (!errorCode) return undefined

  const mapping = ERROR_CODE_MAPPING[errorCode]
  if (!mapping) return undefined

  const title = t(mapping.titleKey)
  const hint = t(mapping.hintKey, mapping.hintParams || { types: t('attachment.supported_types') })
  return `${title}: ${hint}`
}

/**
 * Known supported file extensions (for display purposes)
 * Note: The backend also supports any text-based files via MIME detection
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
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.bmp',
  '.webp',
]

/**
 * Common code file extensions (for icon display)
 */
export const CODE_FILE_EXTENSIONS = [
  '.py',
  '.js',
  '.ts',
  '.jsx',
  '.tsx',
  '.java',
  '.c',
  '.cpp',
  '.h',
  '.hpp',
  '.cs',
  '.go',
  '.rs',
  '.rb',
  '.php',
  '.swift',
  '.kt',
  '.scala',
  '.lua',
  '.r',
  '.sql',
  '.sh',
  '.bash',
  '.zsh',
  '.ps1',
  '.vue',
  '.svelte',
]

/**
 * Common config file extensions (for icon display)
 */
export const CONFIG_FILE_EXTENSIONS = [
  '.json',
  '.yaml',
  '.yml',
  '.xml',
  '.toml',
  '.ini',
  '.conf',
  '.cfg',
  '.env',
  '.properties',
  '.dockerfile',
  '.gitignore',
  '.editorconfig',
  '.eslintrc',
  '.prettierrc',
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
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/bmp',
  'image/webp',
]

/**
 * Maximum file size (100 MB)
 */
export const MAX_FILE_SIZE = 100 * 1024 * 1024

/**
 * Check if a file extension is supported
 * Note: Returns true for all extensions - backend will use MIME detection for unknown types
 */
export function isSupportedExtension(_filename: string): boolean {
  // Allow all file types - the backend will validate using MIME detection
  // for unknown extensions and return appropriate error messages
  return true
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
    case '.jpg':
    case '.jpeg':
    case '.png':
    case '.gif':
    case '.bmp':
    case '.webp':
      return '🖼️'
    default:
      // Check for code files
      if (CODE_FILE_EXTENSIONS.includes(ext)) {
        return '💻'
      }
      // Check for config files
      if (CONFIG_FILE_EXTENSIONS.includes(ext)) {
        return '⚙️'
      }
      // Default icon for other text files
      return '📄'
  }
}

/**
 * Image file extensions
 */
export const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp']

/**
 * Check if a file extension is an image type
 */
export function isImageExtension(extension: string): boolean {
  const ext = extension.toLowerCase()
  return IMAGE_EXTENSIONS.includes(ext)
}

/**
 * Get image preview URL for an attachment
 *
 * @param attachmentId - Attachment ID
 * @returns Preview URL
 */
export function getAttachmentPreviewUrl(attachmentId: number): string {
  return `${API_BASE_URL}/api/attachments/${attachmentId}/download`
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

  // Validate file size before upload
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
          // Handle error.detail that could be a string or an object
          let errorMessage = 'Upload failed'
          if (error.detail) {
            if (typeof error.detail === 'string') {
              errorMessage = error.detail
            } else if (typeof error.detail === 'object' && error.detail.message) {
              errorMessage = error.detail.message
            }
          }
          reject(new Error(errorMessage))
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
export async function getAttachment(attachmentId: number): Promise<AttachmentDetailResponse> {
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
export async function downloadAttachment(attachmentId: number, filename: string): Promise<void> {
  const token = getToken()

  const response = await fetch(`${API_BASE_URL}/api/attachments/${attachmentId}/download`, {
    method: 'GET',
    headers: {
      ...(token && { Authorization: `Bearer ${token}` }),
    },
  })

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

  const response = await fetch(`${API_BASE_URL}/api/attachments/subtask/${subtaskId}`, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(token && { Authorization: `Bearer ${token}` }),
    },
  })

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
