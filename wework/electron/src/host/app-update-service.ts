import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, realpath, rm } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { cloudFetch } from './cloud-http.js'
import type { WeworkUpdateDownloadProgress } from './app-update-progress.js'
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
import { restoreReleaseData, snapshotReleaseData } from '../runtime/release-snapshot.js'
import { verifyReleaseSignature } from '../runtime/release-signature.js'
import { extractPhysicalRelease, removePhysicalRelease } from '../runtime/physical-release-files.js'

const execute = promisify(execFile)

export type WeworkUpdateChannel = 'stable' | 'beta'
export interface WeworkUpdateInfo {
  currentVersion: string
  version: string
  body?: string
  targetVersion?: string
  path?: string[]
}
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
  runningComponents?: () => ComponentPaths | null
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
  private prepared: DesktopRelease | null = null
  private channel: WeworkUpdateChannel = 'stable'
  private downloadPromise: Promise<void> | null = null
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
    if (!this.options.isPackaged)
      throw new Error('Wework updater is only available in a packaged desktop app.')
    if (this.downloadPromise || this.installPromise)
      throw new Error('An update operation is in progress')
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
    if (this.pending?.sha256 !== plan.next.sha256) this.prepared = null
    this.pending = plan.next
    return {
      currentVersion: this.options.currentVersion,
      version: plan.next.version,
      body: plan.next.notes,
      targetVersion: plan.targetVersion,
      path: plan.path,
    }
  }

  downloadProgress(): WeworkUpdateDownloadProgress {
    return this.progress
  }

  async download(): Promise<void> {
    if (this.downloadPromise) return this.downloadPromise
    if (!this.pending) throw new Error('No verified Wework update is available')
    if (this.prepared && (await this.profileStillCurrent())) return
    const pending = this.pending
    this.downloadPromise = this.prepare(pending)
      .catch(error => {
        this.options.log?.({
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
          failure: { message: error instanceof Error ? error.message : String(error) },
        }
        throw error
      })
      .finally(() => {
        this.downloadPromise = null
      })
    return this.downloadPromise
  }

  private async prepare(pending: UpgradeRelease): Promise<void> {
    const started = performance.now()
    this.options.log?.({ event: 'release-preparation-started', version: pending.version })
    this.progress = { downloadedBytes: 0, totalBytes: pending.bytes, phase: 'host' }
    const store = this.options.store
    await this.registerInstalledRelease()
    // Download preparation owns cleanup. Startup cleanup could race creation
    // of the next slot when automatic downloads start immediately after readiness.
    await store.prune()
    const id = `${pending.version}-${randomUUID()}`
    const slot = store.slot(id)
    await mkdir(slot, { recursive: true, mode: 0o700 })
    const archive = join(slot, 'host.tar.gz')
    try {
      await this.downloadArchive(pending, archive)
      this.progress = { ...this.progress, phase: 'extracting' }
      const host = join(slot, 'host')
      await mkdir(host, { recursive: true, mode: 0o700 })
      await extractPhysicalRelease(archive, host)
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
      await verifyReleaseSignature(this.options.executable, release.executable)
      this.progress = { ...this.progress, phase: 'runtime' }
      await this.prepareHostEnvironment(release)
      await store.read(id)
      this.prepared = release
      this.progress = { ...this.progress, phase: 'ready' }
      this.options.log?.({
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
    if (current && !current.id.startsWith('installed-')) return
    const id = current?.id ?? `installed-${this.options.currentVersion}-${randomUUID()}`
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
    }
    const components = this.options.runningComponents?.()
    if (!components) throw new Error('The running release component composition is unavailable')
    await store.save(release)
    await atomicReleaseWrite(join(store.slot(id), 'prepared.json'), JSON.stringify({ components }))
    await atomicReleaseWrite(join(store.root, 'bridge'), this.options.executable)
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
    await execute(
      release.executable,
      [
        join(release.resources, 'app.asar', 'dist', 'runtime', 'release-preparation-cli.js'),
        request,
      ],
      {
        env: { ...environment, ELECTRON_RUN_AS_NODE: '1' },
        timeout: 300_000,
        maxBuffer: 1024 * 1024,
      }
    )
  }

  createInstallAction(): () => Promise<void> {
    if (!this.prepared || this.prepared.version !== this.pending?.version)
      throw new Error('The pending Wework update is not ready')
    return () => {
      if (this.installPromise) return this.installPromise
      this.progress = { ...this.progress, phase: 'installing' }
      this.installPromise = this.install()
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

  private async install(): Promise<void> {
    const release = this.prepared!
    const catalog = await this.readCatalog(this.channel)
    const edge = catalog.edges.find(
      e => e.from === this.options.currentVersion && e.to === release.version && !e.revoked
    )
    const target = catalog.releases.find(r => r.version === release.version && !r.revoked)
    if (!edge || !target || target.sha256 !== this.pending?.sha256)
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
    if (!previousId || !current) return null
    const previous = await this.options.store.read(previousId)
    return {
      version: previous.version,
      restoreRequired: !previous.readableDataSchemas.includes(current.dataSchema),
    }
  }

  createRollbackAction(restoreConfirmed: boolean): () => Promise<void> {
    return () => {
      if (this.installPromise) return this.installPromise
      if (this.downloadPromise)
        return Promise.reject(new Error('An update operation is in progress'))
      this.progress = { ...this.progress, phase: 'installing' }
      this.installPromise = (async () => {
        const previous = await this.previousRelease()
        if (!previous) throw new Error('No previous healthy release is available')
        if (previous.restoreRequired && !restoreConfirmed)
          throw new Error('Restoring pre-update data requires confirmation')
        const store = this.options.store
        let sourceRevision: string | undefined
        if (!previous.restoreRequired) {
          const previousId = await optionalText(join(store.root, 'previousHealthy'))
          const release = await store.read(previousId!)
          const refreshed = {
            ...release,
            profileRoot: join(store.slot(release.id), `rollback-profile-${randomUUID()}`),
          }
          await this.prepareHostEnvironment(refreshed)
          sourceRevision = JSON.parse(
            await readFile(join(store.slot(release.id), 'prepared.json'), 'utf8')
          ).sourceRevision
        }
        this.stopping = true
        await this.options.shutdown()
        if (
          sourceRevision &&
          sourceRevision !== (await profileRevision(currentCoreProfile(this.options.dataDirectory)))
        )
          throw new Error('Plugins changed while preparing rollback; prepare again')
        const activation = await store.requestRollback()
        if (
          process.env.WEWORK_E2E_CONTROL_URL &&
          process.env.WEWORK_E2E_ROLLBACK_FAILURE === 'after-journal'
        ) {
          await atomicReleaseWrite(join(store.root, 'rollback-interrupted'), activation.token)
          process.exit(3)
        }
        if (activation.restoreRequired)
          await restoreReleaseData(
            this.options.dataDirectory,
            store.root,
            activation.snapshot,
            process.env.WEGENT_EXECUTOR_HOME?.trim() || this.options.dataDirectory
          )
        await store.rollback()
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
    try {
      this.options.log?.({
        event: 'release-operation-failed',
        stopping: this.stopping,
        message: this.progress.failure?.message,
      })
    } catch {
      console.error('[app-update] failed to persist release operation failure')
    }
    this.options.onInstallFailure?.(error, this.stopping)
  }
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
