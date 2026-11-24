'use client'

import { useCallback, useEffect, useState } from 'react'
import { teamApis } from '@/apis/team'
import { useUser } from '@/features/common/UserContext'
import type { Team } from '@/types/api'

/** Resolve explicit navigation by identity, not by a changing paginated catalog. */
export function useUrlTeam(id: string | null, enabled: boolean) {
  const { user } = useUser()
  const userId = user?.id
  const teamId = id ? Number(id) : NaN
  const isValidTeamId = Number.isSafeInteger(teamId) && teamId > 0
  const [attempt, setAttempt] = useState(0)
  const retry = useCallback(() => setAttempt(previous => previous + 1), [])
  const key = `${enabled}:${userId}:${teamId}:${attempt}`
  const [result, setResult] = useState<{ key: string; team: Team | null } | null>(null)

  if (result && result.key !== key) setResult(null)

  useEffect(() => {
    if (!enabled || userId === undefined || !isValidTeamId) return
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
  }, [enabled, userId, teamId, key, isValidTeamId])

  if (!enabled || id === null) return { team: null, failed: false, retry: null }
  if (!isValidTeamId) return { team: null, failed: true, retry: null }
  if (result?.key !== key) return { team: null, failed: false, retry: null }
  return { team: result.team, failed: result.team === null, retry: result.team ? null : retry }
}
