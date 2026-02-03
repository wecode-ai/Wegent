// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Zap, Check, Globe, User } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command'
import { ActionButton } from '@/components/ui/action-button'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import type { UnifiedSkill } from '@/apis/skills'

interface SkillSelectorButtonProps {
  /** All available skills */
  skills: UnifiedSkill[]
  /** Team's configured skills */
  teamSkillNames: string[]
  /** Already preloaded skills (for ChatShell only) */
  preloadedSkillNames: string[]
  /** Currently selected skill names */
  selectedSkillNames: string[]
  /** Callback when skills selection changes */
  onSelectionChange: (skillNames: string[]) => void
  /** Whether this is a Chat Shell */
  isChatShell: boolean
  /** Whether the button is disabled */
  disabled?: boolean
}

export default function SkillSelectorButton({
  skills,
  teamSkillNames,
  preloadedSkillNames,
  selectedSkillNames,
  onSelectionChange,
  isChatShell,
  disabled = false,
}: SkillSelectorButtonProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [searchValue, setSearchValue] = useState('')

  // Reset search when popover closes
  useEffect(() => {
    if (!open) {
      setSearchValue('')
    }
  }, [open])

  // Build filtered skill groups
  const { teamSkills, personalSkills, publicSkills, allAvailableSkills } = useMemo(() => {
    // Filter out preloaded skills for Chat Shell
    const preloadedSet = isChatShell ? new Set(preloadedSkillNames) : new Set<string>()
    const teamSkillSet = new Set(teamSkillNames)

    const availableSkills = skills.filter(skill => !preloadedSet.has(skill.name))

    const team: UnifiedSkill[] = []
    const personal: UnifiedSkill[] = []
    const publicList: UnifiedSkill[] = []

    availableSkills.forEach(skill => {
      if (teamSkillSet.has(skill.name)) {
        team.push(skill)
      } else if (skill.is_public) {
        publicList.push(skill)
      } else {
        personal.push(skill)
      }
    })

    return {
      teamSkills: team,
      personalSkills: personal,
      publicSkills: publicList,
      allAvailableSkills: availableSkills,
    }
  }, [skills, teamSkillNames, preloadedSkillNames, isChatShell])

  // Handle skill toggle
  const handleToggleSkill = useCallback(
    (skillName: string) => {
      const isSelected = selectedSkillNames.includes(skillName)
      if (isSelected) {
        onSelectionChange(selectedSkillNames.filter(name => name !== skillName))
      } else {
        onSelectionChange([...selectedSkillNames, skillName])
      }
    },
    [selectedSkillNames, onSelectionChange]
  )

  // Check if skill is selected
  const isSelected = useCallback(
    (skillName: string) => selectedSkillNames.includes(skillName),
    [selectedSkillNames]
  )

  // Render skill item
  const renderSkillItem = (skill: UnifiedSkill) => {
    const selected = isSelected(skill.name)
    return (
      <CommandItem
        key={skill.id}
        value={`${skill.name} ${skill.displayName || ''} ${skill.description || ''}`}
        onSelect={() => handleToggleSkill(skill.name)}
        className={cn(
          'cursor-pointer select-none px-3 py-2 rounded-md mx-1 my-[2px]',
          'aria-selected:bg-hover',
          '!flex !flex-row !items-start !justify-between !gap-2'
        )}
      >
        <div className="flex items-start gap-2 min-w-0 flex-1">
          <Zap className="w-4 h-4 text-primary flex-shrink-0 mt-0.5" />
          <div className="flex flex-col min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="font-medium text-sm text-text-primary truncate">
                {skill.displayName || skill.name}
              </span>
              {skill.version && <span className="text-xs text-text-muted">v{skill.version}</span>}
            </div>
            {skill.description && (
              <span className="text-xs text-text-muted line-clamp-1">{skill.description}</span>
            )}
          </div>
        </div>
        <Check
          className={cn(
            'h-3.5 w-3.5 shrink-0 mt-0.5',
            selected ? 'opacity-100 text-primary' : 'opacity-0'
          )}
        />
      </CommandItem>
    )
  }

  const selectedCount = selectedSkillNames.length

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <div className="relative">
          <ActionButton
            icon={<Zap className="h-4 w-4" />}
            title={t('chat:skills.select_skills')}
            disabled={disabled}
            className={cn(selectedCount > 0 && 'text-primary')}
          />
          {/* Badge showing selected count */}
          {selectedCount > 0 && (
            <Badge
              variant="secondary"
              className="absolute -top-1 -right-1 h-4 min-w-[16px] px-1 text-[10px] font-medium bg-primary text-white pointer-events-none"
            >
              {selectedCount}
            </Badge>
          )}
        </div>
      </PopoverTrigger>
      <PopoverContent
        className={cn(
          'p-0 w-auto min-w-[320px] max-w-[400px] border border-border bg-base',
          'shadow-xl rounded-xl overflow-hidden',
          'max-h-[var(--radix-popover-content-available-height,400px)]',
          'flex flex-col'
        )}
        align="start"
        sideOffset={4}
        collisionPadding={8}
        avoidCollisions={true}
        sticky="partial"
      >
        <Command className="border-0 flex flex-col flex-1 min-h-0 overflow-hidden">
          {/* Header */}
          <div className="px-3 py-2 border-b border-border flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <Zap className="h-4 w-4 text-primary" />
              <span className="text-sm font-medium">{t('chat:skills.select_skills')}</span>
            </div>
            {selectedCount > 0 && (
              <span className="text-xs text-text-muted">
                {t('chat:skills.skills_selected', { count: selectedCount })}
              </span>
            )}
          </div>

          {/* Search input */}
          <CommandInput
            placeholder={t('common:actions.search')}
            value={searchValue}
            onValueChange={setSearchValue}
            className={cn(
              'h-9 rounded-none border-b border-border flex-shrink-0',
              'placeholder:text-text-muted text-sm'
            )}
          />

          <CommandList className="min-h-[36px] max-h-[280px] overflow-y-auto flex-1">
            {allAvailableSkills.length === 0 ? (
              <div className="py-6 px-4 text-center">
                <p className="text-sm text-text-muted">{t('chat:skills.no_available_skills')}</p>
              </div>
            ) : (
              <>
                <CommandEmpty className="py-4 text-center text-sm text-text-muted">
                  {t('common:branches.no_match')}
                </CommandEmpty>

                {/* Team Skills */}
                {teamSkills.length > 0 && (
                  <CommandGroup
                    heading={
                      <div className="flex items-center gap-1.5 text-xs font-medium text-text-muted">
                        <Zap className="w-3 h-3" />
                        {t('chat:skills.team_skills_section')}
                      </div>
                    }
                  >
                    {teamSkills.map(renderSkillItem)}
                  </CommandGroup>
                )}

                {/* Personal Skills */}
                {personalSkills.length > 0 && (
                  <>
                    {teamSkills.length > 0 && <CommandSeparator />}
                    <CommandGroup
                      heading={
                        <div className="flex items-center gap-1.5 text-xs font-medium text-text-muted">
                          <User className="w-3 h-3" />
                          {t('chat:skills.personal_skills_section')}
                        </div>
                      }
                    >
                      {personalSkills.map(renderSkillItem)}
                    </CommandGroup>
                  </>
                )}

                {/* Public Skills */}
                {publicSkills.length > 0 && (
                  <>
                    {(teamSkills.length > 0 || personalSkills.length > 0) && <CommandSeparator />}
                    <CommandGroup
                      heading={
                        <div className="flex items-center gap-1.5 text-xs font-medium text-text-muted">
                          <Globe className="w-3 h-3" />
                          {t('chat:skills.public_skills_section')}
                        </div>
                      }
                    >
                      {publicSkills.map(renderSkillItem)}
                    </CommandGroup>
                  </>
                )}
              </>
            )}
          </CommandList>

          {/* Footer hint */}
          <div className="px-3 py-2 border-t border-border bg-muted/30">
            <p className="text-xs text-text-muted">
              {isChatShell ? t('chat:skills.preload_hint') : t('chat:skills.download_hint')}
            </p>
          </div>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
