// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  fetchUnifiedSkillsList,
  fetchTaskSkills,
  UnifiedSkill,
  TaskSkillsResponse,
} from '@/apis/skills'

interface UseSkillSelectorOptions {
  /** Task ID for fetching task-configured skills */
  taskId?: number | null
  /** Whether to fetch skills data */
  enabled?: boolean
}

interface UseSkillSelectorReturn {
  /** All available skills */
  skills: UnifiedSkill[]
  /** Skills configured for the team (from task) */
  teamSkillNames: string[]
  /** Preloaded skills configured for the team */
  preloadedSkillNames: string[]
  /** Selected skill names (user selection) */
  selectedSkillNames: string[]
  /** Set selected skill names */
  setSelectedSkillNames: (names: string[]) => void
  /** Add a skill to selection */
  addSkill: (skillName: string) => void
  /** Remove a skill from selection */
  removeSkill: (skillName: string) => void
  /** Toggle a skill selection */
  toggleSkill: (skillName: string) => void
  /** Clear all selected skills */
  clearSkills: () => void
  /** Loading state */
  isLoading: boolean
  /** Error state */
  error: string | null
  /** Refresh skills data */
  refresh: () => Promise<void>
}

/**
 * Hook to manage skill selection for chat input
 */
export function useSkillSelector({
  taskId,
  enabled = true,
}: UseSkillSelectorOptions = {}): UseSkillSelectorReturn {
  const [skills, setSkills] = useState<UnifiedSkill[]>([])
  const [taskSkillsData, setTaskSkillsData] = useState<TaskSkillsResponse | null>(null)
  const [selectedSkillNames, setSelectedSkillNames] = useState<string[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Fetch unified skills list
  const fetchSkills = useCallback(async () => {
    if (!enabled) return

    setIsLoading(true)
    setError(null)

    try {
      const data = await fetchUnifiedSkillsList()
      setSkills(data)
    } catch (err) {
      console.error('Failed to fetch skills:', err)
      setError(err instanceof Error ? err.message : 'Failed to fetch skills')
    } finally {
      setIsLoading(false)
    }
  }, [enabled])

  // Fetch task skills if taskId is provided
  const fetchTaskSkillsData = useCallback(async () => {
    if (!taskId || taskId <= 0) {
      setTaskSkillsData(null)
      return
    }

    try {
      const data = await fetchTaskSkills(taskId)
      setTaskSkillsData(data)
    } catch (err) {
      console.error('Failed to fetch task skills:', err)
      // Don't set error for task skills - it's not critical
      setTaskSkillsData(null)
    }
  }, [taskId])

  // Initial fetch
  useEffect(() => {
    fetchSkills()
  }, [fetchSkills])

  // Fetch task skills when taskId changes
  useEffect(() => {
    fetchTaskSkillsData()
  }, [fetchTaskSkillsData])

  // Reset selection when task changes
  useEffect(() => {
    setSelectedSkillNames([])
  }, [taskId])

  // Extract team skill names from task data
  const teamSkillNames = useMemo(() => {
    return taskSkillsData?.skills || []
  }, [taskSkillsData])

  // Extract preloaded skill names from task data
  const preloadedSkillNames = useMemo(() => {
    return taskSkillsData?.preload_skills || []
  }, [taskSkillsData])

  // Add skill to selection
  const addSkill = useCallback((skillName: string) => {
    setSelectedSkillNames(prev => {
      if (prev.includes(skillName)) return prev
      return [...prev, skillName]
    })
  }, [])

  // Remove skill from selection
  const removeSkill = useCallback((skillName: string) => {
    setSelectedSkillNames(prev => prev.filter(name => name !== skillName))
  }, [])

  // Toggle skill selection
  const toggleSkill = useCallback((skillName: string) => {
    setSelectedSkillNames(prev => {
      if (prev.includes(skillName)) {
        return prev.filter(name => name !== skillName)
      }
      return [...prev, skillName]
    })
  }, [])

  // Clear all selections
  const clearSkills = useCallback(() => {
    setSelectedSkillNames([])
  }, [])

  // Refresh all data
  const refresh = useCallback(async () => {
    await Promise.all([fetchSkills(), fetchTaskSkillsData()])
  }, [fetchSkills, fetchTaskSkillsData])

  return {
    skills,
    teamSkillNames,
    preloadedSkillNames,
    selectedSkillNames,
    setSelectedSkillNames,
    addSkill,
    removeSkill,
    toggleSkill,
    clearSkills,
    isLoading,
    error,
    refresh,
  }
}

export default useSkillSelector
