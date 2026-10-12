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
    pendingUpdate = {
      ...update,
      download: async onProgress => {
        await invokeDesktopHost<void>('appUpdate.download')
        await waitForDownloadCompletion(onProgress)
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

const DOWNLOAD_PROGRESS_POLL_MS = 250

/**
 * The desktop host owns the download, so the renderer follows the reported
 * progress until it reaches a terminal phase instead of holding one request
 * open for the whole download.
 */
async function waitForDownloadCompletion(
  onProgress?: (progress: WeworkUpdateDownloadProgress) => void
): Promise<void> {
  for (;;) {
    const progress = await invokeDesktopHost<WeworkUpdateDownloadProgress>(
      'appUpdate.downloadProgress'
    )
    if (progress.phase === 'failed') throw downloadFailureError(progress.failure)
    onProgress?.(progress)
    if (progress.phase === 'ready') return
    await delay(DOWNLOAD_PROGRESS_POLL_MS)
  }
}

function downloadFailureError(failure: WeworkUpdateDownloadProgress['failure']): Error {
  const error = new Error(failure?.message || 'Wework update download failed')
  if (failure?.code) Object.assign(error, { code: failure.code })
  return error
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, ms))
}
