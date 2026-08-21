import { isTauriRuntime } from './runtime-environment'
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
  if (!isTauriRuntime()) {
    throw new Error('Wework updater is only available in the desktop app.')
  }

  try {
    const { check } = await import('@tauri-apps/plugin-updater')
    const update = await check({ target: getWeworkUpdateTarget(channel) })
    if (!update) {
      pendingUpdate = null
      return null
    }

    let downloaded = false
    let downloadPromise: Promise<void> | null = null
    let progress: WeworkUpdateDownloadProgress = {
      downloadedBytes: 0,
      totalBytes: null,
    }
    const progressListeners = new Set<(value: WeworkUpdateDownloadProgress) => void>()

    const notifyProgress = () => {
      for (const listener of progressListeners) {
        listener(progress)
      }
    }

    pendingUpdate = {
      version: update.version,
      currentVersion: update.currentVersion,
      body: update.body,
      download: async onProgress => {
        if (onProgress) {
          progressListeners.add(onProgress)
          onProgress(progress)
        }

        try {
          if (downloaded) return
          if (!downloadPromise) {
            downloadPromise = update
              .download(event => {
                if (event.event === 'Started') {
                  progress = {
                    downloadedBytes: 0,
                    totalBytes: event.data.contentLength ?? null,
                  }
                } else if (event.event === 'Progress') {
                  progress = {
                    ...progress,
                    downloadedBytes: progress.downloadedBytes + event.data.chunkLength,
                  }
                } else {
                  downloaded = true
                }
                notifyProgress()
              })
              .catch(error => {
                downloadPromise = null
                throw error
              })
          }
          await downloadPromise
          downloaded = true
        } finally {
          if (onProgress) {
            progressListeners.delete(onProgress)
          }
        }
      },
      install: () => update.install(),
    }

    return {
      version: update.version,
      currentVersion: update.currentVersion,
      body: update.body,
    }
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

export async function installPendingWeworkUpdate(
  onProgress: (progress: WeworkUpdateDownloadProgress) => void
): Promise<void> {
  if (!pendingUpdate) {
    throw new Error('No pending Wework update is available.')
  }

  try {
    await pendingUpdate.download(onProgress)
    await pendingUpdate.install()
    const { relaunch } = await import('@tauri-apps/plugin-process')
    await relaunch()
  } catch (error) {
    pendingUpdate = null
    throw new Error(errorMessage(error), { cause: error })
  }
}
