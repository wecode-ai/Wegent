// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Chunked upload API client for handling large file uploads.
 *
 * This module provides functions for uploading large files in chunks,
 * avoiding gateway timeouts and improving upload reliability.
 *
 * Flow:
 * 1. Call initChunkedUpload() to start an upload session
 * 2. Upload chunks via uploadChunk() sequentially
 * 3. Call completeChunkedUpload() to finalize and create attachment
 * 4. Optionally call abortChunkedUpload() to cancel
 */

import { getToken } from './user'
import type { AttachmentResponse } from './attachments'

const API_BASE_URL = ''

// Default chunk size: 5MB
export const DEFAULT_CHUNK_SIZE = 5 * 1024 * 1024

// Threshold for using chunked upload (files larger than 10MB use chunked upload)
export const CHUNKED_UPLOAD_THRESHOLD = 10 * 1024 * 1024

/**
 * Response from chunked upload initialization
 */
export interface ChunkedUploadInitResponse {
  upload_id: string
  total_chunks: number
  chunk_size: number
}

/**
 * Response from chunk upload
 */
export interface ChunkUploadResponse {
  chunk_index: number
  received_chunks: number
  total_chunks: number
  progress_percent: number
}

/**
 * Response from upload status check
 */
export interface UploadStatusResponse {
  upload_id: string
  filename: string
  file_size: number
  total_chunks: number
  received_chunks: number
  missing_chunks: number[]
  progress_percent: number
  created_at: number
  last_updated: number
}

/**
 * Calculate hash checksum of data using Web Crypto API
 * Note: Prefixed with _ as it's reserved for future use (optional checksum verification)
 */
async function _calculateChecksum(data: ArrayBuffer): Promise<string> {
  // Use SubtleCrypto for hashing (MD5 is not available, use a simple approach)
  // For MD5, we'll use a lightweight implementation
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  // Take first 16 bytes to simulate MD5 length (for checksum purposes)
  return hashArray
    .slice(0, 16)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * Initialize a chunked upload session
 *
 * @param filename - Original filename
 * @param fileSize - Total file size in bytes
 * @param chunkSize - Optional chunk size (default: 5MB)
 * @returns Upload session details
 */
export async function initChunkedUpload(
  filename: string,
  fileSize: number,
  chunkSize?: number
): Promise<ChunkedUploadInitResponse> {
  const token = getToken()

  const response = await fetch(`${API_BASE_URL}/api/attachments/chunked/init`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token && { Authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify({
      filename,
      file_size: fileSize,
      chunk_size: chunkSize,
    }),
  })

  if (!response.ok) {
    const error = await response.json().catch(() => ({}))
    const message = error.detail?.message || error.detail || 'Failed to initialize upload'
    throw new Error(message)
  }

  return response.json()
}

/**
 * Upload a single chunk
 *
 * @param uploadId - Upload session ID
 * @param chunkIndex - Index of this chunk (0-based)
 * @param chunkData - Chunk binary data
 * @param checksum - Optional checksum for verification
 * @returns Upload progress
 */
export async function uploadChunk(
  uploadId: string,
  chunkIndex: number,
  chunkData: Blob,
  checksum?: string
): Promise<ChunkUploadResponse> {
  const token = getToken()

  const formData = new FormData()
  formData.append('chunk_index', chunkIndex.toString())
  formData.append('chunk', chunkData)
  if (checksum) {
    formData.append('checksum', checksum)
  }

  const response = await fetch(`${API_BASE_URL}/api/attachments/chunked/${uploadId}/chunk`, {
    method: 'POST',
    headers: {
      ...(token && { Authorization: `Bearer ${token}` }),
    },
    body: formData,
  })

  if (!response.ok) {
    const error = await response.json().catch(() => ({}))
    const message = error.detail?.message || error.detail || `Failed to upload chunk ${chunkIndex}`
    throw new Error(message)
  }

  return response.json()
}

/**
 * Complete the chunked upload and create attachment
 *
 * @param uploadId - Upload session ID
 * @returns Attachment response
 */
export async function completeChunkedUpload(uploadId: string): Promise<AttachmentResponse> {
  const token = getToken()

  const response = await fetch(`${API_BASE_URL}/api/attachments/chunked/${uploadId}/complete`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token && { Authorization: `Bearer ${token}` }),
    },
  })

  if (!response.ok) {
    const error = await response.json().catch(() => ({}))
    const message = error.detail?.message || error.detail || 'Failed to complete upload'
    throw new Error(message)
  }

  return response.json()
}

/**
 * Abort a chunked upload
 *
 * @param uploadId - Upload session ID
 */
