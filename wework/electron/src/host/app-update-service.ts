import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, realpath, rm } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { cloudFetch } from './cloud-http.js'
import type {
  WeworkUpdateChannel,
  WeworkUpdateDownloadProgress,
  WeworkUpdateInfo,
} from './app-update-progress.js'
import {
  compareVersions,
  planUpgrade,
  validateUpgradeCatalog,
  type UpgradeCatalog,
  type UpgradeRelease,
} from '../runtime/upgrade-policy.mjs'
import {
  atomicReleaseWrite,
  optionalText,
  ReleaseStore,
  type DesktopRelease,
} from '../runtime/release-store.js'
import {
  currentCoreProfile,
  profileRevision,
  retainReleaseProfile,
} from '../runtime/release-profile.js'
import type { ComponentPaths } from '../runtime/component-update-manager.js'
import { snapshotReleaseData } from '../runtime/release-snapshot.js'
import { verifyReleaseSignature } from '../runtime/release-signature.js'
import { extractPhysicalRelease, removePhysicalRelease } from '../runtime/physical-release-files.js'
import { preparationStep } from '../runtime/release-preparation.js'
import { prepareReleaseProcess } from '../runtime/release-preparation-progress.mjs'
import { terminateProcessTree } from '../runtime/runtime-supervisor.js'

export type { WeworkUpdateChannel, WeworkUpdateInfo } from './app-update-progress.js'
export type AppUpdateController = Pick<
  AppUpdateService,
  'check' | 'download' | 'downloadProgress' | 'createInstallAction'
> & {
  previousRelease?: () => Promise<{ version: string; restoreRequired: boolean } | null>
  createRollbackAction?: (restoreConfirmed: boolean) => () => Promise<void>
}

export interface AppUpdateServiceOptions {
  store: ReleaseStore
  dataDirectory: string
  currentVersion: string
  executable: string
  resources: string
  runtimeRoot: string
  componentDataDirectory?: string
  runningComponents?: () => ComponentPaths | null | Promise<ComponentPaths | null>
  dataSchema: number
  readableDataSchemas: number[]
  updateBaseUrl: string
  isPackaged: boolean
  shutdown: () => Promise<void>
  restart: () => void
  fetch?: typeof fetch
  log?: (event: Record<string, unknown>) => void
  onInstallFailure?: (error: unknown, stopping: boolean) => void
}

export class AppUpdateService {
  private progress: WeworkUpdateDownloadProgress = { downloadedBytes: 0, totalBytes: null }
  private pending: UpgradeRelease | null = null
  private pendingUpdate: WeworkUpdateInfo | null = null
  private prepared: DesktopRelease | null = null
  private readyProgress: WeworkUpdateDownloadProgress | null = null
  private channel: WeworkUpdateChannel = 'stable'
  private checkTask: {
    channel: WeworkUpdateChannel
    promise: Promise<WeworkUpdateInfo | null>
  } | null = null
  private downloadTask: {
    channel: WeworkUpdateChannel
    refresh: Promise<WeworkUpdateInfo | null>
    promise: Promise<void>
  } | null = null
  private installPromise: Promise<void> | null = null
  private stopping = false
  private readonly fetch: typeof fetch

  constructor(private readonly options: AppUpdateServiceOptions) {
    this.fetch = options.fetch ?? cloudFetch
  }

  private async readCatalog(channel: WeworkUpdateChannel): Promise<UpgradeCatalog> {
    const platform =
      process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux'
    const response = await this.fetch(
      `${this.options.updateBaseUrl.replace(/\/+$/, '')}/components-${channel}-${platform}-${process.arch}.json`,
      { cache: 'no-store' }
    )
    if (!response.ok)
      throw new Error(`Verified upgrade catalog request failed: HTTP ${response.status}`)
    const manifest = (await response.json()) as { upgradePolicy?: unknown }
    if (!manifest.upgradePolicy)
      throw new Error('This update channel has no verified upgrade policy yet')
    const catalog = validateUpgradeCatalog(manifest.upgradePolicy)
    if (
      catalog.channel !== channel ||
      catalog.platform !== platform ||
      catalog.arch !== process.arch
    )
      throw new Error('Upgrade catalog target mismatch')
    return catalog
  }

