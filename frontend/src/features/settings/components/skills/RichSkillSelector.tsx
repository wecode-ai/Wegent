// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useMemo, useState, useRef, useEffect } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { Sparkles, Globe, User, Users, ChevronDown } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import type { UnifiedSkill } from '@/apis/skills'

interface RichSkillSelectorProps {
  /** All available skills */
  skills: UnifiedSkill[]
  /** Currently selected skill names */
  selectedSkillNames: string[]
  /** Callback when a skill is selected */
  onSelectSkill: (skillName: string) => void
  /** Placeholder text for the trigger */
  placeholder?: string
  /** Whether the selector is disabled */
  disabled?: boolean
  /** Whether the selector is read-only */
  readOnly?: boolean
}

interface GroupedSkill {
  skill: UnifiedSkill
  group: 'personal' | 'group' | 'public'
}

/**
 * RichSkillSelector Component
 *
 * A rich skill selector with detailed information display including:
 * - Skill name, version, tags
 * - Description
 * - Author and creation time
 *
 * Skills are grouped into: Personal, Group, Public
 */
export function RichSkillSelector({
  skills,
  selectedSkillNames,
  onSelectSkill,
  placeholder,
  disabled = false,
  readOnly = false,
}: RichSkillSelectorProps) {
  const { t } = useTranslation('common')
  const [open, setOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [triggerWidth, setTriggerWidth] = useState<number>(0)
  const listRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  // Measure trigger width when open changes
  useEffect(() => {
    if (open && triggerRef.current) {
      setTriggerWidth(triggerRef.current.offsetWidth)
    }
  }, [open])

  // Group and filter skills
  const groupedSkills = useMemo<GroupedSkill[]>(() => {
    const grouped: GroupedSkill[] = []
    const personalSkills: GroupedSkill[] = []
    const groupSkillsByNamespace: Map<string, GroupedSkill[]> = new Map()
    const publicSkills: GroupedSkill[] = []

    // Filter out already selected skills
    const selectedSet = new Set(selectedSkillNames)
    const availableSkills = skills.filter(skill => !selectedSet.has(skill.name))

    for (const skill of availableSkills) {
      if (skill.is_public) {
        publicSkills.push({ skill, group: 'public' })
      } else if (skill.namespace && skill.namespace !== 'default') {
        const namespace = skill.namespace
        if (!groupSkillsByNamespace.has(namespace)) {
          groupSkillsByNamespace.set(namespace, [])
        }
        groupSkillsByNamespace.get(namespace)!.push({ skill, group: 'group' })
      } else {
        personalSkills.push({ skill, group: 'personal' })
      }
    }

    // Flatten group skills, sorted by namespace
    const sortedNamespaces = Array.from(groupSkillsByNamespace.keys()).sort()
    const groupSkills: GroupedSkill[] = []
    for (const namespace of sortedNamespaces) {
      groupSkills.push(...groupSkillsByNamespace.get(namespace)!)
    }

    // Sort: Personal -> Group -> Public
    grouped.push(...personalSkills, ...groupSkills, ...publicSkills)
    return grouped
  }, [skills, selectedSkillNames])

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
      const tagMatch = skill.tags?.some((tag: string) => tag.toLowerCase().includes(lowerQuery))
      return nameMatch || displayNameMatch || descriptionMatch || tagMatch
    })
  }, [groupedSkills, searchQuery])

  // Get section header for a group
  const getSectionHeader = (group: 'personal' | 'group' | 'public') => {
    switch (group) {
      case 'personal':
        return t('skillSelector.personal_skills_section', 'Personal Skills')
      case 'group':
        return t('skillSelector.group_skills_section', 'Group Skills')
      case 'public':
        return t('skillSelector.public_skills_section', 'Public Skills')
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

  // Handle skill selection
  const handleSelect = (skillName: string) => {
    onSelectSkill(skillName)
    setOpen(false)
    setSearchQuery('')
  }

  // Handle wheel event manually to ensure scrolling works
  const handleWheel = (e: React.WheelEvent) => {
    const list = listRef.current
    if (!list) return

    // Prevent parent scrolling when scrolling within the list
    const isScrollingUp = e.deltaY < 0
    const isScrollingDown = e.deltaY > 0
    const isAtTop = list.scrollTop <= 0
    const isAtBottom = list.scrollTop + list.clientHeight >= list.scrollHeight

    if ((isScrollingUp && isAtTop) || (isScrollingDown && isAtBottom)) {
      // Allow event to propagate to parent when at boundaries
      return
    }

    // Prevent default to stop parent scrolling
    e.stopPropagation()
  }

  // Render grouped skills with section headers
  const renderSkillsList = () => {
    if (filteredSkills.length === 0) {
      return (
        <div className="py-8 text-center text-sm text-text-muted">
          {searchQuery
            ? t('skillSelector.no_matching_skills', 'No matching skills')
            : t('skillSelector.no_available_skills', 'No available skills')}
        </div>
      )
    }

    let currentGroup: 'personal' | 'group' | 'public' | null = null
    let currentNamespace: string | null = null
    const elements: React.ReactNode[] = []

    for (const { skill, group } of filteredSkills) {
      // Add section header when group changes
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
            ? `${getSectionHeader(group)} - ${skill.namespace}`
            : getSectionHeader(group)

        elements.push(
          <div
            key={group === 'group' ? `header-${group}-${skill.namespace}` : `header-${group}`}
            className="px-3 py-2 text-xs text-text-muted font-medium flex items-center gap-1.5 border-b border-border bg-muted/50"
          >
            {getGroupIcon(group)}
            {headerText}
          </div>
        )
      }

      elements.push(
        <div
          key={skill.name}
          className="px-4 py-3 cursor-pointer hover:bg-muted transition-colors border-b border-border last:border-b-0"
          onClick={() => handleSelect(skill.name)}
          role="button"
          tabIndex={0}
          onKeyDown={e => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              handleSelect(skill.name)
            }
          }}
        >
          {/* Header row: Icon + Name + Version + Tags */}
          <div className="flex flex-col w-full gap-1">
            <div className="flex items-center gap-2 flex-wrap">
              <Sparkles className="h-4 w-4 text-primary flex-shrink-0" />
              <span className="font-medium text-text-primary text-sm">
                {skill.displayName || skill.name}
              </span>
              {skill.version && (
                <Badge variant="secondary" size="sm" className="text-[10px]">
                  v{skill.version}
                </Badge>
              )}
              {skill.tags && skill.tags.length > 0 && (
                <div className="flex items-center gap-1 flex-wrap">
                  {skill.tags.slice(0, 3).map((tag: string) => (
                    <Badge key={tag} variant="info" size="sm" className="text-[10px]">
                      {tag}
                    </Badge>
                  ))}
                  {skill.tags.length > 3 && (
                    <Badge variant="info" size="sm" className="text-[10px]">
                      +{skill.tags.length - 3}
                    </Badge>
                  )}
                </div>
              )}
            </div>

            {/* Description */}
            {skill.description && (
              <div className="text-xs text-text-secondary line-clamp-2 pl-6">
                {skill.description}
              </div>
            )}

            {/* Footer: Author and Date */}
            <div className="text-xs text-text-muted pl-6 flex items-center gap-2">
              {skill.author && (
                <>
                  <span>
                    {t('skills.author', 'Author')}: {skill.author}
                  </span>
                  <span>•</span>
                </>
              )}
              {skill.created_at && (
                <span>
                  {t('skills.created_at', 'Created')}:{' '}
                  {new Date(skill.created_at).toLocaleDateString()}
                </span>
              )}
            </div>
          </div>
        </div>
      )
    }

    return elements
  }

  return (
    <Popover open={open && !disabled && !readOnly} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          ref={triggerRef}
          type="button"
          className="flex w-full items-center justify-between rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={disabled}
        >
          <span className="text-text-muted">
            {placeholder || t('skills.select_skill_to_add', 'Select skill to add')}
          </span>
          <ChevronDown className="h-4 w-4 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        className={cn('p-0 border border-border', 'overflow-hidden', 'flex flex-col')}
        style={{ width: triggerWidth > 0 ? triggerWidth : '100%' }}
        align="start"
        side="bottom"
        sideOffset={4}
      >
        {/* Search input */}
        <div className="border-b p-3 shrink-0">
          <Input
            placeholder={t('skillSelector.search_skills', 'Search skills...')}
            value={searchQuery}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSearchQuery(e.target.value)}
          />
        </div>

        {/* Skills list - scrollable */}
        <div
          ref={listRef}
          className="max-h-[350px] overflow-y-auto overflow-x-hidden"
          onWheel={handleWheel}
          style={{
            maxHeight: '350px',
            overscrollBehavior: 'contain',
          }}
        >
          {renderSkillsList()}
        </div>
      </PopoverContent>
    </Popover>
  )
}
