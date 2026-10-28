'use client'

import { useEffect, useState } from 'react'
import { teamApis } from '@/apis/team'
import { useUser } from '@/features/common/UserContext'
import type { Team } from '@/types/api'

/** Resolve explicit navigation by identity, not by a changing paginated catalog. */
export function useUrlTeam(id: string | null, enabled: boolean): Team | null {
  const { user } = useUser()
  const userId = user?.id
  const teamId = id ? Number(id) : NaN
  const key = `${userId}:${teamId}`
  const [result, setResult] = useState<{ key: string; team: Team | null } | null>(null)

  useEffect(() => {
    if (!enabled || userId === undefined || !Number.isSafeInteger(teamId) || teamId <= 0) return
    const controller = new AbortController()
    void teamApis.getTeam(teamId, controller.signal).then(
      team => {
        if (!controller.signal.aborted) setResult({ key, team })
      },
      error => {
        if (!controller.signal.aborted) {
          setResult({ key, team: null })
          console.error('[useUrlTeam] Failed to load requested agent:', error)
        }
      }
    )
    return () => controller.abort()
  }, [enabled, userId, teamId, key])

  return enabled && result?.key === key ? result.team : null
}
