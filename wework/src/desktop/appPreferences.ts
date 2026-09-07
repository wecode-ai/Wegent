import { invokeDesktopHost } from '@/api/dsh/desktopHost'
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
  workbenchMode: WorkbenchMode
  appearanceMode: AppearanceModePreference
  closeToTrayEnabled: boolean
  showMainWindowOnLaunch: boolean
  fixedWorkspaceTabs: FixedWorkspaceTabPreference[]
  startupWorkspaceTabId: string
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
  supervisorModelSelection: ModelSelectionConfig | null
  supervisorIntervalSeconds: number
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
  computerUseEnabled?: boolean
  popoutWindowShortcut: string | null
  popoutWindowProjectlessDefaultEnabled: boolean
  friendlyTaskTitlesEnabled: boolean
  friendlyTaskTitleModel: FriendlyTaskTitleModelConfig | null
  changeRequestStatusEnabled: boolean
  quickPhrases: QuickPhrase[]
  localHarnesses: LocalHarnessPreference[]
  cloudConnection: Record<string, unknown> | null
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
export type AppearanceModePreference = 'light' | 'dark' | 'system'
export type BrowserLinkTarget = 'system' | 'wework'
export type WorkbenchMode = 'focus' | 'developer'
export type FixedWorkspaceTabKind = 'task' | 'board' | 'agent' | 'smart_app'

export interface FixedWorkspaceTabPreference {
  id: string
  kind: FixedWorkspaceTabKind
  installationId?: string
  title?: string
}

export interface AppPreferencesPatch {
  workbenchMode?: WorkbenchMode
  appearanceMode?: AppearanceModePreference
  closeToTrayEnabled?: boolean
  showMainWindowOnLaunch?: boolean
  fixedWorkspaceTabs?: FixedWorkspaceTabPreference[]
  startupWorkspaceTabId?: string
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
  supervisorModelSelection?: ModelSelectionConfig | null
  supervisorIntervalSeconds?: number
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
  computerUseEnabled?: boolean
  popoutWindowShortcut?: string | null
  popoutWindowProjectlessDefaultEnabled?: boolean
  friendlyTaskTitlesEnabled?: boolean
  friendlyTaskTitleModel?: FriendlyTaskTitleModelConfig | null
  changeRequestStatusEnabled?: boolean
  quickPhrases?: QuickPhrase[]
  localHarnesses?: LocalHarnessPreference[]
  cloudConnection?: Record<string, unknown> | null
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
  workbenchMode: 'developer',
  appearanceMode: 'system',
  closeToTrayEnabled: true,
  showMainWindowOnLaunch: true,
  fixedWorkspaceTabs: [
    { id: 'fixed-task', kind: 'task' },
    { id: 'fixed-board', kind: 'board' },
    { id: 'fixed-agent', kind: 'agent' },
  ],
  startupWorkspaceTabId: 'fixed-task',
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
  supervisorModelSelection: null,
  supervisorIntervalSeconds: 30,
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
  computerUseEnabled: false,
  popoutWindowShortcut: 'Alt+Shift+Space',
  popoutWindowProjectlessDefaultEnabled: false,
  friendlyTaskTitlesEnabled: false,
  friendlyTaskTitleModel: null,
  changeRequestStatusEnabled: true,
  quickPhrases: defaultQuickPhrases,
  localHarnesses: defaultLocalHarnessPreferences,
  cloudConnection: null,
}

export const APP_PREFERENCES_CHANGED_EVENT = 'wework:app-preferences-changed'

const supportedLanguagePreferences = new Set<AppLanguagePreference>(['system', 'zh-CN', 'en'])
const supportedAppearanceModes = new Set<AppearanceModePreference>(['light', 'dark', 'system'])
const supportedBrowserLinkTargets = new Set<BrowserLinkTarget>(['system', 'wework'])
const supportedWorkbenchModes = new Set<WorkbenchMode>(['focus', 'developer'])
const supportedFixedWorkspaceTabKinds = new Set<FixedWorkspaceTabKind>([
  'task',
  'board',
  'agent',
  'smart_app',
])

