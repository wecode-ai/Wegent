import { invoke } from '@tauri-apps/api/core'
import { isTauriRuntime } from '@/lib/runtime-environment'

export interface AppPreferences {
  closeToTrayEnabled: boolean
  showMainWindowOnLaunch: boolean
  closeToTrayHintSeen: boolean
  language: AppLanguagePreference
  terminalContextInjectionEnabled: boolean
  taskCompletionNotificationsEnabled: boolean
  trayUnreadEnabled: boolean
  trayRunningEnabled: boolean
  trayUsageEnabled: boolean
}

export type AppLanguagePreference = 'system' | 'zh-CN' | 'en'

export interface AppPreferencesPatch {
  closeToTrayEnabled?: boolean
  showMainWindowOnLaunch?: boolean
  closeToTrayHintSeen?: boolean
  language?: AppLanguagePreference
  terminalContextInjectionEnabled?: boolean
  taskCompletionNotificationsEnabled?: boolean
  trayUnreadEnabled?: boolean
  trayRunningEnabled?: boolean
  trayUsageEnabled?: boolean
}

export const defaultAppPreferences: AppPreferences = {
  closeToTrayEnabled: true,
  showMainWindowOnLaunch: true,
  closeToTrayHintSeen: false,
  language: 'zh-CN',
  terminalContextInjectionEnabled: true,
  taskCompletionNotificationsEnabled: false,
  trayUnreadEnabled: true,
  trayRunningEnabled: true,
  trayUsageEnabled: true,
}

export const APP_PREFERENCES_CHANGED_EVENT = 'wework:app-preferences-changed'

const supportedLanguagePreferences = new Set<AppLanguagePreference>(['system', 'zh-CN', 'en'])

function canInvokeAppPreferencesCommand() {
  if (typeof window === 'undefined') {
    return false
  }

  const tauriInternals = (
    window as typeof window & {
      __TAURI_INTERNALS__?: { invoke?: unknown }
    }
  ).__TAURI_INTERNALS__

  return !tauriInternals || typeof tauriInternals.invoke === 'function'
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
    language:
      typeof record.language === 'string' &&
      supportedLanguagePreferences.has(record.language as AppLanguagePreference)
        ? (record.language as AppLanguagePreference)
        : defaultAppPreferences.language,
    terminalContextInjectionEnabled:
      typeof record.terminalContextInjectionEnabled === 'boolean'
        ? record.terminalContextInjectionEnabled
        : defaultAppPreferences.terminalContextInjectionEnabled,
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
  if (!isTauriRuntime() || !canInvokeAppPreferencesCommand()) {
    return defaultAppPreferences
  }

  return mergeAppPreferences(await invoke('get_app_preferences'))
}

export async function updateAppPreferences(patch: AppPreferencesPatch): Promise<AppPreferences> {
  if (!isTauriRuntime() || !canInvokeAppPreferencesCommand()) {
    const preferences = mergeAppPreferences({ ...defaultAppPreferences, ...patch })
    emitAppPreferencesChanged(preferences)
    return preferences
  }

  const preferences = mergeAppPreferences(await invoke('update_app_preferences', { patch }))
  emitAppPreferencesChanged(preferences)
  return preferences
}
