// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Multimodal (video/image) file-type constants.
 *
 * Kept in wecode so the open-source apis/attachments.ts stays unmodified.
 * Mirrors the backend `_MULTIMODAL_EXTENSIONS` (shared.utils.multimodal_ext)
 * so UI selection, size limits, and prompt routing match the backend pipeline.
 */

import { VIDEO_EXTENSIONS, isImageExtension } from '@/apis/attachments'

/**
 * Image extensions accepted by the multimodal pipeline.
 * Mirrors backend `_MULTIMODAL_IMAGE_EXTENSIONS`.
 */
export const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp']

/**
 * All extensions accepted by the multimodal pipeline (video + image).
 * Used to build the file input `accept` attribute when a KB has multimodal
 * analysis enabled.
 *
 * NOTE: the open-source attachments.ts VIDEO_EXTENSIONS does not include
 * `.webm`/`.m4v` (added by the multimodal pipeline); we supplement here to
 * stay in sync with the backend `_MULTIMODAL_VIDEO_EXTENSIONS`.
 */
export const MULTIMODAL_EXTENSIONS = [...VIDEO_EXTENSIONS, '.webm', '.m4v', ...IMAGE_EXTENSIONS]

/**
 * Maximum multimodal image file size (100 MB, aligned with backend
 * MULTIMODAL_IMAGE_MAX_BYTES — the absolute cap before GCS upload_simple's
 * own 100 MB limit). Videos keep the 1 GB MAX_VIDEO_FILE_SIZE.
 */
export const MAX_MULTIMODAL_IMAGE_FILE_SIZE = 100 * 1024 * 1024

/**
 * Check if a filename is a multimodal file (video or image).
 */
export function isMultimodalFile(filename: string): boolean {
  const ext = filename.slice(filename.lastIndexOf('.')).toLowerCase()
  return MULTIMODAL_EXTENSIONS.includes(ext)
}

export { isImageExtension }
