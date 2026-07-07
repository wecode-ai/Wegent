import { invoke } from '@tauri-apps/api/core'
import { isTauriRuntime } from '@/lib/runtime-environment'

export interface AppPreferences {
  closeToTrayEnabled: boolean
  showMainWindowOnLaunch: boolean
  closeToTrayHintSeen: boolean
}

export interface AppPreferencesPatch {
  closeToTrayEnabled?: boolean
  showMainWindowOnLaunch?: boolean
  closeToTrayHintSeen?: boolean
}

export const defaultAppPreferences: AppPreferences = {
  closeToTrayEnabled: true,
  showMainWindowOnLaunch: true,
  closeToTrayHintSeen: false,
}

function mergeAppPreferences(value: unknown): AppPreferences {
  if (!value || typeof value !== 'object') {
    return defaultAppPreferences
  }

  const record = value as Partial<AppPreferences>
  return {
    closeToTrayEnabled:
      typeof record.closeToTrayEnabled === 'boolean'
        ? record.closeToTrayEnabled
        : defaultAppPreferences.closeToTrayEnabled,
    showMainWindowOnLaunch:
      typeof record.showMainWindowOnLaunch === 'boolean'
        ? record.showMainWindowOnLaunch
        : defaultAppPreferences.showMainWindowOnLaunch,
    closeToTrayHintSeen:
      typeof record.closeToTrayHintSeen === 'boolean'
        ? record.closeToTrayHintSeen
        : defaultAppPreferences.closeToTrayHintSeen,
  }
}

export async function getAppPreferences(): Promise<AppPreferences> {
  if (!isTauriRuntime()) {
    return defaultAppPreferences
  }

  return mergeAppPreferences(await invoke('get_app_preferences'))
}

export async function updateAppPreferences(patch: AppPreferencesPatch): Promise<AppPreferences> {
  if (!isTauriRuntime()) {
    return mergeAppPreferences({ ...defaultAppPreferences, ...patch })
  }

  return mergeAppPreferences(await invoke('update_app_preferences', { patch }))
}
