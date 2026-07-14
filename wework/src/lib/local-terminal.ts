import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
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

  return isTauriRuntime() && isMacOs && !isIosLike
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

export interface StartLocalTerminalOptions {
  cwd?: string
  rows?: number
  cols?: number
  env?: Record<string, string | null | undefined>
}

export interface LocalTerminalOutputPayload {
  session_id: string
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
    throw new Error('Local terminal is unavailable outside the macOS Tauri app')
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
    throw new Error('Local workspace opening is unavailable outside the macOS Tauri app')
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
    throw new Error('Local file opening is unavailable outside the macOS Tauri app')
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
    throw new Error('Local file revealing is unavailable outside the macOS Tauri app')
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
    throw new Error('Local file opening is unavailable outside the macOS Tauri app')
  }

  const trimmedPath = path?.trim()
  if (!trimmedPath) {
    throw new Error('Local file path is empty')
  }

  return invoke<LocalFileOpeners>('list_local_file_openers', { path: trimmedPath })
}

export async function getLocalFileOpenerIcon(iconPath?: string): Promise<string> {
  if (!isLocalTerminalAvailable()) {
    throw new Error('Local application icons are unavailable outside the macOS Tauri app')
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
    throw new Error('Local file opening is unavailable outside the macOS Tauri app')
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
