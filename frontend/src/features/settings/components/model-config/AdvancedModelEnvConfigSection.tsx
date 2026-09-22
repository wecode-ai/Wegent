// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React from 'react'
import { ChevronDown } from 'lucide-react'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import { countAdvancedModelEnvFields } from './advancedModelEnvConfig'

export interface AdvancedModelEnvConfigSectionProps {
  value: string
  error: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onChange: (value: string) => void
  onBlur: () => void
  inputRef?: React.Ref<HTMLTextAreaElement>
}

export function AdvancedModelEnvConfigSection({
  value,
  error,
  open,
  onOpenChange,
  onChange,
  onBlur,
  inputRef,
}: AdvancedModelEnvConfigSectionProps) {
  const { t } = useTranslation()
  const configuredFieldCount = countAdvancedModelEnvFields(value)
  const hintId = 'advanced-model-env-config-hint'
  const errorId = 'advanced-model-env-config-error'

  return (
    <Collapsible open={open} onOpenChange={onOpenChange}>
      <div className="rounded-lg border border-border">
        <CollapsibleTrigger
          className="flex min-h-11 w-full cursor-pointer items-center justify-between gap-3 rounded-lg px-3 py-2 text-left transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&[data-state=open]>svg]:rotate-180"
          data-testid="advanced-model-env-config-trigger"
        >
          <span className="min-w-0">
            <span className="block text-sm font-medium text-text-primary">
              {t('common:models.advanced_env_config')}
            </span>
            <span className="block text-xs text-text-muted">
              {t('common:models.advanced_env_config_summary')}
            </span>
          </span>
          <span className="flex shrink-0 items-center gap-2">
            {configuredFieldCount > 0 && (
              <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-text-muted">
                {t('common:models.advanced_env_config_count', {
                  count: configuredFieldCount,
                })}
              </span>
            )}
            <ChevronDown className="h-4 w-4 transition-transform duration-200 motion-reduce:transition-none" />
          </span>
        </CollapsibleTrigger>

        <CollapsibleContent>
          <div className="space-y-2 border-t border-border p-3">
            <Label htmlFor="advanced_model_env_config" className="text-sm font-medium">
              {t('common:models.advanced_env_config_json')}
            </Label>
            <Textarea
              ref={inputRef}
              id="advanced_model_env_config"
              data-testid="advanced-model-env-config-input"
              value={value}
              onChange={event => onChange(event.target.value)}
              onBlur={onBlur}
              aria-invalid={Boolean(error)}
              aria-describedby={error ? `${hintId} ${errorId}` : hintId}
              placeholder={`{\n  "supports_developer_role": false\n}`}
              className={cn(
                'min-h-[112px] bg-base font-mono text-sm',
                error && 'border-error focus-visible:ring-error'
              )}
            />
            <p id={hintId} className="text-xs text-text-muted">
              {t('common:models.advanced_env_config_hint')}
            </p>
            {error && (
              <p id={errorId} role="alert" className="text-xs text-error">
                {error}
              </p>
            )}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  )
}
