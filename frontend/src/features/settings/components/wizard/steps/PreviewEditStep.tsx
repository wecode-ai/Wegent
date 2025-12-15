// SPDX-FileCopyrightText: 2025 WeCode, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Checkbox } from '@/components/ui/checkbox'
import { Spinner } from '@/components/ui/spinner'
import { useTranslation } from '@/hooks/useTranslation'

interface PreviewEditStepProps {
  systemPrompt: string
  agentName: string
  agentDescription: string
  bindMode: ('chat' | 'code')[]
  onPromptChange: (prompt: string) => void
  onNameChange: (name: string) => void
  onDescriptionChange: (desc: string) => void
  onBindModeChange: (mode: ('chat' | 'code')[]) => void
  isLoading: boolean
}

export default function PreviewEditStep({
  systemPrompt,
  agentName,
  agentDescription,
  bindMode,
  onPromptChange,
  onNameChange,
  onDescriptionChange,
  onBindModeChange,
  isLoading,
}: PreviewEditStepProps) {
  const { t } = useTranslation('common')

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center py-12">
        <Spinner className="w-8 h-8 text-primary" />
        <p className="mt-4 text-text-muted">{t('wizard.generating_prompt')}</p>
      </div>
    )
  }

  const handleBindModeChange = (mode: 'chat' | 'code', checked: boolean) => {
    if (checked) {
      onBindModeChange([...bindMode, mode])
    } else {
      // Ensure at least one mode is selected
      const newModes = bindMode.filter(m => m !== mode)
      if (newModes.length > 0) {
        onBindModeChange(newModes)
      }
    }
  }

  return (
    <div className="space-y-6">
      <p className="text-sm text-text-muted">{t('wizard.preview_hint')}</p>

      {/* Two-column layout on larger screens */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Left: System Prompt */}
        <div className="space-y-2">
          <Label className="text-base font-medium">{t('wizard.system_prompt')}</Label>
          <p className="text-xs text-text-muted">{t('wizard.system_prompt_hint')}</p>
          <Textarea
            value={systemPrompt}
            onChange={e => onPromptChange(e.target.value)}
            className="min-h-[300px] font-mono text-sm"
            placeholder={t('wizard.system_prompt_placeholder')}
          />
        </div>

        {/* Right: Configuration */}
        <div className="space-y-4">
          {/* Agent Name */}
          <div className="space-y-2">
            <Label className="text-base font-medium">
              {t('wizard.agent_name')} <span className="text-error">*</span>
            </Label>
            <Input
              value={agentName}
              onChange={e => onNameChange(e.target.value)}
              placeholder={t('wizard.agent_name_placeholder')}
            />
          </div>

          {/* Description */}
          <div className="space-y-2">
            <Label className="text-base font-medium">{t('wizard.agent_description')}</Label>
            <Textarea
              value={agentDescription}
              onChange={e => onDescriptionChange(e.target.value)}
              placeholder={t('wizard.agent_description_placeholder')}
              className="min-h-[80px]"
            />
          </div>

          {/* Bind Mode */}
          <div className="space-y-2">
            <Label className="text-base font-medium">{t('team.bind_mode')}</Label>
            <p className="text-xs text-text-muted">{t('wizard.bind_mode_hint')}</p>
            <div className="flex gap-4 mt-2">
              <div className="flex items-center space-x-2">
                <Checkbox
                  id="mode-chat"
                  checked={bindMode.includes('chat')}
                  onCheckedChange={checked => handleBindModeChange('chat', !!checked)}
                />
                <Label htmlFor="mode-chat" className="font-normal cursor-pointer">
                  {t('team.bind_mode_chat')}
                </Label>
              </div>
              <div className="flex items-center space-x-2">
                <Checkbox
                  id="mode-code"
                  checked={bindMode.includes('code')}
                  onCheckedChange={checked => handleBindModeChange('code', !!checked)}
                />
                <Label htmlFor="mode-code" className="font-normal cursor-pointer">
                  {t('team.bind_mode_code')}
                </Label>
              </div>
            </div>
          </div>

          {/* Info card */}
          <div className="p-4 bg-surface border border-border rounded-lg mt-4">
            <h4 className="font-medium text-sm mb-2">{t('wizard.will_create')}</h4>
            <ul className="text-sm text-text-secondary space-y-1">
              <li>• Ghost: {agentName ? `${agentName}-ghost` : '-'}</li>
              <li>• Bot: {agentName ? `${agentName}-bot` : '-'}</li>
              <li>• Team: {agentName || '-'}</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  )
}
