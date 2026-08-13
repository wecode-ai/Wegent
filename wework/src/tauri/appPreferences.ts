import { invoke } from '@tauri-apps/api/core'
import { isTauriRuntime } from '@/lib/runtime-environment'
import type { ModelSelectionConfig } from '@/types/api'
import {
  defaultLocalHarnessPreferences,
  normalizeLocalHarnessPreferences,
  type LocalHarnessPreference,
} from '@/lib/local-harness'

export const DEFAULT_CONTEXT_COMPACTION_THRESHOLD = 85
export const CONTEXT_COMPACTION_THRESHOLD_MIN = 1
export const CONTEXT_COMPACTION_THRESHOLD_MAX = 100

export function clampContextCompactionThreshold(value: number): number {
  return Math.min(
    CONTEXT_COMPACTION_THRESHOLD_MAX,
    Math.max(CONTEXT_COMPACTION_THRESHOLD_MIN, Math.round(value))
  )
}

export interface AppPreferences {
  closeToTrayEnabled: boolean
  showMainWindowOnLaunch: boolean
  defaultWorkspaceTab: DefaultWorkspaceTab
  systemDragEnabled: boolean
  preventSleepWhileTasksRunning: boolean
  closeToTrayHintSeen: boolean
  language: AppLanguagePreference
  terminalContextInjectionEnabled: boolean
  contextCompactionThreshold: number
  experimentalFeaturesEnabled: boolean
  telemetryConsentAsked: boolean
  telemetryEnabled: boolean
  supervisorPrinciples: string
  taskCompletionNotificationsEnabled: boolean
  trayUnreadEnabled: boolean
  trayRunningEnabled: boolean
  trayUsageEnabled: boolean
  trayWegentUsageEnabled: boolean
  browserExternalLinkTarget: BrowserLinkTarget
  browserLocalLinkTarget: BrowserLinkTarget
  browserDownloadDirectory: string | null
  browserAskBeforeDownload: boolean
  appshotsPlaySound: boolean
  popoutWindowShortcut: string | null
  popoutWindowProjectlessDefaultEnabled: boolean
  friendlyTaskTitlesEnabled: boolean
  friendlyTaskTitleModel: FriendlyTaskTitleModelConfig | null
  changeRequestStatusEnabled: boolean
  quickPhrases: QuickPhrase[]
  localHarnesses: LocalHarnessPreference[]
}

export interface FriendlyTaskTitleModelConfig {
  modelName: string
  modelType: ModelSelectionConfig['modelType']
  executionModelId: string
  executionModelType: ModelSelectionConfig['modelType']
  options?: ModelSelectionConfig['options']
}

export type QuickPhraseMode = 'normal' | 'plan' | 'goal'

export interface QuickPhrase {
  id: string
  title: string
  content: string
  mode: QuickPhraseMode
  attachmentPaths?: string[]
  createdAt?: number
}

export const QUICK_PHRASE_STASH_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

function stashCreatedAt(phrase: Pick<QuickPhrase, 'id' | 'createdAt'>): number | null {
  if (typeof phrase.createdAt === 'number' && Number.isFinite(phrase.createdAt)) {
    return phrase.createdAt
  }
  if (!phrase.id.startsWith('stash-')) return null
  const timestamp = Number(phrase.id.slice('stash-'.length).split('-')[0])
  return Number.isFinite(timestamp) ? timestamp : null
}

export function isExpiredQuickPhraseStash(phrase: QuickPhrase, now = Date.now()): boolean {
  if (!phrase.id.startsWith('stash-')) return false
  const createdAt = stashCreatedAt(phrase)
  return createdAt !== null && now - createdAt >= QUICK_PHRASE_STASH_MAX_AGE_MS
}

export type AppLanguagePreference = 'system' | 'zh-CN' | 'en'
export type BrowserLinkTarget = 'system' | 'wework'
export type DefaultWorkspaceTab = 'task' | 'board' | 'agent'

