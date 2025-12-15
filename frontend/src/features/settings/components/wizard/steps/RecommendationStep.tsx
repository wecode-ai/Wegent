// SPDX-FileCopyrightText: 2025 WeCode, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { Check, Cpu, Layers } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Spinner } from '@/components/ui/spinner'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import type { ShellRecommendation, ModelRecommendation } from '@/apis/wizard'

interface RecommendationStepProps {
  shell: ShellRecommendation | null
  model: ModelRecommendation | null
  alternativeShells: ShellRecommendation[]
  alternativeModels: ModelRecommendation[]
  selectedShell: ShellRecommendation | null
  selectedModel: ModelRecommendation | null
  onSelectShell: (shell: ShellRecommendation) => void
  onSelectModel: (model: ModelRecommendation | null) => void
  isLoading: boolean
}

export default function RecommendationStep({
  shell,
  model,
  alternativeShells,
  alternativeModels,
  selectedShell,
  selectedModel,
  onSelectShell,
  onSelectModel,
  isLoading,
}: RecommendationStepProps) {
  const { t } = useTranslation('common')

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center py-12">
        <Spinner className="w-8 h-8 text-primary" />
        <p className="mt-4 text-text-muted">{t('wizard.analyzing')}</p>
      </div>
    )
  }

  const allShells = shell ? [shell, ...alternativeShells] : alternativeShells
  const allModels = model ? [model, ...alternativeModels] : alternativeModels

  return (
    <div className="space-y-8">
      {/* Shell Selection */}
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <Layers className="w-5 h-5 text-primary" />
          <h3 className="text-base font-medium">{t('wizard.select_shell')}</h3>
        </div>
        <p className="text-sm text-text-muted">{t('wizard.shell_hint')}</p>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {allShells.map((s, index) => {
            const isSelected = selectedShell?.shell_name === s.shell_name
            const isRecommended = index === 0 && shell

            return (
              <Card
                key={s.shell_name}
                className={cn(
                  'p-4 cursor-pointer transition-all',
                  isSelected
                    ? 'border-primary ring-2 ring-primary/20'
                    : 'hover:border-primary/50'
                )}
                onClick={() => onSelectShell(s)}
              >
                <div className="flex items-start justify-between">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{s.shell_type}</span>
                      {isRecommended && (
                        <Badge variant="success" size="sm">
                          {t('wizard.recommended')}
                        </Badge>
                      )}
                    </div>
                    <p className="text-sm text-text-secondary">{s.reason}</p>
                    <div className="flex items-center gap-2 mt-2">
                      <span className="text-xs text-text-muted">
                        {t('wizard.confidence')}: {Math.round(s.confidence * 100)}%
                      </span>
                    </div>
                  </div>
                  {isSelected && (
                    <div className="flex-shrink-0 w-5 h-5 rounded-full bg-primary flex items-center justify-center">
                      <Check className="w-3 h-3 text-white" />
                    </div>
                  )}
                </div>
              </Card>
            )
          })}
        </div>
      </div>

      {/* Model Selection */}
      {allModels.length > 0 && (
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <Cpu className="w-5 h-5 text-primary" />
            <h3 className="text-base font-medium">{t('wizard.select_model')}</h3>
          </div>
          <p className="text-sm text-text-muted">{t('wizard.model_hint')}</p>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {allModels.map((m, index) => {
              const isSelected = selectedModel?.model_name === m.model_name
              const isRecommended = index === 0 && model

              return (
                <Card
                  key={m.model_name}
                  className={cn(
                    'p-4 cursor-pointer transition-all',
                    isSelected
                      ? 'border-primary ring-2 ring-primary/20'
                      : 'hover:border-primary/50'
                  )}
                  onClick={() => onSelectModel(m)}
                >
                  <div className="flex items-start justify-between">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{m.model_name}</span>
                        {isRecommended && (
                          <Badge variant="success" size="sm">
                            {t('wizard.recommended')}
                          </Badge>
                        )}
                      </div>
                      {m.model_id && (
                        <p className="text-xs text-text-muted">{m.model_id}</p>
                      )}
                      <p className="text-sm text-text-secondary">{m.reason}</p>
                      <div className="flex items-center gap-2 mt-2">
                        <span className="text-xs text-text-muted">
                          {t('wizard.confidence')}: {Math.round(m.confidence * 100)}%
                        </span>
                      </div>
                    </div>
                    {isSelected && (
                      <div className="flex-shrink-0 w-5 h-5 rounded-full bg-primary flex items-center justify-center">
                        <Check className="w-3 h-3 text-white" />
                      </div>
                    )}
                  </div>
                </Card>
              )
            })}
          </div>
        </div>
      )}

      {allModels.length === 0 && (
        <div className="p-4 bg-warning/10 border border-warning/20 rounded-lg">
          <p className="text-sm text-warning">{t('wizard.no_models_available')}</p>
        </div>
      )}
    </div>
  )
}
