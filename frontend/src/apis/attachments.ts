// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Attachment API client for file upload and management.
 */

import SparkMD5 from 'spark-md5'

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
 * Attachment preview response with extracted text snippet
 */
export interface AttachmentPreviewResponse extends AttachmentDetailResponse {
  preview_type: 'text' | 'image' | 'html' | 'none'
  preview_text?: string | null
  download_url: string
}

/**
 * Public share link response
 */
export interface PublicShareLinkResponse {
  share_url: string
  expires_at: string
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
  // Video formats
  '.mp4',
  '.avi',
  '.mkv',
  '.mov',
  '.flv',
  '.wmv',
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
  'application/vnd.xmind.workbook',
  'text/plain',
  'text/markdown',
  'text/html',
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/bmp',
  'image/webp',
]

/**
 * Maximum file size (100 MB for general files)
 */
export const MAX_FILE_SIZE = 100 * 1024 * 1024

/**
 * Maximum video file size (1 GB)
 */
export const MAX_VIDEO_FILE_SIZE = 1024 * 1024 * 1024

/**
 * Video file extensions supported for media-analysis Skill
 */
export const VIDEO_EXTENSIONS = ['.mp4', '.avi', '.mkv', '.mov', '.flv', '.wmv']

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
 * @param size - File size in bytes
 * @param isVideo - Whether the file is a video (uses 1GB limit)
 */
export function isValidFileSize(size: number, isVideo: boolean = false): boolean {
  const limit = isVideo ? MAX_VIDEO_FILE_SIZE : MAX_FILE_SIZE
  return size <= limit
}

/**
 * Check if a file extension is a video type
 */
export function isVideoExtension(extension: string): boolean {
  const ext = extension.startsWith('.') ? extension.toLowerCase() : `.${extension.toLowerCase()}`
  return VIDEO_EXTENSIONS.includes(ext)
}

/**
 * Check if a filename is a supported video file.
 */
export function isVideoFileName(filename: string): boolean {
  const dotIndex = filename.lastIndexOf('.')
  if (dotIndex < 0) return false
  return isVideoExtension(filename.slice(dotIndex))
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
    case '.xmind':
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
    case '.mp4':
    case '.avi':
    case '.mkv':
    case '.mov':
    case '.flv':
    case '.wmv':
      return '🎬'
    case '.html':
    case '.htm':
    case '.html5':
      return '🌐'
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
 * HTML file extensions
 */
export const HTML_EXTENSIONS = ['.html', '.htm', '.html5']

/**
 * Check if a file extension is an image type
 */
export function isImageExtension(extension: string): boolean {
  const ext = extension.toLowerCase()
  return IMAGE_EXTENSIONS.includes(ext)
}

/**
 * Check if a file extension is an HTML type
 */
export function isHtmlExtension(extension: string): boolean {
  const ext = extension.toLowerCase()
  return HTML_EXTENSIONS.includes(ext)
}

/**
 * Get image preview URL for an attachment
 *
 * @param attachmentId - Attachment ID
 * @param shareToken - Optional share token for public access
 * @returns Preview URL
 */
export function getAttachmentPreviewUrl(attachmentId: number, shareToken?: string): string {
  const baseUrl = `${API_BASE_URL}/api/attachments/${attachmentId}/download`
  if (shareToken) {
    return `${baseUrl}?share_token=${encodeURIComponent(shareToken)}`
  }
  return baseUrl
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
 * @param shareToken - Optional share token for public access (no login required)
 * @returns Attachment details
 */
export async function getAttachment(
  attachmentId: number,
  shareToken?: string
): Promise<AttachmentDetailResponse> {
  const token = getToken()
  let url = `${API_BASE_URL}/api/attachments/${attachmentId}`

  // Add share_token as query parameter if provided
  if (shareToken) {
    url += `?share_token=${encodeURIComponent(shareToken)}`
  }

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      // Only include Authorization header if we have a token and no shareToken
      // shareToken-based access doesn't require JWT authentication
      ...(!shareToken && token && { Authorization: `Bearer ${token}` }),
    },
  })

  if (!response.ok) {
    const error = await response.json().catch(() => ({}))
    throw new Error(error.detail || 'Failed to get attachment')
  }

  return response.json()
}

/**
 * Get attachment preview by ID
 *
 * @param attachmentId - Attachment ID
 * @param shareToken - Optional share token for public access (no login required)
 * @returns Attachment preview details
 */
