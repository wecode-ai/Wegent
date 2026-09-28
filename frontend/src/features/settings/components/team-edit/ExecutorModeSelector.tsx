// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { Bot, Code2, Settings2 } from 'lucide-react'

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
  visibleModes?: SimpleExecutorMode[]
  helperText?: string | null
  hideLabel?: boolean
}

const iconMap = {
  simple: Bot,
  complex: Code2,
  custom: Settings2,
} as const

export default function ExecutorModeSelector({
  value,
  onChange,
  shells,
  customShellName,
  onCustomShellChange,
  codingRuntime,
  onCodingRuntimeChange,
  disabledModes = [],
  visibleModes,
  helperText,
  hideLabel = false,
}: ExecutorModeSelectorProps) {
  const { t } = useTranslation()
  const customShells = getCustomShells(shells)
  const hasCustomShells = customShells.length > 0
  const selectedCustomShellName = hasCustomShells ? customShellName : ''
  const visibleOptions = getSimpleExecutorOptions().filter(
    option => !visibleModes || visibleModes.includes(option.value)
  )

  return (
    <section className="space-y-2">
      {!hideLabel && (
        <Label className="text-sm font-medium text-text-primary">
          {t('settings:team.simple.executor.title')}
        </Label>
      )}
      <div>
        <RadioGroup value={value} onValueChange={next => onChange(next as SimpleExecutorMode)}>
          <div
            className={cn(
              'grid gap-2',
              visibleOptions.length === 2 ? 'sm:grid-cols-2' : 'sm:grid-cols-3'
            )}
          >
            {visibleOptions.map(option => {
              const checked = value === option.value
              const disabled = disabledModes.includes(option.value)
              const Icon = iconMap[option.value]

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

        {value === 'complex' && (
          <div className="relative mt-2.5 flex flex-col gap-2.5 rounded-lg border border-primary/30 bg-primary/[0.025] p-2.5 sm:flex-row sm:items-center sm:justify-between">
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
              value={codingRuntime}
              onValueChange={next => onCodingRuntimeChange(next as CodingExecutorRuntime)}
              className="relative z-10 grid shrink-0 grid-cols-2 gap-2"
            >
              {(['codex', 'claude_code'] as const).map(runtime => (
                <label
                  key={runtime}
                  className={cn(
                    'flex min-h-10 min-w-[136px] cursor-pointer items-center gap-2 rounded-md border px-2.5 py-1.5 transition-colors',
                    codingRuntime === runtime
                      ? 'border-primary bg-primary/10'
                      : 'border-border bg-base hover:border-primary/40'
                  )}
                  data-testid={`simple-coding-runtime-${runtime}-card`}
                >
                  <RadioGroupItem
                    value={runtime}
                    aria-label={t(`settings:team.simple.executor.${runtime}.title`)}
                    data-testid={`simple-coding-runtime-${runtime}-radio`}
                  />
                  <div className="min-w-0">
                    <div
                      className={cn(
                        'whitespace-nowrap text-sm font-medium',
                        codingRuntime === runtime ? 'text-primary' : 'text-text-primary'
                      )}
                    >
                      {t(`settings:team.simple.executor.${runtime}.title`)}
                    </div>
                    <p className="whitespace-nowrap text-xs text-text-muted">
                      {t(`settings:team.simple.executor.${runtime}.description`)}
                    </p>
                  </div>
                </label>
              ))}
            </RadioGroup>
          </div>
        )}
      </div>

      {helperText && <p className="text-xs text-text-secondary">{helperText}</p>}

      {value === 'custom' && (
        <div className="space-y-1.5">
          <Select value={selectedCustomShellName} onValueChange={onCustomShellChange}>
            <SelectTrigger className="bg-base">
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
    </section>
  )
}
