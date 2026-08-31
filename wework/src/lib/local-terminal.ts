import i18n from '@/i18n'
import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import { requestDshTerminal, subscribeDshTerminalEvents } from '@/api/dsh/terminalTransport'
import { getLocalExecutorStatus, requestLocalExecutor } from '@/desktop/localExecutor'
import type { LocalHarnessId } from './local-harness'
import type { LocalWorkspaceOpenerId } from './local-workspace-openers'
import { isDesktopRuntime } from './runtime-environment'

type UnlistenFn = () => void

export const WEWORK_LOCAL_HARNESS_SESSIONS_CHANGED_EVENT = 'wework:local-harness-sessions-changed'

export function notifyLocalHarnessSessionsChanged(openSessionId?: string) {
  window.dispatchEvent(
    new CustomEvent(WEWORK_LOCAL_HARNESS_SESSIONS_CHANGED_EVENT, {
      detail: { openSessionId: openSessionId?.trim() || null },
    })
  )
}

function getLocalRuntimePlatform() {
  if (typeof navigator === 'undefined') return null

  const userAgent = navigator.userAgent || ''
  const platform = navigator.platform || ''
  return {
    isIosLike:
      /iPad|iPhone|iPod/.test(userAgent) ||
      (platform === 'MacIntel' && navigator.maxTouchPoints > 1),
    isMacOs: platform.startsWith('Mac') || userAgent.includes('Mac OS X'),
    isWindows: platform.startsWith('Win') || /Windows NT/.test(userAgent),
  }
}

export function isLocalTerminalAvailable(): boolean {
  const platform = getLocalRuntimePlatform()
  return Boolean(
    platform &&
    isDesktopRuntime() &&
    !platform.isIosLike &&
    (platform.isMacOs || platform.isWindows || import.meta.env.VITE_WEWORK_E2E === 'true')
  )
}

export function isLocalHarnessAvailable(): boolean {
  return isDesktopRuntime() && isLocalTerminalAvailable()
}

export async function getLocalExecutorDeviceId(
  expectedBackendUrl?: string
): Promise<string | null> {
  void expectedBackendUrl
  if (!isLocalTerminalAvailable()) return null
  return (await getLocalExecutorStatus()).deviceId?.trim() || null
}

export async function localPathExists(path?: string): Promise<boolean> {
  if (!isLocalTerminalAvailable()) return false

  const trimmedPath = path?.trim()
  if (!trimmedPath) return false
  return invokeDesktopHost('filesystem.stat', { path: trimmedPath })
    .then(() => true)
    .catch(() => false)
}

export type LocalPathKind = 'file' | 'directory' | 'other'

export async function getLocalPathKind(path?: string): Promise<LocalPathKind | null> {
  if (!isLocalTerminalAvailable()) return null

  const trimmedPath = path?.trim()
  if (!trimmedPath) return null
  return invokeDesktopHost<{ isDirectory: boolean; isFile: boolean }>('filesystem.stat', {
    path: trimmedPath,
  })
    .then(metadata => (metadata.isDirectory ? 'directory' : metadata.isFile ? 'file' : 'other'))
    .catch(() => null)
}

export interface StartLocalTerminalOptions {
  cwd?: string
  rows?: number
  cols?: number
  env?: Record<string, string | null | undefined>
  diagnosticContext?: LocalTerminalDiagnosticContext
}

export interface LocalTerminalDiagnosticContext {
  taskId?: string | null
  workspacePath?: string | null
  reason?: string | null
}

export interface LocalHarnessDescriptor {
  id: LocalHarnessId
  installed: boolean
  executable_path: string | null
  version: string | null
}

export interface LocalHarnessSessionDescriptor {
  session_id: string
  harness_id: LocalHarnessId
  title: string
  cwd: string
  created_at: number
  is_primary: boolean
  project_id: number | null
  active: boolean
  archived_at?: number | null
  model_key?: string | null
  plugin_roots?: string[]
  proxy_token?: string
}

interface PersistedLocalHarnessSession extends LocalHarnessSessionDescriptor {
  native_session_id?: string | null
}

interface PreparedLocalHarnessLaunch {
  args: string[]
  env: Record<string, string>
}