export async function getAttachmentPreview(
  attachmentId: number,
  shareToken?: string
): Promise<AttachmentPreviewResponse> {
  const token = getToken()
  let url = `${API_BASE_URL}/api/attachments/${attachmentId}/preview`

  // Add share_token as query parameter if provided
  if (shareToken) {
    url += `?share_token=${encodeURIComponent(shareToken)}`
  }

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      // Only include Authorization header if we have a token and no shareToken
      // shareToken-based access doesn't require JWT authentication
      ...(!shareToken && token && { Authorization: `Bearer ${token}` }),
    },
  })

  if (!response.ok) {
    const error = await response.json().catch(() => ({}))
    throw new Error(error.detail || 'Failed to get attachment preview')
  }

  return response.json()
}

/**
 * Get attachment download URL
 *
 * @param attachmentId - Attachment ID
 * @param shareToken - Optional share token for public access
 * @returns Download URL
 */
export function getAttachmentDownloadUrl(attachmentId: number, shareToken?: string): string {
  const baseUrl = `${API_BASE_URL}/api/attachments/${attachmentId}/download`
  if (shareToken) {
    return `${baseUrl}?share_token=${encodeURIComponent(shareToken)}`
  }
  return baseUrl
}

/**
 * Download attachment file
 *
 * @param attachmentId - Attachment ID
 * @param filename - Optional filename for download. If not provided, will be extracted from Content-Disposition header
 * @param shareToken - Optional share token for public access (no login required)
 */
