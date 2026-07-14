// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * KB upload file-type validation for the multimodal pipeline.
 *
 * Extracted from the open-source DocumentUpload so that file stays free of
 * multimodal-specific extension sets and gating logic. Pure functions + consts.
 */

import { VIDEO_EXTENSIONS } from '@/apis/attachments'

/**
 * Fallback document/code extensions selectable in the KB upload file picker.
 * The runtime value comes from /knowledge-bases/config so backend registry and
 * optional deployment configuration remain the source of truth.
 */
export const DEFAULT_KB_DOCUMENT_ACCEPT =
  '.c,.cpp,.css,.csv,.doc,.docx,.eml,.epub,.go,.htm,.html,.ini,.java,.js,.json,.kt,.kts,.lock,.markdown,.md,.pdf,.php,.ppt,.pptx,.py,.rb,.rs,.sh,.sql,.swift,.toml,.ts,.txt,.vue,.xls,.xlsx,.xmind,.xml,.yaml,.yml'

/**
 * Fallback multimodal extensions accepted by the KB upload file picker when
 * multimodal analysis is enabled for the current KB.
 */
export const DEFAULT_KB_MULTIMODAL_ACCEPT = [
  ...VIDEO_EXTENSIONS,
  '.bmp',
  '.gif',
  '.jpeg',
  '.jpg',
  '.png',
  '.webp',
].join(',')

/**
 * Image extensions. Unsupported for RAG UNLESS the KB has multimodal analysis
 * enabled (video+image). When disabled, they get a friendly upload error.
 */
export const KB_IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp']

/**
 * Check if a file extension is unsupported. Image extensions are unsupported
 * unless multimodal analysis is enabled for this KB. Video extensions are
 * unsupported when the selected model lacks supportsVideo (image-only model).
 */
export function isKBUnsupportedExtension(
  filename: string,
  multimodalEnabled: boolean,
  modelSupportsVideo: boolean
): boolean {
  const ext = filename.toLowerCase().slice(filename.lastIndexOf('.'))
  if (KB_IMAGE_EXTENSIONS.includes(ext)) {
    // Images are only supported when multimodal analysis is enabled.
    return !multimodalEnabled
  }
  if (VIDEO_EXTENSIONS.includes(ext)) {
    // Videos need both multimodal enabled AND a video-capable model.
    return !multimodalEnabled || !modelSupportsVideo
  }
  return false
}

/**
 * Whether the unsupported reason is "video model incapable" (needs a distinct
 * message directing the user to switch models) vs the generic type message.
 */
export function isVideoModelBlock(
  filename: string,
  multimodalEnabled: boolean,
  modelSupportsVideo: boolean
): boolean {
  const ext = filename.toLowerCase().slice(filename.lastIndexOf('.'))
  return VIDEO_EXTENSIONS.includes(ext) && multimodalEnabled && !modelSupportsVideo
}
