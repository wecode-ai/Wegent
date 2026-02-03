// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useCallback, useEffect, useRef, useState, useMemo } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { Check, Zap, User, Users, Globe } from 'lucide-react'
import type { UnifiedSkill } from '@/apis/skills'

/** Animation trigger data for fly animation */
export interface SkillFlyAnimationTrigger {
  skillName: string
  startPosition: { x: number; y: number }
  endPosition: { x: number; y: number }
}

interface SkillAutocompleteProps {
  /** All available skills */
  skills: UnifiedSkill[]
  /** Team's configured skill names (show first in list) */
  teamSkillNames: string[]
  /** Already preloaded skill names (filter out for ChatShell) */
  preloadedSkillNames: string[]
  /** Filter query after / */
  query: string
  /** Already selected skill names */
  selectedSkillNames: string[]
  /** Callback when a skill is selected */
  onSelect: (skillName: string) => void
  /** Callback when menu should close */
  onClose: () => void
  /** Position relative to container */
  position: { top: number; left: number }
  /** Whether this is a Chat Shell (affects filtering behavior) */
  isChatShell: boolean
  /** Whether the selector is read-only (can view but not modify) */
  readOnly?: boolean
  /** Ref to the skill button element for fly animation target */
  skillButtonRef?: React.RefObject<HTMLElement | null>
  /** Callback to trigger fly animation (animation is rendered in parent) */
  onTriggerFlyAnimation?: (data: SkillFlyAnimationTrigger) => void
}

interface GroupedSkill {
  skill: UnifiedSkill
  group: 'team' | 'personal' | 'group' | 'public'
}

/**
 * SkillAutocomplete Component
 *
 * Displays a floating autocomplete menu for selecting skills when user types /.
 * Skills are grouped into:
 * 1. Team Skills - Skills configured for the current agent
 * 2. Personal Skills - User's own uploaded skills (namespace='default', is_public=false)
 * 3. Group Skills - Skills from user's groups (namespace!='default', is_public=false)
 *    - Each group's skills are shown under a separate header with the group name
 * 4. Public Skills - System-wide public skills (is_public=true)
 */
