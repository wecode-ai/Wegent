export interface WeworkUpdateFailure {
  message: string
  code?: string
}

export interface WeworkUpdateDownloadProgress {
  downloadedBytes: number
  totalBytes: number | null
  phase?:
    | 'preparing'
    | 'components'
    | 'host'
    | 'extracting'
    | 'runtime'
    | 'ready'
    | 'installing'
    | 'failed'
  completedComponents?: number
  totalComponents?: number
  failure?: WeworkUpdateFailure
}

export interface ComponentDownloadProgress {
  stageId?: string
  downloadedBytes: number
  totalBytes: number
  completedComponents: number
  totalComponents: number
}