const ELECTRON_HARNESS_SESSIONS_KEY = 'wework:electron-local-harness-sessions:v1'

export interface LocalHarnessPluginLocation {
  marketplacePath: string
  pluginName: string
}

export interface LocalTerminalSnapshot {
  session_id: string
  sequence: number
  data: string
}

export interface StartLocalHarnessOptions extends StartLocalTerminalOptions {
  harnessId: LocalHarnessId
  prompt: string
  isPrimary: boolean
  projectId: number | null
  executablePath?: string | null
  args?: string[]
  pluginRoots?: string[]
  proxyToken?: string
  modelKey?: string | null
  resumeSessionId?: string | null
}

export interface LocalTerminalOutputPayload {
  session_id: string
  sequence: number
  data: string
}

export interface LocalTerminalExitPayload {
  session_id: string
}

export async function startLocalTerminal({
  cwd,
  rows,
  cols,
  env,
  diagnosticContext,
}: StartLocalTerminalOptions = {}): Promise<string> {
  if (!isLocalTerminalAvailable()) {
    throw new Error(i18n.t('localRuntime:local_terminal_unavailable'))
  }

  const trimmedCwd = cwd?.trim()
  const normalizedEnv = normalizeLocalTerminalEnv(env)
  const context = normalizeLocalTerminalDiagnosticContext(diagnosticContext)
  const payload: {
    cwd: string | null
    rows?: number
    cols?: number
    env?: Record<string, string>
    taskId: string | null
    workspacePath: string | null
  } = {
    cwd: trimmedCwd || null,
    rows,
    cols,
    taskId: context.taskId,
    workspacePath: context.workspacePath,
  }
  if (normalizedEnv) {
    payload.env = normalizedEnv
  }

  console.info('Local terminal start requested', {
    cwd: trimmedCwd || null,
    ...context,
  })
  try {
    const sessionId = crypto.randomUUID()
    await requestDshTerminal('terminal.start', {
      session_id: sessionId,
      cwd: payload.cwd,
      rows: payload.rows,
      cols: payload.cols,
      env: payload.env,
    })
    console.info('Local terminal start succeeded', {
      sessionId,
      cwd: trimmedCwd || null,
      ...context,
    })
    return sessionId
  } catch (error) {
    console.error('Local terminal start failed', {
      cwd: trimmedCwd || null,
      ...context,
      error: formatLocalTerminalError(error),
    })
    throw error
  }
}

export async function listLocalHarnesses(
  executableOverrides: Partial<Record<LocalHarnessId, string | null>> = {}
): Promise<LocalHarnessDescriptor[]> {
  if (!isLocalHarnessAvailable()) return []

  return requestLocalExecutor<LocalHarnessDescriptor[]>('executor.harnesses.list', {
    executable_overrides: executableOverrides,
  })
}

export async function listLocalHarnessSessions(): Promise<LocalHarnessSessionDescriptor[]> {
  if (!isLocalHarnessAvailable()) return []
  const sessions = readElectronHarnessSessions().filter(session => !session.archived_at)
  return Promise.all(
    sessions.map(async session => {
      const active = await requestDshTerminal('terminal.snapshot', {
        session_id: session.session_id,
      })
        .then(() => true)
        .catch(() => false)
      return { ...session, active, proxy_token: active ? session.proxy_token : undefined }
    })
  )
}

export async function listArchivedLocalHarnessSessions(): Promise<LocalHarnessSessionDescriptor[]> {
  if (!isLocalHarnessAvailable()) return []
  return readElectronHarnessSessions()
    .filter(session => Boolean(session.archived_at))
    .sort((left, right) => (right.archived_at ?? 0) - (left.archived_at ?? 0))
}

export async function archiveLocalHarnessSession(sessionId: string): Promise<void> {
  if (!isLocalHarnessAvailable()) return
  updateElectronHarnessSessions(sessions =>
    sessions.map(session =>
      session.session_id === sessionId
        ? { ...session, active: false, archived_at: Date.now(), proxy_token: undefined }
        : session
    )
  )
  await requestDshTerminal('terminal.close', { session_id: sessionId }).catch(() => {})
}

