// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { useTranslation } from '@/hooks/useTranslation'
import { FileText, Settings } from 'lucide-react'
import GeneratingLoader from './GeneratingLoader'

interface PromptPreviewStepProps {
  systemPrompt: string
  agentName: string
  agentDescription: string
  onPromptChange: (prompt: string) => void
  onNameChange: (name: string) => void
  onDescriptionChange: (desc: string) => void
  isLoading: boolean
}

export default function PromptPreviewStep({
  systemPrompt,
  agentName,
  agentDescription,
  onPromptChange,
  onNameChange,
  onDescriptionChange,
  isLoading,
}: PromptPreviewStepProps) {
  const { t } = useTranslation()

  if (isLoading) {
    return <GeneratingLoader />
  }

  return (
    <div className="space-y-6">
      {/* Description */}
      <div className="p-4 bg-primary/5 border border-primary/20 rounded-lg">
        <div className="flex items-start gap-3">
          <FileText className="w-5 h-5 text-primary flex-shrink-0 mt-0.5" />
          <div>
            <p className="font-medium text-sm">{t('wizard:prompt_preview_title')}</p>
            <p className="text-sm text-text-secondary mt-1">{t('wizard:prompt_preview_hint')}</p>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Left: System Prompt */}
        <div className="space-y-2">
          <Label className="text-base font-medium">{t('wizard:system_prompt')}</Label>
          <p className="text-xs text-text-muted">{t('wizard:system_prompt_hint')}</p>
          <Textarea
            value={systemPrompt}
            onChange={e => onPromptChange(e.target.value)}
            className="min-h-[280px] font-mono text-sm"
            placeholder={t('wizard:system_prompt_placeholder')}
          />
        </div>

        {/* Right: Configuration */}
        <div className="space-y-4">
          {/* Agent Name */}
          <div className="space-y-2">
            <Label className="text-base font-medium">
              {t('wizard:agent_name')} <span className="text-error">*</span>
            </Label>
            <Input
              value={agentName}
              onChange={e => onNameChange(e.target.value)}
              placeholder={t('wizard:agent_name_placeholder')}
            />
          </div>

          {/* Description */}
          <div className="space-y-2">
            <Label className="text-base font-medium">{t('wizard:agent_description')}</Label>
            <Textarea
              value={agentDescription}
              onChange={e => onDescriptionChange(e.target.value)}
              placeholder={t('wizard:agent_description_placeholder')}
              className="min-h-[80px]"
            />
          </div>

          {/* Info card */}
          <div className="p-4 bg-muted/50 border border-border rounded-lg mt-4">
            <div className="flex items-center gap-2 mb-2">
              <Settings className="w-4 h-4 text-text-secondary" />
              <h4 className="font-medium text-sm">{t('wizard:will_create')}</h4>
            </div>
            <p className="text-sm text-text-secondary">
              {t('wizard:agent')}: <span className="font-medium">{agentName || '-'}</span>
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
