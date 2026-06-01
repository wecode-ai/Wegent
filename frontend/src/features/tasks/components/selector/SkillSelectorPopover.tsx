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
  /** Render style for the selector trigger */
  triggerVariant?: 'button' | 'menu-item'
}

/** Ref handle for SkillSelectorPopover */
export interface SkillSelectorPopoverRef {
  /** Get the button element for animation targeting */
  getButtonElement: () => HTMLElement | null
}

interface AutoAvailableSkill {
  skill: UnifiedSkill
  sources: Array<'agent_builtin' | 'my_default'>
}

interface GroupedSkill {
  skill: UnifiedSkill
  group: 'personal' | 'group' | 'public'
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
      triggerVariant = 'button',
    },
    ref
  ) {
    const { t } = useTranslation()
    const [open, setOpen] = useState(false)
    const [searchQuery, setSearchQuery] = useState('')
    const buttonRef = useRef<HTMLElement | null>(null)

    // Expose button element via ref
    useImperativeHandle(ref, () => ({
      getButtonElement: () => buttonRef.current,
    }))

    const autoAvailableSkills = useMemo<AutoAvailableSkill[]>(() => {
      const teamSkillSet = new Set(teamSkillNames)
      const preloadedSkillSet = new Set(preloadedSkillNames)

      return skills
        .map(skill => {
          const sources: Array<'agent_builtin' | 'my_default'> = []
          if (teamSkillSet.has(skill.name) || preloadedSkillSet.has(skill.name)) {
            sources.push('agent_builtin')
          }
          if (skill.availability?.inMyDefault) {
            sources.push('my_default')
          }
          return sources.length > 0 ? { skill, sources } : null
        })
        .filter((item): item is AutoAvailableSkill => item !== null)
    }, [skills, teamSkillNames, preloadedSkillNames])

    // Group and filter temporary skills
    const groupedSkills = useMemo<GroupedSkill[]>(() => {
      const autoSkillNames = new Set(autoAvailableSkills.map(item => item.skill.name))
      const filteredSkills = skills.filter(skill => {
        if (autoSkillNames.has(skill.name)) return false
        if (isChatShell && preloadedSkillNames.includes(skill.name)) return false
        return true
      })

      // Group skills
      const grouped: GroupedSkill[] = []
      const personalSkills: GroupedSkill[] = []
      // Use Map to group skills by namespace for proper ordering
      const groupSkillsByNamespace: Map<string, GroupedSkill[]> = new Map()
      const publicSkills: GroupedSkill[] = []

      for (const skill of filteredSkills) {
        if (skill.is_public) {
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

      // Sort: Personal -> Group (by namespace) -> Public
      grouped.push(...personalSkills, ...groupSkills, ...publicSkills)
      return grouped
    }, [skills, autoAvailableSkills, preloadedSkillNames, isChatShell])

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

    const filteredAutoAvailableSkills = useMemo(() => {
      if (!searchQuery.trim()) {
        return autoAvailableSkills
      }

      const lowerQuery = searchQuery.toLowerCase()
      return autoAvailableSkills.filter(({ skill }) => {
        const nameMatch = skill.name.toLowerCase().includes(lowerQuery)
        const displayNameMatch = skill.displayName?.toLowerCase().includes(lowerQuery)
        const descriptionMatch = skill.description?.toLowerCase().includes(lowerQuery)
        return nameMatch || displayNameMatch || descriptionMatch
      })
    }, [autoAvailableSkills, searchQuery])

    // Get section header for a group
    const getSectionHeader = (group: 'personal' | 'group' | 'public') => {
      switch (group) {
        case 'personal':
          return t('common:skillSelector.personal_skills_section')
        case 'group':
          return t('common:skillSelector.group_skills_section')
        case 'public':
          return t('common:skillSelector.public_skills_section')
      }
    }

    // Get icon for a group
    const getGroupIcon = (group: 'personal' | 'group' | 'public') => {
      switch (group) {
        case 'personal':
          return <User className="h-3 w-3" />
        case 'group':
          return <Users className="h-3 w-3" />
        case 'public':
          return <Globe className="h-3 w-3" />
      }
    }

    const selectedCount = selectedSkillNames.length
    const hasSkills = groupedSkills.length > 0 || autoAvailableSkills.length > 0

    // Render grouped skills with section headers
    // For group skills, we need to track namespace changes to show group name
    const renderSkillsList = () => {
      if (filteredSkills.length === 0 && filteredAutoAvailableSkills.length === 0) {
        return (
          <div className="py-4 text-center text-sm text-text-muted">
            {searchQuery
              ? t('common:skillSelector.no_matching_skills')
              : t('common:skillSelector.no_available_skills')}
          </div>
        )
      }

      let currentGroup: 'personal' | 'group' | 'public' | null = null
      let currentNamespace: string | null = null
      const elements: React.ReactNode[] = []

      elements.push(
        <div
          key="auto-available-header"
          className="px-2 py-1.5 text-xs text-text-muted font-medium flex items-center gap-1.5 border-t border-border first:border-t-0 mt-1 first:mt-0"
        >
          <Zap className="h-3 w-3" />
          {t('common:skillSelector.autoAvailable')}
        </div>
      )

      if (filteredAutoAvailableSkills.length === 0) {
        elements.push(
          <div key="auto-available-empty" className="px-2 py-2 text-xs text-text-muted">
            {t('common:skillSelector.emptyAutoAvailable')}
          </div>
        )
      }

      for (const { skill, sources } of filteredAutoAvailableSkills) {
        elements.push(
          <div key={`auto-${skill.id}`} className="flex items-center gap-2 px-2 py-2 rounded-md">
            <div className="w-4 h-4 rounded border border-border bg-muted flex items-center justify-center flex-shrink-0 opacity-70">
              <Check className="h-3 w-3 text-text-muted" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm truncate text-text-primary">
                {skill.displayName || skill.name}
              </div>
              {skill.description && (
                <div className="text-xs text-text-muted truncate">{skill.description}</div>
              )}
              <div className="mt-1 flex flex-wrap gap-1">
                {sources.includes('agent_builtin') && (
                  <Badge variant="secondary" className="text-[10px]">
                    {t('common:skillSelector.agentBuiltin')}
                  </Badge>
                )}
                {sources.includes('my_default') && (
                  <Badge variant="secondary" className="text-[10px]">
                    {t('common:skillSelector.myDefault')}
                  </Badge>
                )}
              </div>
            </div>
          </div>
        )
      }

      elements.push(
        <div
          key="temporary-header"
          className="px-2 py-1.5 text-xs text-text-muted font-medium flex items-center gap-1.5 border-t border-border mt-1"
        >
          <Check className="h-3 w-3" />
          {t('common:skillSelector.temporaryUse')}
        </div>
      )

      if (filteredSkills.length === 0) {
        elements.push(
          <div key="temporary-empty" className="px-2 py-2 text-xs text-text-muted">
            {t('common:skillSelector.no_available_skills')}
          </div>
        )
        return elements
      }

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
            key={skill.id}
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

    const selectorContent = (
      <PopoverContent
        align="start"
        side="top"
        className="w-[280px] p-2 max-h-[320px] overflow-hidden flex flex-col"
      >
        <div className="px-2 pb-2 text-sm font-medium text-text-primary">
          {t('common:skillSelector.select_skills')}
        </div>

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

        <div className="flex-1 overflow-y-auto custom-scrollbar">{renderSkillsList()}</div>

        <div className="px-2 pt-2 border-t border-border mt-2 flex items-center justify-between gap-2">
          <span className="text-xs text-text-muted">{t('common:skillSelector.temporaryUse')}</span>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs text-text-muted hover:text-text-primary"
            asChild
          >
            <Link href="/resource-library?tab=mine&type=skill&scope=personal">
              <Settings className="h-3 w-3 mr-1" />
              {t('common:skillSelector.manageDefault')}
            </Link>
          </Button>
        </div>
      </PopoverContent>
    )

    if (triggerVariant === 'menu-item') {
      return (
        <Popover open={open} onOpenChange={handleOpenChange}>
          <PopoverTrigger asChild>
            <button
              ref={node => {
                buttonRef.current = node
              }}
              type="button"
              disabled={!hasSkills || disabled}
              className="w-full flex items-center justify-between px-3 py-2.5 text-left transition-colors hover:bg-hover active:bg-hover disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <span className="flex items-center gap-3">
                <Zap className="h-4 w-4 text-text-muted" />
                <span className="text-sm">{t('common:skillSelector.skill_button_label')}</span>
              </span>
              {selectedCount > 0 && (
                <span className="h-5 min-w-5 rounded-full bg-primary px-1.5 text-[11px] leading-5 text-white text-center">
                  {selectedCount}
                </span>
              )}
            </button>
          </PopoverTrigger>
          {selectorContent}
        </Popover>
      )
    }

    return (
      <TooltipProvider>
        <Popover open={open} onOpenChange={handleOpenChange}>
          <Tooltip>
            <TooltipTrigger asChild>
              <PopoverTrigger asChild>
                <div
                  ref={node => {
                    buttonRef.current = node
                  }}
                  className="relative"
                >
                  <ActionButton
                    onClick={() => setOpen(!open)}
                    disabled={!hasSkills || disabled}
                    icon={<Zap className="h-4 w-4 text-text-primary" />}
                    label={t('common:skillSelector.skill_button_label')}
                    title={t('common:skillSelector.skill_button_tooltip')}
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

          {selectorContent}
        </Popover>
      </TooltipProvider>
    )
  }
)

export default SkillSelectorPopover
