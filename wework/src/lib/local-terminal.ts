import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import i18n from '@/i18n'
import type { LocalHarnessId } from './local-harness'
import type { LocalWorkspaceOpenerId } from './local-workspace-openers'
import { isTauriRuntime } from './runtime-environment'

const localFileOpenerIconCache = new Map<string, string>()
const localFileOpenerIconRequests = new Map<string, Promise<string>>()

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
    isTauriRuntime() &&
    !platform.isIosLike &&
    (platform.isMacOs || platform.isWindows || import.meta.env.VITE_WEWORK_E2E === 'true')
  )
}

export function isLocalHarnessAvailable(): boolean {
  return isLocalTerminalAvailable()
}

export async function getLocalExecutorDeviceId(
  expectedBackendUrl?: string
): Promise<string | null> {
  if (!isLocalTerminalAvailable()) return null

  const deviceId = await invoke<string | null>('get_local_executor_device_id', {
    expectedBackendUrl: expectedBackendUrl?.trim() || null,
  })
  return deviceId?.trim() || null
}

export async function localPathExists(path?: string): Promise<boolean> {
  if (!isLocalTerminalAvailable()) return false

  const trimmedPath = path?.trim()
  if (!trimmedPath) return false

  return invoke<boolean>('local_path_exists', { path: trimmedPath })
}

export type LocalPathKind = 'file' | 'directory' | 'other'

export async function getLocalPathKind(path?: string): Promise<LocalPathKind | null> {
  if (!isLocalTerminalAvailable()) return null

  const trimmedPath = path?.trim()
  if (!trimmedPath) return null

  return invoke<LocalPathKind | null>('get_local_path_kind', { path: trimmedPath })
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
  proxy_token?: string
}

export interface LocalTerminalSnapshot {
  session_id: string
  sequence: number
  data: string
}

export interface StartLocalHarnessOptions extends StartLocalTerminalOptions {
  harnessId: LocalHarnessId
  prompt: string
  executablePath?: string | null
  args?: string[]
  proxyToken?: string
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
    const sessionId = await invoke<string>('start_local_terminal', payload)
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

  return invoke<LocalHarnessDescriptor[]>('list_local_harnesses', {
    executableOverrides,
  })
}

export async function listLocalHarnessSessions(): Promise<LocalHarnessSessionDescriptor[]> {
  if (!isLocalHarnessAvailable()) return []

  return invoke<LocalHarnessSessionDescriptor[]>('list_local_harness_sessions')
}

export async function getLocalTerminalSnapshot(sessionId: string): Promise<LocalTerminalSnapshot> {
  return invoke<LocalTerminalSnapshot>('get_local_terminal_snapshot', { sessionId })
}

export async function startLocalHarness({
  harnessId,
  prompt,
  executablePath,
  args,
  cwd,
  rows,
  cols,
  env,
  proxyToken,
}: StartLocalHarnessOptions): Promise<string> {
  if (!isLocalHarnessAvailable()) {
    throw new Error(i18n.t('localRuntime:local_terminal_unavailable'))
  }

  const trimmedCwd = cwd?.trim()
  const normalizedEnv = normalizeLocalTerminalEnv(env)
  const payload: {
    harnessId: LocalHarnessId
    prompt: string
    executablePath: string | null
    args: string[]
    cwd: string | null
    rows?: number
    cols?: number
    env?: Record<string, string>
    proxyToken?: string
  } = {
    harnessId,
    prompt,
    executablePath: executablePath?.trim() || null,
    args: args ?? [],
    cwd: trimmedCwd || null,
    rows,
    cols,
    proxyToken: proxyToken?.trim() || undefined,
  }
  if (normalizedEnv) {
    payload.env = normalizedEnv
  }

  return invoke<string>('start_local_harness', { request: payload })
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

  await invoke('open_local_workspace', {
    opener,
    path: trimmedPath,
  })
}

export async function openLocalFile(path?: string): Promise<void> {
  if (!isLocalTerminalAvailable()) {
    throw new Error(i18n.t('localRuntime:local_file_opening_unavailable'))
  }

  const trimmedPath = path?.trim()
  if (!trimmedPath) {
    throw new Error('Local file path is empty')
  }

  await invoke('open_local_file', {
    path: trimmedPath,
  })
}

export async function revealLocalFile(path?: string): Promise<void> {
  if (!isLocalTerminalAvailable()) {
    throw new Error(i18n.t('localRuntime:local_file_revealing_unavailable'))
  }

  const trimmedPath = path?.trim()
  if (!trimmedPath) {
    throw new Error('Local file path is empty')
  }

  await invoke('reveal_local_file', { path: trimmedPath })
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

  return invoke<LocalFileOpeners>('list_local_file_openers', { path: trimmedPath })
}

export async function getLocalFileOpenerIcon(iconPath?: string): Promise<string> {
  if (!isLocalTerminalAvailable()) {
    throw new Error(i18n.t('localRuntime:local_app_icons_unavailable'))
  }

  const trimmedIconPath = iconPath?.trim()
  if (!trimmedIconPath) {
    throw new Error('Local application icon path is empty')
  }

  const cached = localFileOpenerIconCache.get(trimmedIconPath)
  if (cached) return cached

  const pending = localFileOpenerIconRequests.get(trimmedIconPath)
  if (pending) return pending

  const request = invoke<string>('get_local_file_opener_icon', { iconPath: trimmedIconPath })
    .then(icon => {
      localFileOpenerIconCache.set(trimmedIconPath, icon)
      return icon
    })
    .finally(() => {
      localFileOpenerIconRequests.delete(trimmedIconPath)
    })
  localFileOpenerIconRequests.set(trimmedIconPath, request)
  return request
}

export function getCachedLocalFileOpenerIcon(iconPath?: string | null): string | null {
  const trimmedIconPath = iconPath?.trim()
  return trimmedIconPath ? (localFileOpenerIconCache.get(trimmedIconPath) ?? null) : null
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

  await invoke('open_local_file_with_application', {
    applicationPath: applicationPath.trim(),
    path: trimmedPath,
  })
}

export async function writeLocalTerminal(sessionId: string, data: string): Promise<void> {
  await invoke('write_local_terminal', {
    sessionId,
    data,
  })
}

export async function attachLocalTerminal(
  sessionId: string,
  diagnosticContext?: LocalTerminalDiagnosticContext
): Promise<void> {
  const context = normalizeLocalTerminalDiagnosticContext(diagnosticContext)
  await invoke('attach_local_terminal', {
    sessionId,
    taskId: context.taskId,
    workspacePath: context.workspacePath,
  })
}

export async function resizeLocalTerminal(
  sessionId: string,
  rows: number,
  cols: number
): Promise<void> {
  await invoke('resize_local_terminal', {
    sessionId,
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
    await invoke('close_local_terminal', {
      sessionId,
      taskId: context.taskId,
      workspacePath: context.workspacePath,
      reason: context.reason,
    })
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
  return listen<LocalTerminalOutputPayload>('local-terminal-output', event => {
    handler(event.payload)
  })
}

export function listenLocalTerminalExit(
  handler: (payload: LocalTerminalExitPayload) => void
): Promise<UnlistenFn> {
  return listen<LocalTerminalExitPayload>('local-terminal-exit', event => {
    handler(event.payload)
  })
}

type LocalTerminalConnectionStage = 'listen-output' | 'listen-exit' | 'snapshot' | 'attach'

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
  onOutput: (payload: LocalTerminalOutputPayload) => void,
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
    onOutput(payload)
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
    if (snapshot.data) {
      onOutput(snapshot)
    }
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
