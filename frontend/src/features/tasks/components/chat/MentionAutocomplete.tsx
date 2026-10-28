// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useCallback, useEffect, useRef, useState, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { MessageSquareText } from 'lucide-react'
import { taskApis } from '@/apis/tasks'
import { useTranslation } from '@/hooks/useTranslation'
import type { Task, Team } from '@/types/api'
import { TeamIconDisplay } from '@/features/settings/components/teams/TeamIconDisplay'
import { formatRelativeTime } from '@/utils/dateTime'

interface MentionableAgent {
  id: number
  name: string
  type: 'team' | 'bot'
  iconId?: string | null
}

type MentionRow = { kind: 'task'; task: Task } | { kind: 'agent'; agent: MentionableAgent }

export interface MentionMenuAnchor {
  /** Viewport-space top edge of the composer cursor. */
  top: number
  /** Viewport-space bottom edge of the composer cursor. */
  bottom: number
  /** Viewport-space left edge of the composer cursor. */
  left: number
  /** Preferred side; the menu still flips when that side lacks room. */
  direction?: 'above' | 'below'
}

interface MentionAutocompleteProps {
  team: Team | null
  query?: string
  tasks?: Task[]
  currentTaskId?: number | null
  showTeamMention?: boolean
  enableTaskMentions?: boolean
  onOpen?: () => void
  onSelect: (mention: string) => void
  onSelectTask?: (task: Task) => void
  onClose: () => void
  position: MentionMenuAnchor
}

const MENU_GAP = 8
const MENU_MARGIN = 8
const MENU_MAX_WIDTH = 380
const MENU_MIN_WIDTH = 200
const MENU_MAX_HEIGHT = 480
const MENU_MIN_HEIGHT = 160

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

export function buildTaskMentionCandidates(
  tasks: Task[],
  query: string,
  currentTaskId?: number | null
): Task[] {
  const normalizedQuery = query.trim().toLowerCase()
  const deduped = new Map<number, Task>()
  for (const task of tasks) {
    if (task.id === currentTaskId) continue
    const title = task.title || ''
    const prompt = task.prompt || ''
    if (
      normalizedQuery &&
      !title.toLowerCase().includes(normalizedQuery) &&
      !prompt.toLowerCase().includes(normalizedQuery)
    ) {
      continue
    }
    deduped.set(task.id, task)
  }
  return Array.from(deduped.values()).sort((left, right) => {
    const updatedDelta =
      timestamp(right.updated_at || right.created_at) -
      timestamp(left.updated_at || left.created_at)
    return updatedDelta || right.id - left.id
  })
}

function timestamp(value?: string | null): number {
  if (!value) return 0
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? 0 : parsed
}

export function taskMentionName(task: Task): string {
  return task.title?.trim() || (task.prompt ?? '').slice(0, 100) || String(task.id)
}

