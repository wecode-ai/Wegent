import type { TeamTargetPage } from '../../selector/team-selector-utils'
import type { QuickLauncher } from './types'
import { buildChatCodeHref } from '@/config/coding-route'

export const QUICK_LAUNCH_QUERY = {
  teamId: 'teamId',
  launcher: 'quickLauncher',
  preset: 'quickPreset',
  showPresets: 'showPresets',
} as const

export interface QuickLaunchIntent {
  teamId: number
  launcherKey?: string | null
  presetId?: string | null
  showPresets: boolean
}

export function buildQuickLaunchHref(
  launcher: QuickLauncher,
  options: {
    presetId?: string
    showPresets?: boolean
  } = {}
): string {
  const params = new URLSearchParams({
    [QUICK_LAUNCH_QUERY.teamId]: String(launcher.team.id),
    [QUICK_LAUNCH_QUERY.launcher]: launcher.key,
  })

  if (options.presetId) {
    params.set(QUICK_LAUNCH_QUERY.preset, options.presetId)
  }

  if (options.showPresets) {
    params.set(QUICK_LAUNCH_QUERY.showPresets, '1')
  }

  if (launcher.targetPage === 'code') {
    return buildChatCodeHref(params)
  }

  return `/${launcher.targetPage}?${params.toString()}`
}

export function getCurrentTargetPageByMode(currentMode: string): TeamTargetPage {
  if (currentMode === 'code') return 'code'
  if (currentMode === 'knowledge') return 'knowledge'
  if (currentMode === 'task') return 'devices/chat'
  if (currentMode === 'video' || currentMode === 'image') return 'generate'
  return 'chat'
}

export function parseQuickLaunchIntent(searchParams: URLSearchParams): QuickLaunchIntent | null {
  const teamId = Number(searchParams.get(QUICK_LAUNCH_QUERY.teamId))
  if (!Number.isFinite(teamId) || teamId <= 0) {
    return null
  }

  const launcherKey = searchParams.get(QUICK_LAUNCH_QUERY.launcher)
  const presetId = searchParams.get(QUICK_LAUNCH_QUERY.preset)
  const showPresets = searchParams.get(QUICK_LAUNCH_QUERY.showPresets) === '1'
  if (!launcherKey && !presetId && !showPresets) {
    return null
  }

  return {
    teamId,
    launcherKey,
    presetId,
    showPresets,
  }
}

export function removeQuickLaunchQueryParams(searchParams: URLSearchParams): URLSearchParams {
  const nextParams = new URLSearchParams(searchParams.toString())
  nextParams.delete(QUICK_LAUNCH_QUERY.teamId)
  nextParams.delete(QUICK_LAUNCH_QUERY.launcher)
  nextParams.delete(QUICK_LAUNCH_QUERY.preset)
  nextParams.delete(QUICK_LAUNCH_QUERY.showPresets)
  return nextParams
}
