export interface WeworkUpdateDownloadProgress {
  downloadedBytes: number
  totalBytes: number | null
  phase?: 'preparing' | 'components' | 'host' | 'verifying' | 'ready'
  completedComponents?: number
  totalComponents?: number
  mode?: 'differential' | 'full'
  reason?: string
}

export interface ComponentDownloadProgress {
  stageId?: string
  downloadedBytes: number
  totalBytes: number
  completedComponents: number
  totalComponents: number
}

export interface HostDownloadPhase {
  phase?: 'verifying'
  mode: 'differential' | 'full'
  reason?: string
  totalBytes?: number
}