function normalizeFixedWorkspaceTabs(value: unknown): FixedWorkspaceTabPreference[] {
  if (!Array.isArray(value)) return []
  const ids = new Set<string>()
  return value.flatMap(item => {
    if (!item || typeof item !== 'object') return []
    const record = item as Partial<FixedWorkspaceTabPreference>
    const id = typeof record.id === 'string' ? record.id.trim() : ''
    const kind =
      typeof record.kind === 'string' &&
      supportedFixedWorkspaceTabKinds.has(record.kind as FixedWorkspaceTabKind)
        ? (record.kind as FixedWorkspaceTabKind)
        : null
    const installationId =
      typeof record.installationId === 'string' ? record.installationId.trim() : ''
    if (!id || ids.has(id) || !kind || (kind === 'smart_app' && !installationId)) return []
    ids.add(id)
    const title = typeof record.title === 'string' ? record.title.trim() : ''
    return [
      {
        id,
        kind,
        ...(installationId && { installationId }),
        ...(title && { title }),
      },
    ]
  })
}

function mergeAppPreferences(value: unknown): AppPreferences {
  if (!value || typeof value !== 'object') {
    return defaultAppPreferences
  }

  const record = value as Partial<AppPreferences>
  const storedFixedWorkspaceTabs = normalizeFixedWorkspaceTabs(record.fixedWorkspaceTabs)
  const legacyDefaultWorkspaceTab =
    typeof (record as Record<string, unknown>).defaultWorkspaceTab === 'string'
      ? String((record as Record<string, unknown>).defaultWorkspaceTab)
      : 'task'
  const fixedWorkspaceTabs =
    storedFixedWorkspaceTabs.length > 0
      ? storedFixedWorkspaceTabs
      : defaultAppPreferences.fixedWorkspaceTabs
  return {
    workbenchMode:
      typeof record.workbenchMode === 'string' &&
      supportedWorkbenchModes.has(record.workbenchMode as WorkbenchMode)
        ? (record.workbenchMode as WorkbenchMode)
        : defaultAppPreferences.workbenchMode,
    appearanceMode:
      typeof record.appearanceMode === 'string' &&
      supportedAppearanceModes.has(record.appearanceMode as AppearanceModePreference)
        ? (record.appearanceMode as AppearanceModePreference)
        : defaultAppPreferences.appearanceMode,
    closeToTrayEnabled:
      typeof record.closeToTrayEnabled === 'boolean'
        ? record.closeToTrayEnabled
        : defaultAppPreferences.closeToTrayEnabled,
    showMainWindowOnLaunch:
      typeof record.showMainWindowOnLaunch === 'boolean'
        ? record.showMainWindowOnLaunch
        : defaultAppPreferences.showMainWindowOnLaunch,
    fixedWorkspaceTabs,
    startupWorkspaceTabId: (() => {
      const requested =
        typeof record.startupWorkspaceTabId === 'string' ? record.startupWorkspaceTabId.trim() : ''
      if (fixedWorkspaceTabs.some(tab => tab.id === requested)) return requested
      return (
        fixedWorkspaceTabs.find(tab => tab.kind === legacyDefaultWorkspaceTab)?.id ??
        fixedWorkspaceTabs[0]?.id ??
        'fixed-task'
      )
    })(),
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
    supervisorModelSelection: normalizeModelSelection(record.supervisorModelSelection),
    supervisorIntervalSeconds: [10, 30, 60, 300].includes(record.supervisorIntervalSeconds ?? 0)
      ? (record.supervisorIntervalSeconds as number)
      : defaultAppPreferences.supervisorIntervalSeconds,
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
    computerUseEnabled:
      typeof record.computerUseEnabled === 'boolean'
        ? record.computerUseEnabled
        : defaultAppPreferences.computerUseEnabled,
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
    cloudConnection:
      record.cloudConnection &&
      typeof record.cloudConnection === 'object' &&
      !Array.isArray(record.cloudConnection)
        ? { ...record.cloudConnection }
        : null,
  }
}

function normalizeModelSelection(value: unknown): ModelSelectionConfig | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Partial<ModelSelectionConfig>
  const modelName = typeof record.modelName === 'string' ? record.modelName.trim() : ''
  if (!modelName) return null
  const modelType =
    record.modelType === 'public' ||
    record.modelType === 'user' ||
    record.modelType === 'group' ||
    record.modelType === 'runtime'
      ? record.modelType
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
    ...(options ? { options } : {}),
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
  if (typeof window === 'undefined') {
    return defaultAppPreferences
  }
  return mergeAppPreferences(await invokeDesktopHost<Record<string, unknown>>('preferences.get'))
}

export async function updateAppPreferences(patch: AppPreferencesPatch): Promise<AppPreferences> {
  if (typeof window === 'undefined') {
    const preferences = mergeAppPreferences({ ...defaultAppPreferences, ...patch })
    return preferences
  }
  const preferences = mergeAppPreferences(
    await invokeDesktopHost<Record<string, unknown>>('preferences.update', { patch })
  )
  emitAppPreferencesChanged(preferences)
  return preferences
}