  async check(channel: WeworkUpdateChannel): Promise<WeworkUpdateInfo | null> {
    this.assertNotInstalling()
    const download = this.downloadTask
    if (download) {
      if (download.channel === channel) return download.refresh
      await download.promise.catch(() => undefined)
      return this.check(channel)
    }
    const check = this.checkTask
    if (check) {
      if (check.channel === channel) return check.promise
      await check.promise.catch(() => undefined)
      return this.check(channel)
    }
    const promise = this.performCheck(channel)
    this.checkTask = { channel, promise }
    try {
      return await promise
    } finally {
      this.checkTask = null
    }
  }

  private async performCheck(channel: WeworkUpdateChannel): Promise<WeworkUpdateInfo | null> {
    if (!this.options.isPackaged)
      throw new Error('Wework updater is only available in a packaged desktop app.')
    const catalog = await this.readCatalog(channel)
    const rolledBack = await optionalText(
      join(this.options.store.root, 'rolled-back-versions.json')
    )
    const blocked: unknown = rolledBack ? JSON.parse(rolledBack) : []
    if (!Array.isArray(blocked) || blocked.some(version => typeof version !== 'string'))
      throw new Error('Invalid rollback quarantine')
    const usable = {
      ...catalog,
      releases: catalog.releases.map(release =>
        blocked.includes(release.version) ? { ...release, revoked: true } : release
      ),
    }
    const plan = planUpgrade(usable, this.options.currentVersion)
    this.channel = channel
    if (!plan) {
      this.pending = null
      this.pendingUpdate = null
      this.clearPreparedRelease()
      if (
        catalog.releases.some(
          r => !r.revoked && compareVersions(r.version, this.options.currentVersion) > 0
        )
      ) {
        throw Object.assign(
          new Error(
            'No verified upgrade path is available from this version. Check again after a tested path is published.'
          ),
          { code: 'UPGRADE_PATH_UNAVAILABLE' }
        )
      }
      return null
    }
    if (
      !matchesRelease(this.pending, plan.next) ||
      (this.prepared && !(await this.profileStillCurrent()))
    ) {
      this.clearPreparedRelease()
    }
    this.pending = plan.next
    this.pendingUpdate = {
      currentVersion: this.options.currentVersion,
      version: plan.next.version,
      readyToInstall: this.prepared !== null,
      body: plan.next.notes,
      targetVersion: plan.targetVersion,
      path: plan.path,
    }
    this.progress = { ...this.progress, update: this.pendingUpdate }
    return this.pendingUpdate
  }

  private clearPreparedRelease(): void {
    this.prepared = null
    this.readyProgress = null
    if (this.progress.phase === 'ready') {
      this.progress = { downloadedBytes: 0, totalBytes: null }
    }
  }

  downloadProgress(): WeworkUpdateDownloadProgress {
    return this.progress
  }

  async download(channel = this.channel): Promise<void> {
    this.assertNotInstalling()
    const download = this.downloadTask
    if (download) {
      if (download.channel === channel) return download.promise
      await download.promise.catch(() => undefined)
      return this.download(channel)
    }
    const canReuse = this.channel === channel && this.progress.phase === 'ready'
    this.progress = { downloadedBytes: 0, totalBytes: null, phase: 'preparing' }
    const refresh = Promise.resolve(this.checkTask?.promise)
      .catch(() => undefined)
      .then(async () => {
        if (
          canReuse &&
          this.channel === channel &&
          this.prepared &&
          (await this.profileStillCurrent())
        )
          return this.pendingUpdate
        return this.performCheck(channel)
      })
    const promise = this.performDownload(refresh)
      .catch(error => {
        this.log({
          event: 'release-preparation-failed',
          phase: this.progress.phase,
          errorType: error instanceof Error ? error.name : typeof error,
          errorMessage:
            error instanceof Error
              ? error.message.replace(/https?:\/\/[^\s]+/g, '[URL removed]').slice(0, 2000)
              : String(error),
        })
        this.progress = {
          ...this.progress,
          phase: 'failed',
          failure: {
            message: error instanceof Error ? error.message : String(error),
            ...(error instanceof Error && 'code' in error && typeof error.code === 'string'
              ? { code: error.code }
              : {}),
          },
        }
        throw error
      })
      .finally(() => {
        this.downloadTask = null
      })
    this.downloadTask = { channel, refresh, promise }
    return promise
  }

