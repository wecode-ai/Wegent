// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0
/**
 * Weibo KB video uploader — registers a VideoUploader that drives the
 * two-phase VideoUploadProvider contract against the Weibo file platform.
 *
 * Phase 1 (init): POST /knowledge-documents/attachments/video-upload/init with
 *   the file md5 (file_hash). The backend WeiboVideoUploadProvider opens a
 *   Weibo chunked upload session and returns { upload_url, headers, extra }
 *   carrying the file_token, X-Up-Auth, chunk_size and filecheck.
 * Phase 2 (chunks): the frontend streams chunks directly to Weibo's
 *   upload.json (reusing the shared chunk helpers from @/apis/attachments —
 *   the binary never enters the backend). The last chunk returns the fid.
 * Phase 3 (complete): POST /knowledge-documents/attachments/video-upload/complete
 *   with { fid }; the backend persists only metadata (fid + storage_backend).
 *
 * Registered as a side effect of loading @wecode/features/knowledge.
 */

import { getToken } from '@/apis/user'
import {
  calculateMD5Chunked,
  getWeiboChunkTasks,
  uploadWeiboChunksConcurrently,
} from '@/apis/attachments'
import {
  registerVideoUploader,
  type VideoUploadResult,
} from '@/features/knowledge/multimodal/video-upload-registry'

const VIDEO_UPLOAD_INIT_PATH = '/api/knowledge-documents/attachments/video-upload/init'
const VIDEO_UPLOAD_COMPLETE_PATH = '/api/knowledge-documents/attachments/video-upload/complete'
// 1 GB — mirrors backend VIDEO_MAX_BYTES; rejected up-front at queue time.
const WEIBO_VIDEO_MAX_BYTES = 1024 * 1024 * 1024

interface VideoUploadInitResponse {
  upload_url: string
  method: string
  headers: Record<string, string>
  extra: Record<string, string | number>
}

interface VideoUploadCompleteResponse {
  attachment_id: number
  storage_backend: string
  object_key: string
}

function getExtension(filename: string): string {
  const dot = filename.lastIndexOf('.')
  return dot >= 0 ? filename.slice(dot) : ''
}

async function initVideoUpload(file: File, fileHash: string): Promise<VideoUploadInitResponse> {
  const token = getToken()
  const response = await fetch(VIDEO_UPLOAD_INIT_PATH, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token && { Authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify({
      filename: file.name,
      file_size: file.size,
      file_extension: getExtension(file.name),
      file_hash: fileHash,
    }),
  })
  if (!response.ok) {
    const error = await response.json().catch(() => ({}))
    if (response.status === 413) {
      throw new Error(`Video file is too large (max ${WEIBO_VIDEO_MAX_BYTES / 1024 / 1024}MB)`)
    }
    if (response.status === 401) {
      throw new Error('Authentication required for video upload')
    }
    throw new Error(error.detail || `Video upload init failed: ${response.status}`)
  }
  return response.json() as Promise<VideoUploadInitResponse>
}

async function completeVideoUpload(
  file: File,
  fid: number,
  requestId?: string
): Promise<VideoUploadCompleteResponse> {
  const token = getToken()
  const response = await fetch(VIDEO_UPLOAD_COMPLETE_PATH, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token && { Authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify({
      filename: file.name,
      file_size: file.size,
      file_extension: getExtension(file.name),
      upload_result: { fid, ...(requestId && { request_id: requestId }) },
    }),
  })
  if (!response.ok) {
    const error = await response.json().catch(() => ({}))
    if (response.status === 401) {
      throw new Error('Authentication required for video upload')
    }
    throw new Error(error.detail || `Video upload complete failed: ${response.status}`)
  }
  return response.json() as Promise<VideoUploadCompleteResponse>
}

async function upload(
  file: File,
  onProgress?: (progress: number) => void
): Promise<VideoUploadResult> {
  // Phase 1: open a Weibo chunked upload session via the framework provider.
  const fileHash = await calculateMD5Chunked(file)
  const init = await initVideoUpload(file, fileHash)

  const auth = init.headers['X-Up-Auth']
  const fileToken = String(init.extra.file_token ?? '')
  const chunkSize = Number(init.extra.chunk_size ?? 0)
  const fileCheck = String(init.extra.filecheck ?? fileHash)
  if (!auth || !fileToken || !chunkSize) {
    throw new Error('Video upload init returned incomplete upload target')
  }

  // Phase 2: stream chunks directly to Weibo (binary never hits the backend).
  const tasks = getWeiboChunkTasks(file, chunkSize)
  const lastResponse = await uploadWeiboChunksConcurrently(
    tasks,
    { auth, fileToken, fileCheck, fileLength: file.size },
    onProgress
  )
  const fidRaw = lastResponse?.fid
  if (!fidRaw) {
    throw new Error('Video upload completed but no fid returned')
  }
  const fid = parseInt(String(fidRaw), 10)

  // Phase 3: register metadata (fid) via the framework complete endpoint.
  const result = await completeVideoUpload(file, fid, lastResponse?.request_id)
  return { attachment_id: result.attachment_id }
}

registerVideoUploader({ upload, maxSizeBytes: WEIBO_VIDEO_MAX_BYTES })
