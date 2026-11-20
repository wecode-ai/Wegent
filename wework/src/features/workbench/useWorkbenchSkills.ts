import { useCallback, useMemo, useState, useSyncExternalStore } from 'react'
import {
  createAsyncResource,
  getIdleResourceSnapshot,
  subscribeIdleResource,
} from '@wegent/chat-core/async-resource'
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
const EMPTY_SKILLS: UnifiedSkill[] = []
const EMPTY_SELECTED_SKILLS: SkillRef[] = []
Object.freeze(EMPTY_SKILLS)
Object.freeze(EMPTY_SELECTED_SKILLS)

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
  const catalog = useMemo(
    () =>
      createAsyncResource(
        'workbench-skills',
        async () => {
          try {
            return (await api.listSkills()).filter(skill => skill.visible !== false)
          } catch (cause) {
            throw cause instanceof Error ? cause : new Error('Failed to load skills')
          }
        },
        { refreshOnSubscribe: true }
      ),
    [api]
  )
  const query = useSyncExternalStore(
    enabled ? catalog.subscribe : subscribeIdleResource,
    catalog.getSnapshot,
    getIdleResourceSnapshot
  )
  const [selectedSkillsByScope, setSelectedSkillsByScope] = useState<Record<string, SkillRef[]>>({})
  const selectedSkills = selectedSkillsByScope[scopeKey] ?? EMPTY_SELECTED_SKILLS

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
    skills: enabled ? (query.data ?? EMPTY_SKILLS) : EMPTY_SKILLS,
    selectedSkills,
    selectedSkillNames,
    setSelectedSkills,
    setSelectedSkillsForScope,
    toggleSkill,
    isLoading: enabled && (query.status === 'idle' || query.status === 'loading'),
    error: enabled && query.status === 'error' ? (query.error as Error) : null,
  }
}
