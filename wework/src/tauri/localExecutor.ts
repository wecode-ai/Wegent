import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

export const LOCAL_EXECUTOR_COMMANDS = {
  ensure: 'local_executor_ensure_started',
  status: 'local_executor_status',
  request: 'local_executor_request',
  restart: 'local_executor_restart',
} as const

export const LOCAL_EXECUTOR_EVENT = 'local-executor:event'

export interface LocalExecutorStatus {
  running: boolean
  ready?: boolean
  deviceId?: string
  version?: string
  error?: string
}

export interface LocalExecutorEvent {
  event: string
  payload: Record<string, unknown>
}

export function ensureLocalExecutorStarted(): Promise<LocalExecutorStatus> {
  return invoke<LocalExecutorStatus>(LOCAL_EXECUTOR_COMMANDS.ensure)
}

export function getLocalExecutorStatus(): Promise<LocalExecutorStatus> {
  return invoke<LocalExecutorStatus>(LOCAL_EXECUTOR_COMMANDS.status)
}

export function restartLocalExecutor(): Promise<LocalExecutorStatus> {
  return invoke<LocalExecutorStatus>(LOCAL_EXECUTOR_COMMANDS.restart)
}

export function requestLocalExecutor<T = unknown>(
  method: string,
  params: Record<string, unknown> = {}
): Promise<T> {
  return invoke<T>(LOCAL_EXECUTOR_COMMANDS.request, { method, params })
}

export function subscribeLocalExecutorEvents(
  handler: (event: LocalExecutorEvent) => void
): Promise<UnlistenFn> {
  return listen<LocalExecutorEvent>(LOCAL_EXECUTOR_EVENT, event => {
    handler(event.payload)
  })
}
