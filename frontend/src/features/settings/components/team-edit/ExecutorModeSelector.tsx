// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { Bot, Code2 } from 'lucide-react'

import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import {
  simpleChoiceCardBaseClass,
  simpleChoiceCardSelectedClass,
  simpleChoiceCardUnselectedClass,
} from '@/components/common/simple-choice-card-styles'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import type { UnifiedShell } from '@/apis/shells'
import {
  getCustomShells,
  getSimpleExecutorOptions,
  type CodingExecutorRuntime,
  type SimpleExecutorMode,
} from './simple-team-edit-utils'

interface ExecutorModeSelectorProps {
  value: SimpleExecutorMode
  onChange: (value: SimpleExecutorMode) => void
  shells: UnifiedShell[]
  customShellName: string
  onCustomShellChange: (value: string) => void
  codingRuntime: CodingExecutorRuntime
  onCodingRuntimeChange: (value: CodingExecutorRuntime) => void
  disabledModes?: SimpleExecutorMode[]
  helperText?: string | null
  hideLabel?: boolean
}

export default function ExecutorModeSelector({
  value,
  onChange,
  shells,
  customShellName,
  onCustomShellChange,
  codingRuntime,
  onCodingRuntimeChange,
  disabledModes = [],
  helperText,
  hideLabel = false,
}: ExecutorModeSelectorProps) {
  const { t } = useTranslation()
  const customShells = getCustomShells(shells)
  const hasCustomShells = customShells.length > 0
  const selectedCustomShellName = hasCustomShells ? customShellName : ''
  const useCase = value === 'custom' ? 'complex' : value
  const selectedRuntime = value === 'custom' ? 'custom' : codingRuntime
  const useCaseOptions = getSimpleExecutorOptions().filter(option => option.value !== 'custom')

  const handleRuntimeChange = (runtime: CodingExecutorRuntime | 'custom') => {
    if (runtime === 'custom') {
      onChange('custom')
    } else {
      onCodingRuntimeChange(runtime)
      if (value === 'custom') onChange('complex')
    }
  }

  return (
    <section className="space-y-2">
      {!hideLabel && (
        <Label className="text-sm font-medium text-text-primary">
          {t('settings:team.simple.executor.title')}
        </Label>
      )}
      <div>
        <RadioGroup
          aria-label={t('settings:team.simple.executor.title')}
          value={useCase}
          onValueChange={next => onChange(next as SimpleExecutorMode)}
        >
          <div className="grid gap-2 sm:grid-cols-2">
            {useCaseOptions.map(option => {
              const checked = useCase === option.value
              const disabled = disabledModes.includes(option.value)
              const Icon = option.value === 'simple' ? Bot : Code2

              return (
                <div key={option.value} className="min-w-0">
                  <label
                    className={cn(
                      simpleChoiceCardBaseClass,
                      'min-h-[68px] w-full',
                      checked ? simpleChoiceCardSelectedClass : simpleChoiceCardUnselectedClass,
                      disabled && 'cursor-not-allowed opacity-50'
                    )}
                    data-testid={`simple-executor-${option.value}-card`}
                  >
                    <RadioGroupItem
                      value={option.value}
                      disabled={disabled}
                      aria-label={t(option.titleKey)}
                      data-testid={`simple-executor-${option.value}-radio`}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 text-sm font-medium">
                        <Icon className="h-4 w-4 text-primary" />
                        <span>{t(option.titleKey)}</span>
                      </div>
                      <p className="mt-0.5 text-xs leading-5 text-text-secondary">
                        {t(option.descriptionKey)}
                      </p>
                    </div>
                  </label>
                </div>
              )
            })}
          </div>
        </RadioGroup>

        {useCase === 'complex' && (
          <div className="relative mt-2.5 space-y-2.5 rounded-lg border border-primary/30 bg-primary/[0.025] p-2.5">
            <div
              className="absolute -top-1.5 left-1/2 h-3 w-3 -translate-x-1/2 rotate-45 border-l border-t border-primary/30 bg-primary/[0.025] sm:left-3/4"
              aria-hidden="true"
            />
            <div className="relative z-10 min-w-0">
              <Label className="text-sm font-medium text-text-primary">
                {t('settings:team.simple.executor.coding_runtime_label')}
              </Label>
              <p className="mt-0.5 text-xs leading-[18px] text-text-muted">
                {t('settings:team.simple.executor.coding_runtime_description')}
              </p>
            </div>
            <RadioGroup
              aria-label={t('settings:team.simple.executor.coding_runtime_label')}
              value={selectedRuntime}
              onValueChange={next => handleRuntimeChange(next as CodingExecutorRuntime | 'custom')}
              className="relative z-10 grid gap-2 md:grid-cols-3"
            >
              {(['codex', 'claude_code', 'custom'] as const).map(runtime => {
                const checked = selectedRuntime === runtime
                const disabled = disabledModes.includes(runtime === 'custom' ? 'custom' : 'complex')
                const testId =
                  runtime === 'custom'
                    ? 'simple-executor-custom'
                    : `simple-coding-runtime-${runtime}`

                return (
                  <label
                    key={runtime}
                    className={cn(
                      'flex min-h-11 min-w-0 cursor-pointer items-center gap-2 rounded-md border px-2.5 py-1.5 transition-colors md:min-h-10',
                      checked
                        ? 'border-primary bg-primary/10'
                        : 'border-border bg-base hover:border-primary/40',
                      disabled && 'cursor-not-allowed opacity-50'
                    )}
                    data-testid={`${testId}-card`}
                  >
                    <RadioGroupItem
                      value={runtime}
                      disabled={disabled}
                      aria-label={t(`settings:team.simple.executor.${runtime}.title`)}
                      data-testid={`${testId}-radio`}
                    />
                    <div className="min-w-0">
                      <div
                        className={cn(
                          'text-sm font-medium',
                          checked ? 'text-primary' : 'text-text-primary'
                        )}
                      >
                        {t(`settings:team.simple.executor.${runtime}.title`)}
                      </div>
                      <p className="text-xs text-text-muted">
                        {t(`settings:team.simple.executor.${runtime}.description`)}
                      </p>
                    </div>
                  </label>
                )
              })}
            </RadioGroup>

            {value === 'custom' && (
              <div className="space-y-1.5">
                <Select value={selectedCustomShellName} onValueChange={onCustomShellChange}>
                  <SelectTrigger
                    className="h-11 bg-base md:h-10"
                    aria-label={t('settings:team.simple.executor.custom_shell_placeholder')}
                    data-testid="simple-custom-shell-select"
                  >
                    <SelectValue
                      placeholder={t(
                        hasCustomShells
                          ? 'settings:team.simple.executor.custom_shell_placeholder'
                          : 'settings:team.simple.executor.no_custom_shells'
                      )}
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {hasCustomShells ? (
                      customShells.map(shell => (
                        <SelectItem
                          key={`${shell.type}-${shell.namespace || 'default'}-${shell.name}`}
                          value={shell.name}
                        >
                          {shell.displayName || shell.name}
                        </SelectItem>
                      ))
                    ) : (
                      <SelectItem value="__no_custom_shells__" disabled>
                        <span className="text-text-muted">
                          {t('settings:team.simple.executor.no_custom_shells')}
                        </span>
                      </SelectItem>
                    )}
                  </SelectContent>
                </Select>
                {!hasCustomShells && (
                  <p className="text-xs leading-5 text-text-secondary">
                    {t('settings:team.simple.executor.manage_custom_shells_hint')}
                  </p>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {helperText && <p className="text-xs text-text-secondary">{helperText}</p>}
    </section>
  )
}