export async function unarchiveLocalHarnessSession(sessionId: string): Promise<void> {
  if (!isLocalHarnessAvailable()) return
  updateElectronHarnessSessions(sessions =>
    sessions.map(session =>
      session.session_id === sessionId ? { ...session, archived_at: null } : session
    )
  )
}

export async function deleteArchivedLocalHarnessSession(sessionId: string): Promise<void> {
  if (!isLocalHarnessAvailable()) return
  updateElectronHarnessSessions(sessions =>
    sessions.filter(session => session.session_id !== sessionId)
  )
}

export async function resolveLocalHarnessPluginRoots(
  locations: LocalHarnessPluginLocation[]
): Promise<string[]> {
  if (!isLocalHarnessAvailable() || locations.length === 0) return []
  return Array.from(
    new Set(
      locations.flatMap(location => {
        const marketplacePath = location.marketplacePath.trim().replace(/[\\/]+$/, '')
        const pluginName = location.pluginName.trim()
        return marketplacePath && pluginName ? [`${marketplacePath}/plugins/${pluginName}`] : []
      })
    )
  )
}

export async function getLocalTerminalSnapshot(sessionId: string): Promise<LocalTerminalSnapshot> {
  return requestDshTerminal<LocalTerminalSnapshot>('terminal.snapshot', {
    session_id: sessionId,
  })
}

export async function startLocalHarness({
  harnessId,
  prompt,
  isPrimary,
  projectId,
  executablePath,
  args,
  pluginRoots,
  cwd,
  rows,
  cols,
  env,
  proxyToken,
  modelKey,
  resumeSessionId,
}: StartLocalHarnessOptions): Promise<string> {
  if (!isLocalHarnessAvailable()) {
    throw new Error(i18n.t('localRuntime:local_terminal_unavailable'))
  }

  const trimmedCwd = cwd?.trim()
  const normalizedEnv = normalizeLocalTerminalEnv(env)
  const payload: {
    harnessId: LocalHarnessId
    prompt: string
    isPrimary: boolean
    projectId: number | null
    executablePath: string | null
    args: string[]
    pluginRoots: string[]
    cwd: string | null
    rows?: number
    cols?: number
    env?: Record<string, string>
    proxyToken?: string
    modelKey: string | null
    resumeSessionId: string | null
  } = {
    harnessId,
    prompt,
    isPrimary,
    projectId,
    executablePath: executablePath?.trim() || null,
    args: args ?? [],
    pluginRoots: pluginRoots ?? [],
    cwd: trimmedCwd || null,
    rows,
    cols,
    proxyToken: proxyToken?.trim() || undefined,
    modelKey: modelKey?.trim() || null,
    resumeSessionId: resumeSessionId?.trim() || null,
  }
  if (normalizedEnv) {
    payload.env = normalizedEnv
  }

  const persisted = resumeSessionId
    ? readElectronHarnessSessions().find(session => session.session_id === resumeSessionId)
    : undefined
  const sessionId = persisted?.session_id ?? `local-harness-${Date.now()}-${crypto.randomUUID()}`
  const nativeSessionId =
    harnessId === 'claude_code' ? persisted?.native_session_id || crypto.randomUUID() : null
  let launchArgs = [...payload.args]
  if (persisted) {
    if (harnessId === 'claude_code' && nativeSessionId) {
      launchArgs.push('--resume', nativeSessionId)
    } else {
      launchArgs.push('--continue')
    }
  } else if (harnessId === 'claude_code' && nativeSessionId) {
    launchArgs.push('--session-id', nativeSessionId)
  }
  if (!persisted && payload.prompt.trim()) {
    if (harnessId === 'opencode') {
      launchArgs.push('--prompt', payload.prompt.trim())
    } else if (harnessId === 'claude_code') {
      launchArgs.push(payload.prompt.trim())
    } else if (harnessId === 'kimi_code') {
      launchArgs.push('--prompt', payload.prompt.trim())
    }
  }
  const prepared = await requestLocalExecutor<PreparedLocalHarnessLaunch>(
    'executor.harnesses.prepare_launch',
    {
      harness_id: harnessId,
      session_id: sessionId,
      cwd: payload.cwd,
      args: launchArgs,
      uses_wework_model: Boolean(payload.proxyToken),
      accept_bypass_permissions:
        harnessId === 'claude_code' &&
        (launchArgs.includes('--dangerously-skip-permissions') ||
          launchArgs.some(
            (argument, index) =>
              argument === '--permission-mode' && launchArgs[index + 1] === 'bypassPermissions'
          )),
    }
  )
  launchArgs = prepared.args
  const launchEnv = { ...(payload.env ?? {}), ...prepared.env }
  await requestDshTerminal('terminal.start', {
    session_id: sessionId,
    executable: payload.executablePath,
    args: launchArgs,
    cwd: payload.cwd,
    rows: payload.rows,
    cols: payload.cols,
    env: launchEnv,
  })
  const descriptor: PersistedLocalHarnessSession = {
    session_id: sessionId,
    harness_id: harnessId,
    title:
      persisted?.title ||
      payload.prompt.split(/\r?\n/, 1)[0]?.trim().slice(0, 80) ||
      (harnessId === 'opencode'
        ? 'OpenCode'
        : harnessId === 'claude_code'
          ? 'Claude Code'
          : 'Kimi Code'),
    cwd: payload.cwd || '',
    created_at: persisted?.created_at ?? Date.now(),
    is_primary: persisted?.is_primary ?? isPrimary,
    project_id: persisted?.project_id ?? projectId,
    active: true,
    archived_at: null,
    model_key: modelKey,
    plugin_roots: pluginRoots ?? [],
    proxy_token: proxyToken,
    native_session_id: nativeSessionId,
  }
  updateElectronHarnessSessions(sessions => [
    descriptor,
    ...sessions.filter(session => session.session_id !== sessionId),
  ])
  return sessionId
}

