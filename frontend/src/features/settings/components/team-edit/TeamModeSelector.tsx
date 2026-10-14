// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useId } from 'react'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { useTranslation } from '@/hooks/useTranslation'
import { getSelectableTeamModes, TeamMode } from '../team-modes'

interface TeamModeSelectorProps {
  mode: TeamMode
  onModeChange: (mode: TeamMode) => void
  disabled?: boolean
}

export default function TeamModeSelector({
  mode,
  onModeChange,
  disabled = false,
}: TeamModeSelectorProps) {
  const { t } = useTranslation('common')
  const id = useId()

  return (
    <div className="space-y-2">
      <Label id={`${id}-label`} className="text-sm font-medium text-text-primary">
        {t('team.model')}
      </Label>
      <RadioGroup
        aria-labelledby={`${id}-label`}
        aria-describedby={`${id}-description`}
        value={mode}
        onValueChange={value => onModeChange(value as TeamMode)}
        disabled={disabled}
        className="grid grid-cols-3 gap-2"
      >
        {getSelectableTeamModes().map(option => (
          <div key={option}>
            <RadioGroupItem
              value={option}
              id={`${id}-${option}`}
              className="peer sr-only"
              data-testid={`select-mode-radio-${option}`}
            />
            <label
              htmlFor={`${id}-${option}`}
              data-testid={`select-mode-label-${option}`}
              className="flex min-h-11 cursor-pointer items-center justify-center rounded-md border border-border px-3 text-sm font-medium text-text-secondary transition-colors hover:bg-surface peer-data-[state=checked]:border-text-primary peer-data-[state=checked]:bg-surface peer-data-[state=checked]:text-text-primary peer-focus-visible:ring-2 peer-focus-visible:ring-primary peer-disabled:cursor-not-allowed peer-disabled:opacity-50"
            >
              {t(`team_model.${option}`)}
            </label>
          </div>
        ))}
      </RadioGroup>
      <p id={`${id}-description`} className="text-sm text-text-secondary">
        {t(`team_model_desc.${mode}`)}
      </p>
    </div>
  )
}
