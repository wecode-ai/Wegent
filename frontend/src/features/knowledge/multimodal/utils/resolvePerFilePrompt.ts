// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Resolve the per-upload multimodal prompt override for a single file.
 *
 * Extracted from the open-source DocumentList so that file stays free of an
 * unconditional attachment dependency. Video files get the video prompt, image
 * files get the image prompt, non-media files get undefined (inherit the KB
 * default). undefined/null prompt values fall through to the KB default.
 */

import { isImageExtension, isVideoFileName } from '@/apis/attachments'

export type MultimodalAnalysisPrompts = {
  video?: string | null
  image?: string | null
}

export function resolvePerFilePrompt(
  documentName: string,
  extension: string,
  prompts: MultimodalAnalysisPrompts | undefined
): string | undefined {
  if (!prompts) return undefined
  if (isVideoFileName(documentName)) {
    return prompts.video ?? undefined
  }
  if (isImageExtension(`.${extension}`)) {
    return prompts.image ?? undefined
  }
  return undefined
}