export async function abortChunkedUpload(uploadId: string): Promise<void> {
  const token = getToken()

  const response = await fetch(`${API_BASE_URL}/api/attachments/chunked/${uploadId}/abort`, {
    method: 'DELETE',
    headers: {
      ...(token && { Authorization: `Bearer ${token}` }),
    },
  })

  if (!response.ok) {
    // Ignore abort errors - the upload might already be completed or expired
    console.warn('Failed to abort chunked upload:', uploadId)
  }
}

/**
 * Get upload status
 *
 * @param uploadId - Upload session ID
 * @returns Upload status
 */
export async function getUploadStatus(uploadId: string): Promise<UploadStatusResponse> {
  const token = getToken()

  const response = await fetch(`${API_BASE_URL}/api/attachments/chunked/${uploadId}/status`, {
    method: 'GET',
    headers: {
      ...(token && { Authorization: `Bearer ${token}` }),
    },
  })

  if (!response.ok) {
    const error = await response.json().catch(() => ({}))
    const message = error.detail?.message || error.detail || 'Failed to get upload status'
    throw new Error(message)
  }

  return response.json()
}

/**
 * Progress callback type for chunked upload
 */
export type ChunkedUploadProgressCallback = (progress: {
  phase: 'initializing' | 'uploading' | 'completing'
  uploadedChunks: number
  totalChunks: number
  uploadedBytes: number
  totalBytes: number
  percent: number
}) => void

/**
 * Upload a file using chunked upload
 *
 * This function handles the entire chunked upload flow:
 * 1. Initialize upload session
 * 2. Upload all chunks sequentially
 * 3. Complete the upload
 *
 * @param file - File to upload
 * @param onProgress - Optional progress callback
 * @param abortSignal - Optional AbortSignal to cancel upload
 * @returns Attachment response
 */
export async function uploadFileChunked(
  file: File,
  onProgress?: ChunkedUploadProgressCallback,
  abortSignal?: AbortSignal
): Promise<AttachmentResponse> {
  // Report initializing phase
  onProgress?.({
    phase: 'initializing',
    uploadedChunks: 0,
    totalChunks: 0,
    uploadedBytes: 0,
    totalBytes: file.size,
    percent: 0,
  })

  // Initialize upload
  const initResponse = await initChunkedUpload(file.name, file.size)
  const { upload_id, total_chunks, chunk_size } = initResponse

  try {
    // Upload chunks sequentially
    for (let i = 0; i < total_chunks; i++) {
      // Check for abort
      if (abortSignal?.aborted) {
        await abortChunkedUpload(upload_id)
        throw new Error('Upload cancelled')
      }

      const start = i * chunk_size
      const end = Math.min(start + chunk_size, file.size)
      const chunkBlob = file.slice(start, end)

      await uploadChunk(upload_id, i, chunkBlob)

      // Report progress
      const uploadedBytes = end
      onProgress?.({
        phase: 'uploading',
        uploadedChunks: i + 1,
        totalChunks: total_chunks,
        uploadedBytes,
        totalBytes: file.size,
        percent: Math.round((uploadedBytes / file.size) * 90), // 0-90% for upload phase
      })
    }

    // Check for abort before completing
    if (abortSignal?.aborted) {
      await abortChunkedUpload(upload_id)
      throw new Error('Upload cancelled')
    }

    // Report completing phase
    onProgress?.({
      phase: 'completing',
      uploadedChunks: total_chunks,
      totalChunks: total_chunks,
      uploadedBytes: file.size,
      totalBytes: file.size,
      percent: 95,
    })

    // Complete upload
    const attachment = await completeChunkedUpload(upload_id)

    // Report 100%
    onProgress?.({
      phase: 'completing',
      uploadedChunks: total_chunks,
      totalChunks: total_chunks,
      uploadedBytes: file.size,
      totalBytes: file.size,
      percent: 100,
    })

    return attachment
  } catch (error) {
    // Try to abort on error (best effort)
    try {
      await abortChunkedUpload(upload_id)
    } catch {
      // Ignore abort errors
    }
    throw error
  }
}

/**
 * Check if a file should use chunked upload
 *
 * @param fileSize - File size in bytes
 * @returns true if chunked upload should be used
 */
export function shouldUseChunkedUpload(fileSize: number): boolean {
  return fileSize > CHUNKED_UPLOAD_THRESHOLD
}

/**
 * Chunked upload API exports
 */
export const chunkedUploadApis = {
  initChunkedUpload,
  uploadChunk,
  completeChunkedUpload,
  abortChunkedUpload,
  getUploadStatus,
  uploadFileChunked,
  shouldUseChunkedUpload,
}
