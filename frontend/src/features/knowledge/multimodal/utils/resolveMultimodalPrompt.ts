// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { MultimodalDefaultPrompts } from '@/apis/knowledge'

/**
 * Which layer the effective multimodal prompt comes from.
 *
 * Mirrors the backend 3-layer precedence (document override > knowledge base
 * default > system default) so the UI prefilled value always matches what the
 * converter will actually use at dispatch time.
 */
export type PromptSource = 'document' | 'knowledge' | 'system'

export interface ResolvedPrompt {
  /** The actual effective prompt text (the layer that won). */
  text: string
  /** Which layer the effective prompt came from. */
  source: PromptSource
  /** True when the effective prompt is not the system default. */
  customized: boolean
}

/**
 * Resolve the effective multimodal prompt for a document, mirroring the backend
 * three-layer precedence: document override > knowledge base default > system
 * default. Blank/whitespace values are treated as absent so an empty override
 * falls through to the next layer.
 *
 * This is a *display-time* resolver: it powers the prefill + source label in
 * the KB create/edit, upload advanced settings, and re-analyze dialogs. The
 * backend runs the same precedence again at dispatch time (single source of
 * truth lives in shared.models.multimodal_prompts + the orchestrator resolver).
 *
 * @param mediaType       'video' | 'image'
 * @param docPrompt       document.source_config.multimodal_analysis_prompt
 * @param kbPrompt        kb.multimodal_analysis_video_prompt | _image_prompt
 * @param systemDefaults  { video_prompt, image_prompt } from getMultimodalDefaultPrompts()
 */
export function resolveEffectivePrompt(
  mediaType: 'video' | 'image',
  docPrompt: string | null | undefined,
  kbPrompt: string | null | undefined,
  systemDefaults: Pick<MultimodalDefaultPrompts, 'video_prompt' | 'image_prompt'>
): ResolvedPrompt {
  if (docPrompt && docPrompt.trim()) {
    return { text: docPrompt, source: 'document', customized: true }
  }
  if (kbPrompt && kbPrompt.trim()) {
    return { text: kbPrompt, source: 'knowledge', customized: true }
  }
  return {
    text: mediaType === 'video' ? systemDefaults.video_prompt : systemDefaults.image_prompt,
    source: 'system',
    customized: false,
  }
}