  private async performDownload(refresh: Promise<WeworkUpdateInfo | null>): Promise<void> {
    const update = await refresh
    if (!update) {
      this.progress = { ...this.progress, phase: 'upToDate', update: null }
      return
    }
    this.progress = { ...this.progress, update }
    if (this.prepared && this.readyProgress && (await this.profileStillCurrent())) {
      this.progress = { ...this.readyProgress, update }
      return
    }
    this.prepared = null
    this.readyProgress = null
    await this.prepare(this.pending!)
    this.readyProgress = this.progress
  }

  private async prepare(pending: UpgradeRelease): Promise<void> {
    const started = performance.now()
    this.log({ event: 'release-preparation-started', version: pending.version })
    this.progress = {
      ...this.progress,
      downloadedBytes: 0,
      totalBytes: pending.bytes,
      phase: 'host',
    }
    const store = this.options.store
    const id = `${pending.version}-${randomUUID()}`
    const step = <T>(stage: string, run: () => Promise<T>) =>
      preparationStep(
        { write: async (_source, line) => this.options.log?.(JSON.parse(line)) },
        { id, version: pending.version },
        stage,
        run
      )
    await step('retain-source', () => this.registerInstalledRelease())
    // Download preparation owns cleanup. Startup cleanup could race creation
    // of the next slot when automatic downloads start immediately after readiness.
    await step('prune', () => store.prune())
    const slot = store.slot(id)
    await mkdir(slot, { recursive: true, mode: 0o700 })
    const archive = join(slot, 'host.tar.gz')
    try {
      await step('download', () => this.downloadArchive(pending, archive))
      this.progress = { ...this.progress, phase: 'extracting' }
      const host = join(slot, 'host')
      await mkdir(host, { recursive: true, mode: 0o700 })
      await step('host-extraction', () => extractPhysicalRelease(archive, host))
      const manifest = JSON.parse(await readFile(join(host, 'wework-release.json'), 'utf8')) as {
        schemaVersion: number
        version: string
        sourceSha: string
        executable: string
        resources: string
      }
      if (
        manifest.schemaVersion !== 1 ||
        manifest.version !== pending.version ||
        manifest.sourceSha !== pending.sourceSha
      )
        throw new Error('Downloaded host release identity mismatch')
      const release: DesktopRelease = {
        schemaVersion: 1,
        id,
        version: pending.version,
        executable: ownedPath(host, manifest.executable),
        resources: ownedPath(host, manifest.resources),
        runtimeRoot: join(slot, 'runtimes'),
        profileRoot: join(slot, 'profile'),
        dataSchema: pending.dataSchema,
        readableDataSchemas: pending.readableDataSchemas,
      }
      await step('signature', () =>
        verifyReleaseSignature(this.options.executable, release.executable)
      )
      this.progress = { ...this.progress, phase: 'runtime' }
      await step('target-preparation', () => this.prepareHostEnvironment(release))
      this.prepared = await store.read(id)
      this.pendingUpdate = { ...this.pendingUpdate!, readyToInstall: true }
      this.progress = { ...this.progress, phase: 'ready', update: this.pendingUpdate }
      this.log({
        event: 'release-prepared',
        version: release.version,
        durationMs: Math.round(performance.now() - started),
      })
    } catch (error) {
      await removePhysicalRelease(slot)
      throw error
    } finally {
      await rm(archive, { force: true })
    }
  }

