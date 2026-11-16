import type {
  WeworkUpdateDownloadProgress,
  WeworkUpdateInfo,
} from '../../electron/src/host/app-update-progress'

export class WeworkUpdateRetryConfirmationError extends Error {
  readonly code = 'UPDATE_RETRY_CONFIRMATION_REQUIRED'
  readonly stage = 'check'
  readonly update: WeworkUpdateInfo

  constructor(update: WeworkUpdateInfo) {
    super('Retrying this update requires confirmation')
    this.name = 'WeworkUpdateRetryConfirmationError'
    this.update = update
  }
}

export function createWeworkUpdateFailureError(
  failure: WeworkUpdateDownloadProgress['failure']
): Error {
  return Object.assign(new Error(failure?.message || 'Wework update failed'), failure)
}
