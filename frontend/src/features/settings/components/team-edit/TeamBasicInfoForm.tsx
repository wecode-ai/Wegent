// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React from 'react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { useTranslation } from '@/hooks/useTranslation'
import { TeamIconPicker } from '../teams/TeamIconPicker'
import { HelpCircle } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

interface TeamBasicInfoFormProps {
  name: string
  setName: (name: string) => void
  description: string
  setDescription: (description: string) => void
  bindMode: ('chat' | 'code' | 'knowledge' | 'task')[]
  setBindMode: (bindMode: ('chat' | 'code' | 'knowledge' | 'task')[]) => void
  icon?: string | null
  setIcon?: (icon: string) => void
  requiresWorkspace?: boolean | null
  setRequiresWorkspace?: (value: boolean | null) => void
}

export default function TeamBasicInfoForm({
  name,
  setName,
  description,
  setDescription,
  bindMode,
  setBindMode,
  icon,
  setIcon,
  requiresWorkspace,
  setRequiresWorkspace,
}: TeamBasicInfoFormProps) {
  const { t } = useTranslation()

  // Show requires_workspace toggle only when 'code' mode is selected
  const showRequiresWorkspace = bindMode.includes('code') && setRequiresWorkspace

  return (
    <div className="space-y-4">
      {/* Team Name with Icon and Bind Mode - Grid layout */}
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="teamName" className="text-sm font-medium">
            {t('common:team.name')} <span className="text-red-400">*</span>
          </Label>
          <div className="flex items-center gap-2">
            {setIcon && <TeamIconPicker value={icon} onChange={setIcon} />}
            <Input
              id="teamName"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder={t('common:team.name_placeholder')}
              className="bg-base flex-1"
            />
          </div>
        </div>

        {/* Bind Mode */}
        <div className="space-y-2">
          <Label className="text-sm font-medium">{t('common:team.bind_mode')}</Label>
          <div className="flex gap-2">
            {(['chat', 'code', 'task'] as const).map(opt => {
              const isSelected = bindMode.includes(opt)
              return (
                <button
                  key={opt}
                  type="button"
                  onClick={() => {
                    if (isSelected) {
                      // Allow deselecting even if it's the last one (can be empty)
                      setBindMode(bindMode.filter(m => m !== opt))
                    } else {
                      setBindMode([...bindMode, opt])
                    }
                  }}
                  className={`
                    px-3 py-1.5 text-sm font-medium rounded-md border transition-colors
                    ${
                      isSelected
                        ? 'bg-primary text-primary-foreground border-primary'
                        : 'border-border hover:bg-accent hover:text-accent-foreground'
                    }
                  `}
                >
                  {t(`team.bind_mode_${opt}`)}
                </button>
              )
            })}
          </div>
        </div>
      </div>

      {/* Description - Full width */}
      <div className="space-y-2">
        <Label htmlFor="teamDescription" className="text-sm font-medium">
          {t('common:team.description')}
        </Label>
        <Input
          id="teamDescription"
          value={description}
          onChange={e => setDescription(e.target.value)}
          placeholder={t('common:team.description_placeholder')}
          className="bg-base"
        />
      </div>

      {/* Requires Workspace Toggle - Only show when code mode is selected */}
      {showRequiresWorkspace && (
        <div className="flex items-center justify-between py-2">
          <div className="flex items-center gap-2">
            <Label htmlFor="requiresWorkspace" className="text-sm font-medium">
              {t('common:team.requires_workspace')}
            </Label>
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <HelpCircle className="h-4 w-4 text-text-muted cursor-help" />
                </TooltipTrigger>
                <TooltipContent side="top" className="max-w-xs">
                  <p className="text-xs">{t('common:team.requires_workspace_hint')}</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
          <Switch
            id="requiresWorkspace"
            checked={requiresWorkspace === true}
            onCheckedChange={checked => setRequiresWorkspace(checked)}
          />
        </div>
      )}
    </div>
  )
}
