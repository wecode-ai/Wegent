import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import i18n from '@/i18n'
import type { LocalHarnessId } from './local-harness'
import type { LocalWorkspaceOpenerId } from './local-workspace-openers'
import { isTauriRuntime } from './runtime-environment'

const localFileOpenerIconCache = new Map<string, string>()
const localFileOpenerIconRequests = new Map<string, Promise<string>>()

export function isLocalTerminalAvailable(): boolean {
  if (typeof navigator === 'undefined') return false

  const userAgent = navigator.userAgent || ''
  const platform = navigator.platform || ''
  const isIosLike =
    /iPad|iPhone|iPod/.test(userAgent) || (platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  const isMacOs = platform.startsWith('Mac') || userAgent.includes('Mac OS X')
  const isWindows = platform.startsWith('Win') || /Windows NT/.test(userAgent)
  const isDesktopE2E = import.meta.env.VITE_WEWORK_E2E === 'true'

  return isTauriRuntime() && (isMacOs || isWindows || isDesktopE2E) && !isIosLike
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
}: StartLocalTerminalOptions = {}): Promise<string> {
  if (!isLocalTerminalAvailable()) {
    throw new Error(i18n.t('localRuntime:local_terminal_unavailable'))
  }

  const trimmedCwd = cwd?.trim()
  const normalizedEnv = normalizeLocalTerminalEnv(env)
  const payload: {
    cwd: string | null
    rows?: number
    cols?: number
    env?: Record<string, string>
  } = {
    cwd: trimmedCwd || null,
    rows,
    cols,
  }
  if (normalizedEnv) {
    payload.env = normalizedEnv
  }

  return invoke<string>('start_local_terminal', payload)
}

export async function listLocalHarnesses(
  executableOverrides: Partial<Record<LocalHarnessId, string | null>> = {}
): Promise<LocalHarnessDescriptor[]> {
  if (!isLocalTerminalAvailable()) return []

  return invoke<LocalHarnessDescriptor[]>('list_local_harnesses', {
    executableOverrides,
  })
}

export async function listLocalHarnessSessions(): Promise<LocalHarnessSessionDescriptor[]> {
  if (!isLocalTerminalAvailable()) return []

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
}: StartLocalHarnessOptions): Promise<string> {
  if (!isLocalTerminalAvailable()) {
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
  } = {
    harnessId,
    prompt,
    executablePath: executablePath?.trim() || null,
    args: args ?? [],
    cwd: trimmedCwd || null,
    rows,
    cols,
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

export async function attachLocalTerminal(sessionId: string): Promise<void> {
  await invoke('attach_local_terminal', {
    sessionId,
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

export async function closeLocalTerminal(sessionId: string): Promise<void> {
  await invoke('close_local_terminal', {
    sessionId,
  })
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
  error: unknown
) {
  console.error('Local terminal connection failed', {
    sessionId,
    stage,
    error: error instanceof Error ? error.message : String(error),
  })
}

export async function connectLocalTerminal(
  sessionId: string,
  onOutput: (payload: LocalTerminalOutputPayload) => void,
  onExit: (payload: LocalTerminalExitPayload) => void
): Promise<UnlistenFn> {
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
  } catch (error) {
    logLocalTerminalConnectionFailure(sessionId, 'listen-output', error)
    throw error
  }

  let exitUnlisten: UnlistenFn
  try {
    exitUnlisten = await listenLocalTerminalExit(payload => {
      if (payload.session_id === sessionId) {
        onExit(payload)
      }
    })
  } catch (error) {
    outputUnlisten()
    logLocalTerminalConnectionFailure(sessionId, 'listen-exit', error)
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
  } catch (error) {
    outputUnlisten()
    exitUnlisten()
    logLocalTerminalConnectionFailure(sessionId, 'snapshot', error)
    throw error
  }

  try {
    await attachLocalTerminal(sessionId)
  } catch (error) {
    outputUnlisten()
    exitUnlisten()
    logLocalTerminalConnectionFailure(sessionId, 'attach', error)
    throw error
  }

  return () => {
    outputUnlisten()
    exitUnlisten()
  }
}