export async function downloadAttachment(
  attachmentId: number,
  filename?: string,
  shareToken?: string
): Promise<void> {
  const token = getToken()
  const downloadUrl = getAttachmentDownloadUrl(attachmentId, shareToken)

  const response = await fetch(downloadUrl, {
    method: 'GET',
    headers: {
      // Only include Authorization header if we have a token and no shareToken
      // shareToken-based access doesn't require JWT authentication
      ...(!shareToken && token && { Authorization: `Bearer ${token}` }),
    },
  })

  if (!response.ok) {
    throw new Error('Failed to download attachment')
  }

  // Extract filename from Content-Disposition header if not provided
  let downloadFilename = filename
  if (!downloadFilename) {
    const contentDisposition = response.headers.get('Content-Disposition')
    if (contentDisposition) {
      // Parse filename from Content-Disposition header
      // Format: attachment; filename="example.pdf" or attachment; filename*=UTF-8''example.pdf
      // Try RFC 5987 format first (filename*=UTF-8''encoded_filename)
      const rfc5987Match = contentDisposition.match(/filename\*=UTF-8''(.+)/)
      if (rfc5987Match && rfc5987Match[1]) {
        downloadFilename = rfc5987Match[1]
        // Decode URI component if it's encoded
        try {
          downloadFilename = decodeURIComponent(downloadFilename)
        } catch {
          // Keep original if decode fails
        }
      } else {
        // Fallback to standard format (filename="example.pdf")
        const standardMatch = contentDisposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/)
        if (standardMatch && standardMatch[1]) {
          downloadFilename = standardMatch[1].replace(/['"]/g, '')
        }
      }
    }
    // Fallback filename if extraction fails
    if (!downloadFilename) {
      downloadFilename = `attachment-${attachmentId}.file`
    }
  }

  const blob = await response.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = downloadFilename
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
 * Create public share link for attachment
 *
 * @param attachmentId - Attachment ID
 * @param expiresInDays - Link expiration time in days (1-30, default: 7)
 * @returns Share URL and expiration time
 */
export async function createAttachmentShareLink(
  attachmentId: number,
  expiresInDays: number = 7
): Promise<PublicShareLinkResponse> {
  const token = getToken()

  const response = await fetch(
    `${API_BASE_URL}/api/attachments/${attachmentId}/public-share?expires_in_days=${expiresInDays}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token && { Authorization: `Bearer ${token}` }),
      },
    }
  )

  if (!response.ok) {
    const error = await response.json().catch(() => ({}))
    throw new Error(error.detail || 'Failed to create share link')
  }

  return response.json()
}

// ==================== Video Upload APIs ====================

/**
 * Weibo file service upload response
 */
interface WeiboUploadResponse {
  fid: number
  request_id: string
  url: string
}

/**
 * Weibo init response for chunked upload (from backend API)
 */
interface WeiboInitResponse {
  file_token: string
  chunk_size: number // in bytes
  auth: string // X-Up-Auth header value for chunk upload
  request_id: string
  file_check: string // MD5 hash of the file (calculated during init)
}

/**
 * Weibo chunk upload response
 */
export interface WeiboChunkUploadResponse {
  succ?: boolean
  fid?: string // only in last chunk response
  fmid?: string
  url?: string
  request_id: string
  error?: string
  msg?: string
  errmsg?: string
  message?: string
}

/**
 * Calculate MD5 hash of a file using chunked reading
 * to avoid memory issues with large files (e.g., 1GB videos)
 *
 * @param file - File to calculate MD5 for
 * @returns MD5 hash string
 */
async function calculateMD5Chunked(file: File): Promise<string> {
  const chunkSize = 10 * 1024 * 1024 // 10MB chunks
  const spark = new SparkMD5.ArrayBuffer()

  for (let offset = 0; offset < file.size; offset += chunkSize) {
    const chunk = file.slice(offset, Math.min(offset + chunkSize, file.size))
    const arrayBuffer = await chunk.arrayBuffer()
    spark.append(arrayBuffer)
  }

  return spark.end()
}

/**
 * Calculate MD5 hash of a blob chunk
 */
async function calculateChunkMD5(blob: Blob): Promise<string> {
  const arrayBuffer = await blob.arrayBuffer()
  const spark = new SparkMD5.ArrayBuffer()
  spark.append(arrayBuffer)
  return spark.end()
}

/**
 * Initialize Weibo chunked upload via backend API
 * @param file - File to upload
 * @returns Init response including file_check (MD5) for reuse
 */
async function initWeiboUpload(file: File): Promise<WeiboInitResponse> {
  const token = getToken()
  const md5Hex = await calculateMD5Chunked(file)

  const response = await fetch(`${API_BASE_URL}/api/attachments/weibo-init`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token && { Authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify({
      filename: file.name,
      file_size: file.size,
      file_check: md5Hex,
    }),
  })

  if (!response.ok) {
    const error = await response.json().catch(() => ({}))
    throw new Error(error.detail || `Weibo init failed: ${response.status}`)
  }

  const data = await response.json()
  if (!data.file_token) {
    throw new Error('Weibo init failed: no file_token returned')
  }

  // Return init response with file_check for reuse
  return {
    file_token: data.file_token,
    chunk_size: data.chunk_size,
    auth: data.auth,
    request_id: data.request_id,
    file_check: md5Hex, // Include calculated MD5 for reuse
  }
}

/**
 * Upload a single chunk to Weibo
 */
function uploadWeiboChunk(
  chunk: Blob,
  params: {
    auth: string // X-Up-Auth header value
    fileToken: string
    startLoc: number
    sectionCheck: string
    chunkCount: number
    chunkIndex: number
    chunkSize: number
    fileLength: number
    fileCheck: string
  },
  onChunkProgress?: (progress: number) => void,
  abortSignal?: AbortSignal
): Promise<WeiboChunkUploadResponse> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()

    const query = new URLSearchParams({
      filetoken: params.fileToken,
      startloc: String(params.startLoc),
      sectioncheck: params.sectionCheck,
      chunkcount: String(params.chunkCount),
      chunkindex: String(params.chunkIndex),
      chunksize: String(params.chunkSize),
      filelength: String(params.fileLength),
      filecheck: params.fileCheck,
    })
    const url = `https://i.fileplatform.api.weibo.com/2/multimedia/upload.json?${query.toString()}`

    // Handle abort signal
    const handleAbort = () => {
      xhr.abort()
      reject(new Error('Upload cancelled'))
    }

    if (abortSignal) {
      if (abortSignal.aborted) {
        reject(new Error('Upload cancelled'))
        return
      }
      abortSignal.addEventListener('abort', handleAbort)
    }

    xhr.upload.addEventListener('progress', event => {
      if (event.lengthComputable && onChunkProgress) {
        onChunkProgress(Math.round((event.loaded / event.total) * 100))
      }
    })

    xhr.addEventListener('load', () => {
      if (abortSignal) {
        abortSignal.removeEventListener('abort', handleAbort)
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const response: WeiboChunkUploadResponse = JSON.parse(xhr.responseText)
          const businessError = getWeiboChunkUploadError(response)
          if (businessError) {
            reject(new Error(businessError))
            return
          }
          resolve(response)
        } catch {
          reject(new Error('Failed to parse Weibo chunk response'))
        }
      } else {
        reject(new Error(`Weibo chunk upload failed: ${xhr.status}`))
      }
    })

    xhr.addEventListener('error', () => {
      if (abortSignal) {
        abortSignal.removeEventListener('abort', handleAbort)
      }
      reject(new Error('Network error during chunk upload'))
    })

    xhr.addEventListener('abort', () => {
      if (abortSignal) {
        abortSignal.removeEventListener('abort', handleAbort)
      }
      reject(new Error('Upload cancelled'))
    })

    xhr.open('POST', url)
    xhr.setRequestHeader('Content-Type', 'application/octet-stream')
    xhr.setRequestHeader('X-Up-Auth', params.auth)
    chunk.arrayBuffer().then(buffer => xhr.send(buffer))
  })
}

