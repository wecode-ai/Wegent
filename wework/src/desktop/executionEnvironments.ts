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
  source?: 'electron' | 'configured' | 'system'
  configuredPath?: string | null
  restartRequired?: boolean
}

export function listExecutionEnvironments() {
  return window.weworkElectronExecutionEnvironments?.list() ?? Promise.resolve([])
}

export function chooseNodeExecutable() {
  return (
    window.weworkElectronExecutionEnvironments?.chooseNodeExecutable() ??
    Promise.reject(new Error('Node.js selection is unavailable outside Electron'))
  )
}

export function useBuiltinNode() {
  return (
    window.weworkElectronExecutionEnvironments?.useBuiltinNode() ??
    Promise.reject(new Error('Node.js configuration is unavailable outside Electron'))
  )
}

declare global {
  interface Window {
    weworkElectronExecutionEnvironments?: {
      list(): Promise<ExecutionEnvironmentStatus[]>
      chooseNodeExecutable(): Promise<{ path: string; version: string } | null>
      useBuiltinNode(): Promise<void>
    }
  }
}
