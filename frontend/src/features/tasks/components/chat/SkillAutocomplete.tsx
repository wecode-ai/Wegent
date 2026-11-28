// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState, useMemo } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { Check, Zap, User, Users, Globe } from 'lucide-react'
import type { UnifiedSkill } from '@/apis/skills'
import { groupSkillsBySource, type SourceGroupedSkill } from '@/utils/skillGrouping'

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
  /** Whether an unmatched query displays the empty menu */
  showEmptyResults?: boolean
  /** Editor that opened the slash menu */
  editorRef?: React.RefObject<HTMLElement | null>
  editorViewportRef?: React.RefObject<HTMLElement | null>
  onVisibilityChange?: (visible: boolean) => void
  /** Already selected skill IDs */
  selectedSkillIds?: number[]
  /** Callback when a skill is selected */
  onSelect: (skill: UnifiedSkill) => void
  /** Callback when menu should close */
  onClose: () => void
  /** Live caret range in the editor */
  anchor: { getBoundingClientRect(): Pick<DOMRect, 'top' | 'bottom' | 'left'> }
  /** Whether this is a Chat Shell (affects filtering behavior) */
  isChatShell: boolean
  /** Ref to the skill button element for fly animation target */
  skillButtonRef?: React.RefObject<HTMLElement | null>
  /** Callback to trigger fly animation (animation is rendered in parent) */
  onTriggerFlyAnimation?: (data: SkillFlyAnimationTrigger) => void
}

interface GroupedSkill extends Omit<SourceGroupedSkill, 'group'> {
  group: SourceGroupedSkill['group'] | 'team'
}

const MENU_GAP = 8
const MENU_MARGIN = 8
const MENU_MAX_WIDTH = 400
const MENU_MAX_HEIGHT = 300

type CaretBounds = ReturnType<SkillAutocompleteProps['anchor']['getBoundingClientRect']>

function getMenuPlacement(
  caret: CaretBounds,
  menu: HTMLElement,
  editorViewport?: HTMLElement | null
) {
  const viewport = window.visualViewport
  const viewportTop = viewport?.offsetTop ?? 0
  const viewportLeft = viewport?.offsetLeft ?? 0
  const viewportHeight = viewport?.height ?? window.innerHeight
  const viewportWidth = viewport?.width ?? window.innerWidth
  const viewportBottom = viewportTop + viewportHeight
  const viewportRight = viewportLeft + viewportWidth
  const editorBounds = editorViewport?.getBoundingClientRect()
  const visibleTop = Math.max(viewportTop, editorBounds?.top ?? viewportTop)
  const visibleBottom = Math.min(viewportBottom, editorBounds?.bottom ?? viewportBottom)
  if (
    caret.bottom <= visibleTop ||
    caret.top >= visibleBottom ||
    caret.left < viewportLeft ||
    caret.left > viewportRight
  ) {
    return null
  }

  const aboveAnchor = caret.top - MENU_GAP
  const belowAnchor = caret.bottom + MENU_GAP
  const above = aboveAnchor - viewportTop - MENU_MARGIN
  const below = viewportBottom - MENU_MARGIN - belowAnchor
  const preferredBelow = caret.top < viewportTop + viewportHeight / 2
  const desiredHeight = Math.min(
    menu.scrollHeight + menu.offsetHeight - menu.clientHeight,
    MENU_MAX_HEIGHT
  )
  const preferredSpace = preferredBelow ? below : above
  const otherSpace = preferredBelow ? above : below
  const opensBelow =
    preferredSpace < desiredHeight && otherSpace > preferredSpace ? !preferredBelow : preferredBelow
  const width = Math.min(MENU_MAX_WIDTH, viewportWidth - MENU_MARGIN * 2)
  const maxHeight = Math.min(MENU_MAX_HEIGHT, opensBelow ? below : above)
  if (width <= 0 || maxHeight <= 0) return null

  return {
    top: opensBelow ? belowAnchor : aboveAnchor,
    left: Math.max(
      viewportLeft + MENU_MARGIN,
      Math.min(caret.left, viewportRight - width - MENU_MARGIN)
    ),
    width,
    maxHeight,
    transform: opensBelow ? undefined : 'translateY(-100%)',
  }
}

/**
 * SkillAutocomplete Component
 *
 * Displays a floating autocomplete menu for selecting skills when user types /.
 * Skills are grouped into:
 * 1. Team Skills - Skills configured for the current agent
 * 2. Personal Skills - Non-public skills without a group source
 * 3. Group Skills - Group-owned skills and personal skills shared through bindings
 *    - Group names are shown only for skills stored in a group namespace
 * 4. Public Skills - System-wide public skills (is_public=true)
 */