function readElectronHarnessSessions(): PersistedLocalHarnessSession[] {
  if (typeof window === 'undefined') return []
  try {
    const value = JSON.parse(window.localStorage.getItem(ELECTRON_HARNESS_SESSIONS_KEY) ?? '[]')
    return Array.isArray(value) ? (value as PersistedLocalHarnessSession[]) : []
  } catch {
    return []
  }
}

function updateElectronHarnessSessions(
  update: (sessions: PersistedLocalHarnessSession[]) => PersistedLocalHarnessSession[]
) {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(
    ELECTRON_HARNESS_SESSIONS_KEY,
    JSON.stringify(update(readElectronHarnessSessions()))
  )
}

function normalizeLocalTerminalEnv(env?: Record<string, string | null | undefined>) {
  if (!env) return null

  const entries = Object.entries(env).flatMap(([key, value]) => {
    const normalizedKey = key.trim()
    if (!normalizedKey || normalizedKey.includes('=') || value == null) return []

    return [[normalizedKey, value]]
  })

  return entries.length > 0 ? Object.fromEntries(entries) : null
}

function normalizeLocalTerminalDiagnosticContext(
  context?: LocalTerminalDiagnosticContext
): Required<LocalTerminalDiagnosticContext> {
  return {
    taskId: context?.taskId?.trim() || null,
    workspacePath: context?.workspacePath?.trim() || null,
    reason: context?.reason?.trim() || null,
  }
}

function formatLocalTerminalError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export interface OpenLocalWorkspaceOptions {
  opener: LocalWorkspaceOpenerId
  path?: string
}

export async function openLocalWorkspace({
  opener,
  path,
}: OpenLocalWorkspaceOptions): Promise<void> {
  if (!isLocalTerminalAvailable()) {
    throw new Error(i18n.t('localRuntime:local_workspace_opening_unavailable'))
  }

  const trimmedPath = path?.trim()
  if (!trimmedPath) {
    throw new Error('Local workspace path is empty')
  }

  await invokeDesktopHost<void>('workspace.open', {
    opener,
    path: trimmedPath,
  })
}

export interface LocalWorkspaceOpenerAvailability {
  id: LocalWorkspaceOpenerId
  category: string
  available: boolean
  label?: string
}

