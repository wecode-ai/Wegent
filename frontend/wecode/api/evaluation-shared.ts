// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared API functions for evaluation module.
 * File upload/download through backend proxy (no S3 URL exposure).
 */

import { fetchJson, getEvaluationUrl } from './evaluation-client'
import { getToken } from '@/apis/user'

// ============================================================================
// Types
// ============================================================================

export type EvalFileType =
  | 'question_content'
  | 'question_criteria'
  | 'exam_attachment'
  | 'topic_attachment'

export interface FileUploadResponse {
  key: string
  filename: string
  file_size: number
  content_type: string
}

export interface EvalAttachment {
  key: string
  filename: string
  file_size?: number
  content_type?: string
}

// ============================================================================
// File Upload API (Backend Proxy)
// ============================================================================

/**
 * Upload a file through backend proxy.
 * The file is uploaded directly to the backend, which proxies it to S3.
 * This avoids exposing S3 URLs to the frontend (prevents Mixed Content issues).
 *
 * @param file - File to upload
 * @param fileType - Type of file (question_content, question_criteria, answer_attachment)
 * @param topicId - Topic ID
 * @param questionId - Question ID (required for question files)
 * @param onProgress - Optional progress callback (0-100)
 * @returns Upload response with S3 key
 */
export async function uploadEvaluationFile(
  file: File,
  fileType: EvalFileType,
  topicId: number,
  questionId?: number,
  slot?: string,
  onProgress?: (progress: number) => void
): Promise<FileUploadResponse> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    const formData = new FormData()

    // Build form data
    formData.append('file', file)
    formData.append('file_type', fileType)
    formData.append('topic_id', topicId.toString())
    if (questionId !== undefined) {
      formData.append('question_id', questionId.toString())
    }
    if (slot !== undefined) {
      formData.append('slot', slot)
    }

    // Track upload progress
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
          reject(new Error('Invalid response format'))
        }
      } else {
        try {
          const errorData = JSON.parse(xhr.responseText)
          reject(new Error(errorData.detail || `Upload failed: ${xhr.status}`))
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

    // Get auth token and make request
    const token = getToken()
    xhr.open('POST', getEvaluationUrl('/shared/files/upload'))
    if (token) {
      xhr.setRequestHeader('Authorization', `Bearer ${token}`)
    }
    xhr.send(formData)
  })
}

// ============================================================================
// File Download API (Backend Proxy)
// ============================================================================

/**
 * Download progress callback type.
 */
export type DownloadProgressCallback = (loaded: number, total: number) => void

/**
 * Download a file through backend proxy with streaming support.
 * The file is fetched from the backend, which proxies it from S3.
 * This avoids exposing S3 URLs to the frontend (prevents Mixed Content issues).
 *
 * Uses ReadableStream for better performance with large files.
 *
 * @param s3Path - S3 storage path
 * @param filename - Optional filename for download
 * @param onProgress - Optional callback for download progress
 */
export async function downloadEvaluationFile(
  s3Path: string,
  filename?: string,
  onProgress?: DownloadProgressCallback
): Promise<void> {
  const token = getToken()
  const params = new URLSearchParams({ s3_path: s3Path })
  const url = getEvaluationUrl(`/shared/files/download?${params}`)

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}))
      throw new Error(errorData.detail || `Download failed: ${response.status}`)
    }

    // Get content length for progress tracking
    const contentLength = response.headers.get('Content-Length')
    const total = contentLength ? parseInt(contentLength, 10) : 0

    // Extract filename from Content-Disposition header or use provided filename
    let downloadFilename = filename
    if (!downloadFilename) {
      const contentDisposition = response.headers.get('Content-Disposition')
      if (contentDisposition) {
        const match = contentDisposition.match(/filename\*?=(?:UTF-8'')?["']?([^"';\s]+)["']?/i)
        if (match) {
          downloadFilename = decodeURIComponent(match[1])
        }
      }
    }

    // Fallback to extracting from path
    if (!downloadFilename) {
      downloadFilename = s3Path.split('/').pop() || 'download'
    }

    // Use ReadableStream for better performance with large files
    const reader = response.body?.getReader()
    if (!reader) {
      throw new Error('Response body is not readable')
    }

    // Read the stream in chunks
    const chunks: Uint8Array[] = []
    let received = 0

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      chunks.push(value)
      received += value.length

      // Report progress
      if (onProgress && total > 0) {
        onProgress(received, total)
      }
    }

    // Combine chunks into a single Uint8Array
    const allChunks = new Uint8Array(received)
    let position = 0
    for (const chunk of chunks) {
      allChunks.set(chunk, position)
      position += chunk.length
    }

    // Create blob and download
    const blob = new Blob([allChunks])
    const blobUrl = URL.createObjectURL(blob)

    // Create a temporary link to trigger download
    const link = document.createElement('a')
    link.href = blobUrl
    link.download = downloadFilename
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)

    // Clean up the blob URL
    URL.revokeObjectURL(blobUrl)
  } catch (error) {
    console.error('Download failed:', error)
    throw error
  }
}

// ============================================================================
// Text-to-File Upload API
// ============================================================================

/**
 * Upload text content as a file through backend proxy.
 * Useful for uploading supplementary notes or other text-based content.
 *
 * @param content - Text content to upload
 * @param filename - Filename for the uploaded file
 * @param fileType - Type of file
 * @param topicId - Topic ID
 * @param questionId - Question ID (optional)
 * @param slot - Slot identifier for exam attachments (optional)
 * @returns Upload response with S3 key
 */
export async function uploadTextAsFile(
  content: string,
  filename: string,
  fileType: EvalFileType,
  topicId: number,
  questionId?: number,
  slot?: string
): Promise<FileUploadResponse> {
  const token = getToken()

  const body = {
    content,
    filename,
    file_type: fileType,
    topic_id: topicId,
    question_id: questionId,
    slot,
  }

  const response = await fetch(getEvaluationUrl('/shared/files/upload-text'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}))
    throw new Error(errorData.detail || `Upload failed: ${response.status}`)
  }

  return response.json()
}

// ============================================================================
// File Content API (for reading text files)
// ============================================================================

/**
 * Fetch file content as text through backend proxy.
 * Used for reading uploaded text files (like supplementary notes) back into the UI.
 *
 * @param s3Path - S3 storage path
 * @returns File content as text string
 */
export async function fetchFileContent(s3Path: string): Promise<string> {
  const token = getToken()
  const params = new URLSearchParams({ s3_path: s3Path })
  const url = getEvaluationUrl(`/shared/files/content?${params}`)

  const response = await fetch(url, {
    method: 'GET',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}))
    throw new Error(errorData.detail || `Failed to fetch file content: ${response.status}`)
  }

  return response.text()
}

// ============================================================================
// Report Viewing API
// ============================================================================

import type { GradingTask } from '../types/evaluation'

/**
 * View a published grading report.
 *
 * @param reportId - Report (GradingTask) ID
 * @returns Grading task with report data
 */
export async function viewReport(reportId: number): Promise<GradingTask> {
  return fetchJson<GradingTask>(getEvaluationUrl(`/shared/reports/${reportId}`))
}
