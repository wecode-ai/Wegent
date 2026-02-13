// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared API functions for evaluation module.
 * Includes file upload/download with presigned URLs.
 */

import { fetchJson, getEvaluationUrl } from './evaluation-client'
import { getToken } from '@/apis/user'

// ============================================================================
// Types
// ============================================================================

export type EvalFileType = 'question_content' | 'question_criteria' | 'answer_attachment'

export interface FileUploadRequest {
  file_type: EvalFileType
  filename: string
  topic_id: number
  question_id?: number
  content_type?: string
}

export interface FileUploadResponse {
  key: string
  upload_url: string
  expires_in: number
}

export interface FileDownloadResponse {
  download_url: string
  expires_in: number
}

export interface EvalAttachment {
  key: string
  filename: string
  file_size?: number
  content_type?: string
}

// ============================================================================
// File Upload API
// ============================================================================

/**
 * Get a presigned URL for uploading a file to S3.
 *
 * @param request - Upload request containing file metadata
 * @returns Presigned PUT URL for uploading
 */
export async function getUploadUrl(request: FileUploadRequest): Promise<FileUploadResponse> {
  return fetchJson<FileUploadResponse>(getEvaluationUrl('/shared/files/upload'), {
    method: 'POST',
    body: JSON.stringify(request),
  })
}

/**
 * Get a presigned URL for downloading a file from S3.
 *
 * @param s3Path - S3 storage path of the file
 * @returns Presigned GET URL for downloading
 */
export async function getDownloadUrl(s3Path: string): Promise<FileDownloadResponse> {
  const params = new URLSearchParams({ s3_path: s3Path })
  return fetchJson<FileDownloadResponse>(getEvaluationUrl(`/shared/files/download?${params}`))
}

/**
 * Upload a file directly to S3 using the presigned URL.
 *
 * @param uploadUrl - Presigned PUT URL from getUploadUrl
 * @param file - File to upload
 * @param onProgress - Optional progress callback (0-100)
 */
export async function uploadFileToS3(
  uploadUrl: string,
  file: File,
  onProgress?: (progress: number) => void
): Promise<void> {
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
        resolve()
      } else {
        reject(new Error(`Upload failed: ${xhr.status}`))
      }
    })

    xhr.addEventListener('error', () => {
      reject(new Error('Network error during upload'))
    })

    xhr.addEventListener('abort', () => {
      reject(new Error('Upload cancelled'))
    })

    xhr.open('PUT', uploadUrl)
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream')
    xhr.send(file)
  })
}

/**
 * Complete file upload workflow: get presigned URL and upload file.
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
  // Step 1: Get presigned URL
  const uploadResponse = await getUploadUrl({
    file_type: fileType,
    filename: file.name,
    topic_id: topicId,
    question_id: questionId,
    content_type: file.type,
  })

  // Step 2: Upload file to S3
  await uploadFileToS3(uploadResponse.upload_url, file, onProgress)

  return uploadResponse
}

/**
 * Download a file from S3.
 *
 * @param s3Path - S3 storage path
 * @param filename - Optional filename for download
 */
export async function downloadEvaluationFile(s3Path: string, filename?: string): Promise<void> {
  const { download_url } = await getDownloadUrl(s3Path)

  // Create a temporary link to trigger download
  const link = document.createElement('a')
  link.href = download_url
  if (filename) {
    link.download = filename
  }
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
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
