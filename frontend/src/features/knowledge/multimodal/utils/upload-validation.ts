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
 * Image extensions. Unsupported for RAG UNLESS the KB has multimodal analysis
 * enabled (video+image). When disabled, they get a friendly upload error.
 */
export const KB_IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp']

/**
 * Document/code extensions selectable in the KB upload file picker.
 * Multimodal extensions (video+image) are appended conditionally when the KB
 * has multimodal analysis enabled (MULTIMODAL_EXTENSIONS from
 * @/apis/attachments — the set the upload path routes to the converter).
 */
export const KB_DOCUMENT_ACCEPT =
  '.pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.csv,.txt,.md,.markdown,.adoc,.asciidoc,.asm,.bat,.c,.cc,.cpp,.css,.conf,.config,.dart,.env,.go,.gradle,.groovy,.h,.html,.ini,.java,.js,.json,.jsx,.kotlin,.less,.license,.log,.lua,.mjs,.php,.pl,.properties,.ps1,.py,.rb,.readme,.rst,.rust,.sass,.scala,.scss,.sh,.sql,.srt,.styl,.svg,.swift,.textile,.toml,.ts,.tsx,.tsv,.vue,.wiki,.xml,.yaml,.yml'

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
