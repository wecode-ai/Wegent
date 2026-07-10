// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Hook encapsulating multimodal (video/image Gemini) knowledge-base config:
 * state, validation, and submit-field assembly.
 *
 * Used by Create/EditKnowledgeBaseDialog so the open-source dialog files stay
 * free of multimodal state management. Pattern follows useDeviceVncState.
 */

import { useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import type { SummaryModelRef } from '@/types/knowledge'

export interface MultimodalKBConfig {
  multimodalAnalysisEnabled: boolean
  multimodalAnalysisModelRef: SummaryModelRef | null
  multimodalAnalysisModelError: string
  multimodalVideoPrompt: string | null
  multimodalImagePrompt: string | null
}

/** Fields to merge into the create/update KB request payload. */
export interface MultimodalKBSubmitFields {
  multimodal_analysis_enabled: boolean
  multimodal_analysis_model_ref: SummaryModelRef | null
  multimodal_analysis_video_prompt: string | null
  multimodal_analysis_image_prompt: string | null
}

export function useMultimodalKBConfig() {
  const { t } = useTranslation('knowledge')
  const [multimodalAnalysisEnabled, setMultimodalAnalysisEnabled] = useState(false)
  const [multimodalAnalysisModelRef, setMultimodalAnalysisModelRef] =
    useState<SummaryModelRef | null>(null)
  const [multimodalAnalysisModelError, setMultimodalAnalysisModelError] = useState('')
  const [multimodalVideoPrompt, setMultimodalVideoPrompt] = useState<string | null>(null)
  const [multimodalImagePrompt, setMultimodalImagePrompt] = useState<string | null>(null)

  /** Load existing KB config (used by EditKnowledgeBaseDialog). */
  function loadFromKB(kb: MultimodalKBConfig | null | undefined) {
    if (!kb) return
    setMultimodalAnalysisEnabled(kb.multimodalAnalysisEnabled || false)
    setMultimodalAnalysisModelRef(kb.multimodalAnalysisModelRef || null)
    setMultimodalAnalysisModelError('')
    setMultimodalVideoPrompt(kb.multimodalVideoPrompt ?? null)
    setMultimodalImagePrompt(kb.multimodalImagePrompt ?? null)
  }

  /** Validate; returns true if valid. Sets error state on failure. */
  function validate(): boolean {
    // Require a model whenever the user has toggled multimodal ON, regardless of
    // the global pipeline switch. The global switch controls whether the
    // pipeline RUNS (conversion_pipeline), not whether the KB can be configured
    // — silently allowing enabled=true with no model left the config in a state
    // that always failed at dispatch time.
    if (multimodalAnalysisEnabled && !multimodalAnalysisModelRef) {
      setMultimodalAnalysisModelError(t('document.multimodal.modelRequired'))
      return false
    }
    setMultimodalAnalysisModelError('')
    return true
  }

  /** Clear the multimodal model error state. */
  function clearError(): void {
    setMultimodalAnalysisModelError('')
  }

  /** Assemble the multimodal fields for the create/update request payload. */
  function buildSubmitFields(): MultimodalKBSubmitFields {
    // Submit the user's raw toggle intent. The global pipeline switch
    // (useMultimodalFeatureEnabled) gates whether the pipeline RUNS, not whether
    // the KB config is saved — gating the submitted value here caused "toggle on
    // but multimodal stays off after create" when the switch was off or unresolved.
    return {
      multimodal_analysis_enabled: multimodalAnalysisEnabled,
      multimodal_analysis_model_ref: multimodalAnalysisEnabled ? multimodalAnalysisModelRef : null,
      multimodal_analysis_video_prompt: multimodalAnalysisEnabled ? multimodalVideoPrompt : null,
      multimodal_analysis_image_prompt: multimodalAnalysisEnabled ? multimodalImagePrompt : null,
    }
  }

  /** Reset all multimodal state to defaults (for dialog close/reset). */
  function reset(): void {
    setMultimodalAnalysisEnabled(false)
    setMultimodalAnalysisModelRef(null)
    setMultimodalAnalysisModelError('')
    setMultimodalVideoPrompt(null)
    setMultimodalImagePrompt(null)
  }

  /** Props bundle to spread onto <KnowledgeBaseForm> for the multimodal config
   *  section. Avoids enumerating 9 props by hand in each dialog. */
  const formProps = {
    multimodalAnalysisEnabled,
    onMultimodalAnalysisEnabledChange: (checked: boolean) => {
      setMultimodalAnalysisEnabled(checked)
      if (!checked) {
        setMultimodalAnalysisModelRef(null)
        setMultimodalAnalysisModelError('')
      }
    },
    multimodalAnalysisModelRef,
    multimodalAnalysisModelError,
    onMultimodalAnalysisModelChange: (value: SummaryModelRef | null) => {
      setMultimodalAnalysisModelRef(value)
      setMultimodalAnalysisModelError('')
    },
    multimodalAnalysisVideoPrompt: multimodalVideoPrompt,
    multimodalAnalysisImagePrompt: multimodalImagePrompt,
    onMultimodalVideoPromptChange: setMultimodalVideoPrompt,
    onMultimodalImagePromptChange: setMultimodalImagePrompt,
  }

  return {
    // state (for submit-field overrides in EditDialog)
    multimodalAnalysisEnabled,
    multimodalVideoPrompt,
    multimodalImagePrompt,
    // actions
    loadFromKB,
    validate,
    clearError,
    reset,
    buildSubmitFields,
    // spread onto <KnowledgeBaseForm>
    formProps,
  }
}
