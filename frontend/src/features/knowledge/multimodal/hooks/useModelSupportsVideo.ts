// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Resolve whether the KB's multimodal analysis model declares supportsVideo.
 *
 * Extracted from the open-source DocumentList so that file stays free of the
 * model-capability fetch. Returns true (video-capable) by default when
 * multimodal is disabled, no model is configured, or the fetch fails — so a
 * transient error never wrongly blocks video uploads. The backend remains the
 * correctness boundary; this is UX early-rejection only.
 */

import { useEffect, useState } from 'react'
import { modelApis } from '@/apis/models'
import { getModelCapabilities } from '@/lib/model-capabilities'

interface MultimodalModelRef {
  name: string
  namespace: string
  type: string
}

interface KnowledgeBaseLike {
  multimodal_analysis_enabled?: boolean
  multimodal_analysis_model_ref?: MultimodalModelRef | null
}

export function useModelSupportsVideo(knowledgeBase: KnowledgeBaseLike): boolean {
  const [modelSupportsVideo, setModelSupportsVideo] = useState(true)
  useEffect(() => {
    const modelRef = knowledgeBase.multimodal_analysis_model_ref
    const multimodalEnabled = knowledgeBase.multimodal_analysis_enabled
    if (!multimodalEnabled || !modelRef) {
      setModelSupportsVideo(true)
      return
    }
    let cancelled = false
    modelApis
      .getUnifiedModels(undefined, false, 'all', undefined, 'llm')
      .then(response => {
        if (cancelled) return
        const match = (response.data || []).find(
          m =>
            m.name === modelRef.name &&
            m.namespace === modelRef.namespace &&
            m.type === modelRef.type
        )
        // Default to true when the model can't be resolved, so a transient
        // fetch failure does not wrongly block video uploads.
        setModelSupportsVideo(!match || getModelCapabilities(match).supportsVideo !== false)
      })
      .catch(() => {
        if (!cancelled) setModelSupportsVideo(true)
      })
    return () => {
      cancelled = true
    }
  }, [knowledgeBase.multimodal_analysis_enabled, knowledgeBase.multimodal_analysis_model_ref])
  return modelSupportsVideo
}