export async function listLocalWorkspaceOpeners(): Promise<LocalWorkspaceOpenerAvailability[]> {
  if (!isLocalTerminalAvailable()) {
    return []
  }

  return invokeDesktopHost<LocalWorkspaceOpenerAvailability[]>('workspace.listOpeners')
}

export async function pickLocalWorkspaceOpenerExe(): Promise<string | null> {
  if (!isLocalTerminalAvailable()) {
    return null
  }

  return invokeDesktopHost<string | null>('workspace.pickOpener')
}

export async function openLocalFile(path?: string): Promise<void> {
  if (!isLocalTerminalAvailable()) {
    throw new Error(i18n.t('localRuntime:local_file_opening_unavailable'))
  }

  const trimmedPath = path?.trim()
  if (!trimmedPath) {
    throw new Error('Local file path is empty')
  }

  await invokeDesktopHost<void>('shell.openPath', { path: trimmedPath })
}

export async function revealLocalFile(path?: string): Promise<void> {
  if (!isLocalTerminalAvailable()) {
    throw new Error(i18n.t('localRuntime:local_file_revealing_unavailable'))
  }

  const trimmedPath = path?.trim()
  if (!trimmedPath) {
    throw new Error('Local file path is empty')
  }

  await invokeDesktopHost<void>('shell.showItemInFolder', { path: trimmedPath })
}

export interface LocalFileOpener {
  name: string
  path: string
  icon_path: string | null
}

export interface LocalFileOpeners {
  default_path: string | null
  applications: LocalFileOpener[]
}

export async function listLocalFileOpeners(path?: string): Promise<LocalFileOpeners> {
  if (!isLocalTerminalAvailable()) {
    throw new Error(i18n.t('localRuntime:local_file_opening_unavailable'))
  }

  const trimmedPath = path?.trim()
  if (!trimmedPath) {
    throw new Error('Local file path is empty')
  }

  return { default_path: null, applications: [] }
}

export async function getLocalFileOpenerIcon(iconPath?: string): Promise<string> {
  if (!isLocalTerminalAvailable()) {
    throw new Error(i18n.t('localRuntime:local_app_icons_unavailable'))
  }

  const trimmedIconPath = iconPath?.trim()
  if (!trimmedIconPath) {
    throw new Error('Local application icon path is empty')
  }

  throw new Error('Local application icons are not available in Electron')
}

export function getCachedLocalFileOpenerIcon(iconPath?: string | null): string | null {
  void iconPath
  return null
}

export async function openLocalFileWithApplication(
  applicationPath: string,
  path?: string
): Promise<void> {
  if (!isLocalTerminalAvailable()) {
    throw new Error(i18n.t('localRuntime:local_file_opening_unavailable'))
  }

  const trimmedPath = path?.trim()
  if (!trimmedPath || !applicationPath.trim()) {
    throw new Error('Local file path or application path is empty')
  }

  throw new Error('Opening a local file with a selected application is not available in Electron')
}

export async function writeLocalTerminal(sessionId: string, data: string): Promise<void> {
  await requestDshTerminal('terminal.input', {
    session_id: sessionId,
    data,
  })
}

export async function attachLocalTerminal(
  sessionId: string,
  diagnosticContext?: LocalTerminalDiagnosticContext
): Promise<void> {
  void sessionId
  void diagnosticContext
}

export async function resizeLocalTerminal(
  sessionId: string,
  rows: number,
  cols: number
): Promise<void> {
  await requestDshTerminal('terminal.resize', {
    session_id: sessionId,
    rows,
    cols,
  })
}

export async function closeLocalTerminal(
  sessionId: string,
  diagnosticContext?: LocalTerminalDiagnosticContext
): Promise<void> {
  const context = normalizeLocalTerminalDiagnosticContext(diagnosticContext)
  console.info('Local terminal close requested', { sessionId, ...context })
  try {
    await requestDshTerminal('terminal.close', { session_id: sessionId })
    console.info('Local terminal close succeeded', { sessionId, ...context })
  } catch (error) {
    console.error('Local terminal close failed', {
      sessionId,
      ...context,
      error: formatLocalTerminalError(error),
    })
    throw error
  }
}

