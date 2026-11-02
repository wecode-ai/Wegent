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
    | 'upToDate'
    | 'installing'
    | 'failed'
  completedComponents?: number
  totalComponents?: number
  failure?: WeworkUpdateFailure
  update?: WeworkUpdateInfo | null
}

export type WeworkUpdateChannel = 'stable' | 'beta'

export interface WeworkUpdateInfo {
  currentVersion: string
  version: string
  body?: string
  targetVersion?: string
  path?: string[]
}

export interface ComponentDownloadProgress {
  stageId?: string
  downloadedBytes: number
  totalBytes: number
  completedComponents: number
  totalComponents: number
}
