'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { userApis } from '@/apis/user'
import type { QuickLaunchInputPreset, QuickLaunchResponse, Team } from '@/types/api'
import {
  getBindModesTargetPage,
  getTeamDisplayName,
  type TeamModeFilter,
} from '../../selector/team-selector-utils'
import type { QuickInputPreset, QuickLauncher } from './types'

interface UseQuickLaunchersOptions {
  currentMode: TeamModeFilter
  defaultTeam?: Team | null
  recommendedTeam?: Team | null
}

function presetsFromPhrases(phrases: string[] | undefined): QuickInputPreset[] {
  return (phrases ?? [])
    .map(phrase => phrase.trim())
    .filter(Boolean)
    .map((phrase, index) => ({
      id: `preset_${index + 1}`,
      title: phrase,
      prompt: phrase,
    }))
}

function normalizeInputPresets(
  inputPresets: QuickLaunchInputPreset[] | undefined,
  fallbackPhrases?: string[]
): QuickInputPreset[] {
  if (inputPresets && inputPresets.length > 0) {
    return inputPresets.map(preset => ({
      id: preset.id,
      title: preset.title,
      prompt: preset.prompt,
      options: preset.options,
      source_attachment_ids: preset.source_attachment_ids,
    }))
  }

  return presetsFromPhrases(fallbackPhrases)
}

export function useQuickLaunchers({
  currentMode,
  defaultTeam,
  recommendedTeam,
}: UseQuickLaunchersOptions) {
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

  const systemLaunchers = useMemo<QuickLauncher[]>(() => {
    const launchers: QuickLauncher[] = []

    for (const item of data?.system_functions ?? []) {
      const team = { id: item.team_id, bind_mode: item.bind_mode }

      launchers.push({
        key: `system:${item.id}`,
        type: 'system_function',
        title: item.title,
        description: item.description,
        icon: item.icon,
        team,
        targetPage: getBindModesTargetPage(item.bind_mode, currentMode),
        inputPresets: normalizeInputPresets(item.input_presets),
      })
    }

    if (!recommendedTeam) return launchers

    const recommendedLauncher = launchers.find(
      launcher => launcher.team.id === recommendedTeam.id
    ) ?? {
      key: `linked-agent:${recommendedTeam.id}`,
      type: 'system_function',
      title: getTeamDisplayName(recommendedTeam),
      description: recommendedTeam.description,
      icon: recommendedTeam.icon,
      team: recommendedTeam,
      targetPage: getBindModesTargetPage(recommendedTeam.bind_mode, currentMode),
      inputPresets: [],
    }
    return [recommendedLauncher, ...launchers.filter(launcher => launcher !== recommendedLauncher)]
  }, [currentMode, data?.system_functions, recommendedTeam])

  const favoriteLaunchers = useMemo<QuickLauncher[]>(() => {
    const launchers: QuickLauncher[] = []

    for (const item of data?.favorite_agents ?? []) {
      const team = { id: item.team_id, bind_mode: item.bind_mode }
      if (defaultTeam?.id === team.id) continue

      launchers.push({
        key: `agent:${item.team_id}`,
        type: 'favorite_agent',
        title: item.title,
        description: item.description,
        icon: item.icon,
        team,
        targetPage: getBindModesTargetPage(item.bind_mode, currentMode),
        inputPresets: normalizeInputPresets(item.input_presets, item.quick_phrases),
      })
    }

    return launchers
  }, [currentMode, data?.favorite_agents, defaultTeam?.id])

  return {
    isLoading,
    refetch: fetchQuickLaunch,
    systemLaunchers,
    favoriteLaunchers,
  }
}
