import { randomUUID } from 'node:crypto'
import type { AppUpdater, UpdateInfo } from 'electron-updater'
import type {
  ComponentDownloadProgress,
  HostDownloadPhase,
  WeworkUpdateDownloadProgress,
} from './app-update-progress.js'
export type { WeworkUpdateDownloadProgress } from './app-update-progress.js'

export type WeworkUpdateChannel = 'stable' | 'beta'

export interface WeworkUpdateInfo {
  currentVersion: string
  version: string
  body?: string
}

interface AppUpdateServiceOptions {
  updater: AppUpdater
  currentVersion: () => string
  isPackaged: () => boolean
  prepareUpdate: (
    version: string,
    channel: WeworkUpdateChannel,
    onProgress: (progress: ComponentDownloadProgress) => void
  ) => Promise<void>
  prepareInstall: () => Promise<void>
  updateBaseUrl: string
  log?: (event: Record<string, unknown>) => void
}

export class AppUpdateService {
  private readonly updater: AppUpdater
  private readonly currentVersion: () => string
  private readonly isPackaged: () => boolean
  private readonly prepareUpdate: (
    version: string,
    channel: WeworkUpdateChannel,
    onProgress: (progress: ComponentDownloadProgress) => void
  ) => Promise<void>
  private readonly prepareInstall: () => Promise<void>
  private readonly updateBaseUrl: string
  private readonly log: (event: Record<string, unknown>) => void
  private checkPromise: Promise<WeworkUpdateInfo | null> | null = null
  private checkingChannel: WeworkUpdateChannel | null = null
  private pendingUpdate: WeworkUpdateInfo | null = null
  private pendingVersion: string | null = null
  private pendingChannel: WeworkUpdateChannel | null = null
  private downloadedVersion: string | null = null
  private downloadPromise: Promise<void> | null = null
  private progress: WeworkUpdateDownloadProgress = {
    downloadedBytes: 0,
    totalBytes: null,
  }

  constructor(options: AppUpdateServiceOptions) {
    this.log = options.log ?? (() => undefined)
    this.updater = options.updater
    this.currentVersion = options.currentVersion
    this.isPackaged = options.isPackaged
    this.prepareUpdate = options.prepareUpdate
    this.prepareInstall = options.prepareInstall
    this.updateBaseUrl = options.updateBaseUrl.replace(/\/+$/, '')
    this.updater.autoDownload = false
    this.updater.autoInstallOnAppQuit = false
  }

  async check(channel: WeworkUpdateChannel): Promise<WeworkUpdateInfo | null> {
    if (this.downloadPromise) {
      if (this.pendingChannel === channel) return this.pendingUpdate
      await this.downloadPromise.catch(() => undefined)
    }
    if (this.checkPromise) {
      if (this.checkingChannel === channel) return this.checkPromise
      await this.checkPromise.catch(() => undefined)
      return this.check(channel)
    }
    this.checkingChannel = channel
    const promise = this.performCheck(channel)
    this.checkPromise = promise
    try {
      return await promise
    } finally {
      this.checkPromise = null
      this.checkingChannel = null
    }
  }

  private async performCheck(channel: WeworkUpdateChannel): Promise<WeworkUpdateInfo | null> {
    if (!this.isPackaged()) {
      throw new Error('Wework updater is only available in a packaged desktop app.')
    }

    this.updater.allowPrerelease = channel === 'beta'
    this.updater.channel = channel === 'beta' ? 'beta' : 'latest'
    this.updater.setFeedURL({
      provider: 'generic',
      url: this.updateBaseUrl,
      useMultipleRangeRequest: false,
    })
    let result
    try {
      result = await this.updater.checkForUpdates()
    } catch (error) {
      if (isMissingChannelManifestError(error)) return null
      throw error
    }
    if (!result?.isUpdateAvailable || !result.updateInfo) {
      if (this.downloadedVersion !== this.pendingVersion) {
        this.pendingVersion = null
        this.pendingChannel = null
        this.pendingUpdate = null
      }
      return null
    }

    const update = toWeworkUpdateInfo(this.currentVersion(), result.updateInfo)
    if (this.pendingVersion !== update.version || this.pendingChannel !== channel) {
      this.downloadedVersion = null
      this.progress = { downloadedBytes: 0, totalBytes: null }
    }
    this.pendingUpdate = update
    this.pendingVersion = update.version
    this.pendingChannel = channel
    return update
  }

  downloadProgress(): WeworkUpdateDownloadProgress {
    return this.progress
  }

  async download(): Promise<void> {
    if (!this.pendingVersion || !this.pendingChannel) {
      throw new Error('No pending Wework update is available.')
    }
    if (this.downloadedVersion === this.pendingVersion) return
    if (this.downloadPromise) return this.downloadPromise

    const taskId = randomUUID()
    const pendingVersion = this.pendingVersion
    const pendingChannel = this.pendingChannel
    let componentStageId: string | undefined
    let componentBytes = 0
    let completedAttempts = 0
    let attemptBytes = 0
    let hostTotal: number | null = null
    const report = () => {
      this.progress = {
        ...this.progress,
        downloadedBytes: componentBytes + completedAttempts + attemptBytes,
        totalBytes: hostTotal === null ? null : componentBytes + completedAttempts + hostTotal,
      }
    }
    const progress = (value: { transferred: number; total: number }) => {
      attemptBytes = value.transferred
      hostTotal = value.total > 0 ? value.total : null
      report()
    }
    const phase = (value: HostDownloadPhase) => {
      if (value.phase === 'verifying') {
        this.progress = { ...this.progress, phase: 'verifying' }
        return
      }
      if (this.progress.mode && this.progress.mode !== value.mode) {
        completedAttempts += attemptBytes
        attemptBytes = 0
      }
      hostTotal = value.totalBytes ?? null
      this.progress = { ...this.progress, phase: 'host', mode: value.mode, reason: value.reason }
      report()
      this.log({ taskId, event: 'host-download-phase', ...value })
    }
    this.progress = { downloadedBytes: 0, totalBytes: null, phase: 'preparing' }
    this.downloadPromise = (async () => {
      this.updater.on('download-progress', progress)
      this.updater.on('wework-download-phase', phase)
      this.log({
        taskId,
        event: 'update-started',
        version: pendingVersion,
        channel: pendingChannel,
      })
      try {
        await this.prepareUpdate(pendingVersion, pendingChannel, value => {
          if (value.stageId && componentStageId !== value.stageId) {
            componentStageId = value.stageId
            this.log({ taskId, event: 'component-stage-linked', stageId: componentStageId })
          }
          componentBytes = value.downloadedBytes
          this.progress = { ...value, totalBytes: null, phase: 'components' }
        })
        this.progress = { ...this.progress, phase: 'host', totalBytes: null }
        await this.updater.downloadUpdate()
        this.downloadedVersion = pendingVersion
        this.progress = { ...this.progress, phase: 'ready' }
        this.log({ taskId, event: 'update-ready', ...this.progress })
      } catch (error) {
        this.log({ taskId, event: 'update-failed', downloadedBytes: this.progress.downloadedBytes })
        throw error
      } finally {
        this.updater.off('download-progress', progress)
        this.updater.off('wework-download-phase', phase)
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

function isMissingChannelManifestError(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && error.code === 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND'
  )
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
