// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useCallback, useEffect, useRef, useState, useMemo } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { Check, Zap, Globe, User } from 'lucide-react'
import type { UnifiedSkill } from '@/apis/skills'
import { cn } from '@/lib/utils'

interface SkillAutocompleteProps {
  /** All available skills */
  skills: UnifiedSkill[]
  /** Team's configured skills (show first) */
  teamSkillNames: string[]
  /** Already preloaded skills to filter out (for ChatShell only) */
  preloadedSkillNames: string[]
  /** Filter query after / */
  query: string
  /** Already selected skills */
  selectedSkillNames: string[]
  /** Callback when skill is selected */
  onSelect: (skillName: string) => void
  /** Callback to close menu */
  onClose: () => void
  /** Position for the menu */
  position: { top: number; left: number }
  /** Whether this is a Chat Shell (determines filtering behavior) */
  isChatShell: boolean
}

interface SkillGroup {
  title: string
  titleKey: string
  skills: UnifiedSkill[]
  icon: React.ReactNode
}

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
}: SkillAutocompleteProps) {
  const { t } = useTranslation()
  const menuRef = useRef<HTMLDivElement>(null)
  const [selectedIndex, setSelectedIndex] = useState(0)

  // Build skill groups with filtering
  const skillGroups = useMemo<SkillGroup[]>(() => {
    // Filter out preloaded skills for Chat Shell
    const preloadedSet = isChatShell ? new Set(preloadedSkillNames) : new Set<string>()
    const teamSkillSet = new Set(teamSkillNames)

    // Filter skills that are not preloaded (for Chat Shell)
    const availableSkills = skills.filter(skill => !preloadedSet.has(skill.name))

    // Apply query filter
    const filteredSkills = query.trim()
      ? availableSkills.filter(
          skill =>
            skill.name.toLowerCase().includes(query.toLowerCase()) ||
            skill.displayName?.toLowerCase().includes(query.toLowerCase()) ||
            skill.description?.toLowerCase().includes(query.toLowerCase())
        )
      : availableSkills

    // Group skills
    const teamSkills: UnifiedSkill[] = []
    const personalSkills: UnifiedSkill[] = []
    const publicSkills: UnifiedSkill[] = []

    filteredSkills.forEach(skill => {
      if (teamSkillSet.has(skill.name)) {
        teamSkills.push(skill)
      } else if (skill.is_public) {
        publicSkills.push(skill)
      } else {
        personalSkills.push(skill)
      }
    })

    const groups: SkillGroup[] = []

    if (teamSkills.length > 0) {
      groups.push({
        title: t('chat:skills.team_skills_section'),
        titleKey: 'team',
        skills: teamSkills,
        icon: <Zap className="h-3 w-3" />,
      })
    }

    if (personalSkills.length > 0) {
      groups.push({
        title: t('chat:skills.personal_skills_section'),
        titleKey: 'personal',
        skills: personalSkills,
        icon: <User className="h-3 w-3" />,
      })
    }

    if (publicSkills.length > 0) {
      groups.push({
        title: t('chat:skills.public_skills_section'),
        titleKey: 'public',
        skills: publicSkills,
        icon: <Globe className="h-3 w-3" />,
      })
    }

    return groups
  }, [skills, teamSkillNames, preloadedSkillNames, query, isChatShell, t])

  // Flatten skills for keyboard navigation
  const flatSkills = useMemo(() => {
    return skillGroups.flatMap(group => group.skills)
  }, [skillGroups])

  // Reset selected index when filtered skills change
  useEffect(() => {
    setSelectedIndex(0)
  }, [flatSkills])

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
    (skill: UnifiedSkill) => {
      onSelect(skill.name)
      onClose()
    },
    [onSelect, onClose]
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
        setSelectedIndex(prev => Math.min(prev + 1, flatSkills.length - 1))
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        event.stopPropagation()
        setSelectedIndex(prev => Math.max(prev - 1, 0))
      } else if (event.key === 'Enter') {
        event.preventDefault()
        event.stopPropagation()
        if (flatSkills[selectedIndex]) {
          handleSelect(flatSkills[selectedIndex])
        }
      }
    }

    document.addEventListener('keydown', handleKeyDown, true)
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true)
    }
  }, [onClose, flatSkills, selectedIndex, handleSelect])

  // Check if a skill is selected
  const isSelected = useCallback(
    (skillName: string) => selectedSkillNames.includes(skillName),
    [selectedSkillNames]
  )

  if (flatSkills.length === 0) {
    return (
      <div
        ref={menuRef}
        className="absolute z-50 bg-surface border border-border rounded-md shadow-lg py-2 px-3 min-w-[200px]"
        style={{
          bottom: `calc(100% - ${position.top}px)`,
          left: `${position.left}px`,
        }}
      >
        <div className="text-sm text-text-muted">{t('chat:skills.no_available_skills')}</div>
      </div>
    )
  }

  // Track current flat index for highlighting
  let currentFlatIndex = 0

  return (
    <div
      ref={menuRef}
      className="absolute z-50 bg-surface border border-border rounded-md shadow-lg py-1 min-w-[280px] max-w-[360px] max-h-[300px] overflow-y-auto"
      style={{
        bottom: `calc(100% - ${position.top}px)`,
        left: `${position.left}px`,
      }}
    >
      {/* Header */}
      <div className="px-3 py-1.5 border-b border-border">
        <div className="text-xs font-medium text-text-muted flex items-center gap-1.5">
          <Zap className="h-3 w-3" />
          {t('chat:skills.skill_autocomplete_title')}
        </div>
      </div>

      {/* Skill groups */}
      {skillGroups.map((group, groupIndex) => (
        <div key={group.titleKey}>
          {/* Group header */}
          <div className="px-3 py-1 mt-1">
            <div className="text-xs font-medium text-text-muted flex items-center gap-1">
              {group.icon}
              {group.title}
            </div>
          </div>

          {/* Group items */}
          {group.skills.map(skill => {
            const flatIndex = currentFlatIndex++
            const selected = isSelected(skill.name)

            return (
              <div
                key={`${group.titleKey}-${skill.id}`}
                className={cn(
                  'px-3 py-2 cursor-pointer transition-colors flex items-center gap-2',
                  flatIndex === selectedIndex ? 'bg-muted' : 'hover:bg-muted'
                )}
                onClick={() => handleSelect(skill)}
                role="button"
                tabIndex={0}
                onKeyDown={e => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    handleSelect(skill)
                  }
                }}
              >
                {/* Skill icon */}
                <Zap className="h-4 w-4 text-primary flex-shrink-0" />

                {/* Skill info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-sm font-medium text-text-primary truncate">
                      {skill.displayName || skill.name}
                    </span>
                    {skill.version && (
                      <span className="text-xs text-text-muted">v{skill.version}</span>
                    )}
                  </div>
                  {skill.description && (
                    <span className="text-xs text-text-muted line-clamp-1">
                      {skill.description}
                    </span>
                  )}
                </div>

                {/* Selection indicator */}
                <Check
                  className={cn(
                    'h-4 w-4 flex-shrink-0',
                    selected ? 'text-primary opacity-100' : 'opacity-0'
                  )}
                />
              </div>
            )
          })}

          {/* Separator between groups */}
          {groupIndex < skillGroups.length - 1 && <div className="my-1 border-t border-border" />}
        </div>
      ))}

      {/* Footer hint */}
      <div className="px-3 py-1.5 border-t border-border mt-1">
        <div className="text-xs text-text-muted">
          {isChatShell ? t('chat:skills.preload_hint') : t('chat:skills.download_hint')}
        </div>
      </div>
    </div>
  )
}
