// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useMemo, useState, forwardRef, useImperativeHandle, useRef } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { Zap, Check, Search, User, Users, Globe, Settings } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { ActionButton } from '@/components/ui/action-button'
import { Button } from '@/components/ui/button'
import type { UnifiedSkill } from '@/apis/skills'
import Link from 'next/link'

interface SkillSelectorPopoverProps {
  /** All available skills */
  skills: UnifiedSkill[]
  /** Team's configured skill names (show first in list) */
  teamSkillNames: string[]
  /** Already preloaded skill names (filter out for ChatShell) */
  preloadedSkillNames: string[]
  /** Currently selected skill names */
  selectedSkillNames: string[]
  /** Callback when a skill is toggled */
  onToggleSkill: (skillName: string) => void
  /** Whether this is a Chat Shell (affects filtering behavior) */
  isChatShell: boolean
  /** Whether the selector is disabled (cannot open popover) */
  disabled?: boolean
  /** Whether the selector is read-only (can view but not modify) */
  readOnly?: boolean
}

/** Ref handle for SkillSelectorPopover */
export interface SkillSelectorPopoverRef {
  /** Get the button element for animation targeting */
  getButtonElement: () => HTMLElement | null
}

interface GroupedSkill {
  skill: UnifiedSkill
  group: 'team' | 'personal' | 'group' | 'public'
}

/**
 * SkillSelectorPopover Component
 *
 * A popover button that allows selecting multiple skills for a message.
 * Skills are grouped into:
 * 1. Team Skills - Skills configured for the current agent
 * 2. Personal Skills - User's own uploaded skills (namespace='default', is_public=false)
 * 3. Group Skills - Skills from user's groups (namespace!='default', is_public=false)
 *    - Each group's skills are shown under a separate header with the group name
 * 4. Public Skills - System-wide public skills (is_public=true)
 */
