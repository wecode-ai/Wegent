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
    return (data?.system_functions ?? [])
      .map(item => {
        const team = findTeam(filteredTeams, item.team_id)
        if (!team) return null

        return {
          key: `system:${item.id}`,
          type: 'system_function' as const,
          title: item.title,
          description: item.description,
          icon: item.icon,
          team,
          quickPhrases: item.quick_phrases ?? [],
        }
      })
      .filter((item): item is QuickLauncher => item !== null)
  }, [data?.system_functions, filteredTeams])

  const favoriteLaunchers = useMemo<QuickLauncher[]>(() => {
    return (data?.favorite_agents ?? [])
      .map(item => {
        const team = findTeam(filteredTeams, item.team_id)
        if (!team || defaultTeam?.id === team.id) return null

        return {
          key: `agent:${item.team_id}`,
          type: 'favorite_agent' as const,
          title: item.title,
          description: item.description,
          icon: item.icon,
          team,
          quickPhrases: item.quick_phrases ?? team.quick_phrases ?? [],
        }
      })
      .filter((item): item is QuickLauncher => item !== null)
  }, [data?.favorite_agents, defaultTeam?.id, filteredTeams])

  return {
    isLoading,
    refetch: fetchQuickLaunch,
    systemLaunchers,
    favoriteLaunchers,
  }
}