  private async downloadArchive(release: UpgradeRelease, destination: string): Promise<void> {
    const response = await this.fetch(release.url)
    if (!response.ok || !response.body)
      throw new Error(`Release download failed: HTTP ${response.status}`)
    const handle = await open(destination, 'wx', 0o600)
    const reader = response.body.getReader()
    const hash = createHash('sha256')
    let received = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        received += value.byteLength
        if (received > release.bytes) throw new Error('Release package exceeds declared size')
        hash.update(value)
        await handle.writeFile(value)
        this.progress = { ...this.progress, downloadedBytes: received }
      }
      if (received !== release.bytes || hash.digest('hex') !== release.sha256)
        throw new Error('Release package integrity check failed')
      await handle.sync()
    } finally {
      await reader.cancel().catch(() => undefined)
      reader.releaseLock()
      await handle.close()
    }
  }

  private async registerInstalledRelease(): Promise<void> {
    const store = this.options.store
    const current = await store.active()
    const runningRelease = current?.version === this.options.currentVersion
    if (runningRelease && !current.id.startsWith('installed-')) return
    const components = await this.options.runningComponents?.()
    if (!components) throw new Error('The running release component composition is unavailable')
    const id = runningRelease
      ? current.id
      : `installed-${this.options.currentVersion}-${randomUUID()}`
    const retainedRelease = runningRelease ? current.retainedRelease : current?.id
    const release: DesktopRelease = {
      schemaVersion: 1,
      id,
      version: this.options.currentVersion,
      executable: this.options.executable,
      resources: this.options.resources,
      runtimeRoot: this.options.runtimeRoot,
      componentDataDirectory: this.options.componentDataDirectory ?? this.options.dataDirectory,
      profileRoot: await realpath(currentCoreProfile(this.options.dataDirectory)),
      dataSchema: this.options.dataSchema,
      readableDataSchemas: this.options.readableDataSchemas,
      ...(retainedRelease ? { retainedRelease } : {}),
    }
    await store.save(release)
    await atomicReleaseWrite(join(store.slot(id), 'prepared.json'), JSON.stringify({ components }))
    await atomicReleaseWrite(join(store.root, 'bridge'), this.options.executable)
    if (current && !runningRelease) {
      await rm(join(store.root, 'previousHealthy'), { force: true })
    }
    await atomicReleaseWrite(join(store.root, 'active'), id)
  }

  private async profileStillCurrent(): Promise<boolean> {
    if (!this.prepared) return false
    const prepared = JSON.parse(
      await readFile(join(this.options.store.slot(this.prepared.id), 'prepared.json'), 'utf8')
    ) as { sourceRevision: string }
    return (
      prepared.sourceRevision ===
      (await profileRevision(currentCoreProfile(this.options.dataDirectory)))
    )
  }

  private async prepareHostEnvironment(release: DesktopRelease): Promise<void> {
    const request = join(this.options.store.slot(release.id), 'prepare-request.json')
    await atomicReleaseWrite(
      request,
      JSON.stringify({
        release,
        storeRoot: this.options.store.root,
        sourceProfile: await realpath(currentCoreProfile(this.options.dataDirectory)),
      })
    )
    const environment = { ...process.env }
    for (const key of [
      'WEWORK_RELEASE_SUPERVISED',
      'WEWORK_ACTIVE_RELEASE_ID',
      'WEWORK_RELEASE_ROOT',
      'ELECTRON_RUN_AS_NODE',
    ])
      delete environment[key]
    await prepareReleaseProcess(
      release.executable,
      [
        join(release.resources, 'app.asar', 'dist', 'runtime', 'release-preparation-cli.js'),
        request,
      ],
      {
        env: { ...environment, ELECTRON_RUN_AS_NODE: '1' },
        progress: 'stdout',
        releaseId: release.id,
        version: release.version,
        stop: child => terminateProcessTree(child, 10_000),
      }
    )
  }

  createInstallAction(version = this.pending?.version): () => Promise<void> {
    this.assertReady(version)
    return () => {
      this.assertReady(version)
      const release = this.prepared!
      const pending = this.pending!
      const channel = this.channel
      this.progress = { ...this.progress, phase: 'installing' }
      this.installPromise = Promise.resolve()
        .then(() => this.install(release, pending, channel))
        .catch(error => {
          this.failInstall(error)
          throw error
        })
        .finally(() => {
          this.installPromise = null
        })
      return this.installPromise
    }
  }

  private assertNotInstalling(): void {
    if (this.installPromise || this.stopping) throw new Error('An update operation is in progress')
  }

  private assertReady(version: string | undefined): void {
    this.assertNotInstalling()
    if (
      this.downloadTask ||
      this.checkTask ||
      !version ||
      !this.prepared ||
      this.prepared.version !== version ||
      this.pending?.version !== version
    )
      throw new Error('The pending Wework update is not ready')
  }

  private async install(
    release: DesktopRelease,
    pending: UpgradeRelease,
    channel: WeworkUpdateChannel
  ): Promise<void> {
    const catalog = await this.readCatalog(channel)
    const edge = catalog.edges.find(
      e => e.from === this.options.currentVersion && e.to === release.version && !e.revoked
    )
    const target = catalog.releases.find(r => r.version === release.version && !r.revoked)
    if (!edge || !target || !matchesRelease(pending, target))
      throw new Error('The verified upgrade path was revoked or changed')
    if (!(await this.profileStillCurrent()))
      throw new Error(
        'Plugins changed after preparation. Prepare the update again before restarting.'
      )
    this.stopping = true
    await this.options.shutdown()
    if (!(await this.profileStillCurrent()))
      throw new Error('Plugin configuration changed before shutdown completed')
    const store = this.options.store
    const current = await store.active()
    if (!current) throw new Error('Current release is missing')
    const snapshot = await snapshotReleaseData(
      this.options.dataDirectory,
      store.root,
      process.env.WEGENT_EXECUTOR_HOME?.trim() || this.options.dataDirectory
    )
    if (current.id.startsWith('installed-')) {
      const profileRoot = join(store.slot(current.id), `retained-profile-${randomUUID()}`)
      // Record recovery's destination before moving the stopped writer's profile.
      await store.save({ ...current, profileRoot })
      await retainReleaseProfile(this.options.dataDirectory, profileRoot)
    }
    await store.activate(release, snapshot)
    this.options.restart()
  }

  async previousRelease(): Promise<{ version: string; restoreRequired: boolean } | null> {
    const previousId = await optionalText(join(this.options.store.root, 'previousHealthy'))
    const current = await this.options.store.active()
    if (!previousId || !current || current.version !== this.options.currentVersion) return null
    const previous = await this.options.store.read(previousId)
    return {
      version: previous.version,
      restoreRequired: !previous.readableDataSchemas.includes(current.dataSchema),
    }
  }

  createRollbackAction(restoreConfirmed: boolean): () => Promise<void> {
    return () => {
      if (this.installPromise) return this.installPromise
      if (this.downloadTask || this.checkTask || this.stopping)
        return Promise.reject(new Error('An update operation is in progress'))
      this.progress = { ...this.progress, phase: 'installing' }
      this.installPromise = (async () => {
        const previous = await this.previousRelease()
        if (!previous) throw new Error('No previous healthy release is available')
        if (previous.restoreRequired && !restoreConfirmed)
          throw new Error('Restoring pre-update data requires confirmation')
        const store = this.options.store
        this.stopping = true
        await this.options.shutdown()
        const activation = await store.requestRollback()
        if (
          process.env.WEWORK_E2E_CONTROL_URL &&
          process.env.WEWORK_E2E_ROLLBACK_FAILURE === 'after-journal'
        ) {
          await atomicReleaseWrite(join(store.root, 'rollback-interrupted'), activation.token)
          process.exit(3)
        }
        // Bootstrap resumes this journal before restoring data and selecting the
        // retained host. Clearing it here would turn rollback into ordinary startup.
        this.options.restart()
      })()
        .catch(error => {
          this.failInstall(error)
          throw error
        })
        .finally(() => {
          this.installPromise = null
        })
      return this.installPromise
    }
  }

  private failInstall(error: unknown): void {
    this.progress = {
      ...this.progress,
      phase: 'failed',
      failure: { message: error instanceof Error ? error.message : String(error) },
    }
    this.log({
      event: 'release-operation-failed',
      stopping: this.stopping,
      message: this.progress.failure?.message,
    })
    this.options.onInstallFailure?.(error, this.stopping)
  }

  private log(event: Record<string, unknown>): void {
    try {
      this.options.log?.(event)
    } catch {
      console.error('[app-update] failed to persist release operation log')
    }
  }
}

function matchesRelease(left: UpgradeRelease | null, right: UpgradeRelease): boolean {
  return (
    left?.version === right.version &&
    left.sha256 === right.sha256 &&
    left.sourceSha === right.sourceSha &&
    left.bytes === right.bytes &&
    left.dataSchema === right.dataSchema &&
    left.readableDataSchemas.length === right.readableDataSchemas.length &&
    left.readableDataSchemas.every((schema, index) => right.readableDataSchemas[index] === schema)
  )
}

function ownedPath(root: string, path: string): string {
  if (typeof path !== 'string' || isAbsolute(path) || /[\r\n\\]/.test(path))
    throw new Error('Unsafe release package path')
  const resolved = resolve(root, path)
  const offset = relative(root, resolved)
  if (!offset || offset === '..' || offset.startsWith(`..${sep}`) || isAbsolute(offset))
    throw new Error('Release package path escapes its slot')
  return resolved
}