export default function MentionAutocomplete({
  team,
  query = '',
  tasks = [],
  currentTaskId,
  showTeamMention = false,
  enableTaskMentions = false,
  onOpen,
  onSelect,
  onSelectTask,
  onClose,
  position,
}: MentionAutocompleteProps) {
  const { t } = useTranslation()
  const menuRef = useRef<HTMLDivElement>(null)
  const onOpenRef = useRef(onOpen)
  onOpenRef.current = onOpen
  const [selectedIndex, setSelectedIndex] = useState(0)
  const selectedIndexRef = useRef(selectedIndex)
  selectedIndexRef.current = selectedIndex
  const [remoteTasks, setRemoteTasks] = useState<Task[]>([])
  const [isSearchingTasks, setIsSearchingTasks] = useState(false)
  const [viewport, setViewport] = useState(() =>
    typeof window === 'undefined'
      ? { width: 0, height: 0 }
      : { width: window.innerWidth, height: window.innerHeight }
  )

  useEffect(() => {
    const updateViewport = () =>
      setViewport({ width: window.innerWidth, height: window.innerHeight })
    updateViewport()
    window.addEventListener('resize', updateViewport)
    return () => window.removeEventListener('resize', updateViewport)
  }, [])

  useEffect(() => {
    if (enableTaskMentions) {
      onOpenRef.current?.()
    }
  }, [enableTaskMentions])

  useEffect(() => {
    const normalizedQuery = query.trim()
    if (!enableTaskMentions || !normalizedQuery) {
      setRemoteTasks([])
      setIsSearchingTasks(false)
      return
    }

    let cancelled = false
    setIsSearchingTasks(true)
    const timer = window.setTimeout(() => {
      void taskApis
        .searchTasks(normalizedQuery, { limit: 20 })
        .then(result => {
          if (!cancelled) setRemoteTasks(result.items || [])
        })
        .catch(() => {
          if (!cancelled) setRemoteTasks([])
        })
        .finally(() => {
          if (!cancelled) setIsSearchingTasks(false)
        })
    }, 180)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [enableTaskMentions, query])

  const mentionableAgents = useMemo<MentionableAgent[]>(() => {
    if (!team) return []
    return [{ id: team.id, name: team.name, type: 'team', iconId: team.icon }]
  }, [team])

  const filteredAgents = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()
    if (!normalizedQuery) return mentionableAgents
    return mentionableAgents.filter(agent => agent.name.toLowerCase().includes(normalizedQuery))
  }, [mentionableAgents, query])

  const taskCandidates = useMemo(
    () => buildTaskMentionCandidates([...tasks, ...remoteTasks], query, currentTaskId).slice(0, 20),
    [currentTaskId, query, remoteTasks, tasks]
  )

  const rows = useMemo<MentionRow[]>(() => {
    const nextRows: MentionRow[] = []
    if (showTeamMention) {
      nextRows.push(...filteredAgents.map(agent => ({ kind: 'agent' as const, agent })))
    }
    nextRows.push(...taskCandidates.map(task => ({ kind: 'task' as const, task })))
    return nextRows
  }, [filteredAgents, showTeamMention, taskCandidates])

  useEffect(() => {
    setSelectedIndex(0)
  }, [rows])

  useEffect(() => {
    const selected = menuRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')
    if (typeof selected?.scrollIntoView === 'function') {
      selected.scrollIntoView({ block: 'nearest' })
    }
  }, [selectedIndex])

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
    (row: MentionRow) => {
      if (row.kind === 'task') {
        if (!onSelectTask) return
        onSelectTask(row.task)
      } else {
        onSelect(`@${row.agent.name}`)
      }
      onClose()
    },
    [onClose, onSelect, onSelectTask]
  )

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) return
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onClose()
      } else if (event.key === 'ArrowDown') {
        event.preventDefault()
        event.stopPropagation()
        setSelectedIndex(prev => Math.min(prev + 1, Math.max(0, rows.length - 1)))
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        event.stopPropagation()
        setSelectedIndex(prev => Math.max(prev - 1, 0))
      } else if (event.key === 'Enter') {
        event.preventDefault()
        event.stopPropagation()
        const selected = rows[selectedIndexRef.current]
        if (selected) {
          handleSelect(selected)
        }
      }
    }

    document.addEventListener('keydown', handleKeyDown, true)
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true)
    }
  }, [handleSelect, onClose, rows])

  if (!team && !enableTaskMentions && taskCandidates.length === 0) {
    return null
  }

  const availableBelow = viewport.height - position.bottom - MENU_GAP - MENU_MARGIN
  const availableAbove = position.top - MENU_GAP - MENU_MARGIN
  let direction = position.direction ?? (availableBelow >= availableAbove ? 'below' : 'above')
  if (
    direction === 'below' &&
    availableBelow < MENU_MIN_HEIGHT &&
    availableAbove > availableBelow
  ) {
    direction = 'above'
  } else if (
    direction === 'above' &&
    availableAbove < MENU_MIN_HEIGHT &&
    availableBelow > availableAbove
  ) {
    direction = 'below'
  }
  const available = direction === 'below' ? availableBelow : availableAbove
  const maxViewportHeight = Math.max(80, viewport.height - MENU_MARGIN * 2)
  const maxHeight = clamp(available, Math.min(MENU_MIN_HEIGHT, maxViewportHeight), MENU_MAX_HEIGHT)
  const menuTop =
    direction === 'below' ? position.bottom + MENU_GAP : position.top - MENU_GAP - maxHeight
  const clampedTop = clamp(
    menuTop,
    MENU_MARGIN,
    Math.max(MENU_MARGIN, viewport.height - maxHeight - MENU_MARGIN)
  )
  const menuWidth = Math.min(
    MENU_MAX_WIDTH,
    Math.max(MENU_MIN_WIDTH, viewport.width - MENU_MARGIN * 2)
  )
  const menuLeft = clamp(
    position.left,
    MENU_MARGIN,
    Math.max(MENU_MARGIN, viewport.width - menuWidth - MENU_MARGIN)
  )

  let previousKind: MentionRow['kind'] | null = null
  const menu = (
    <div
      ref={menuRef}
      data-testid="mention-autocomplete"
      data-direction={direction}
      role="listbox"
      className="z-50 overflow-y-auto rounded-lg border border-border bg-surface py-1 shadow-lg"
      style={{
        position: 'fixed',
        top: `${clampedTop}px`,
        left: `${menuLeft}px`,
        width: `${menuWidth}px`,
        maxHeight,
      }}
    >
      {rows.map((row, index) => {
        const showSectionHeader = row.kind !== previousKind
        previousKind = row.kind
        const isSelected = index === selectedIndex
        if (row.kind === 'task') {
          const updatedAt = formatRelativeTime(row.task.updated_at || row.task.created_at, t)
          return (
            <React.Fragment key={`task:${row.task.id}`}>
              {showSectionHeader && (
                <div className="px-3 pb-1 pt-2 text-xs text-text-muted">
                  {t('chat:mention.taskSection')}
                </div>
              )}
              <button
                type="button"
                role="option"
                data-testid={`mention-task-option-${row.task.id}`}
                aria-selected={isSelected}
                className={`flex min-h-11 w-full items-center gap-2 px-3 py-2 text-left transition-colors md:min-h-0 ${
                  isSelected
                    ? 'bg-primary/10 text-primary ring-1 ring-inset ring-primary/30'
                    : 'hover:bg-muted'
                }`}
                onClick={() => handleSelect(row)}
                onMouseEnter={() => setSelectedIndex(index)}
              >
                <MessageSquareText className="h-4 w-4 flex-shrink-0 text-text-secondary" />
                <span className="min-w-0 flex-1">
                  <span
                    className={`block truncate text-sm font-medium ${
                      isSelected ? 'text-primary' : 'text-text-primary'
                    }`}
                  >
                    {taskMentionName(row.task)}
                  </span>
                  <span
                    className={`block truncate text-xs ${
                      isSelected ? 'text-primary/70' : 'text-text-muted'
                    }`}
                  >
                    {t('chat:mention.taskHint')}
                    {updatedAt ? ` · ${updatedAt}` : ''}
                  </span>
                </span>
              </button>
            </React.Fragment>
          )
        }

        return (
          <React.Fragment key={`agent:${row.agent.id}`}>
            {showSectionHeader && (
              <div className="px-3 pb-1 pt-2 text-xs text-text-muted">
                {t('chat:mention.agentSection')}
              </div>
            )}
            <button
              type="button"
              role="option"
              data-testid={`mention-agent-option-${row.agent.id}`}
              aria-selected={isSelected}
              className={`flex min-h-11 w-full items-center gap-2 px-3 py-2 text-left transition-colors md:min-h-0 ${
                isSelected
                  ? 'bg-primary/10 text-primary ring-1 ring-inset ring-primary/30'
                  : 'hover:bg-muted'
              }`}
              onClick={() => handleSelect(row)}
              onMouseEnter={() => setSelectedIndex(index)}
            >
              <TeamIconDisplay
                iconId={row.agent.iconId}
                size="sm"
                className="flex-shrink-0 text-text-secondary"
              />
              <span
                className={`min-w-0 flex-1 truncate text-sm font-medium ${
                  isSelected ? 'text-primary' : 'text-text-primary'
                }`}
              >
                {row.agent.name}
              </span>
            </button>
          </React.Fragment>
        )
      })}
      {rows.length === 0 && (
        <div className="px-3 py-2 text-sm text-text-muted">
          {isSearchingTasks ? t('chat:mention.searching') : t('chat:mention.noResults')}
        </div>
      )}
      <div className="mt-1 border-t border-border px-3 py-1 text-xs text-text-muted">
        {t('chat:groupChat.mentionAutocomplete.title')}
      </div>
    </div>
  )

  if (typeof document === 'undefined') return menu
  return createPortal(menu, document.body)
}
