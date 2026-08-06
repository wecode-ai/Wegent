// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { userApis } from '@/apis/user'
import type { TeamModeFilter } from './team-selector-utils'

export function useRecentTeams(currentMode: TeamModeFilter = 'chat') {
  const [recentTeamIds, setRecentTeamIds] = useState<number[]>([])
  const isMountedRef = useRef(false)

  const refreshRecentTeams = useCallback(async () => {
    try {
      const teams = await userApis.getRecentTeams(currentMode === 'code')
      if (isMountedRef.current) {
        setRecentTeamIds(teams.map(team => team.id))
      }
    } catch (error) {
      console.error('Failed to load recent teams:', error)
    }
  }, [currentMode])

  useEffect(() => {
    isMountedRef.current = true
    void refreshRecentTeams()
    return () => {
      isMountedRef.current = false
    }
  }, [refreshRecentTeams])

  return { recentTeamIds, refreshRecentTeams }
}
