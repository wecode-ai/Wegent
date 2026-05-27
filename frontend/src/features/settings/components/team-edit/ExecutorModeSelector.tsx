// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { Bot, Code2, Settings2 } from 'lucide-react'

import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
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
  type SimpleExecutorMode,
} from './simple-team-edit-utils'

interface ExecutorModeSelectorProps {
  value: SimpleExecutorMode
  onChange: (value: SimpleExecutorMode) => void
  shells: UnifiedShell[]
  customShellName: string
  onCustomShellChange: (value: string) => void
  disabledModes?: SimpleExecutorMode[]
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
  disabledModes = [],
  helperText,
  hideLabel = false,
}: ExecutorModeSelectorProps) {
  const { t } = useTranslation()
  const customShells = getCustomShells(shells)

  return (
    <section className="space-y-2">
      {!hideLabel && (
        <Label className="text-sm font-medium text-text-primary">
          {t('settings:team.simple.executor.title')}
        </Label>
      )}
      <RadioGroup value={value} onValueChange={next => onChange(next as SimpleExecutorMode)}>
        <div className="grid gap-2 sm:grid-cols-3">
          {getSimpleExecutorOptions().map(option => {
            const checked = value === option.value
            const disabled = disabledModes.includes(option.value)
            const Icon = iconMap[option.value]

            return (
              <label
                key={option.value}
                className={cn(
                  'flex min-h-[78px] cursor-pointer gap-2.5 rounded-md border border-transparent px-3 py-2.5 transition-colors',
                  checked
                    ? 'border-primary bg-primary/5 text-text-primary ring-1 ring-primary/20'
                    : 'bg-transparent hover:bg-surface',
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
            )
          })}
        </div>
      </RadioGroup>

      {helperText && <p className="text-xs text-text-secondary">{helperText}</p>}

      {value === 'custom' && (
        <Select value={customShellName} onValueChange={onCustomShellChange}>
          <SelectTrigger className="bg-base">
            <SelectValue
              placeholder={t('settings:team.simple.executor.custom_shell_placeholder')}
            />
          </SelectTrigger>
          <SelectContent>
            {customShells.map(shell => (
              <SelectItem
                key={`${shell.type}-${shell.namespace || 'default'}-${shell.name}`}
                value={shell.name}
              >
                {shell.displayName || shell.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </section>
  )
}
