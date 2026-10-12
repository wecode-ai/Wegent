export interface WeworkUpdateDownloadProgress {
  downloadedBytes: number
  totalBytes: number | null
  phase?: 'preparing' | 'components' | 'host' | 'ready'
  completedComponents?: number
  totalComponents?: number
}

export interface ComponentDownloadProgress {
  stageId?: string
  downloadedBytes: number
  totalBytes: number
  completedComponents: number
  totalComponents: number
}
