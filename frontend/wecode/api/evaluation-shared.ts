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

export type EvalFileType = 'question_content' | 'question_criteria' | 'answer_attachment'

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
 * Download a file through backend proxy.
 * The file is fetched from the backend, which proxies it from S3.
 * This avoids exposing S3 URLs to the frontend (prevents Mixed Content issues).
 *
 * @param s3Path - S3 storage path
 * @param filename - Optional filename for download
 */
export async function downloadEvaluationFile(s3Path: string, filename?: string): Promise<void> {
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

    // Get the blob from response
    const blob = await response.blob()
    const blobUrl = URL.createObjectURL(blob)

    // Extract filename from Content-Disposition header or use provided filename
    let downloadFilename = filename
    if (!downloadFilename) {
      const contentDisposition = response.headers.get('Content-Disposition')
      if (contentDisposition) {
        // Try to extract filename from Content-Disposition
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
