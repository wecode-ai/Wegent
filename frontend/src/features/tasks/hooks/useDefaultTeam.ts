'use client'

import { useEffect, useState } from 'react'
import { teamApis } from '@/apis/team'
import { useUser } from '@/features/common/UserContext'
import type { Team, TaskType } from '@/types/api'

/** Resolve the default independently while the full catalog is loading. */
export function useDefaultTeam(mode: TaskType, enabled: boolean): Team | null {
  const { user } = useUser()
  const userId = user?.id
  const [result, setResult] = useState<{ key: string; team: Team | null } | null>(null)
  const key = `${userId}:${mode}`

  useEffect(() => {
    if (!enabled || userId === undefined || !['chat', 'code', 'knowledge', 'task'].includes(mode))
      return
    const controller = new AbortController()
    void teamApis
      .getDefaultTeam(mode as 'chat' | 'code' | 'knowledge' | 'task', controller.signal)
      .then(
        team => {
          if (!controller.signal.aborted) setResult({ key, team })
        },
        error => {
          if (!controller.signal.aborted) {
            setResult({ key, team: null })
            console.error('[useDefaultTeam] Failed to load default agent:', error)
          }
        }
      )
    return () => controller.abort()
  }, [mode, enabled, userId, key])

  return enabled && result?.key === key ? result.team : null
}