export function getWeiboChunkUploadError(response: WeiboChunkUploadResponse): string | null {
  if (response.succ !== false) {
    return null
  }
  return (
    response.error ||
    response.errmsg ||
    response.msg ||
    response.message ||
    'Weibo chunk upload failed'
  )
}

/**
 * Upload video to Weibo file service platform using chunked upload
 *
 * @param file - Video file to upload
 * @param onProgress - Optional progress callback (0-100)
 * @param abortSignal - Optional AbortSignal to cancel the upload
 * @returns Upload result with fid
 */
export async function uploadVideoToWeibo(
  file: File,
  onProgress?: (progress: number) => void,
  abortSignal?: AbortSignal
): Promise<WeiboUploadResponse> {
  // Step 1: Initialize upload via backend to get file_token, chunk size, auth and file_check (MD5)
  const initResult = await initWeiboUpload(file)
  const { file_token: fileToken, chunk_size: chunkSize, auth, file_check: fileCheck } = initResult

  // Step 2: Calculate total chunks (MD5 already calculated in initWeiboUpload)
  const totalChunks = Math.ceil(file.size / chunkSize)

  // Step 3: Upload each chunk
  let lastResponse: WeiboChunkUploadResponse | null = null

  for (let i = 0; i < totalChunks; i++) {
    // Check for abort
    if (abortSignal?.aborted) {
      throw new Error('Upload cancelled')
    }

    const startLoc = i * chunkSize
    const endLoc = Math.min(startLoc + chunkSize, file.size)
    const chunk = file.slice(startLoc, endLoc)
    const chunkIndex = i + 1 // Weibo uses 1-based index
    const actualChunkSize = endLoc - startLoc

    // Calculate chunk MD5
    const sectionCheck = await calculateChunkMD5(chunk)

    // Upload chunk with retry
    let retryCount = 0
    const maxRetries = 3

    while (retryCount < maxRetries) {
      try {
        lastResponse = await uploadWeiboChunk(
          chunk,
          {
            auth,
            fileToken,
            startLoc,
            sectionCheck,
            chunkCount: totalChunks,
            chunkIndex,
            chunkSize: actualChunkSize,
            fileLength: file.size,
            fileCheck,
          },
          chunkProgress => {
            // Update overall progress
            if (onProgress) {
              const baseProgress = (i / totalChunks) * 100
              const chunkContribution = (chunkProgress / 100) * (100 / totalChunks)
              onProgress(Math.round(baseProgress + chunkContribution))
            }
          },
          abortSignal // Pass abort signal to chunk upload
        )
        break // Success, exit retry loop
      } catch (error) {
        // Don't retry on cancel
        if ((error as Error).message === 'Upload cancelled') {
          throw error
        }
        retryCount++
        if (retryCount >= maxRetries) {
          throw error
        }
        // Wait before retry
        await new Promise(resolve => setTimeout(resolve, 1000 * retryCount))
      }
    }

    // Update progress after chunk completion
    if (onProgress) {
      onProgress(Math.round(((i + 1) / totalChunks) * 100))
    }
  }

  // Step 5: Return result from last chunk (contains fid)
  if (!lastResponse?.fid) {
    throw new Error('Upload completed but no fid returned')
  }

  return {
    fid: parseInt(lastResponse.fid, 10),
    request_id: lastResponse.request_id,
    url: lastResponse.url || '',
  }
}