export interface AppPreferencesPatch {
  closeToTrayEnabled?: boolean
  showMainWindowOnLaunch?: boolean
  defaultWorkspaceTab?: DefaultWorkspaceTab
  systemDragEnabled?: boolean
  preventSleepWhileTasksRunning?: boolean
  closeToTrayHintSeen?: boolean
  language?: AppLanguagePreference
  terminalContextInjectionEnabled?: boolean
  contextCompactionThreshold?: number
  experimentalFeaturesEnabled?: boolean
  telemetryConsentAsked?: boolean
  telemetryEnabled?: boolean
  supervisorPrinciples?: string
  taskCompletionNotificationsEnabled?: boolean
  trayUnreadEnabled?: boolean
  trayRunningEnabled?: boolean
  trayUsageEnabled?: boolean
  trayWegentUsageEnabled?: boolean
  browserExternalLinkTarget?: BrowserLinkTarget
  browserLocalLinkTarget?: BrowserLinkTarget
  browserDownloadDirectory?: string | null
  browserAskBeforeDownload?: boolean
  appshotsPlaySound?: boolean
  popoutWindowShortcut?: string | null
  popoutWindowProjectlessDefaultEnabled?: boolean
  friendlyTaskTitlesEnabled?: boolean
  friendlyTaskTitleModel?: FriendlyTaskTitleModelConfig | null
  changeRequestStatusEnabled?: boolean
  quickPhrases?: QuickPhrase[]
  localHarnesses?: LocalHarnessPreference[]
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
  defaultWorkspaceTab: 'task',
  systemDragEnabled: true,
  preventSleepWhileTasksRunning: true,
  closeToTrayHintSeen: false,
  language: 'zh-CN',
  terminalContextInjectionEnabled: true,
  contextCompactionThreshold: DEFAULT_CONTEXT_COMPACTION_THRESHOLD,
  experimentalFeaturesEnabled: false,
  telemetryConsentAsked: false,
  telemetryEnabled: false,
  supervisorPrinciples: '',
  taskCompletionNotificationsEnabled: false,
  trayUnreadEnabled: true,
  trayRunningEnabled: true,
  trayUsageEnabled: true,
  trayWegentUsageEnabled: true,
  browserExternalLinkTarget: 'system',
  browserLocalLinkTarget: 'wework',
  browserDownloadDirectory: null,
  browserAskBeforeDownload: false,
  appshotsPlaySound: true,
  popoutWindowShortcut: 'Alt+Shift+Space',
  popoutWindowProjectlessDefaultEnabled: false,
  friendlyTaskTitlesEnabled: false,
  friendlyTaskTitleModel: null,
  changeRequestStatusEnabled: true,
  quickPhrases: defaultQuickPhrases,
  localHarnesses: defaultLocalHarnessPreferences,
}

export const APP_PREFERENCES_CHANGED_EVENT = 'wework:app-preferences-changed'

const supportedLanguagePreferences = new Set<AppLanguagePreference>(['system', 'zh-CN', 'en'])
const supportedBrowserLinkTargets = new Set<BrowserLinkTarget>(['system', 'wework'])
const supportedDefaultWorkspaceTabs = new Set<DefaultWorkspaceTab>(['task', 'board', 'agent'])

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
    defaultWorkspaceTab:
      typeof record.defaultWorkspaceTab === 'string' &&
      supportedDefaultWorkspaceTabs.has(record.defaultWorkspaceTab as DefaultWorkspaceTab)
        ? (record.defaultWorkspaceTab as DefaultWorkspaceTab)
        : defaultAppPreferences.defaultWorkspaceTab,
    systemDragEnabled:
      typeof record.systemDragEnabled === 'boolean'
        ? record.systemDragEnabled
        : defaultAppPreferences.systemDragEnabled,
    preventSleepWhileTasksRunning:
      typeof record.preventSleepWhileTasksRunning === 'boolean'
        ? record.preventSleepWhileTasksRunning
        : defaultAppPreferences.preventSleepWhileTasksRunning,
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
    contextCompactionThreshold:
      typeof record.contextCompactionThreshold === 'number' &&
      Number.isFinite(record.contextCompactionThreshold)
        ? clampContextCompactionThreshold(record.contextCompactionThreshold)
        : defaultAppPreferences.contextCompactionThreshold,
    experimentalFeaturesEnabled:
      typeof record.experimentalFeaturesEnabled === 'boolean'
        ? record.experimentalFeaturesEnabled
        : defaultAppPreferences.experimentalFeaturesEnabled,
    telemetryConsentAsked:
      typeof record.telemetryConsentAsked === 'boolean'
        ? record.telemetryConsentAsked
        : defaultAppPreferences.telemetryConsentAsked,
    telemetryEnabled:
      typeof record.telemetryEnabled === 'boolean'
        ? record.telemetryEnabled
        : defaultAppPreferences.telemetryEnabled,
    supervisorPrinciples:
      typeof record.supervisorPrinciples === 'string'
        ? record.supervisorPrinciples
        : defaultAppPreferences.supervisorPrinciples,
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
    trayWegentUsageEnabled:
      typeof record.trayWegentUsageEnabled === 'boolean'
        ? record.trayWegentUsageEnabled
        : defaultAppPreferences.trayWegentUsageEnabled,
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
    popoutWindowShortcut:
      typeof record.popoutWindowShortcut === 'string' && record.popoutWindowShortcut.trim()
        ? record.popoutWindowShortcut.trim()
        : Object.prototype.hasOwnProperty.call(record, 'popoutWindowShortcut')
          ? null
          : defaultAppPreferences.popoutWindowShortcut,
    popoutWindowProjectlessDefaultEnabled:
      typeof record.popoutWindowProjectlessDefaultEnabled === 'boolean'
        ? record.popoutWindowProjectlessDefaultEnabled
        : defaultAppPreferences.popoutWindowProjectlessDefaultEnabled,
    friendlyTaskTitlesEnabled:
      typeof record.friendlyTaskTitlesEnabled === 'boolean'
        ? record.friendlyTaskTitlesEnabled
        : defaultAppPreferences.friendlyTaskTitlesEnabled,
    friendlyTaskTitleModel: normalizeFriendlyTaskTitleModel(record.friendlyTaskTitleModel),
    changeRequestStatusEnabled:
      typeof record.changeRequestStatusEnabled === 'boolean'
        ? record.changeRequestStatusEnabled
        : defaultAppPreferences.changeRequestStatusEnabled,
    quickPhrases: Array.isArray(record.quickPhrases)
      ? record.quickPhrases
          .flatMap(item => normalizeQuickPhrase(item))
          .filter(item => !isExpiredQuickPhraseStash(item))
      : defaultAppPreferences.quickPhrases,
    localHarnesses: normalizeLocalHarnessPreferences(record.localHarnesses),
  }
}

