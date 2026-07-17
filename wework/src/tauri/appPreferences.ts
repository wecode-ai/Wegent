import { invoke } from '@tauri-apps/api/core'
import { isTauriRuntime } from '@/lib/runtime-environment'

export interface AppPreferences {
  closeToTrayEnabled: boolean
  showMainWindowOnLaunch: boolean
  closeToTrayHintSeen: boolean
  language: AppLanguagePreference
  terminalContextInjectionEnabled: boolean
  experimentalFeaturesEnabled: boolean
  taskCompletionNotificationsEnabled: boolean
  trayUnreadEnabled: boolean
  trayRunningEnabled: boolean
  trayUsageEnabled: boolean
  browserExternalLinkTarget: BrowserLinkTarget
  browserLocalLinkTarget: BrowserLinkTarget
  browserDownloadDirectory: string | null
  browserAskBeforeDownload: boolean
  appshotsPlaySound: boolean
  quickPhrases: QuickPhrase[]
}

export type QuickPhraseMode = 'normal' | 'plan' | 'goal'

export interface QuickPhrase {
  id: string
  title: string
  content: string
  mode: QuickPhraseMode
}

export type AppLanguagePreference = 'system' | 'zh-CN' | 'en'
export type BrowserLinkTarget = 'system' | 'wework'

export interface AppPreferencesPatch {
  closeToTrayEnabled?: boolean
  showMainWindowOnLaunch?: boolean
  closeToTrayHintSeen?: boolean
  language?: AppLanguagePreference
  terminalContextInjectionEnabled?: boolean
  experimentalFeaturesEnabled?: boolean
  taskCompletionNotificationsEnabled?: boolean
  trayUnreadEnabled?: boolean
  trayRunningEnabled?: boolean
  trayUsageEnabled?: boolean
  browserExternalLinkTarget?: BrowserLinkTarget
  browserLocalLinkTarget?: BrowserLinkTarget
  browserDownloadDirectory?: string | null
  browserAskBeforeDownload?: boolean
  appshotsPlaySound?: boolean
  quickPhrases?: QuickPhrase[]
}

export const defaultQuickPhrases: QuickPhrase[] = [
  {
    id: 'default-summary-progress',
    title: '总结当前进展',
    content: '总结目前完成的工作和下一步建议',
    mode: 'normal',
  },
  {
    id: 'default-create-plan',
    title: '制定实施计划',
    content: '分析需求并制定详细的实施计划',
    mode: 'plan',
  },
  {
    id: 'default-pursue-goal',
    title: '持续完成这个目标',
    content: '持续推进这个目标，直到真正完成',
    mode: 'goal',
  },
]

export const defaultAppPreferences: AppPreferences = {
  closeToTrayEnabled: true,
  showMainWindowOnLaunch: true,
  closeToTrayHintSeen: false,
  language: 'zh-CN',
  terminalContextInjectionEnabled: true,
  experimentalFeaturesEnabled: false,
  taskCompletionNotificationsEnabled: false,
  trayUnreadEnabled: true,
  trayRunningEnabled: true,
  trayUsageEnabled: true,
  browserExternalLinkTarget: 'system',
  browserLocalLinkTarget: 'wework',
  browserDownloadDirectory: null,
  browserAskBeforeDownload: false,
  appshotsPlaySound: true,
  quickPhrases: defaultQuickPhrases,
}

export const APP_PREFERENCES_CHANGED_EVENT = 'wework:app-preferences-changed'

const supportedLanguagePreferences = new Set<AppLanguagePreference>(['system', 'zh-CN', 'en'])
const supportedBrowserLinkTargets = new Set<BrowserLinkTarget>(['system', 'wework'])

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
    experimentalFeaturesEnabled:
      typeof record.experimentalFeaturesEnabled === 'boolean'
        ? record.experimentalFeaturesEnabled
        : defaultAppPreferences.experimentalFeaturesEnabled,
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
    browserExternalLinkTarget:
      typeof record.browserExternalLinkTarget === 'string' &&
      supportedBrowserLinkTargets.has(record.browserExternalLinkTarget as BrowserLinkTarget)
        ? (record.browserExternalLinkTarget as BrowserLinkTarget)
        : defaultAppPreferences.browserExternalLinkTarget,
    browserLocalLinkTarget:
      typeof record.browserLocalLinkTarget === 'string' &&
      supportedBrowserLinkTargets.has(record.browserLocalLinkTarget as BrowserLinkTarget)
        ? (record.browserLocalLinkTarget as BrowserLinkTarget)
        : defaultAppPreferences.browserLocalLinkTarget,
    browserDownloadDirectory:
      typeof record.browserDownloadDirectory === 'string' && record.browserDownloadDirectory.trim()
        ? record.browserDownloadDirectory.trim()
        : defaultAppPreferences.browserDownloadDirectory,
    browserAskBeforeDownload:
      typeof record.browserAskBeforeDownload === 'boolean'
        ? record.browserAskBeforeDownload
        : defaultAppPreferences.browserAskBeforeDownload,
    appshotsPlaySound:
      typeof record.appshotsPlaySound === 'boolean'
        ? record.appshotsPlaySound
        : defaultAppPreferences.appshotsPlaySound,
    quickPhrases: Array.isArray(record.quickPhrases)
      ? record.quickPhrases.flatMap(item => normalizeQuickPhrase(item))
      : defaultAppPreferences.quickPhrases,
  }
}

function normalizeQuickPhrase(value: unknown): QuickPhrase[] {
  if (!value || typeof value !== 'object') return []
  const record = value as Partial<QuickPhrase>
  const id = typeof record.id === 'string' ? record.id : ''
  const title = typeof record.title === 'string' ? record.title.trim() : ''
  const content = typeof record.content === 'string' ? record.content.trim() : ''
  const mode = record.mode
  if (!id || !title || !content || !['normal', 'plan', 'goal'].includes(mode ?? '')) return []
  return [{ id, title, content, mode: mode as QuickPhraseMode }]
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

  const nativePatch =
    Object.prototype.hasOwnProperty.call(patch, 'browserDownloadDirectory') &&
    patch.browserDownloadDirectory === null
      ? { ...patch, browserDownloadDirectory: '' }
      : patch
  const preferences = mergeAppPreferences(
    await invoke('update_app_preferences', { patch: nativePatch })
  )
  emitAppPreferencesChanged(preferences)
  return preferences
}
