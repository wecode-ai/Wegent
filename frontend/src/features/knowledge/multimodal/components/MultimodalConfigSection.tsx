// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Multimodal analysis config section rendered inside the knowledge-base form
 * (advanced settings). Encapsulates the enable switch, model selector, and
 * per-media-type prompt editors.
 *
 * Extracted from the open-source KnowledgeBaseForm so the form file stays free
 * of multimodal UI. Pattern follows knowledge-permission-ui subcomponents.
 */

import { useTranslation } from '@/hooks/useTranslation'
import { Switch } from '@/components/ui/switch'
import type { SummaryModelRef } from '@/types/knowledge'
import { MultimodalAnalysisModelSelector } from './MultimodalAnalysisModelSelector'
import { MultimodalPromptEditor } from './MultimodalPromptEditor'
// SimpleConfigRow is an open-source layout primitive used by KnowledgeBaseForm;
// import it from the open-source component so we reuse the exact same row style.
import { SimpleConfigRow } from '@/features/settings/components/team-edit/SimpleConfigLayout'

interface MultimodalConfigSectionProps {
  enabled: boolean
  modelRef: SummaryModelRef | null
  modelError?: string
  videoPrompt?: string | null
  imagePrompt?: string | null
  onEnabledChange: (value: boolean) => void
  onModelChange: (value: SummaryModelRef | null) => void
  onVideoPromptChange?: (value: string | null) => void
  onImagePromptChange?: (value: string | null) => void
}

export function MultimodalConfigSection({
  enabled,
  modelRef,
  modelError,
  videoPrompt,
  imagePrompt,
  onEnabledChange,
  onModelChange,
  onVideoPromptChange,
  onImagePromptChange,
}: MultimodalConfigSectionProps) {
  const { t } = useTranslation('knowledge')

  return (
    <>
      <SimpleConfigRow
        label={t('document.multimodal.enableLabel')}
        description={t('document.multimodal.enableDescription')}
      >
        <div className="flex justify-end">
          <Switch
            id="knowledge-multimodal-enabled"
            checked={enabled}
            onCheckedChange={checked => onEnabledChange(checked)}
          />
        </div>
      </SimpleConfigRow>

      {enabled && (
        <SimpleConfigRow label={t('document.multimodal.selectModel')}>
          <MultimodalAnalysisModelSelector
            value={modelRef}
            onChange={onModelChange}
            error={modelError}
          />
        </SimpleConfigRow>
      )}

      {enabled && onVideoPromptChange && (
        <SimpleConfigRow label={t('document.multimodal.videoPromptLabel')} align="start">
          <MultimodalPromptEditor
            mediaType="video"
            scope="knowledge"
            value={videoPrompt}
            onChange={onVideoPromptChange}
            idSuffix="kb-video"
          />
        </SimpleConfigRow>
      )}

      {enabled && onImagePromptChange && (
        <SimpleConfigRow label={t('document.multimodal.imagePromptLabel')} align="start">
          <MultimodalPromptEditor
            mediaType="image"
            scope="knowledge"
            value={imagePrompt}
            onChange={onImagePromptChange}
            idSuffix="kb-image"
          />
        </SimpleConfigRow>
      )}
    </>
  )
}
