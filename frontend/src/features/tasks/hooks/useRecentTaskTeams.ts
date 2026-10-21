'use client'

import { useEffect, useState } from 'react'
import { userApis } from '@/apis/user'
import { useUser } from '@/features/common/UserContext'
import type { TaskType } from '@/types/api'

const EMPTY_RECENT_TEAM_IDS: number[] = []

/** Resolve task history independently from selector recommendations. */
export function useRecentTaskTeams(
  mode: TaskType,
  enabled: boolean
): { recentTeamIds: number[]; isLoading: boolean } {
  const { user } = useUser()
  const userId = user?.id
  const key = `${userId}:${mode}`
  const [result, setResult] = useState<{ key: string; recentTeamIds: number[] } | null>(null)

  useEffect(() => {
    setResult(null)
    if (!enabled || userId === undefined) return

    const controller = new AbortController()
    void userApis
      .getRecentTeams(mode === 'code', {
        includeFallback: false,
        mode,
        signal: controller.signal,
      })
      .then(
        teams => {
          if (!controller.signal.aborted) {
            setResult({ key, recentTeamIds: teams.map(team => team.id) })
          }
        },
        error => {
          if (!controller.signal.aborted) {
            setResult({ key, recentTeamIds: [] })
            console.error('[useRecentTaskTeams] Failed to load recent agents:', error)
          }
        }
      )
    return () => controller.abort()
  }, [enabled, key, mode, userId])

  const currentResult = enabled && result?.key === key ? result : null
  return {
    recentTeamIds: currentResult?.recentTeamIds ?? EMPTY_RECENT_TEAM_IDS,
    isLoading: enabled && currentResult === null,
  }
}