const SkillSelectorPopover = forwardRef<SkillSelectorPopoverRef, SkillSelectorPopoverProps>(
  function SkillSelectorPopover(
    {
      skills,
      teamSkillNames,
      preloadedSkillNames,
      selectedSkillNames,
      onToggleSkill,
      isChatShell,
      disabled = false,
      readOnly = false,
    },
    ref
  ) {
    const { t } = useTranslation()
    const [open, setOpen] = useState(false)
    const [searchQuery, setSearchQuery] = useState('')
    const buttonRef = useRef<HTMLDivElement>(null)

    // Expose button element via ref
    useImperativeHandle(ref, () => ({
      getButtonElement: () => buttonRef.current,
    }))

    // Group and filter skills
    const groupedSkills = useMemo<GroupedSkill[]>(() => {
      // For Chat Shell, filter out preloaded skills (they're auto-injected)
      const filteredSkills = isChatShell
        ? skills.filter(skill => !preloadedSkillNames.includes(skill.name))
        : skills

      // Create a set of team skill names for fast lookup
      const teamSkillSet = new Set(teamSkillNames)

      // Group skills
      const grouped: GroupedSkill[] = []
      const teamSkills: GroupedSkill[] = []
      const personalSkills: GroupedSkill[] = []
      // Use Map to group skills by namespace for proper ordering
      const groupSkillsByNamespace: Map<string, GroupedSkill[]> = new Map()
      const publicSkills: GroupedSkill[] = []

      for (const skill of filteredSkills) {
        if (teamSkillSet.has(skill.name)) {
          teamSkills.push({ skill, group: 'team' })
        } else if (skill.is_public) {
          publicSkills.push({ skill, group: 'public' })
        } else if (skill.namespace && skill.namespace !== 'default') {
          // Group skills: namespace is not 'default' and not public
          // Group by namespace for proper ordering
          const namespace = skill.namespace
          if (!groupSkillsByNamespace.has(namespace)) {
            groupSkillsByNamespace.set(namespace, [])
          }
          groupSkillsByNamespace.get(namespace)!.push({ skill, group: 'group' })
        } else {
          // Personal skills: namespace is 'default' and not public
          personalSkills.push({ skill, group: 'personal' })
        }
      }

      // Flatten group skills, sorted by namespace
      const sortedNamespaces = Array.from(groupSkillsByNamespace.keys()).sort()
      const groupSkills: GroupedSkill[] = []
      for (const namespace of sortedNamespaces) {
        groupSkills.push(...groupSkillsByNamespace.get(namespace)!)
      }

      // Sort: Team -> Personal -> Group (by namespace) -> Public
      grouped.push(...teamSkills, ...personalSkills, ...groupSkills, ...publicSkills)
      return grouped
    }, [skills, teamSkillNames, preloadedSkillNames, isChatShell])

    // Filter by search query
    const filteredSkills = useMemo(() => {
      if (!searchQuery.trim()) {
        return groupedSkills
      }

      const lowerQuery = searchQuery.toLowerCase()
      return groupedSkills.filter(({ skill }) => {
        const nameMatch = skill.name.toLowerCase().includes(lowerQuery)
        const displayNameMatch = skill.displayName?.toLowerCase().includes(lowerQuery)
        const descriptionMatch = skill.description?.toLowerCase().includes(lowerQuery)
        return nameMatch || displayNameMatch || descriptionMatch
      })
    }, [groupedSkills, searchQuery])

    // Get section header for a group
    const getSectionHeader = (group: 'team' | 'personal' | 'group' | 'public') => {
      switch (group) {
        case 'team':
          return t('common:skillSelector.team_skills_section')
        case 'personal':
          return t('common:skillSelector.personal_skills_section')
        case 'group':
          return t('common:skillSelector.group_skills_section')
        case 'public':
          return t('common:skillSelector.public_skills_section')
      }
    }

    // Get icon for a group
    const getGroupIcon = (group: 'team' | 'personal' | 'group' | 'public') => {
      switch (group) {
        case 'team':
          return <Zap className="h-3 w-3" />
        case 'personal':
          return <User className="h-3 w-3" />
        case 'group':
          return <Users className="h-3 w-3" />
        case 'public':
          return <Globe className="h-3 w-3" />
      }
    }

    const selectedCount = selectedSkillNames.length
    const hasSkills = groupedSkills.length > 0

    // Render grouped skills with section headers
    // For group skills, we need to track namespace changes to show group name
    const renderSkillsList = () => {
      if (filteredSkills.length === 0) {
        return (
          <div className="py-4 text-center text-sm text-text-muted">
            {searchQuery
              ? t('common:skillSelector.no_matching_skills')
              : t('common:skillSelector.no_available_skills')}
          </div>
        )
      }

      let currentGroup: 'team' | 'personal' | 'group' | 'public' | null = null
      let currentNamespace: string | null = null
      const elements: React.ReactNode[] = []

      for (const { skill, group } of filteredSkills) {
        // Add section header when group changes
        // For 'group' type, also add header when namespace changes
        const needsHeader =
          group !== currentGroup || (group === 'group' && skill.namespace !== currentNamespace)

        if (needsHeader) {
          currentGroup = group
          if (group === 'group') {
            currentNamespace = skill.namespace || null
          }

          // For group skills, show the group name (namespace) in the header
          const headerText =
            group === 'group' && skill.namespace
              ? `${t('common:skillSelector.group_skills_section')} - ${skill.namespace}`
              : getSectionHeader(group)

          elements.push(
            <div
              key={group === 'group' ? `header-${group}-${skill.namespace}` : `header-${group}`}
              className="px-2 py-1.5 text-xs text-text-muted font-medium flex items-center gap-1.5 border-t border-border first:border-t-0 mt-1 first:mt-0"
            >
              {getGroupIcon(group)}
              {headerText}
            </div>
          )
        }

        const isSelected = selectedSkillNames.includes(skill.name)

        elements.push(
          <div
            key={skill.name}
            className={`flex items-center gap-2 px-2 py-2 rounded-md transition-colors ${
              readOnly ? 'cursor-default' : 'cursor-pointer'
            } ${isSelected ? 'bg-primary/10' : readOnly ? '' : 'hover:bg-muted'}`}
            onClick={readOnly ? undefined : () => onToggleSkill(skill.name)}
            role={readOnly ? undefined : 'button'}
            tabIndex={readOnly ? -1 : 0}
            onKeyDown={
              readOnly
                ? undefined
                : e => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      onToggleSkill(skill.name)
                    }
                  }
            }
          >
            <div
              className={`w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 ${
                isSelected ? 'bg-primary border-primary text-white' : 'border-border bg-background'
              } ${readOnly ? 'opacity-60' : ''}`}
            >
              {isSelected && <Check className="h-3 w-3" />}
            </div>
            <div className="flex-1 min-w-0">
              <div
                className={`text-sm truncate ${readOnly ? 'text-text-muted' : 'text-text-primary'}`}
              >
                {skill.displayName || skill.name}
              </div>
              {skill.description && (
                <div className="text-xs text-text-muted truncate">{skill.description}</div>
              )}
            </div>
          </div>
        )
      }

      return elements
    }

    // Prevent opening popover when disabled
    const handleOpenChange = (newOpen: boolean) => {
      if (disabled) return
      setOpen(newOpen)
    }

    return (
      <TooltipProvider>
        <Popover open={open} onOpenChange={handleOpenChange}>
          <Tooltip>
            <TooltipTrigger asChild>
              <PopoverTrigger asChild>
                <div ref={buttonRef} className="relative">
                  <ActionButton
                    variant="outline"
                    onClick={() => setOpen(!open)}
                    disabled={!hasSkills || disabled}
                    icon={<Zap className="h-4 w-4 text-text-primary" />}
                    title={t('common:skillSelector.skill_button_tooltip')}
                    className="border-border bg-base text-text-primary hover:bg-hover"
                  />
                  {selectedCount > 0 && (
                    <Badge
                      variant="secondary"
                      className="absolute -top-1.5 -right-1.5 h-[18px] min-w-[18px] flex items-center justify-center text-[10px] px-1 bg-primary text-white pointer-events-none z-10 rounded-full"
                    >
                      {selectedCount}
                    </Badge>
                  )}
                </div>
              </PopoverTrigger>
            </TooltipTrigger>
            <TooltipContent side="top">
              <p className="text-xs">{t('common:skillSelector.skill_button_tooltip')}</p>
            </TooltipContent>
          </Tooltip>

          <PopoverContent
            align="start"
            side="top"
            className="w-[280px] p-2 max-h-[320px] overflow-hidden flex flex-col"
          >
            <div className="px-2 pb-2 text-sm font-medium text-text-primary">
              {t('common:skillSelector.select_skills')}
            </div>

            {/* Search input */}
            <div className="px-2 pb-2">
              <div className="relative">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-text-muted" />
                <Input
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  placeholder={t('common:skillSelector.search_skills')}
                  className="h-8 pl-7 text-sm"
                />
              </div>
            </div>

            {/* Skills list */}
            <div className="flex-1 overflow-y-auto custom-scrollbar">{renderSkillsList()}</div>

            {/* Footer with hint and settings link */}
            <div className="px-2 pt-2 border-t border-border mt-2 flex items-center justify-between gap-2">
              <span className="text-xs text-text-muted">
                {isChatShell
                  ? t('common:skillSelector.preload_hint')
                  : t('common:skillSelector.download_hint')}
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-xs text-text-muted hover:text-text-primary"
                asChild
              >
                <Link href="/settings?section=personal&tab=personal-skills">
                  <Settings className="h-3 w-3 mr-1" />
                  {t('common:skillSelector.manage_skills')}
                </Link>
              </Button>
            </div>
          </PopoverContent>
        </Popover>
      </TooltipProvider>
    )
  }
)

export default SkillSelectorPopover
