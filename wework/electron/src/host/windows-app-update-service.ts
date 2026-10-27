import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import semver from 'semver'
import type {
  AppUpdateController,
  WeworkUpdateChannel,
  WeworkUpdateInfo,
} from './app-update-service.js'
import type { WeworkUpdateDownloadProgress } from './app-update-progress.js'
import type { VersionInstallation } from './version-installation.js'
import { NativeUpdateHandoff } from './native-update-handoff.js'
import { physicalFilesystem } from './physical-filesystem.js'
import { extractVersionArchive } from './version-archive.js'
import {
  hashFile,
  parseUpdateFeed,
  verifyVersionDirectory,
  UPDATE_SCHEMA_VERSION,
  type VersionUpdateFeed,
} from './version-release.js'

const { createWriteStream } = physicalFilesystem
const { lstat, mkdir, open, rename, rm } = physicalFilesystem.promises

interface WindowsAppUpdateOptions {
  installation: VersionInstallation
  arch: string
  updateBaseUrl: string
  fetch: typeof fetch
  prepareInstall: () => Promise<void>
  recoverInstall: (error: Error) => Promise<void>
  quit: () => void
  launchArgs: string[]
  log: (event: Record<string, unknown>) => void
}

interface PendingUpdate {
  feed: VersionUpdateFeed
  channel: WeworkUpdateChannel
  info: WeworkUpdateInfo
  candidatePath?: string
}

/** Windows updates publish complete immutable versions; NSIS only bootstraps installations. */
export class WindowsAppUpdateService implements AppUpdateController {
  private pending: PendingUpdate | null = null
  private checkPromise: Promise<WeworkUpdateInfo | null> | null = null
  private checkingChannel: WeworkUpdateChannel | null = null
  private downloadPromise: Promise<void> | null = null
  private installing = false
  private progress: WeworkUpdateDownloadProgress = { downloadedBytes: 0, totalBytes: null }

  constructor(private readonly options: WindowsAppUpdateOptions) {}

  async check(channel: WeworkUpdateChannel): Promise<WeworkUpdateInfo | null> {
    if (this.installing) throw new Error('An update is already being installed')
    if (this.downloadPromise) await this.downloadPromise
    if (this.checkPromise) {
      if (this.checkingChannel === channel) return this.checkPromise
      await this.checkPromise
      return this.check(channel)
    }
    const promise = this.performCheck(channel)
    this.checkingChannel = channel
    this.checkPromise = promise
    try {
      return await promise
    } finally {
      this.checkPromise = null
      this.checkingChannel = null
    }
  }

