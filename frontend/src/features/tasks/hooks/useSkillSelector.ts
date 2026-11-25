// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect, useMemo, useCallback } from 'react'
import { fetchUnifiedSkillsList, UnifiedSkill } from '@/apis/skills'
import { fetchTeamSkills, TeamSkillsResponse } from '@/apis/team'
import type { SkillRef, Team } from '@/types/api'
import { isChatShell } from '../service/messageService'
import { filterVisibleSkills } from '@/utils/skillVisibility'

export type { SkillRef } from '@/types/api'

const EMPTY_SKILL_REFS: SkillRef[] = []

type SkillSelection = SkillRef | string

function selectionName(selection: SkillSelection): string {
  return typeof selection === 'string' ? selection : selection.name
}

function sameSkillRefs(current: SkillRef[], previous: SkillRef[]): boolean {
  return (
    current === previous ||
    (current.length === previous.length &&
      current.every((skill, index) => {
        const old = previous[index]
        return (
          skill.name === old.name &&
          skill.namespace === old.namespace &&
          skill.is_public === old.is_public &&
          (skill.skill_id ?? null) === (old.skill_id ?? null)
        )
      }))
  )
}

export type AutoAvailableSkill = UnifiedSkill & {
  availabilitySources: Array<'agent_builtin' | 'my_default'>
}

interface UseSkillSelectorOptions {
  /** Selected team for the current chat */
  team: Team | null
  /** Whether skills feature is enabled */
  enabled?: boolean
  /** Task that owns the current selection, or undefined for a new draft */
  taskId?: number
  /** Initial selections restored from task metadata */
  initialSelectedSkills?: SkillRef[]
}

interface UseSkillSelectorReturn {
  /** All available skills (from unified API) */
  availableSkills: UnifiedSkill[]
  /** Skills that are automatically available from the agent or my defaults */
  autoAvailableSkills: AutoAvailableSkill[]
  /** Skills that can be selected for this message only */
  temporarySkills: UnifiedSkill[]
  /** Team's configured skill names */
  teamSkillNames: string[]
  /** Team's preloaded skill names (auto-injected, to filter out for Chat Shell) */
  preloadedSkillNames: string[]
  /** Currently selected skill names */
  selectedSkillNames: string[]
  /** Currently selected skills with full info (name, namespace, is_public) */
  selectedSkills: SkillRef[]
  /** Add a skill to selection */
  addSkill: (skill: UnifiedSkill) => void
  /** Remove a skill from selection */
  removeSkill: (skillName: string) => void
  /** Toggle a skill (add if not selected, remove if selected) */
  toggleSkill: (skill: UnifiedSkill) => void
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
 * Fetches available skills from the unified API and team-specific skills,
 * and manages the selection state for user-chosen skills.
 *
 * The hook handles different Shell types:
 * - Chat Shell: Uses preload_skill_names (prompts injected into system message)
 * - Other Shells (ClaudeCode, Agno): Uses additional_skill_names (downloaded to executor)
 */
export function useSkillSelector({
  team,
  enabled = true,
  taskId,
  initialSelectedSkills,
}: UseSkillSelectorOptions): UseSkillSelectorReturn {
  // State for available skills from unified API
  const [availableSkills, setAvailableSkills] = useState<UnifiedSkill[]>([])
  // State for team-specific skills (from backend)
  const [loadedTeamSkills, setLoadedTeamSkills] = useState<TeamSkillsResponse | null>(null)
  const teamSkillsData = enabled && loadedTeamSkills?.team_id === team?.id ? loadedTeamSkills : null

  const scope = taskId === undefined ? `draft:${team?.id ?? ''}` : `task:${taskId}`
  const initialRefs = initialSelectedSkills ?? EMPTY_SKILL_REFS
  const [restored, setRestored] = useState({ scope, refs: initialRefs })
  const [selectedRefs, setSelectedRefs] = useState<SkillSelection[]>(initialRefs)
  // A same-task refresh can return a new array while the user is editing the next message.
  if (
    restored.scope !== scope ||
    (initialSelectedSkills && !sameSkillRefs(initialRefs, restored.refs))
  ) {
    setRestored({ scope, refs: initialRefs })
    setSelectedRefs(initialRefs)
  }

  const selectedSkillNames = useMemo(() => selectedRefs.map(selectionName), [selectedRefs])
  const setSelectedSkillNames = useCallback((names: string[]) => {
    setSelectedRefs(names)
  }, [])
  // Loading and error states
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)

  // Determine if current team is Chat Shell type
  const isChatShellType = useMemo(() => isChatShell(team), [team])

