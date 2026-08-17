import { getPluginUseCount30d } from '@/features/plugins/pluginTrial'
import type { LocalDeviceApp } from '@/types/api'
import { displayAppName } from './composerMentionCandidates'

export const RECENT_PLUGIN_APPS_KEY = 'wework:composer:recent-plugin-apps'

export function readRecentPluginAppIds(): Map<string, number> {
  try {
    const raw = window.localStorage.getItem(RECENT_PLUGIN_APPS_KEY) || '[]'
    const recent = JSON.parse(raw) as unknown
    if (!Array.isArray(recent) || !recent.every(item => typeof item === 'string')) {
      return new Map()
    }
    return new Map(recent.map((id, index) => [id, index]))
  } catch {
    return new Map()
  }
}

/**
 * Sort installed composer plugins by personal 30-day usage (desc),
 * then recent picker selection, then display name.
 * Usage keys match mention display names recorded by recordPluginUsageFromInput.
 */
export function compareComposerPluginsByUsage(
  left: LocalDeviceApp,
  right: LocalDeviceApp,
  recentIds: Map<string, number> = readRecentPluginAppIds()
): number {
  const leftCount = getPluginUseCount30d(displayAppName(left))
  const rightCount = getPluginUseCount30d(displayAppName(right))
  if (leftCount !== rightCount) return rightCount - leftCount

  const leftRecent = recentIds.get(left.id) ?? Number.MAX_SAFE_INTEGER
  const rightRecent = recentIds.get(right.id) ?? Number.MAX_SAFE_INTEGER
  if (leftRecent !== rightRecent) return leftRecent - rightRecent

  return displayAppName(left).localeCompare(displayAppName(right))
}

export function sortComposerPluginsByUsage(
  apps: LocalDeviceApp[],
  recentIds: Map<string, number> = readRecentPluginAppIds()
): LocalDeviceApp[] {
  return [...apps].sort((left, right) => compareComposerPluginsByUsage(left, right, recentIds))
}
