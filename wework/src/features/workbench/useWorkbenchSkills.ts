import { useCallback, useEffect, useMemo, useState } from 'react'
import type { SkillRef, UnifiedSkill } from '@/types/api'
import type { TeamSkillsResponse } from '@/api/skills'

interface WorkbenchSkillApi {
  listSkills: () => Promise<UnifiedSkill[]>
  getTeamSkills: (teamId: number) => Promise<TeamSkillsResponse>
}

interface UseWorkbenchSkillsOptions {
  api: WorkbenchSkillApi
  teamId?: number | null
  locked: boolean
  scopeKey?: string
}

const DEFAULT_SKILL_SCOPE_KEY = 'default'

function isSameSkill(left: SkillRef, right: SkillRef): boolean {
  return (
    left.name === right.name &&
    left.namespace === right.namespace &&
    left.is_public === right.is_public
  )
}

export function useWorkbenchSkills({
  api,
  teamId,
  locked,
  scopeKey = DEFAULT_SKILL_SCOPE_KEY,
}: UseWorkbenchSkillsOptions) {
  const [skills, setSkills] = useState<UnifiedSkill[]>([])
  const [teamSkillNames, setTeamSkillNames] = useState<string[]>([])
  const [preloadedSkillNames, setPreloadedSkillNames] = useState<string[]>([])
  const [selectedSkillsByScope, setSelectedSkillsByScope] = useState<Record<string, SkillRef[]>>({})
  const [isLoading, setIsLoading] = useState(false)
  const [isTeamSkillsLoading, setIsTeamSkillsLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const selectedSkills = useMemo(
    () => selectedSkillsByScope[scopeKey] ?? [],
    [scopeKey, selectedSkillsByScope]
  )

  useEffect(() => {
    let cancelled = false

    async function loadSkills() {
      setIsLoading(true)
      setError(null)
      try {
        const response = await api.listSkills()
        if (!cancelled) {
          setSkills(response.filter(skill => skill.visible !== false))
        }
      } catch (nextError) {
        if (!cancelled) {
          setError(nextError instanceof Error ? nextError : new Error('Failed to load skills'))
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false)
        }
      }
    }

    loadSkills()
    return () => {
      cancelled = true
    }
  }, [api])

  useEffect(() => {
    let cancelled = false

    async function loadTeamSkills() {
      if (!teamId) {
        setTeamSkillNames([])
        setPreloadedSkillNames([])
        setIsTeamSkillsLoading(false)
        return
      }

      setIsTeamSkillsLoading(true)
      try {
        const response = await api.getTeamSkills(teamId)
        if (!cancelled) {
          setTeamSkillNames(response.skills)
          setPreloadedSkillNames(response.preload_skills)
        }
      } catch {
        if (!cancelled) {
          setTeamSkillNames([])
          setPreloadedSkillNames([])
        }
      } finally {
        if (!cancelled) {
          setIsTeamSkillsLoading(false)
        }
      }
    }

    loadTeamSkills()
    return () => {
      cancelled = true
    }
  }, [api, teamId])

  const selectedSkillNames = useMemo(
    () => selectedSkills.map(skill => skill.name),
    [selectedSkills]
  )

  const setSelectedSkills = useCallback(
    (nextSkills: SkillRef[]) => {
      if (locked) return
      setSelectedSkillsByScope(current => ({
        ...current,
        [scopeKey]: nextSkills,
      }))
    },
    [locked, scopeKey]
  )

  const toggleSkill = useCallback(
    (skill: SkillRef) => {
      if (locked) return
      setSelectedSkillsByScope(currentByScope => {
        const current = currentByScope[scopeKey] ?? []
        if (current.some(item => isSameSkill(item, skill))) {
          return {
            ...currentByScope,
            [scopeKey]: current.filter(item => !isSameSkill(item, skill)),
          }
        }
        return {
          ...currentByScope,
          [scopeKey]: [...current, skill],
        }
      })
    },
    [locked, scopeKey]
  )

  return {
    skills,
    teamSkillNames,
    preloadedSkillNames,
    selectedSkills,
    selectedSkillNames,
    setSelectedSkills,
    toggleSkill,
    isLoading: isLoading || isTeamSkillsLoading,
    error,
  }
}