export default function SkillAutocomplete({
  skills,
  teamSkillNames,
  preloadedSkillNames,
  query = '',
  showEmptyResults = true,
  editorRef,
  editorViewportRef,
  onVisibilityChange,
  selectedSkillIds = [],
  onSelect,
  onClose,
  anchor,
  isChatShell,
  skillButtonRef,
  onTriggerFlyAnimation,
}: SkillAutocompleteProps) {
  const { t } = useTranslation('common')
  const menuRef = useRef<HTMLDivElement>(null)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [menuPositioned, setMenuPositioned] = useState(false)

  // Group and filter skills
  const groupedSkills = useMemo<GroupedSkill[]>(() => {
    // For Chat Shell, filter out preloaded skills (they're auto-injected)
    const filteredSkills = isChatShell
      ? skills.filter(skill => !preloadedSkillNames.includes(skill.name))
      : skills

    // Create a set of team skill names for fast lookup
    const teamSkillSet = new Set(teamSkillNames)

    const teamSkills: GroupedSkill[] = filteredSkills
      .filter(skill => teamSkillSet.has(skill.name))
      .map(skill => ({ skill, group: 'team' }))
    const otherSkills = filteredSkills.filter(skill => !teamSkillSet.has(skill.name))
    return [...teamSkills, ...groupSkillsBySource(otherSkills)]
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

  const hasResults = filteredSkills.length > 0
  const showMenu = showEmptyResults || hasResults
  const visible = showMenu && menuPositioned
  useLayoutEffect(() => {
    const menu = menuRef.current
    if (!menu) {
      setMenuPositioned(false)
      return
    }

    const editorViewport = editorViewportRef?.current
    let lastCaret = anchor.getBoundingClientRect()
    let frame = 0
    const positionMenu = (caret: CaretBounds) => {
      lastCaret = caret
      const placement = getMenuPlacement(caret, menu, editorViewport)
      if (placement) {
        // Geometry updates write to the menu only. React owns its visibility and rows.
        menu.style.top = `${placement.top}px`
        menu.style.left = `${placement.left}px`
        menu.style.width = `${placement.width}px`
        menu.style.maxHeight = `${placement.maxHeight}px`
        menu.style.transform = placement.transform ?? ''
      }
      setMenuPositioned(placement !== null)
    }
    const updatePlacement = () => positionMenu(anchor.getBoundingClientRect())
    const trackCaretPosition = () => {
      const caret = anchor.getBoundingClientRect()
      if (
        caret.top !== lastCaret.top ||
        caret.bottom !== lastCaret.bottom ||
        caret.left !== lastCaret.left
      ) {
        positionMenu(caret)
      }
      frame = window.requestAnimationFrame(trackCaretPosition)
    }
    const handleScroll = (event: Event) => {
      if (event.target !== menu) updatePlacement()
    }
    positionMenu(lastCaret)
    // A centered composer can move when nearby content changes size without scrolling or resizing.
    if (editorViewport) frame = window.requestAnimationFrame(trackCaretPosition)
    const observer =
      typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(updatePlacement)
    observer?.observe(menu)
    if (editorRef?.current) observer?.observe(editorRef.current)
    if (editorViewport) observer?.observe(editorViewport)
    const viewport = window.visualViewport
    viewport?.addEventListener('resize', updatePlacement)
    viewport?.addEventListener('scroll', updatePlacement)
    window.addEventListener('resize', updatePlacement)
    window.addEventListener('scroll', handleScroll, true)
    return () => {
      window.cancelAnimationFrame(frame)
      observer?.disconnect()
      viewport?.removeEventListener('resize', updatePlacement)
      viewport?.removeEventListener('scroll', updatePlacement)
      window.removeEventListener('resize', updatePlacement)
      window.removeEventListener('scroll', handleScroll, true)
    }
  }, [anchor, editorRef, editorViewportRef, filteredSkills, showMenu])

  useLayoutEffect(() => {
    onVisibilityChange?.(visible)
    return () => {
      if (visible) onVisibilityChange?.(false)
    }
  }, [onVisibilityChange, visible])

  useEffect(() => {
    const focused = document.activeElement
    const focusedIndex = menuRef.current?.contains(focused)
      ? focused?.getAttribute('data-skill-index')
      : null
    setSelectedIndex(Number(focusedIndex ?? 0))
  }, [filteredSkills])

  // Close on outside click or when keyboard focus leaves the autocomplete.
  useEffect(() => {
    const closeIfOutsideMenu = (event: Event) => {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target)) {
        onClose()
      }
    }
    const handleFocusOutside = (event: FocusEvent) => {
      const target = event.target
      if (target instanceof Node && !editorRef?.current?.contains(target)) {
        closeIfOutsideMenu(event)
      }
    }

    document.addEventListener('mousedown', closeIfOutsideMenu)
    document.addEventListener('focusin', handleFocusOutside)
    return () => {
      document.removeEventListener('mousedown', closeIfOutsideMenu)
      document.removeEventListener('focusin', handleFocusOutside)
    }
  }, [editorRef, onClose])

  const handleSelect = useCallback(
    (skill: UnifiedSkill, option?: HTMLElement | null) => {
      // Get start position from the clicked element or menu
      let startX = 0
      let startY = 0

      if (option) {
        const rect = option.getBoundingClientRect()
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
          skillName: skill.name,
          startPosition: { x: startX, y: startY },
          endPosition: { x: endX, y: endY },
        })
      }

      // Call onSelect and onClose immediately
      onSelect(skill)
      onClose()
    },
    [onSelect, onClose, skillButtonRef, onTriggerFlyAnimation]
  )

  // Handle keyboard navigation
  useEffect(() => {
    if (!visible) return

    const handleKeyDown = (event: KeyboardEvent) => {
      const menu = menuRef.current
      if (!menu || event.isComposing || event.keyCode === 229 || !(event.target instanceof Node))
        return

      const focusInMenu = menu.contains(event.target)
      if (!focusInMenu && !editorRef?.current?.contains(event.target)) return

      const getOption = (index: number) =>
        menuRef.current?.querySelector<HTMLButtonElement>(`[data-skill-index="${index}"]`)
      const selected = filteredSkills[selectedIndex]

      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onClose()
      } else if (
        filteredSkills.length > 0 &&
        (event.key === 'ArrowDown' || event.key === 'ArrowUp')
      ) {
        event.preventDefault()
        event.stopPropagation()

        const step = event.key === 'ArrowDown' ? 1 : -1
        const nextIndex = Math.min(Math.max(selectedIndex + step, 0), filteredSkills.length - 1)
        setSelectedIndex(nextIndex)
        const option = getOption(nextIndex)
        if (focusInMenu) {
          option?.focus()
        } else {
          option?.scrollIntoView?.({ block: 'nearest' })
        }
      } else if (
        event.key === 'Enter' &&
        !focusInMenu &&
        !event.shiftKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        selected
      ) {
        event.preventDefault()
        event.stopPropagation()
        handleSelect(selected.skill, getOption(selectedIndex))
      }
    }

    document.addEventListener('keydown', handleKeyDown, true) // Use capture phase
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true)
    }
  }, [onClose, filteredSkills, selectedIndex, handleSelect, editorRef, visible])

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

  if (!showMenu) return null

  // Group skills for rendering with section headers
  // For group skills, we need to track namespace changes to show group name
  let currentGroup: 'team' | 'personal' | 'group' | 'public' | null = null
  let currentNamespace: string | null = null
  const renderItems: React.ReactNode[] = []
  const selectedIds = new Set(selectedSkillIds)
  let itemIndex = 0

  for (const { skill, group, groupNamespace } of filteredSkills) {
    // Add section header when group changes
    // For 'group' type, also add header when namespace changes
    const needsHeader =
      group !== currentGroup || (group === 'group' && (groupNamespace || null) !== currentNamespace)

    if (needsHeader) {
      currentGroup = group
      if (group === 'group') {
        currentNamespace = groupNamespace || null
      }

      // For group skills, show the group name (namespace) in the header
      const headerText =
        group === 'group' && groupNamespace
          ? `${t('common:skillSelector.group_skills_section')} - ${groupNamespace}`
          : getSectionHeader(group)

      renderItems.push(
        <div
          key={group === 'group' ? `header-${group}-${groupNamespace || ''}` : `header-${group}`}
          className="px-3 py-1.5 text-xs text-text-muted font-medium flex items-center gap-1.5 border-t border-border first:border-t-0 mt-1 first:mt-0"
        >
          {getGroupIcon(group)}
          {headerText}
        </div>
      )
    }

    const isSelected = selectedIds.has(skill.id)
    const displayIndex = itemIndex
    itemIndex++

    renderItems.push(
      <button
        key={skill.id}
        type="button"
        data-testid="slash-skill-option"
        data-skill-index={displayIndex}
        aria-pressed={isSelected}
        className={`min-h-[44px] w-full px-3 py-2 text-left transition-colors flex items-center gap-2 cursor-pointer ${
          displayIndex === selectedIndex ? 'bg-muted' : 'hover:bg-muted'
        } ${isSelected ? 'opacity-60' : ''}`}
        onMouseDown={e => e.preventDefault()}
        onFocus={() => setSelectedIndex(displayIndex)}
        onClick={e => handleSelect(skill, e.currentTarget)}
      >
        <Zap className="h-4 w-4 flex-shrink-0 text-primary" />
        <span className="flex-1 min-w-0">
          <span className="flex items-center gap-2">
            <span className="text-sm font-medium truncate text-text-primary">
              {skill.displayName || skill.name}
            </span>
            {isSelected && <Check className="h-3.5 w-3.5 text-primary flex-shrink-0" />}
          </span>
          {skill.description && (
            <span className="block text-xs text-text-muted truncate">{skill.description}</span>
          )}
        </span>
      </button>
    )
  }

  return (
    <div
      ref={menuRef}
      data-testid="slash-skill-menu"
      className="fixed z-50 overflow-y-auto rounded-md border border-border bg-surface py-1 shadow-lg"
      style={{ visibility: visible ? undefined : 'hidden' }}
    >
      {hasResults ? (
        <>
          {renderItems}
          <div className="mt-1 border-t border-border px-3 py-1 text-xs text-text-muted">
            {t('common:skillSelector.skill_autocomplete_title')}
          </div>
        </>
      ) : (
        <div className="px-3 py-1 text-sm text-text-muted">
          {t('common:skillSelector.no_available_skills')}
        </div>
      )}
    </div>
  )
}
