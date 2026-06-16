import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { isTauriRuntime } from './runtime-environment'

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
}: StartLocalTerminalOptions = {}): Promise<string> {
  if (!isLocalTerminalAvailable()) {
    throw new Error('Local terminal is unavailable outside the macOS Tauri app')
  }

  const trimmedCwd = cwd?.trim()
  return invoke<string>('start_local_terminal', {
    cwd: trimmedCwd || null,
    rows,
    cols,
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