export default function SkillAutocomplete({
  skills,
  teamSkillNames,
  preloadedSkillNames,
  query = '',
  selectedSkillNames,
  onSelect,
  onClose,
  position,
  isChatShell,
  readOnly = false,
  skillButtonRef,
  onTriggerFlyAnimation,
}: SkillAutocompleteProps) {
  const { t } = useTranslation()
  const menuRef = useRef<HTMLDivElement>(null)
  const [selectedIndex, setSelectedIndex] = useState(0)

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

  // Filter by query
  const filteredSkills = useMemo(() => {
    if (!query || query.trim() === '') {
      return groupedSkills
    }

    const lowerQuery = query.toLowerCase()
    return groupedSkills.filter(({ skill }) => {
      const nameMatch = skill.name.toLowerCase().includes(lowerQuery)
      const displayNameMatch = skill.displayName?.toLowerCase().includes(lowerQuery)
      const descriptionMatch = skill.description?.toLowerCase().includes(lowerQuery)
      return nameMatch || displayNameMatch || descriptionMatch
    })
  }, [groupedSkills, query])

  // Reset selected index when filtered skills change
  useEffect(() => {
    setSelectedIndex(0)
  }, [filteredSkills])

  // Close on outside click
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        onClose()
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [onClose])

  const handleSelect = useCallback(
    (skillName: string, event?: React.MouseEvent | React.KeyboardEvent) => {
      // Get start position from the clicked element or menu
      let startX = 0
      let startY = 0

      if (event && 'currentTarget' in event && event.currentTarget instanceof HTMLElement) {
        const rect = event.currentTarget.getBoundingClientRect()
        startX = rect.left + rect.width / 2
        startY = rect.top + rect.height / 2
      } else if (menuRef.current) {
        // Fallback to menu position for keyboard selection
        const rect = menuRef.current.getBoundingClientRect()
        startX = rect.left + 40 // Approximate icon position
        startY = rect.top + 20
      }

      // Get end position from skill button ref
      let endX = startX
      let endY = startY + 100 // Default fallback

      if (skillButtonRef?.current) {
        const buttonRect = skillButtonRef.current.getBoundingClientRect()
        endX = buttonRect.left + buttonRect.width / 2
        endY = buttonRect.top + buttonRect.height / 2
      }

      // Trigger animation in parent component (so it persists after this component unmounts)
      if (onTriggerFlyAnimation) {
        onTriggerFlyAnimation({
          skillName,
          startPosition: { x: startX, y: startY },
          endPosition: { x: endX, y: endY },
        })
      }

      // Call onSelect and onClose immediately
      onSelect(skillName)
      onClose()
    },
    [onSelect, onClose, skillButtonRef, onTriggerFlyAnimation]
  )

  // Handle keyboard navigation
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onClose()
      } else if (event.key === 'ArrowDown') {
        event.preventDefault()
        event.stopPropagation()
        setSelectedIndex(prev => Math.min(prev + 1, filteredSkills.length - 1))
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        event.stopPropagation()
        setSelectedIndex(prev => Math.max(prev - 1, 0))
      } else if (event.key === 'Enter') {
        event.preventDefault()
        event.stopPropagation()
        // In read-only mode, Enter just closes the menu
        if (readOnly) {
          onClose()
        } else if (filteredSkills[selectedIndex]) {
          // For keyboard selection, get position from the selected item
          const selectedItem = menuRef.current?.querySelector(
            `[data-skill-index="${selectedIndex}"]`
          ) as HTMLElement | null
          if (selectedItem) {
            const fakeEvent = {
              currentTarget: selectedItem,
            } as unknown as React.KeyboardEvent
            handleSelect(filteredSkills[selectedIndex].skill.name, fakeEvent)
          } else {
            handleSelect(filteredSkills[selectedIndex].skill.name)
          }
        }
      }
    }

    document.addEventListener('keydown', handleKeyDown, true) // Use capture phase
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true)
    }
  }, [onClose, filteredSkills, selectedIndex, handleSelect, readOnly])

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

  if (filteredSkills.length === 0) {
    return (
      <div
        ref={menuRef}
        className="absolute z-50 bg-surface border border-border rounded-md shadow-lg py-2 px-3 min-w-[250px]"
        style={{
          bottom: `calc(100% - ${position.top}px)`,
          left: `${position.left}px`,
        }}
      >
        <div className="text-sm text-text-muted">
          {t('common:skillSelector.no_available_skills')}
        </div>
      </div>
    )
  }

  // Group skills for rendering with section headers
  // For group skills, we need to track namespace changes to show group name
  let currentGroup: 'team' | 'personal' | 'group' | 'public' | null = null
  let currentNamespace: string | null = null
  const renderItems: React.ReactNode[] = []
  let itemIndex = 0

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

      renderItems.push(
        <div
          key={group === 'group' ? `header-${group}-${skill.namespace}` : `header-${group}`}
          className="px-3 py-1.5 text-xs text-text-muted font-medium flex items-center gap-1.5 border-t border-border first:border-t-0 mt-1 first:mt-0"
        >
          {getGroupIcon(group)}
          {headerText}
        </div>
      )
    }

    const isSelected = selectedSkillNames.includes(skill.name)
    const displayIndex = itemIndex
    itemIndex++

    renderItems.push(
      <div
        key={skill.name}
        data-skill-index={displayIndex}
        className={`px-3 py-2 transition-colors flex items-center gap-2 ${
          readOnly ? 'cursor-default' : 'cursor-pointer'
        } ${
          displayIndex === selectedIndex ? 'bg-muted' : readOnly ? '' : 'hover:bg-muted'
        } ${isSelected ? 'opacity-60' : ''}`}
        onClick={readOnly ? undefined : e => handleSelect(skill.name, e)}
        role={readOnly ? undefined : 'button'}
        tabIndex={readOnly ? -1 : 0}
        onKeyDown={
          readOnly
            ? undefined
            : e => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  handleSelect(skill.name, e)
                }
              }
        }
      >
        <Zap className={`h-4 w-4 flex-shrink-0 ${readOnly ? 'text-text-muted' : 'text-primary'}`} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span
              className={`text-sm font-medium truncate ${readOnly ? 'text-text-muted' : 'text-text-primary'}`}
            >
              {skill.displayName || skill.name}
            </span>
            {isSelected && <Check className="h-3.5 w-3.5 text-primary flex-shrink-0" />}
          </div>
          {skill.description && (
            <div className="text-xs text-text-muted truncate">{skill.description}</div>
          )}
        </div>
      </div>
    )
  }

  return (
    <div
      ref={menuRef}
      className="absolute z-50 bg-surface border border-border rounded-md shadow-lg py-1 min-w-[300px] max-w-[400px] max-h-[300px] overflow-y-auto"
      style={{
        bottom: `calc(100% - ${position.top}px)`,
        left: `${position.left}px`,
      }}
    >
      {renderItems}
      <div className="px-3 py-1 text-xs text-text-muted border-t border-border mt-1">
        {t('common:skillSelector.skill_autocomplete_title')}
      </div>
    </div>
  )
}