/**
 * Upload video file (complete flow: Weibo upload + backend metadata save)
 *
 * This is a unified entry point for video uploads, used by all hooks.
 *
 * @param file - Video file to upload
 * @param onProgress - Optional progress callback (0-100)
 * @param abortSignal - Optional AbortSignal to cancel the upload
 * @returns Attachment response
 */
export async function uploadVideo(
  file: File,
  onProgress?: (progress: number) => void,
  abortSignal?: AbortSignal
): Promise<AttachmentResponse> {
  const extension = getFileExtension(file.name)

  // Step 1: Upload to Weibo platform (auth handled via backend init API)
  const weiboResult = await uploadVideoToWeibo(file, onProgress, abortSignal)

  // Step 2: Save video metadata to backend
  return saveVideoMetadata(file.name, file.size, extension, weiboResult.fid)
}

/**
 * Save video metadata to backend after Weibo upload
 *
 * @param filename - Original filename
 * @param fileSize - File size in bytes
 * @param fileExtension - File extension (e.g., ".mp4")
 * @param fid - File ID returned by Weibo platform
 * @returns Attachment response
 */
export async function saveVideoMetadata(
  filename: string,
  fileSize: number,
  fileExtension: string,
  fid: number
): Promise<AttachmentResponse> {
  const token = getToken()

  const response = await fetch(`${API_BASE_URL}/api/attachments/upload-video-metadata`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token && { Authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify({
      filename,
      file_size: fileSize,
      file_extension: fileExtension,
      fid,
    }),
  })

  if (!response.ok) {
    const error = await response.json().catch(() => ({}))
    throw new Error(error.detail || 'Failed to save video metadata')
  }

  return response.json()
}

/**
 * Unified file upload function that automatically routes to the appropriate
 * upload method based on file type (video vs regular file).
 *
 * @param file - File to upload
 * @param onProgress - Optional progress callback (0-100)
 * @param abortSignal - Optional AbortSignal to cancel the upload (video only, at chunk boundaries)
 * @returns Attachment response
 */
export async function uploadFile(
  file: File,
  onProgress?: (progress: number) => void,
  abortSignal?: AbortSignal
): Promise<AttachmentResponse> {
  const extension = getFileExtension(file.name)
  const isVideo = isVideoExtension(extension)

  if (isVideo) {
    return uploadVideo(file, onProgress, abortSignal)
  } else {
    return uploadAttachment(file, onProgress)
  }
}

/**
 * Validate file before upload and get error message if invalid.
 *
 * @param file - File to validate
 * @param t - i18n translation function
 * @returns Error message if validation fails, null if valid
 */
export function validateFile(
  file: File,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  t: (key: string, params?: Record<string, any>) => string
): string | null {
  // Check file type
  if (!isSupportedExtension(file.name)) {
    return `${t('common:attachment.errors.unsupported_type')}: ${t('common:attachment.errors.unsupported_type_hint', { types: t('common:attachment.supported_types') })}`
  }

  // Check file size
  const extension = getFileExtension(file.name)
  const isVideo = isVideoExtension(extension)
  if (!isValidFileSize(file.size, isVideo)) {
    const limitMB = isVideo
      ? Math.round(MAX_VIDEO_FILE_SIZE / (1024 * 1024))
      : Math.round(MAX_FILE_SIZE / (1024 * 1024))
    return `${t('common:attachment.errors.file_too_large')}: ${t('common:attachment.errors.file_too_large_hint', { size: limitMB })}`
  }

  return null
}

/**
 * Get file size limit in MB based on file type.
 *
 * @param filename - File name to check
 * @returns Size limit in MB
 */
export function getFileSizeLimitMB(filename: string): number {
  const extension = getFileExtension(filename)
  const isVideo = isVideoExtension(extension)
  return isVideo
    ? Math.round(MAX_VIDEO_FILE_SIZE / (1024 * 1024))
    : Math.round(MAX_FILE_SIZE / (1024 * 1024))
}

/**
 * Attachment API exports
 */
export const attachmentApis = {
  uploadAttachment,
  getAttachment,
  getAttachmentPreview,
  getAttachmentDownloadUrl,
  downloadAttachment,
  deleteAttachment,
  getAttachmentBySubtask,
  createAttachmentShareLink,
  uploadVideoToWeibo,
  saveVideoMetadata,
  uploadVideo,
  uploadFile,
  validateFile,
  getFileSizeLimitMB,
}
