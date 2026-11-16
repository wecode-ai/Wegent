export interface WeworkUpdateFailure {
  message: string
  code?: string
  stage?: WeworkUpdateFailureStage
  retryable?: boolean
}

export type WeworkUpdateFailureStage =
  | 'check'
  | 'download'
  | 'extract'
  | 'verify'
  | 'prepare'
  | 'install'

export interface WeworkUpdateRetryConfirmation {
  token: string
  version: string
  reason: 'startup-failed' | 'rolled-back' | 'legacy-rollback'
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
  readyToInstall: boolean
  body?: string
  targetVersion?: string
  path?: string[]
  retryConfirmation?: WeworkUpdateRetryConfirmation
}

export interface ComponentDownloadProgress {
  stageId?: string
  downloadedBytes: number
  totalBytes: number
  completedComponents: number
  totalComponents: number
}
