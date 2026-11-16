import { useCallback, useEffect, useRef, useState } from 'react'

import {
  fetchPublicSkillsList,
  fetchUnifiedSkillsList,
  type SkillBindingTarget,
  type UnifiedSkill,
} from '@/apis/skills'

/** Keep discovery scoped to the binding target, including overlapping refreshes. */
export function useBotSkillOptions(
  target: SkillBindingTarget,
  enabled: boolean,
  publicScope = false
) {
  const key = JSON.stringify([target, publicScope])
  const requestId = useRef(0)
  const [state, setState] = useState<{
    key: string
    skills: UnifiedSkill[]
    loading: boolean
    error: boolean
  }>({ key: '', skills: [], loading: false, error: false })

  const reload = useCallback(async () => {
    const id = ++requestId.current
    if (!enabled) return
    setState(previous => ({
      key,
      skills: previous.key === key ? previous.skills : [],
      loading: true,
      error: false,
    }))
    try {
      const [binding, isPublic] = JSON.parse(key) as [SkillBindingTarget, boolean]
      const skills = isPublic
        ? await fetchPublicSkillsList()
        : await fetchUnifiedSkillsList({ binding })
      if (id === requestId.current) setState({ key, skills, loading: false, error: false })
    } catch {
      if (id === requestId.current) {
        setState(previous => ({ ...previous, loading: false, error: true }))
      }
    }
  }, [enabled, key])

  useEffect(() => {
    void reload()
    return () => {
      requestId.current += 1
    }
  }, [reload])

  const current = enabled && state.key === key
  return {
    skills: current ? state.skills : [],
    loading: enabled && (!current || state.loading),
    error: current && state.error,
    reload,
  }
}
