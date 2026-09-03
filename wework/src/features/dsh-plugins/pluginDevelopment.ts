import { invokeDesktopHost, subscribeDesktopHostEvents } from '@/api/dsh/desktopHost'

const WEWORK_PLUGIN_DEVELOPER_NAME = 'wework-plugin-developer'
const WEWORK_PLUGIN_DEVELOPER_MARKETPLACE = 'wework-personal'

export type PluginDevelopmentStatus =
  | 'validating'
  | 'starting'
  | 'ready'
  | 'reloading'
  | 'error'
  | 'stopping'
  | 'stopped'

export interface PluginDevelopmentError {
  stage: string
  message: string
  timestamp: string
}

export interface PluginDevelopmentSession {
  id: string
  name: string
  displayName: string
  description: string
  version: string
  sourceRoot: string
  status: PluginDevelopmentStatus
  electronPid: number | null
  coreDshPid: number | null
  hmrGeneration: number
  startedAt: string
  updatedAt: string
  hmrUpdatedAt: string | null
  lastError: PluginDevelopmentError | null
  userDataDirectory: string
  logDirectory: string
}

export interface PluginDevelopmentProjectClassification {
  sourceRoot: string
  kind: 'standard' | 'wework-core-dsh-plugin'
  revision: string
  plugin: Pick<
    PluginDevelopmentSession,
    'name' | 'displayName' | 'description' | 'version' | 'sourceRoot'
  > | null
}

export interface InitializedPluginDevelopmentProject {
  name: string
  displayName: string
  description: string
  version: string
  sourceRoot: string
  kind: 'wework-core-dsh-plugin'
}

export function pluginDevelopmentInitialInput(displayName: string, prompt: string): string {
  const reference = `[$${displayName.trim()}](plugin://${WEWORK_PLUGIN_DEVELOPER_NAME}@${WEWORK_PLUGIN_DEVELOPER_MARKETPLACE})`
  return `${reference} ${prompt}`
}

export function classifyPluginDevelopmentProject(
  sourceRoot: string
): Promise<PluginDevelopmentProjectClassification> {
  return invokeDesktopHost('pluginDevelopment.classify', { sourceRoot })
}

export function initializePluginDevelopmentProject(
  sourceRoot: string
): Promise<InitializedPluginDevelopmentProject> {
  return invokeDesktopHost('pluginDevelopment.initialize', { sourceRoot })
}

export function observePluginDevelopmentProject(
  sourceRoot: string | null
): Promise<PluginDevelopmentProjectClassification | null> {
  return invokeDesktopHost('pluginDevelopment.observe', { sourceRoot })
}

export function readPluginDevelopmentSessions(): Promise<PluginDevelopmentSession[]> {
  return invokeDesktopHost('pluginDevelopment.list')
}

export function startPluginDevelopment(sourceRoot: string): Promise<PluginDevelopmentSession> {
  return invokeDesktopHost('pluginDevelopment.start', { sourceRoot })
}

export async function focusPluginDevelopment(): Promise<void> {
  await invokeDesktopHost('pluginDevelopment.focus')
}

export async function restartPluginDevelopmentCoreDsh(): Promise<void> {
  await invokeDesktopHost('pluginDevelopment.restartCoreDsh')
}

export async function openPluginDevelopmentDevTools(): Promise<void> {
  await invokeDesktopHost('pluginDevelopment.openDevTools')
}

export async function openPluginDevelopmentLogs(): Promise<void> {
  await invokeDesktopHost('pluginDevelopment.openLogDirectory')
}

export async function stopPluginDevelopment(): Promise<void> {
  await invokeDesktopHost('pluginDevelopment.stop')
}

export async function deletePluginDevelopmentData(): Promise<void> {
  await invokeDesktopHost('pluginDevelopment.deleteData')
}

export function subscribePluginDevelopment(
  handler: (session: PluginDevelopmentSession) => void
): () => void {
  return subscribeDesktopHostEvents(event => {
    if (event.type !== 'plugin-development.state') return
    handler(event.payload as unknown as PluginDevelopmentSession)
  })
}
