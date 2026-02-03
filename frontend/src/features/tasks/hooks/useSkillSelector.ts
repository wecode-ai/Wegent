// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect, useMemo, useCallback } from 'react'
import { fetchUnifiedSkillsList, UnifiedSkill } from '@/apis/skills'
import { fetchTeamSkills, TeamSkillsResponse } from '@/apis/team'
import type { Team } from '@/types/api'
import { isChatShell } from '../service/messageService'

/**
 * Skill reference with full identification info for backend
 * Backend needs name + namespace + is_public to uniquely identify a skill
 */
export interface SkillRef {
  name: string
  namespace: string
  is_public: boolean
}

interface UseSkillSelectorOptions {
  /** Selected team for the current chat */
  team: Team | null
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
  /** Currently selected skills with full info (name, namespace, is_public) */
  selectedSkills: SkillRef[]
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
}: UseSkillSelectorOptions): UseSkillSelectorReturn {
  // State for available skills from unified API
  const [availableSkills, setAvailableSkills] = useState<UnifiedSkill[]>([])
  // State for team-specific skills (from backend)
  const [teamSkillsData, setTeamSkillsData] = useState<TeamSkillsResponse | null>(null)
  // User-selected skill names
  const [selectedSkillNames, setSelectedSkillNames] = useState<string[]>([])
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

  // Fetch team-specific skills when team ID changes
  useEffect(() => {
    if (!enabled || !team?.id) {
      setTeamSkillsData(null)
      return
    }

    const fetchTeamSkillsData = async () => {
      try {
        const skills = await fetchTeamSkills(team.id)
        setTeamSkillsData(skills)
      } catch (err) {
        console.warn('[useSkillSelector] Failed to fetch team skills:', err)
        // Don't set error for team skills - it's optional
      }
    }

    fetchTeamSkillsData()
  }, [enabled, team?.id])

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

  // Compute selected skills with full info (name, namespace, is_public)
  // by looking up each selected skill name in availableSkills
  const selectedSkills = useMemo<SkillRef[]>(() => {
    return selectedSkillNames.map(name => {
      const skill = availableSkills.find(s => s.name === name)
      if (skill) {
        return {
          name: skill.name,
          namespace: skill.namespace,
          is_public: skill.is_public,
        }
      }
      // If skill not found in availableSkills, return with default values
      // This shouldn't happen in normal usage, but provides a fallback
      return {
        name,
        namespace: 'default',
        is_public: false,
      }
    })
  }, [selectedSkillNames, availableSkills])

  return {
    availableSkills,
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