function normalizeFriendlyTaskTitleModel(value: unknown): FriendlyTaskTitleModelConfig | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Partial<FriendlyTaskTitleModelConfig>
  const modelName = typeof record.modelName === 'string' ? record.modelName.trim() : ''
  const executionModelId =
    typeof record.executionModelId === 'string' ? record.executionModelId.trim() : ''
  if (!modelName || !executionModelId) return null
  const modelType =
    record.modelType === 'public' ||
    record.modelType === 'user' ||
    record.modelType === 'group' ||
    record.modelType === 'runtime'
      ? record.modelType
      : null
  const executionModelType =
    record.executionModelType === 'public' ||
    record.executionModelType === 'user' ||
    record.executionModelType === 'group' ||
    record.executionModelType === 'runtime'
      ? record.executionModelType
      : null
  const options =
    record.options && typeof record.options === 'object' && !Array.isArray(record.options)
      ? Object.fromEntries(
          Object.entries(record.options).flatMap(([key, option]) =>
            typeof option === 'string' ? [[key, option]] : []
          )
        )
      : undefined
  return {
    modelName,
    modelType,
    executionModelId,
    executionModelType,
    ...(options ? { options } : {}),
  }
}

function normalizeQuickPhrase(value: unknown): QuickPhrase[] {
  if (!value || typeof value !== 'object') return []
  const record = value as Partial<QuickPhrase>
  const id = typeof record.id === 'string' ? record.id : ''
  const title = typeof record.title === 'string' ? record.title.trim() : ''
  const content = typeof record.content === 'string' ? record.content.trim() : ''
  const attachmentPaths = Array.isArray(record.attachmentPaths)
    ? record.attachmentPaths.flatMap(path =>
        typeof path === 'string' && path.trim() ? [path.trim()] : []
      )
    : []
  const mode = record.mode
  const createdAt =
    typeof record.createdAt === 'number' && Number.isFinite(record.createdAt)
      ? record.createdAt
      : undefined
  if (
    !id ||
    !title ||
    (!content && attachmentPaths.length === 0) ||
    !['normal', 'plan', 'goal'].includes(mode ?? '')
  ) {
    return []
  }
  return [
    {
      id,
      title,
      content,
      mode: mode as QuickPhraseMode,
      ...(attachmentPaths.length > 0 && { attachmentPaths }),
      ...(createdAt !== undefined && { createdAt }),
    },
  ]
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

  const nativePatch = {
    ...patch,
    ...(Object.prototype.hasOwnProperty.call(patch, 'browserDownloadDirectory') &&
    patch.browserDownloadDirectory === null
      ? { browserDownloadDirectory: '' }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(patch, 'popoutWindowShortcut') &&
    patch.popoutWindowShortcut === null
      ? { popoutWindowShortcut: '' }
      : {}),
  }
  const preferences = mergeAppPreferences(
    await invoke('update_app_preferences', { patch: nativePatch })
  )
  emitAppPreferencesChanged(preferences)
  return preferences
}
