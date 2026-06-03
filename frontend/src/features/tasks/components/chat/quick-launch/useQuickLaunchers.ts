'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { userApis } from '@/apis/user'
import type { QuickLaunchResponse, TaskType, Team } from '@/types/api'
import { filterTeamsByMode } from '../../selector/team-selector-utils'
import type { QuickLauncher } from './types'

interface UseQuickLaunchersOptions {
  teams: Team[]
  currentMode: TaskType
  defaultTeam?: Team | null
}

function findTeam(teams: Team[], teamId: number) {
  return teams.find(team => team.id === teamId) || null
}

export function useQuickLaunchers({ teams, currentMode, defaultTeam }: UseQuickLaunchersOptions) {
  const [data, setData] = useState<QuickLaunchResponse | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  const fetchQuickLaunch = useCallback(async () => {
    try {
      setIsLoading(true)
      setData(await userApis.getQuickLaunch())
    } catch (error) {
      console.error('Failed to fetch quick launch:', error)
      setData({ system_functions: [], favorite_agents: [] })
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    void fetchQuickLaunch()
    window.addEventListener('quick-access-updated', fetchQuickLaunch)
    return () => window.removeEventListener('quick-access-updated', fetchQuickLaunch)
  }, [fetchQuickLaunch])

  const filteredTeams = useMemo(() => filterTeamsByMode(teams, currentMode), [teams, currentMode])

  const systemLaunchers = useMemo<QuickLauncher[]>(() => {
    const launchers: QuickLauncher[] = []

    for (const item of data?.system_functions ?? []) {
      const team = findTeam(filteredTeams, item.team_id)
      if (!team) continue

      launchers.push({
        key: `system:${item.id}`,
        type: 'system_function',
        title: item.title,
        description: item.description,
        icon: item.icon,
        team,
        quickPhrases: item.quick_phrases ?? [],
      })
    }

    return launchers
  }, [data?.system_functions, filteredTeams])

  const favoriteLaunchers = useMemo<QuickLauncher[]>(() => {
    const launchers: QuickLauncher[] = []

    for (const item of data?.favorite_agents ?? []) {
      const team = findTeam(filteredTeams, item.team_id)
      if (!team || defaultTeam?.id === team.id) continue

      launchers.push({
        key: `agent:${item.team_id}`,
        type: 'favorite_agent',
        title: item.title,
        description: item.description,
        icon: item.icon,
        team,
        quickPhrases: item.quick_phrases ?? team.quick_phrases ?? [],
      })
    }

    return launchers
  }, [data?.favorite_agents, defaultTeam?.id, filteredTeams])

  return {
    isLoading,
    refetch: fetchQuickLaunch,
    systemLaunchers,
    favoriteLaunchers,
  }
}