export function listenLocalTerminalOutput(
  handler: (payload: LocalTerminalOutputPayload) => void
): Promise<UnlistenFn> {
  return Promise.resolve(
    subscribeDshTerminalEvents(event => {
      if (event.event === 'terminal.output') {
        handler(event.payload as unknown as LocalTerminalOutputPayload)
      }
    })
  )
}

export function listenLocalTerminalExit(
  handler: (payload: LocalTerminalExitPayload) => void
): Promise<UnlistenFn> {
  return Promise.resolve(
    subscribeDshTerminalEvents(event => {
      if (event.event === 'terminal.exit') {
        handler(event.payload as unknown as LocalTerminalExitPayload)
      }
    })
  )
}

type LocalTerminalConnectionStage = 'listen-output' | 'listen-exit' | 'snapshot' | 'attach'
export type LocalTerminalOutputSource = 'snapshot' | 'live'

function logLocalTerminalConnectionFailure(
  sessionId: string,
  stage: LocalTerminalConnectionStage,
  diagnosticContext: LocalTerminalDiagnosticContext | undefined,
  error: unknown
) {
  const context = normalizeLocalTerminalDiagnosticContext(diagnosticContext)
  console.error('Local terminal connection failed', {
    sessionId,
    stage,
    ...context,
    error: formatLocalTerminalError(error),
  })
}

export async function connectLocalTerminal(
  sessionId: string,
  onOutput: (payload: LocalTerminalOutputPayload, source: LocalTerminalOutputSource) => void,
  onExit: (payload: LocalTerminalExitPayload) => void,
  diagnosticContext?: LocalTerminalDiagnosticContext
): Promise<UnlistenFn> {
  const context = normalizeLocalTerminalDiagnosticContext(diagnosticContext)
  console.info('Local terminal connection requested', { sessionId, ...context })
  let snapshotLoaded = false
  let lastSequence = 0
  const pendingOutput: LocalTerminalOutputPayload[] = []
  const handleOutput = (payload: LocalTerminalOutputPayload) => {
    if (payload.session_id !== sessionId || payload.sequence <= lastSequence) return
    if (!snapshotLoaded) {
      pendingOutput.push(payload)
      return
    }
    lastSequence = payload.sequence
    onOutput(payload, 'live')
  }
  let outputUnlisten: UnlistenFn
  try {
    outputUnlisten = await listenLocalTerminalOutput(handleOutput)
    console.info('Local terminal connection stage succeeded', {
      sessionId,
      stage: 'listen-output',
      ...context,
    })
  } catch (error) {
    logLocalTerminalConnectionFailure(sessionId, 'listen-output', context, error)
    throw error
  }

  let exitUnlisten: UnlistenFn
  try {
    exitUnlisten = await listenLocalTerminalExit(payload => {
      if (payload.session_id === sessionId) {
        onExit(payload)
      }
    })
    console.info('Local terminal connection stage succeeded', {
      sessionId,
      stage: 'listen-exit',
      ...context,
    })
  } catch (error) {
    outputUnlisten()
    logLocalTerminalConnectionFailure(sessionId, 'listen-exit', context, error)
    throw error
  }

  try {
    const snapshot = await getLocalTerminalSnapshot(sessionId)
    lastSequence = snapshot.sequence
    onOutput(snapshot, 'snapshot')
    snapshotLoaded = true
    pendingOutput.sort((left, right) => left.sequence - right.sequence).forEach(handleOutput)
    console.info('Local terminal connection stage succeeded', {
      sessionId,
      stage: 'snapshot',
      ...context,
    })
  } catch (error) {
    outputUnlisten()
    exitUnlisten()
    logLocalTerminalConnectionFailure(sessionId, 'snapshot', context, error)
    throw error
  }

  try {
    await attachLocalTerminal(sessionId, context)
    console.info('Local terminal connection stage succeeded', {
      sessionId,
      stage: 'attach',
      ...context,
    })
  } catch (error) {
    outputUnlisten()
    exitUnlisten()
    logLocalTerminalConnectionFailure(sessionId, 'attach', context, error)
    throw error
  }

  return () => {
    outputUnlisten()
    exitUnlisten()
  }
}
