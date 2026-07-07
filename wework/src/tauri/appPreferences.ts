import { invoke } from '@tauri-apps/api/core'
import { isTauriRuntime } from '@/lib/runtime-environment'

export interface AppPreferences {
  closeToTrayEnabled: boolean
  showMainWindowOnLaunch: boolean
  closeToTrayHintSeen: boolean
  language: AppLanguagePreference
}

export type AppLanguagePreference = 'system' | 'zh-CN' | 'en'

export interface AppPreferencesPatch {
  closeToTrayEnabled?: boolean
  showMainWindowOnLaunch?: boolean
  closeToTrayHintSeen?: boolean
  language?: AppLanguagePreference
}

export const defaultAppPreferences: AppPreferences = {
  closeToTrayEnabled: true,
  showMainWindowOnLaunch: true,
  closeToTrayHintSeen: false,
  language: 'zh-CN',
}

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
  }
}

export async function getAppPreferences(): Promise<AppPreferences> {
  if (!isTauriRuntime() || !canInvokeAppPreferencesCommand()) {
    return defaultAppPreferences
  }

  return mergeAppPreferences(await invoke('get_app_preferences'))
}

export async function updateAppPreferences(patch: AppPreferencesPatch): Promise<AppPreferences> {
  if (!isTauriRuntime() || !canInvokeAppPreferencesCommand()) {
    return mergeAppPreferences({ ...defaultAppPreferences, ...patch })
  }

  return mergeAppPreferences(await invoke('update_app_preferences', { patch }))
}
