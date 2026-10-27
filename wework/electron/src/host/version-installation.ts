import { readFileSync, realpathSync } from 'node:fs'
import { mkdir, open, rename, rm } from 'node:fs/promises'
import { dirname, join, resolve, relative, win32 } from 'node:path'
import { parseVersionRelease, UPDATE_SCHEMA_VERSION } from './version-release.js'

export interface VersionInstallation {
  root: string
  launcher: string
  version: string
}

export function normalizeInstallationRoot(path: string, platform = process.platform): string {
  return platform === 'win32'
    ? win32.toNamespacedPath(win32.resolve(path)).toLowerCase()
    : resolve(path)
}

export function versionInstallation(options: {
  packaged: boolean
  platform: NodeJS.Platform
  arch: string
  executable: string
  version: string
}): VersionInstallation | null {
  if (!options.packaged || options.platform !== 'win32') return null
  const versionRoot = dirname(options.executable)
  const root = resolve(versionRoot, '..', '..')
  if (relative(root, versionRoot).split(/[\\/]/)[0] !== 'versions') {
    throw new Error('Windows application must be launched from a complete version installation')
  }
  const manifest = parseVersionRelease(
    JSON.parse(readFileSync(join(versionRoot, 'release.json'), 'utf8')),
    options.arch
  )
  if (manifest.version !== options.version)
    throw new Error('Application and release versions differ')
  return { root, launcher: join(root, 'WeWork.exe'), version: manifest.version }
}

export class VersionUpdateHealth {
  private readonly trial: { transactionId: string; token: string } | null
  private runtimeReady = false
  private rendererReady = false
  private failed = false
  private confirmation: Promise<void> | null = null

  constructor(
    private readonly installation: VersionInstallation | null,
    environment: NodeJS.ProcessEnv
  ) {
    const transactionId = environment.WEWORK_UPDATE_TRANSACTION_ID
    const token = environment.WEWORK_UPDATE_HEALTH_TOKEN
    const root = environment.WEWORK_UPDATE_INSTALL_ROOT
    // Do not propagate the update capability to plugins, terminals, or executors.
    delete environment.WEWORK_UPDATE_TRANSACTION_ID
    delete environment.WEWORK_UPDATE_HEALTH_TOKEN
    delete environment.WEWORK_UPDATE_INSTALL_ROOT
    if (!transactionId && !token) {
      this.trial = null
    } else {
      if (
        !installation ||
        !root ||
        normalizeInstallationRoot(realpathSync.native(root)) !==
          normalizeInstallationRoot(realpathSync.native(installation.root)) ||
        !transactionId ||
        !/^[a-zA-Z0-9-]{1,100}$/.test(transactionId) ||
        !token
      ) {
        throw new Error('Invalid update startup capability')
      }
      this.trial = { transactionId, token }
    }
  }

  markRuntimeReady(): Promise<void> {
    this.runtimeReady = true
    return this.confirmIfReady()
  }

  markRendererReady(): Promise<void> {
    this.rendererReady = true
    return this.confirmIfReady()
  }

  markFailed(): void {
    this.failed = true
  }

  async completeRuntimeStartup(start: () => Promise<void>): Promise<void> {
    try {
      await start()
      await this.markRuntimeReady()
    } catch (error) {
      this.markFailed()
      throw error
    }
  }

  private confirmIfReady(): Promise<void> {
    if (
      this.failed ||
      !this.trial ||
      !this.installation ||
      !this.runtimeReady ||
      !this.rendererReady
    ) {
      return Promise.resolve()
    }
    this.confirmation ??= this.confirm(this.installation.root, this.trial)
    return this.confirmation
  }

  private async confirm(
    root: string,
    trial: { transactionId: string; token: string }
  ): Promise<void> {
    const directory = join(root, '.updates', 'health')
    await mkdir(directory, { recursive: true })
    const path = join(directory, `${trial.transactionId}.json`)
    const temporary = `${path}.${process.pid}.tmp`
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(JSON.stringify({ schemaVersion: UPDATE_SCHEMA_VERSION, ...trial }))
      await handle.sync()
    } finally {
      await handle.close()
    }
    if (this.failed) {
      await rm(temporary, { force: true })
      return
    }
    await rename(temporary, path)
  }
}
