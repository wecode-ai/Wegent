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
  return Promise.resolve<ExecutionEnvironmentStatus[]>([])
}

export function installExecutionEnvironment(id: ExecutionEnvironmentStatus['id']) {
  return Promise.reject<ExecutionEnvironmentStatus>(
    new Error(`Managed ${id} installation is unavailable in Electron`)
  )
}

export function removeExecutionEnvironment(id: ExecutionEnvironmentStatus['id']) {
  return Promise.reject<void>(new Error(`Managed ${id} removal is unavailable in Electron`))
}
