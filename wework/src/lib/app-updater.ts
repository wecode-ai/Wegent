import { isElectronRuntime } from './runtime-environment'
import { getPlatform } from './platform'

export type WeworkUpdateChannel = 'stable' | 'beta'

export interface WeworkUpdateInfo {
  currentVersion: string
  version: string
  body?: string
}

export interface WeworkUpdateDownloadProgress {
  downloadedBytes: number
  totalBytes: number | null
}

interface PendingUpdate {
  version: string
  currentVersion: string
  body?: string
  download: (onProgress?: (progress: WeworkUpdateDownloadProgress) => void) => Promise<void>
  install: () => Promise<void>
}

let pendingUpdate: PendingUpdate | null = null

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return 'Unknown updater error'
}

export function getWeworkUpdateTarget(channel: WeworkUpdateChannel): string {
  const platform = getPlatform()
  if (platform === 'linux') {
    throw new Error('Wework updater is not available on Linux.')
  }
  return `${channel}-${platform === 'mac' ? 'darwin' : 'windows'}`
}

export async function checkForWeworkUpdate(
  channel: WeworkUpdateChannel
): Promise<WeworkUpdateInfo | null> {
  if (!isElectronRuntime()) {
    throw new Error('Wework updater is only available in the desktop app.')
  }

  void channel
  pendingUpdate = null
  throw new Error('Automatic updates are not yet available in the Electron desktop host.')
}

export async function downloadPendingWeworkUpdate(
  onProgress?: (progress: WeworkUpdateDownloadProgress) => void
): Promise<void> {
  if (!pendingUpdate) {
    throw new Error('No pending Wework update is available.')
  }

  try {
    await pendingUpdate.download(onProgress)
  } catch (error) {
    throw new Error(errorMessage(error), { cause: error })
  }
}

export async function installPendingWeworkUpdate(
  onProgress: (progress: WeworkUpdateDownloadProgress) => void
): Promise<void> {
  if (!pendingUpdate) {
    throw new Error('No pending Wework update is available.')
  }

  try {
    await pendingUpdate.download(onProgress)
    await pendingUpdate.install()
  } catch (error) {
    pendingUpdate = null
    throw new Error(errorMessage(error), { cause: error })
  }
}