  // Team's configured skill names (from team skills API)
  const teamSkillNames = useMemo(() => {
    if (teamSkillsData?.skills) {
      return teamSkillsData.skills
    }
    return []
  }, [teamSkillsData])

  // Team's preloaded skill names (auto-injected into system prompt)
  const preloadedSkillNames = useMemo(() => {
    if (teamSkillsData?.preload_skills) {
      return teamSkillsData.preload_skills
    }
    return []
  }, [teamSkillsData])

  const autoAvailableSkills = useMemo<AutoAvailableSkill[]>(() => {
    const teamSkillSet = new Set(teamSkillNames)
    const preloadedSkillSet = new Set(preloadedSkillNames)

    return availableSkills
      .map(skill => {
        const availabilitySources: Array<'agent_builtin' | 'my_default'> = []
        if (teamSkillSet.has(skill.name) || preloadedSkillSet.has(skill.name)) {
          availabilitySources.push('agent_builtin')
        }
        if (skill.availability?.inMyDefault) {
          availabilitySources.push('my_default')
        }
        return availabilitySources.length > 0
          ? {
              ...skill,
              availabilitySources,
            }
          : null
      })
      .filter((skill): skill is AutoAvailableSkill => skill !== null)
  }, [availableSkills, teamSkillNames, preloadedSkillNames])

  const autoAvailableSkillNames = useMemo(
    () => new Set(autoAvailableSkills.map(skill => skill.name)),
    [autoAvailableSkills]
  )

  const temporarySkills = useMemo(() => {
    return availableSkills.filter(skill => !autoAvailableSkillNames.has(skill.name))
  }, [availableSkills, autoAvailableSkillNames])

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
        setAvailableSkills(filterVisibleSkills(skills))
      } catch (err) {
        console.error('[useSkillSelector] Failed to fetch skills:', err)
        setError(err instanceof Error ? err : new Error('Failed to fetch skills'))
      } finally {
        setIsLoading(false)
      }
    }

    fetchSkills()
  }, [enabled])

  // Fetch team-specific skills when team ID changes
  useEffect(() => {
    if (!enabled || !team?.id) return

    let active = true
    const fetchTeamSkillsData = async () => {
      try {
        const skills = await fetchTeamSkills(team.id)
        if (active) setLoadedTeamSkills(skills)
      } catch (err) {
        if (active) console.warn('[useSkillSelector] Failed to fetch team skills:', err)
        // Don't set error for team skills - it's optional
      }
    }

    void fetchTeamSkillsData()
    return () => {
      active = false
    }
  }, [enabled, team?.id])

  const resolveSkill = useCallback(
    (skill: UnifiedSkill): SkillRef => ({
      skill_id: skill.id,
      name: skill.name,
      namespace: skill.namespace,
      is_public: skill.is_public,
    }),
    []
  )

  const resolveStoredSkill = useCallback(
    (selection: SkillSelection): SkillRef => {
      const name = selectionName(selection)
      if (typeof selection !== 'string' && selection.skill_id != null) return selection

      const matches = availableSkills.filter(
        item =>
          item.name === name &&
          (typeof selection === 'string' ||
            (item.namespace === selection.namespace && item.is_public === selection.is_public))
      )
      if (matches.length === 1) return resolveSkill(matches[0])
      return typeof selection === 'string'
        ? { name, namespace: 'default', is_public: false }
        : selection
    },
    [availableSkills, resolveSkill]
  )

  // The chat API and runtime resolve one requested skill per name.
  const addSkill = useCallback(
    (selection: UnifiedSkill) => {
      const skill = resolveSkill(selection)
      setSelectedRefs(prev => [...prev.filter(item => selectionName(item) !== skill.name), skill])
    },
    [resolveSkill]
  )

  const removeSkill = useCallback((skillName: string) => {
    setSelectedRefs(prev => prev.filter(skill => selectionName(skill) !== skillName))
  }, [])

  const toggleSkill = useCallback(
    (selection: UnifiedSkill) => {
      const skill = resolveSkill(selection)
      setSelectedRefs(prev => {
        const remaining = prev.filter(item => selectionName(item) !== skill.name)
        return prev.some(item => resolveStoredSkill(item).skill_id === skill.skill_id)
          ? remaining
          : [...remaining, skill]
      })
    },
    [resolveSkill, resolveStoredSkill]
  )

  const resetSkills = useCallback(() => {
    setSelectedRefs([])
  }, [])

  const selectedSkills = useMemo(
    () => selectedRefs.map(resolveStoredSkill),
    [selectedRefs, resolveStoredSkill]
  )

  return {
    availableSkills,
    autoAvailableSkills,
    temporarySkills,
    teamSkillNames,
    preloadedSkillNames,
    selectedSkillNames,
    selectedSkills,
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
