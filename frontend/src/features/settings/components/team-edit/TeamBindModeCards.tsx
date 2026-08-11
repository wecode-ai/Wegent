// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useState } from 'react'
import { ChevronDown, Code2, ImageIcon, MessageCircle, Monitor, Video } from 'lucide-react'

import { Checkbox } from '@/components/ui/checkbox'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import type { TaskType } from '@/types/api'
import {
  simpleChoiceCardBaseClass,
  simpleChoiceCardSelectedClass,
  simpleChoiceCardUnselectedClass,
} from './simple-choice-card-styles'
import { getSimpleBindModeOptions } from './simple-team-edit-utils'

interface TeamBindModeCardsProps {
  value: TaskType[]
  onChange: (value: TaskType[]) => void
}

const iconMap = {
  chat: MessageCircle,
  code: Code2,
  task: Monitor,
  video: Video,
  image: ImageIcon,
} as const

const ADVANCED_MODES = new Set<TaskType>(['video', 'image'])

export default function TeamBindModeCards({ value, onChange }: TeamBindModeCardsProps) {
  const { t } = useTranslation()
  const options = getSimpleBindModeOptions()
  const commonOptions = options.filter(option => !ADVANCED_MODES.has(option.value))
  const advancedOptions = options.filter(option => ADVANCED_MODES.has(option.value))
  const hasSelectedAdvancedMode = value.some(mode => ADVANCED_MODES.has(mode))
  const [showAdvancedModes, setShowAdvancedModes] = useState(hasSelectedAdvancedMode)

  useEffect(() => {
    if (hasSelectedAdvancedMode) {
      setShowAdvancedModes(true)
    }
  }, [hasSelectedAdvancedMode])

  const toggle = (mode: TaskType) => {
    if (value.includes(mode)) {
      onChange(value.filter(item => item !== mode))
      return
    }

    onChange([...value, mode])
  }

  const renderOption = (option: (typeof options)[number]) => {
    const checked = value.includes(option.value)
    const Icon = iconMap[option.value]

    return (
      <label
        key={option.value}
        className={cn(
          simpleChoiceCardBaseClass,
          checked ? simpleChoiceCardSelectedClass : simpleChoiceCardUnselectedClass
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
          <p className="mt-0.5 text-xs leading-5 text-text-secondary">{t(option.descriptionKey)}</p>
        </div>
      </label>
    )
  }

  return (
    <div className="space-y-2">
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {commonOptions.map(renderOption)}
      </div>

      <Collapsible
        open={showAdvancedModes}
        onOpenChange={setShowAdvancedModes}
        className="space-y-2"
      >
        <CollapsibleContent>
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {advancedOptions.map(renderOption)}
          </div>
        </CollapsibleContent>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="ml-auto flex min-h-9 items-center gap-1.5 rounded-md px-3 text-sm text-text-secondary transition-colors hover:bg-surface hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
            aria-expanded={showAdvancedModes}
            data-testid="team-bind-mode-more-toggle"
          >
            {t(
              showAdvancedModes
                ? 'settings:team.simple.bind_mode.collapse_more_modes'
                : 'settings:team.simple.bind_mode.more_modes'
            )}
            <ChevronDown
              className={cn(
                'h-4 w-4 transition-transform duration-200',
                showAdvancedModes && 'rotate-180'
              )}
            />
          </button>
        </CollapsibleTrigger>
      </Collapsible>
    </div>
  )
}