  private async performCheck(channel: WeworkUpdateChannel): Promise<WeworkUpdateInfo | null> {
    const base = `${this.options.updateBaseUrl.replace(/\/+$/, '')}/`
    const response = await this.options.fetch(new URL(`windows-${channel}-v2.json`, base), {
      cache: 'no-store',
      signal: AbortSignal.timeout(30_000),
    })
    if (response.status === 404) return null
    if (!response.ok) throw new Error(`Windows update check failed (HTTP ${response.status})`)
    if (Number(response.headers.get('content-length')) > 1024 ** 2) {
      await response.body?.cancel()
      throw new Error('Windows update feed is too large')
    }
    const feed = parseUpdateFeed(await response.json(), this.options.arch)
    const url = new URL(feed.url, base)
    // Loopback HTTP supports the real local update server used by desktop E2E.
    if (
      url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname))
    ) {
      throw new Error('Windows update URL must use HTTPS')
    }
    feed.url = url.href
    if (
      !semver.gt(feed.version, this.options.installation.version) ||
      (channel === 'stable' && semver.prerelease(feed.version))
    )
      return null
    const info: WeworkUpdateInfo = {
      currentVersion: this.options.installation.version,
      version: feed.version,
      ...(feed.releaseNotes ? { body: feed.releaseNotes } : {}),
    }
    if (this.pending?.feed.sha512 !== feed.sha512 || this.pending.feed.version !== feed.version) {
      if (this.pending?.candidatePath) {
        await rm(this.pending.candidatePath, { recursive: true, force: true })
      }
      this.progress = { downloadedBytes: 0, totalBytes: null }
      this.pending = { feed, channel, info }
    }
    return info
  }

  downloadProgress(): WeworkUpdateDownloadProgress {
    return { ...this.progress }
  }

  async download(): Promise<void> {
    if (this.installing) throw new Error('An update is already being installed')
    if (this.checkPromise) await this.checkPromise
    const pending = this.pending
    if (!pending) throw new Error('No pending Wework update is available.')
    if (pending.candidatePath) return
    if (this.downloadPromise) return this.downloadPromise
    const taskId = randomUUID()
    this.progress = { downloadedBytes: 0, totalBytes: pending.feed.size, phase: 'host' }
    this.options.log({
      taskId,
      event: 'update-started',
      version: pending.feed.version,
      protocol: 2,
    })
    const promise = this.stage(pending).catch(error => {
      this.progress = {
        ...this.progress,
        phase: 'failed',
        failure: { message: error instanceof Error ? error.message : String(error) },
      }
      // Network errors can include signed download URLs; never persist them.
      this.options.log({
        taskId,
        event: 'update-failed',
        errorType: error instanceof Error ? error.name : typeof error,
      })
      throw error
    })
    this.downloadPromise = promise
    try {
      await promise
      this.options.log({
        taskId,
        event: 'update-ready',
        version: pending.feed.version,
        protocol: 2,
      })
    } finally {
      this.downloadPromise = null
    }
  }

  private async stage(pending: PendingUpdate): Promise<void> {
    const root = join(this.options.installation.root, '.updates')
    const downloads = join(root, 'downloads')
    await mkdir(downloads, { recursive: true })
    const id = createHash('sha256').update(pending.feed.sha512).digest('hex')
    const archive = join(downloads, `${id}.zip`)
    let cached = false
    try {
      const metadata = await lstat(archive)
      cached =
        metadata.isFile() &&
        !metadata.isSymbolicLink() &&
        metadata.size === pending.feed.size &&
        (await hashFile(archive, 'sha512')) === pending.feed.sha512
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (!cached) {
      await rm(archive, { force: true })
      await this.downloadArchive(pending.feed, archive)
    }
    this.progress = {
      downloadedBytes: pending.feed.size,
      totalBytes: pending.feed.size,
      phase: 'preparing',
    }
    const candidatePath = join(root, 'staging', randomUUID())
    await mkdir(candidatePath, { recursive: true })
    try {
      await extractVersionArchive(archive, candidatePath)
      await verifyVersionDirectory(candidatePath, pending.feed)
      pending.candidatePath = candidatePath
      this.progress = { ...this.progress, phase: 'ready' }
      await rm(archive, { force: true })
    } catch (error) {
      await rm(candidatePath, { recursive: true, force: true })
      await rm(archive, { force: true })
      throw error
    }
  }

  private async downloadArchive(feed: VersionUpdateFeed, archive: string): Promise<void> {
    const temporary = `${archive}.${randomUUID()}.partial`
    try {
      const response = await this.options.fetch(feed.url, {
        signal: AbortSignal.timeout(30 * 60_000),
      })
      if (!response.ok || !response.body)
        throw new Error(`Windows update download failed (HTTP ${response.status})`)
      const hash = createHash('sha512')
      let bytes = 0
      const progress = new Transform({
        transform: (chunk: Buffer, _encoding, callback) => {
          bytes += chunk.length
          if (bytes > feed.size) {
            callback(new Error('Update download exceeds expected size'))
            return
          }
          hash.update(chunk)
          this.progress = { downloadedBytes: bytes, totalBytes: feed.size, phase: 'host' }
          callback(null, chunk)
        },
      })
      await pipeline(
        Readable.fromWeb(response.body as never),
        progress,
        createWriteStream(temporary, { flags: 'wx', mode: 0o600 })
      )
      if (bytes !== feed.size || hash.digest('base64') !== feed.sha512) {
        throw new Error('Update download checksum or size mismatch')
      }
      const handle = await open(temporary, 'r+')
      try {
        await handle.sync()
      } finally {
        await handle.close()
      }
      await rename(temporary, archive)
    } finally {
      await rm(temporary, { force: true })
    }
  }

  createInstallAction(): () => Promise<void> {
    const pending = this.pending
    const candidatePath = pending?.candidatePath
    if (!pending || !candidatePath)
      throw new Error('The pending Wework update has not finished downloading.')
    return async () => {
      if (this.installing) throw new Error('An update is already being installed')
      if (this.pending !== pending)
        throw new Error('The selected update has changed. Download it again.')
      this.installing = true
      let handoff: NativeUpdateHandoff | undefined
      let request: string | undefined
      let shutdownStarted = false
      try {
        // Revalidate before stopping a working application. Native repeats this at the trust boundary.
        await verifyVersionDirectory(candidatePath, pending.feed)
        const requests = join(this.options.installation.root, '.updates', 'requests')
        await mkdir(requests, { recursive: true })
        request = join(requests, `${randomUUID()}.json`)
        const handle = await open(request, 'wx', 0o600)
        try {
          await handle.writeFile(
            JSON.stringify({
              schemaVersion: UPDATE_SCHEMA_VERSION,
              installRoot: this.options.installation.root,
              candidatePath,
              parentPid: process.pid,
              launchArgs: this.options.launchArgs,
            })
          )
          await handle.sync()
        } finally {
          await handle.close()
        }
        handoff = new NativeUpdateHandoff(
          spawn(this.options.installation.launcher, ['--apply', request], {
            detached: true,
            stdio: 'ignore',
            windowsHide: true,
          })
        )
        await handoff.ready
        handoff.assertAlive()
        // Native waits for this process to exit before it can publish or start the candidate.
        shutdownStarted = true
        await this.options.prepareInstall()
        handoff.release()
        this.options.quit()
      } catch (error) {
        // Revoke the waiting updater's request before any later application exit can activate it.
        try {
          if (request) await rm(request, { force: true })
        } catch {
          // Still terminate the updater if revoking its request is blocked by the filesystem.
          this.options.log({ event: 'update-request-cleanup-failed' })
        }
        try {
          await handoff?.cancel()
        } catch (cancellationError) {
          this.options.log({ event: 'update-cancellation-failed' })
          throw new AggregateError(
            [error, cancellationError],
            'Update cancellation could not be confirmed. Keep the application running.',
            { cause: cancellationError }
          )
        }
        this.installing = false
        if (shutdownStarted) {
          await this.options.recoverInstall(
            error instanceof Error ? error : new Error(String(error))
          )
        }
        throw error
      }
    }
  }
}
