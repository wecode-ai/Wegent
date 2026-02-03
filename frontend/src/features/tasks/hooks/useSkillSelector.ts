// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect, useMemo, useCallback } from 'react'
import { fetchUnifiedSkillsList, UnifiedSkill } from '@/apis/skills'
import { fetchTaskSkills, TaskSkillsResponse } from '@/apis/tasks'
import type { Team } from '@/types/api'
import { isChatShell } from '../service/messageService'

// Type for skill reference (can be string name or object with name)
type SkillRefLike = string | { name: string }

interface UseSkillSelectorOptions {
  /** Selected team for the current chat */
  team: Team | null
  /** Current task ID (if any) */
  taskId?: number
  /** Whether skills feature is enabled */
  enabled?: boolean
}

interface UseSkillSelectorReturn {
  /** All available skills (from unified API) */
  availableSkills: UnifiedSkill[]
  /** Team's configured skill names */
  teamSkillNames: string[]
  /** Team's preloaded skill names (auto-injected, to filter out for Chat Shell) */
  preloadedSkillNames: string[]
  /** Currently selected skill names */
  selectedSkillNames: string[]
  /** Add a skill to selection */
  addSkill: (skillName: string) => void
  /** Remove a skill from selection */
  removeSkill: (skillName: string) => void
  /** Toggle a skill (add if not selected, remove if selected) */
  toggleSkill: (skillName: string) => void
  /** Reset all selected skills */
  resetSkills: () => void
  /** Set selected skill names directly */
  setSelectedSkillNames: (skills: string[]) => void
  /** Whether the current team is a Chat Shell type */
  isChatShellType: boolean
  /** Loading state */
  isLoading: boolean
  /** Error state */
  error: Error | null
}

/**
 * Hook for managing skill selection in chat interface.
 *
 * Fetches available skills from the unified API and task-specific skills,
 * and manages the selection state for user-chosen skills.
 *
 * The hook handles different Shell types:
 * - Chat Shell: Uses preload_skill_names (prompts injected into system message)
 * - Other Shells (ClaudeCode, Agno): Uses additional_skill_names (downloaded to executor)
 */
export function useSkillSelector({
  team,
  taskId,
  enabled = true,
}: UseSkillSelectorOptions): UseSkillSelectorReturn {
  // State for available skills from unified API
  const [availableSkills, setAvailableSkills] = useState<UnifiedSkill[]>([])
  // State for task-specific skills (from backend)
  const [taskSkills, setTaskSkills] = useState<TaskSkillsResponse | null>(null)
  // User-selected skill names
  const [selectedSkillNames, setSelectedSkillNames] = useState<string[]>([])
  // Loading and error states
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)

  // Determine if current team is Chat Shell type
  const isChatShellType = useMemo(() => isChatShell(team), [team])

  // Team's configured skill names (from task skills or team config)
  const teamSkillNames = useMemo(() => {
    if (taskSkills?.skills) {
      return taskSkills.skills
    }
    // Fallback: extract from team's bots if available
    if (team?.bots) {
      const skillNames = new Set<string>()
      for (const botWrapper of team.bots) {
        // Skills may be directly on bot in summary format
        const skills = (botWrapper.bot as { skills?: SkillRefLike[] })?.skills
        if (skills) {
          skills.forEach((skill: SkillRefLike) => {
            if (typeof skill === 'string') {
              skillNames.add(skill)
            } else if (skill.name) {
              skillNames.add(skill.name)
            }
          })
        }
      }
      return Array.from(skillNames)
    }
    return []
  }, [taskSkills, team])

  // Team's preloaded skill names (auto-injected into system prompt)
  const preloadedSkillNames = useMemo(() => {
    if (taskSkills?.preload_skills) {
      return taskSkills.preload_skills
    }
    // Fallback: extract from team's bots preloadSkills
    if (team?.bots) {
      const preloadNames = new Set<string>()
      for (const botWrapper of team.bots) {
        // PreloadSkills may be directly on bot in summary format
        const preloadSkills = (botWrapper.bot as { preloadSkills?: SkillRefLike[] })?.preloadSkills
        if (preloadSkills) {
          preloadSkills.forEach((skill: SkillRefLike) => {
            if (typeof skill === 'string') {
              preloadNames.add(skill)
            } else if (skill.name) {
              preloadNames.add(skill.name)
            }
          })
        }
      }
      return Array.from(preloadNames)
    }
    return []
  }, [taskSkills, team])

  // Fetch available skills when enabled
  useEffect(() => {
    if (!enabled) {
      setAvailableSkills([])
      return
    }

    const fetchSkills = async () => {
      setIsLoading(true)
      setError(null)
      try {
        const skills = await fetchUnifiedSkillsList({ scope: 'all' })
        setAvailableSkills(skills)
      } catch (err) {
        console.error('[useSkillSelector] Failed to fetch skills:', err)
        setError(err instanceof Error ? err : new Error('Failed to fetch skills'))
      } finally {
        setIsLoading(false)
      }
    }

    fetchSkills()
  }, [enabled])

  // Fetch task-specific skills when task ID changes
  useEffect(() => {
    if (!enabled || !taskId) {
      setTaskSkills(null)
      return
    }

    const fetchTaskSkillsData = async () => {
      try {
        const skills = await fetchTaskSkills(taskId)
        setTaskSkills(skills)
      } catch (err) {
        console.warn('[useSkillSelector] Failed to fetch task skills:', err)
        // Don't set error for task skills - it's optional
      }
    }

    fetchTaskSkillsData()
  }, [enabled, taskId])

  // Reset selected skills when team changes
  useEffect(() => {
    setSelectedSkillNames([])
  }, [team?.id])

  // Skill management callbacks
  const addSkill = useCallback((skillName: string) => {
    setSelectedSkillNames(prev => {
      if (prev.includes(skillName)) return prev
      return [...prev, skillName]
    })
  }, [])

  const removeSkill = useCallback((skillName: string) => {
    setSelectedSkillNames(prev => prev.filter(name => name !== skillName))
  }, [])

  const toggleSkill = useCallback((skillName: string) => {
    setSelectedSkillNames(prev => {
      if (prev.includes(skillName)) {
        return prev.filter(name => name !== skillName)
      }
      return [...prev, skillName]
    })
  }, [])

  const resetSkills = useCallback(() => {
    setSelectedSkillNames([])
  }, [])

  return {
    availableSkills,
    teamSkillNames,
    preloadedSkillNames,
    selectedSkillNames,
    addSkill,
    removeSkill,
    toggleSkill,
    resetSkills,
    setSelectedSkillNames,
    isChatShellType,
    isLoading,
    error,
  }
}

export type { UseSkillSelectorReturn }
