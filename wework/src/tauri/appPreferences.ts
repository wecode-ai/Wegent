import { invoke } from '@tauri-apps/api/core'
import { isTauriRuntime } from '@/lib/runtime-environment'

export interface AppPreferences {
  closeToTrayEnabled: boolean
  showMainWindowOnLaunch: boolean
  closeToTrayHintSeen: boolean
  taskCompletionNotificationsEnabled: boolean
  trayUnreadEnabled: boolean
  trayRunningEnabled: boolean
  trayUsageEnabled: boolean
}

export interface AppPreferencesPatch {
  closeToTrayEnabled?: boolean
  showMainWindowOnLaunch?: boolean
  closeToTrayHintSeen?: boolean
  taskCompletionNotificationsEnabled?: boolean
  trayUnreadEnabled?: boolean
  trayRunningEnabled?: boolean
  trayUsageEnabled?: boolean
}

export const defaultAppPreferences: AppPreferences = {
  closeToTrayEnabled: true,
  showMainWindowOnLaunch: true,
  closeToTrayHintSeen: false,
  taskCompletionNotificationsEnabled: true,
  trayUnreadEnabled: true,
  trayRunningEnabled: true,
  trayUsageEnabled: true,
}

export const APP_PREFERENCES_CHANGED_EVENT = 'wework:app-preferences-changed'

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
    taskCompletionNotificationsEnabled:
      typeof record.taskCompletionNotificationsEnabled === 'boolean'
        ? record.taskCompletionNotificationsEnabled
        : defaultAppPreferences.taskCompletionNotificationsEnabled,
    trayUnreadEnabled:
      typeof record.trayUnreadEnabled === 'boolean'
        ? record.trayUnreadEnabled
        : defaultAppPreferences.trayUnreadEnabled,
    trayRunningEnabled:
      typeof record.trayRunningEnabled === 'boolean'
        ? record.trayRunningEnabled
        : defaultAppPreferences.trayRunningEnabled,
    trayUsageEnabled:
      typeof record.trayUsageEnabled === 'boolean'
        ? record.trayUsageEnabled
        : defaultAppPreferences.trayUsageEnabled,
  }
}

function emitAppPreferencesChanged(preferences: AppPreferences) {
  window.dispatchEvent(new CustomEvent(APP_PREFERENCES_CHANGED_EVENT, { detail: preferences }))
}

export async function getAppPreferences(): Promise<AppPreferences> {
  if (!isTauriRuntime()) {
    return defaultAppPreferences
  }

  return mergeAppPreferences(await invoke('get_app_preferences'))
}

export async function updateAppPreferences(patch: AppPreferencesPatch): Promise<AppPreferences> {
  const preferences = !isTauriRuntime()
    ? mergeAppPreferences({ ...defaultAppPreferences, ...patch })
    : mergeAppPreferences(await invoke('update_app_preferences', { patch }))
  emitAppPreferencesChanged(preferences)
  return preferences
}
