'use client'

import { useEffect, useState } from 'react'
import { teamApis } from '@/apis/team'
import { useUser } from '@/features/common/UserContext'
import type { Team } from '@/types/api'

/** Resolve an explicit URL selection independently of a changing paginated catalog. */
export function useRequestedTeam(teamId: string | null, enabled: boolean): Team | null {
  const { user } = useUser()
  const userId = user?.id
  const id = Number(teamId)
  const key = `${userId}:${id}`
  const [result, setResult] = useState<{ key: string; team: Team } | null>(null)

  useEffect(() => {
    if (!enabled || userId === undefined || !Number.isSafeInteger(id) || id <= 0) return
    let active = true
    void teamApis.getTeam(id).then(
      team => {
        if (active) setResult({ key, team })
      },
      error => {
        if (active) console.error('[useRequestedTeam] Failed to load requested agent:', error)
      }
    )
    return () => {
      active = false
    }
  }, [enabled, userId, id, key])

  return enabled && result?.key === key ? result.team : null
}
