// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * KB video upload provider registry (frontend).
 *
 * KB video uploads bypass the generic attachment upload (100 MB, binary) and
 * use a two-phase object-storage contract: the registered uploader sends the
 * binary to the configured object storage (GCS / OSS / ...), then calls the
 * backend `/knowledge-documents/attachments/video-upload/complete` endpoint
 * to register metadata. The binary never reaches the generic
 * `/attachments/upload` path.
 *
 * Open-source default: no uploader registered (null) → KB video files are
 * rejected at the queue stage with a "video upload unavailable" message.
 * Internal deployments register a concrete uploader via
 * `registerVideoUploader()`.
 *
 * Mirrors the backend VideoUploadProvider + the existing video-download-registry
 * pattern (registry + null default + provider registers).
 */

export type VideoUploadResult = {
  attachment_id: number
}

export type VideoUploadFn = (
  file: File,
  onProgress?: (progress: number) => void
) => Promise<VideoUploadResult>

/**
 * A registered KB video uploader carries the provider's size limit so the
 * frontend can validate at queue time (before any bytes leave the browser).
 * `maxSizeBytes` is the absolute ceiling the backing object store / provider
 * accepts; files larger than this are rejected up-front rather than failing
 * mid-upload.
 */
export interface VideoUploader {
  upload: VideoUploadFn
  maxSizeBytes: number
}

let uploader: VideoUploader | null = null

/**
 * Register a KB video uploader (internal deployments).
 * Pass null to clear.
 */
export function registerVideoUploader(fn: VideoUploader | null): void {
  uploader = fn
}

/**
 * Returns the registered video uploader, or null when no provider is wired
 * (open-source default — KB video upload is unavailable).
 */
export function getVideoUploader(): VideoUploader | null {
  return uploader
}
