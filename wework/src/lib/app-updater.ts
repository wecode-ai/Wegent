import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import { isElectronRuntime } from './runtime-environment'
import { getPlatform } from './platform'

export type WeworkUpdateChannel = 'stable' | 'beta'

export interface WeworkUpdateInfo {
  currentVersion: string
  version: string
  body?: string
}

import type { WeworkUpdateDownloadProgress } from '../../electron/src/host/app-update-progress'
export type { WeworkUpdateDownloadProgress } from '../../electron/src/host/app-update-progress'

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
  getWeworkUpdateTarget(channel)

  try {
    const update = await invokeDesktopHost<WeworkUpdateInfo | null>('appUpdate.check', { channel })
    if (!update) {
      pendingUpdate = null
      return null
    }
    pendingUpdate = {
      ...update,
      download: async onProgress => {
        const timer = onProgress
          ? window.setInterval(() => {
              void invokeDesktopHost<WeworkUpdateDownloadProgress>('appUpdate.downloadProgress')
                .then(onProgress)
                .catch(() => undefined)
            }, 250)
          : null
        try {
          await invokeDesktopHost<void>('appUpdate.download')
        } finally {
          if (timer !== null) window.clearInterval(timer)
          if (onProgress) {
            const progress = await invokeDesktopHost<WeworkUpdateDownloadProgress>(
              'appUpdate.downloadProgress'
            ).catch(() => null)
            if (progress) onProgress(progress)
          }
        }
      },
      install: () => invokeDesktopHost<void>('appUpdate.install'),
    }
    return update
  } catch (error) {
    pendingUpdate = null
    throw new Error(errorMessage(error), { cause: error })
  }
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

export async function installDownloadedWeworkUpdate(): Promise<void> {
  if (!pendingUpdate) {
    throw new Error('No pending Wework update is available.')
  }

  try {
    await pendingUpdate.install()
  } catch (error) {
    pendingUpdate = null
    throw new Error(errorMessage(error), { cause: error })
  }
}
