import { useCallback, useEffect, useMemo, useState } from 'react'
import type { SkillRef, UnifiedSkill } from '@/types/api'

interface WorkbenchSkillApi {
  listSkills: () => Promise<UnifiedSkill[]>
}

interface UseWorkbenchSkillsOptions {
  api: WorkbenchSkillApi
  locked: boolean
  enabled?: boolean
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
  locked,
  enabled = true,
  scopeKey = DEFAULT_SKILL_SCOPE_KEY,
}: UseWorkbenchSkillsOptions) {
  const [skills, setSkills] = useState<UnifiedSkill[]>([])
  const [selectedSkillsByScope, setSelectedSkillsByScope] = useState<Record<string, SkillRef[]>>({})
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const selectedSkills = useMemo(
    () => selectedSkillsByScope[scopeKey] ?? [],
    [scopeKey, selectedSkillsByScope]
  )

  useEffect(() => {
    if (!enabled) return

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
  }, [api, enabled])

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

  const setSelectedSkillsForScope = useCallback(
    (targetScopeKey: string, nextSkills: SkillRef[]) => {
      setSelectedSkillsByScope(current => ({
        ...current,
        [targetScopeKey]: nextSkills,
      }))
    },
    []
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
    skills: enabled ? skills : [],
    selectedSkills,
    selectedSkillNames,
    setSelectedSkills,
    setSelectedSkillsForScope,
    toggleSkill,
    isLoading: enabled && isLoading,
    error: enabled ? error : null,
  }
}
