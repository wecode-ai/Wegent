// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { TEAM_ICONS, getTeamIconById, DEFAULT_TEAM_ICON_ID } from '../../constants/team-icons'
import { useTranslation } from '@/hooks/useTranslation'

interface TeamIconPickerProps {
  value: string | null | undefined
  onChange: (iconId: string) => void
  disabled?: boolean
}

/**
 * Icon picker component for selecting team icons
 * Shows a grid of preset icons in a popover
 */
export function TeamIconPicker({ value, onChange, disabled = false }: TeamIconPickerProps) {
  const { t } = useTranslation()
  const [open, setOpen] = React.useState(false)

  const selectedIcon = getTeamIconById(value || DEFAULT_TEAM_ICON_ID)
  const SelectedIconComponent = selectedIcon.icon

  const handleSelectIcon = (iconId: string) => {
    onChange(iconId)
    setOpen(false)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className={`
            flex items-center justify-center w-10 h-10 rounded-lg border border-border
            bg-base hover:bg-hover transition-colors
            ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}
          `}
          title={t('common:teams.icon')}
        >
          <SelectedIconComponent className="w-5 h-5 text-primary" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[300px] p-3" align="start" side="bottom" sideOffset={4}>
        <div className="space-y-2">
          <div className="text-sm font-medium text-text-primary">
            {t('common:teams.selectIcon')}
          </div>
          <div className="grid grid-cols-7 gap-1.5">
            {TEAM_ICONS.map(iconConfig => {
              const IconComponent = iconConfig.icon
              const isSelected = iconConfig.id === (value || DEFAULT_TEAM_ICON_ID)

              return (
                <button
                  key={iconConfig.id}
                  type="button"
                  onClick={() => handleSelectIcon(iconConfig.id)}
                  className={`
                    flex items-center justify-center w-9 h-9 rounded-md transition-colors
                    ${
                      isSelected
                        ? 'bg-primary text-white'
                        : 'bg-surface hover:bg-hover text-text-secondary hover:text-text-primary'
                    }
                  `}
                  title={iconConfig.label}
                >
                  <IconComponent className="w-5 h-5" />
                </button>
              )
            })}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
