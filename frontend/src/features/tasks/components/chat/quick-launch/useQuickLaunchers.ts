'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { userApis } from '@/apis/user'
import type { QuickLaunchInputPreset, QuickLaunchResponse, Team } from '@/types/api'
import { getBindModesTargetPage, type TeamModeFilter } from '../../selector/team-selector-utils'
import type { QuickInputPreset, QuickLauncher } from './types'

interface UseQuickLaunchersOptions {
  currentMode: TeamModeFilter
  defaultTeam?: Team | null
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

export function useQuickLaunchers({ currentMode, defaultTeam }: UseQuickLaunchersOptions) {
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

    return launchers
  }, [currentMode, data?.system_functions])

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
