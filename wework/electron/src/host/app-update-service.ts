import type { AppUpdater, UpdateInfo } from 'electron-updater'

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

interface AppUpdateServiceOptions {
  updater: AppUpdater
  currentVersion: () => string
  isPackaged: () => boolean
  prepareInstall: () => Promise<void>
  updateBaseUrl: string
}

export class AppUpdateService {
  private readonly updater: AppUpdater
  private readonly currentVersion: () => string
  private readonly isPackaged: () => boolean
  private readonly prepareInstall: () => Promise<void>
  private readonly updateBaseUrl: string
  private pendingVersion: string | null = null
  private downloadedVersion: string | null = null
  private downloadPromise: Promise<void> | null = null
  private progress: WeworkUpdateDownloadProgress = {
    downloadedBytes: 0,
    totalBytes: null,
  }

  constructor(options: AppUpdateServiceOptions) {
    this.updater = options.updater
    this.currentVersion = options.currentVersion
    this.isPackaged = options.isPackaged
    this.prepareInstall = options.prepareInstall
    this.updateBaseUrl = options.updateBaseUrl.replace(/\/+$/, '')
    this.updater.autoDownload = false
    this.updater.autoInstallOnAppQuit = false
  }

  async check(channel: WeworkUpdateChannel): Promise<WeworkUpdateInfo | null> {
    if (!this.isPackaged()) {
      throw new Error('Wework updater is only available in a packaged desktop app.')
    }

    this.updater.allowPrerelease = channel === 'beta'
    this.updater.channel = channel === 'beta' ? 'beta' : 'latest'
    this.updater.setFeedURL({ provider: 'generic', url: this.updateBaseUrl })
    this.pendingVersion = null
    this.downloadedVersion = null
    this.downloadPromise = null
    this.progress = { downloadedBytes: 0, totalBytes: null }
    const result = await this.updater.checkForUpdates()
    if (!result?.isUpdateAvailable || !result.updateInfo) return null

    const update = toWeworkUpdateInfo(this.currentVersion(), result.updateInfo)
    this.pendingVersion = update.version
    return update
  }

  downloadProgress(): WeworkUpdateDownloadProgress {
    return this.progress
  }

  async download(): Promise<void> {
    if (!this.pendingVersion) {
      throw new Error('No pending Wework update is available.')
    }
    if (this.downloadedVersion === this.pendingVersion) return
    if (this.downloadPromise) return this.downloadPromise

    const progress = (value: { transferred: number; total: number }) => {
      this.progress = {
        downloadedBytes: value.transferred,
        totalBytes: value.total > 0 ? value.total : null,
      }
    }
    const pendingVersion = this.pendingVersion
    this.downloadPromise = (async () => {
      this.updater.on('download-progress', progress)
      try {
        await this.updater.downloadUpdate()
        this.downloadedVersion = pendingVersion
      } finally {
        this.updater.off('download-progress', progress)
        this.downloadPromise = null
      }
    })()
    return this.downloadPromise
  }

  createInstallAction(): () => Promise<void> {
    if (!this.pendingVersion || this.downloadedVersion !== this.pendingVersion) {
      throw new Error('The pending Wework update has not finished downloading.')
    }
    return async () => {
      await this.prepareInstall()
      this.updater.quitAndInstall(false, true)
    }
  }
}

function toWeworkUpdateInfo(currentVersion: string, update: UpdateInfo): WeworkUpdateInfo {
  const body =
    typeof update.releaseNotes === 'string'
      ? update.releaseNotes
      : update.releaseNotes
          ?.map(note => note.note)
          .filter(Boolean)
          .join('\n\n')
  return {
    currentVersion,
    version: update.version,
    ...(body ? { body } : {}),
  }
}
