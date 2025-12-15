// SPDX-FileCopyrightText: 2025 WeCode, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { Check, Ghost, Bot, Users } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { useTranslation } from '@/hooks/useTranslation'
import type { ShellRecommendation, ModelRecommendation } from '@/apis/wizard'

interface ConfirmCreateStepProps {
  agentName: string
  agentDescription: string
  systemPrompt: string
  selectedShell: ShellRecommendation | null
  selectedModel: ModelRecommendation | null
  bindMode: ('chat' | 'code')[]
}

export default function ConfirmCreateStep({
  agentName,
  agentDescription,
  systemPrompt,
  selectedShell,
  selectedModel,
  bindMode,
}: ConfirmCreateStepProps) {
  const { t } = useTranslation('common')

  return (
    <div className="space-y-6">
      <p className="text-sm text-text-muted">{t('wizard.confirm_hint')}</p>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Ghost Card */}
        <Card className="p-4">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center">
              <Ghost className="w-5 h-5 text-primary" />
            </div>
            <div>
              <p className="text-xs text-text-muted">Ghost</p>
              <p className="font-medium">{agentName}-ghost</p>
            </div>
          </div>
          <div className="text-xs text-text-secondary line-clamp-3">
            {systemPrompt.substring(0, 100)}...
          </div>
        </Card>

        {/* Bot Card */}
        <Card className="p-4">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center">
              <Bot className="w-5 h-5 text-primary" />
            </div>
            <div>
              <p className="text-xs text-text-muted">Bot</p>
              <p className="font-medium">{agentName}-bot</p>
            </div>
          </div>
          <div className="space-y-1 text-xs text-text-secondary">
            <p>Shell: {selectedShell?.shell_type || '-'}</p>
            <p>Model: {selectedModel?.model_name || t('wizard.default_model')}</p>
          </div>
        </Card>

        {/* Team Card */}
        <Card className="p-4">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center">
              <Users className="w-5 h-5 text-primary" />
            </div>
            <div>
              <p className="text-xs text-text-muted">Team ({t('wizard.agent')})</p>
              <p className="font-medium">{agentName}</p>
            </div>
          </div>
          <div className="space-y-1 text-xs text-text-secondary">
            <p>{agentDescription || t('wizard.no_description')}</p>
            <div className="flex gap-1 mt-2">
              {bindMode.map(mode => (
                <Badge key={mode} variant="secondary" size="sm">
                  {mode}
                </Badge>
              ))}
            </div>
          </div>
        </Card>
      </div>

      {/* Configuration Summary */}
      <Card className="p-4">
        <h4 className="font-medium mb-4">{t('wizard.configuration_summary')}</h4>
        <div className="grid grid-cols-2 gap-4 text-sm">
          <div>
            <p className="text-text-muted">{t('wizard.agent_name')}</p>
            <p className="font-medium">{agentName}</p>
          </div>
          <div>
            <p className="text-text-muted">{t('wizard.shell_type')}</p>
            <p className="font-medium">{selectedShell?.shell_type || '-'}</p>
          </div>
          <div>
            <p className="text-text-muted">{t('wizard.model')}</p>
            <p className="font-medium">
              {selectedModel?.model_name || t('wizard.default_model')}
            </p>
          </div>
          <div>
            <p className="text-text-muted">{t('team.bind_mode')}</p>
            <p className="font-medium">{bindMode.join(', ')}</p>
          </div>
        </div>
      </Card>

      {/* Success hint */}
      <div className="p-4 bg-success/10 border border-success/20 rounded-lg flex items-start gap-3">
        <Check className="w-5 h-5 text-success flex-shrink-0 mt-0.5" />
        <div>
          <p className="font-medium text-success">{t('wizard.ready_to_create')}</p>
          <p className="text-sm text-success/80 mt-1">{t('wizard.ready_to_create_hint')}</p>
        </div>
      </div>
    </div>
  )
}
