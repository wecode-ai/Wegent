import { invoke } from '@tauri-apps/api/core'

export type ExecutionEnvironmentState =
  | 'idle'
  | 'downloading'
  | 'installed'
  | 'notInstalled'
  | 'error'

export interface ExecutionEnvironmentStatus {
  id: 'node' | 'python'
  managed: boolean
  autoInstall: boolean
  state: ExecutionEnvironmentState
  version: string | null
  downloadedBytes: number
  totalBytes: number
  installedBytes: number
  path: string | null
  error: string | null
}

export function listExecutionEnvironments() {
  return invoke<ExecutionEnvironmentStatus[]>('list_execution_environments')
}

export function installExecutionEnvironment(id: ExecutionEnvironmentStatus['id']) {
  return invoke<ExecutionEnvironmentStatus>('install_execution_environment', { id })
}

export function removeExecutionEnvironment(id: ExecutionEnvironmentStatus['id']) {
  return invoke<void>('remove_execution_environment', { id })
}
