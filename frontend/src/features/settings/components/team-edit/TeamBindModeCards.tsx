// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { Code2, MessageCircle, Monitor } from 'lucide-react'

import { Checkbox } from '@/components/ui/checkbox'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import type { TaskType } from '@/types/api'
import { getSimpleBindModeOptions } from './simple-team-edit-utils'

interface TeamBindModeCardsProps {
  value: TaskType[]
  onChange: (value: TaskType[]) => void
}

const iconMap = {
  chat: MessageCircle,
  code: Code2,
  task: Monitor,
} as const

export default function TeamBindModeCards({ value, onChange }: TeamBindModeCardsProps) {
  const { t } = useTranslation()

  const toggle = (mode: TaskType) => {
    if (value.includes(mode)) {
      onChange(value.filter(item => item !== mode))
      return
    }

    onChange([...value, mode])
  }

  return (
    <div className="grid gap-2 sm:grid-cols-3">
      {getSimpleBindModeOptions().map(option => {
        const checked = value.includes(option.value)
        const Icon = iconMap[option.value]

        return (
          <label
            key={option.value}
            className={cn(
              'flex min-h-[76px] cursor-pointer gap-2.5 rounded-md border border-transparent px-3 py-2.5 transition-colors',
              checked
                ? 'border-primary bg-primary/5 text-text-primary ring-1 ring-primary/20'
                : 'bg-transparent hover:bg-surface'
            )}
            data-testid={`simple-bind-mode-${option.value}-card`}
          >
            <Checkbox
              checked={checked}
              onCheckedChange={() => toggle(option.value)}
              aria-label={t(option.titleKey)}
              data-testid={`simple-bind-mode-${option.value}-checkbox`}
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
  )
}
