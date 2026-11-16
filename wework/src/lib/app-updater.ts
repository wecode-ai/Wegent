import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import { isElectronRuntime } from './runtime-environment'
import { flushDesktopLocalStoragePersistence } from '@/desktop/localStoragePersistence'
import { getPlatform } from './platform'
import {
  createWeworkUpdateFailureError,
  WeworkUpdateRetryConfirmationError,
} from './app-updater-errors'

import type {
  WeworkUpdateChannel,
  WeworkUpdateDownloadProgress,
  WeworkUpdateInfo,
} from '../../electron/src/host/app-update-progress'
export type {
  WeworkUpdateChannel,
  WeworkUpdateDownloadProgress,
  WeworkUpdateInfo,
} from '../../electron/src/host/app-update-progress'

let pendingUpdate: (WeworkUpdateInfo & { channel: WeworkUpdateChannel }) | null = null

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return 'Unknown updater error'
}

function assertWeworkUpdaterSupported(): void {
  const platform = getPlatform()
  if (platform === 'linux') {
    throw new Error('Wework updater is not available on Linux.')
  }
}

export async function checkForWeworkUpdate(
  channel: WeworkUpdateChannel
): Promise<WeworkUpdateInfo | null> {
  if (!isElectronRuntime()) {
    throw new Error('Wework updater is only available in the desktop app.')
  }
  assertWeworkUpdaterSupported()

  try {
    const update = await invokeDesktopHost<WeworkUpdateInfo | null>('appUpdate.check', { channel })
    if (!update) {
      pendingUpdate = null
      return null
    }
    pendingUpdate = { ...update, channel }
    return update
  } catch (error) {
    if (pendingUpdate?.channel !== channel) pendingUpdate = null
    throw new Error(errorMessage(error), { cause: error })
  }
}

export async function downloadPendingWeworkUpdate(
  onProgress?: (progress: WeworkUpdateDownloadProgress) => void,
  retryToken?: string
): Promise<WeworkUpdateInfo | null> {
  if (!pendingUpdate) {
    throw new Error('No pending Wework update is available.')
  }

  const channel = pendingUpdate.channel
  try {
    await invokeDesktopHost<void>('appUpdate.download', {
      channel,
      ...(retryToken ? { retryToken } : {}),
    })
    const update = await waitForDownloadCompletion(onProgress)
    pendingUpdate = update ? { ...update, channel } : null
    return update
  } catch (error) {
    if (error instanceof WeworkUpdateRetryConfirmationError) {
      pendingUpdate = { ...error.update, channel }
      throw error
    }
    throw new Error(errorMessage(error), { cause: error })
  }
}

export async function installDownloadedWeworkUpdate(): Promise<void> {
  const update = pendingUpdate
  if (!update) {
    throw new Error('No pending Wework update is available.')
  }

  try {
    await flushDesktopLocalStoragePersistence()
    await invokeDesktopHost<void>('appUpdate.install', { version: update.version })
  } catch (error) {
    throw new Error(errorMessage(error), { cause: error })
  }
}

const DOWNLOAD_PROGRESS_POLL_MS = 250

/**
 * The desktop host owns the download, so the renderer follows the reported
 * progress until it reaches a terminal phase instead of holding one request
 * open for the whole download.
 */
async function waitForDownloadCompletion(
  onProgress?: (progress: WeworkUpdateDownloadProgress) => void
): Promise<WeworkUpdateInfo | null> {
  for (;;) {
    const progress = await invokeDesktopHost<WeworkUpdateDownloadProgress>(
      'appUpdate.downloadProgress'
    )
    if (progress.phase === 'failed') {
      if (progress.failure?.code === 'UPDATE_RETRY_CONFIRMATION_REQUIRED' && progress.update) {
        throw new WeworkUpdateRetryConfirmationError(progress.update)
      }
      throw createWeworkUpdateFailureError(progress.failure)
    }
    onProgress?.(progress)
    if (progress.phase === 'upToDate') return null
    if (progress.phase === 'ready') {
      if (!progress.update) throw new Error('The downloaded update has no version information.')
      return progress.update
    }
    await delay(DOWNLOAD_PROGRESS_POLL_MS)
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, ms))
}
