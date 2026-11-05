import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { chmod, copyFile, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import * as tar from 'tar'
import { extractPythonBootstrapZip } from './python-runtime-zip.js'
import {
  PythonRuntimeLoginRequiredError,
  type PythonRuntimeDownloads,
} from './python-runtime-downloads.js'
import { pythonArtifact } from './python-runtime-artifacts.js'
import {
  findCompatibleSystemPython,
  type PluginPythonInterpreter,
} from './python-runtime-selection.js'

const execFileAsync = promisify(execFile)
const PYTHON_VERSION = '3.12.12'
const UV_VERSION = '0.9.5'
const UV_DOWNLOAD_TIMEOUT_MS = 5 * 60_000
const PYTHON_HEALTH_CHECK = [
  'import ensurepip, ssl, sys, venv, zlib',
  'print(f"Python {sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}")',
].join('; ')

interface UvArtifact {
  archiveName: string
  archiveBytes: number
  archiveSha256: string
  executablePath: string
  executableSha256: string
}

const UV_ARTIFACTS: Record<string, UvArtifact> = {
  'darwin-arm64': {
    archiveName: 'uv-aarch64-apple-darwin.tar.gz',
    archiveBytes: 18_341_942,
    archiveSha256: 'dc098ff224d78ed418e121fd374f655949d2c7031a70f6f6604eaf016a130433',
    executablePath: 'uv-aarch64-apple-darwin/uv',
    executableSha256: 'd54989c0037e115f53c34a5658c2cc0ff5c44e35b5635ed9a5463b9caa364f81',
  },
  'darwin-x64': {
    archiveName: 'uv-x86_64-apple-darwin.tar.gz',
    archiveBytes: 19_689_319,
    archiveSha256: '58b1d4a25aa8ff99147c2550b33dcf730207fe7e0f9a0d5d36a1bbf36b845aca',
    executablePath: 'uv-x86_64-apple-darwin/uv',
    executableSha256: '5749c828967b8bad23e0b76c116d6beb8d54bd116f7bbbf5f015a1282e10392a',
  },
  'linux-arm64': {
    archiveName: 'uv-aarch64-unknown-linux-gnu.tar.gz',
    archiveBytes: 20_199_463,
    archiveSha256: '9db0c2f6683099f86bfeea47f4134e915f382512278de95b2a0e625957594ff3',
    executablePath: 'uv-aarch64-unknown-linux-gnu/uv',
    executableSha256: 'b880aad13554f4eb7815f962b4f40e3f94fb2f86cae4b98afa0906324b61f754',
  },
  'linux-x64': {
    archiveName: 'uv-x86_64-unknown-linux-gnu.tar.gz',
    archiveBytes: 21_370_871,
    archiveSha256: '2cf10babba653310606f8b49876cfb679928669e7ddaa1fb41fb00ce73e64f66',
    executablePath: 'uv-x86_64-unknown-linux-gnu/uv',
    executableSha256: 'd3dc3ca8e29337dd602a9a4df9e6edb15ebc52aed91461debeedb96939dc4ce0',
  },
  'win32-arm64': {
    archiveName: 'uv-aarch64-pc-windows-msvc.zip',
    archiveBytes: 19_448_216,
    archiveSha256: '4c615aa19e37b2ec7da3370a25a562bb0061ab005081e4539702c059715dc2b0',
    executablePath: 'uv.exe',
    executableSha256: 'bdb71f3522356f307a2708775085602eca8240955cd414c0860712356afcc1a9',
  },
  'win32-x64': {
    archiveName: 'uv-x86_64-pc-windows-msvc.zip',
    archiveBytes: 20_760_405,
    archiveSha256: '515dc53d7553f1357d0abc1f70acd921fbb9e30230b1d9a08737236daa6ee920',
    executablePath: 'uv.exe',
    executableSha256: '456ee3b3b9a30cf647a2b36ad3e2ffe6261485414e9978daec0ce3a049afc0af',
  },
}

export interface PythonRuntimeStatus {
  id: 'python'
  managed: true
  autoInstall: true
  state: 'idle' | 'downloading' | 'installed' | 'notInstalled' | 'error'
  version: string | null
  downloadedBytes: number
  totalBytes: number
  installedBytes: number
  path: string
  error: string | null
  source: 'managed'
  phase: 'download' | 'install' | 'verify' | null
  temporaryPythonVersion?: string
}

interface RunFileResult {
  stdout: string
  stderr: string
}

type RunFile = (
  file: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; timeout: number; cwd?: string }
) => Promise<RunFileResult>

export interface PythonRuntimeManagerOptions {
  dataDirectory: string
  environment: NodeJS.ProcessEnv
  resolveDownloads: () => Promise<PythonRuntimeDownloads>
  platform?: NodeJS.Platform
  arch?: string
  fetch?: typeof fetch
  resolveProxy?: (targetUrl: string) => Promise<string | null>
  downloadTimeoutMs?: number
  runFile?: RunFile
  fileSha256?: (path: string) => Promise<string>
  log?: (event: Record<string, unknown>) => void
  onStatusChange?: (status: PythonRuntimeStatus) => void
}

export class PythonRuntimeManager {
  private readonly root: string
  private readonly runtimeEnvironment: NodeJS.ProcessEnv
  private readonly runtimeBin: string
  private readonly resolveDownloads: () => Promise<PythonRuntimeDownloads>
  private readonly platform: NodeJS.Platform
  private readonly arch: string
  private readonly fetch: typeof fetch
  private readonly resolveProxy?: (targetUrl: string) => Promise<string | null>
  private readonly downloadTimeoutMs: number
  private readonly runFile: RunFile
  private readonly fileSha256: (path: string) => Promise<string>
  private readonly log: (event: Record<string, unknown>) => void
  private activeEnsure: Promise<PythonRuntimeStatus> | null = null
  private activeStatus: Promise<PythonRuntimeStatus> | null = null
  private currentStatus: PythonRuntimeStatus
  private lastStatusPublishedAt = 0
  private temporaryPythonVersion: string | undefined
  private automaticPreparationAttempted = false
  private waitingForLogin = false
  private readonly onStatusChange?: (status: PythonRuntimeStatus) => void

  constructor(options: PythonRuntimeManagerOptions) {
    this.root = join(options.dataDirectory, 'managed-runtimes', 'python')
    this.runtimeBin = join(this.root, 'bin')
    this.resolveDownloads = options.resolveDownloads
    this.platform = options.platform ?? process.platform
    this.arch = options.arch ?? process.arch
    this.fetch = options.fetch ?? globalThis.fetch
    this.resolveProxy = options.resolveProxy
    this.downloadTimeoutMs = options.downloadTimeoutMs ?? UV_DOWNLOAD_TIMEOUT_MS
    this.fileSha256 = options.fileSha256 ?? sha256File
    this.runFile =
      options.runFile ??
      (async (file, args, runOptions) => {
        const result = await execFileAsync(file, args, runOptions)
        return { stdout: result.stdout, stderr: result.stderr }
      })
    this.log = options.log ?? (() => undefined)
    this.onStatusChange = options.onStatusChange
    this.runtimeEnvironment = {
      ...options.environment,
      WEGENT_PYTHON_PATH: this.pythonPath(),
    }
    this.currentStatus = this.statusValue('idle')
  }

  environment(): NodeJS.ProcessEnv {
    return { ...this.runtimeEnvironment }
  }

  async resolvePluginPython(
    pluginRoot: string,
    allowSystemFallback: boolean,
    prepare = true
  ): Promise<PluginPythonInterpreter> {
    const status = await this.status()
    if (
      status.state === 'installed' &&
      status.version &&
      (status.version === PYTHON_VERSION || !prepare)
    )
      return { path: status.path, version: status.version, source: 'managed' }
    if (!prepare && !this.activeEnsure) throw new Error('Plugin Python is not ready')
    const preparation = prepare ? this.ensure() : this.activeEnsure
    if (!preparation) throw new Error('Plugin Python is not ready')
    const managed = preparation.then(
      (ready): PluginPythonInterpreter => ({
        path: ready.path,
        version: ready.version ?? PYTHON_VERSION,
        source: 'managed',
      })
    )
    void managed.catch(() => undefined)
    if (!allowSystemFallback) {
      if (!prepare) throw new Error('Plugin Python is not ready')
      return managed
    }
    // Local probing must not delay a managed runtime that becomes ready first.
    const local = findCompatibleSystemPython(
      pluginRoot,
      this.root,
      this.runtimeEnvironment,
      this.platform,
      this.runFile
    ).then(candidate => {
      if (
        candidate &&
        this.activeEnsure &&
        !['installed', 'error'].includes(this.currentStatus.state)
      ) {
        this.temporaryPythonVersion = candidate.version
        this.setStatus({
          ...this.currentStatus,
          state: 'downloading',
          temporaryPythonVersion: candidate.version,
        })
        return candidate
      }
      if (!prepare && this.currentStatus.state !== 'installed')
        throw new Error('Plugin Python is not ready')
      return managed
    })
    return Promise.race([managed, local])
  }

  status(): Promise<PythonRuntimeStatus> {
    if (this.activeEnsure) return Promise.resolve({ ...this.currentStatus })
    this.activeStatus ??= this.inspectStatus().finally(() => {
      this.activeStatus = null
    })
    return this.activeStatus
  }

  private async inspectStatus(): Promise<PythonRuntimeStatus> {
    const installed = await this.inspectInstalledPython()
    if (this.activeEnsure) return { ...this.currentStatus }
    this.setStatus(
      installed ??
        (this.currentStatus.state === 'error'
          ? this.currentStatus
          : this.statusValue('notInstalled'))
    )
    return { ...this.currentStatus }
  }

  ensure(): Promise<PythonRuntimeStatus> {
    this.automaticPreparationAttempted = true
    if (this.activeEnsure) return this.activeEnsure
    this.activeEnsure = this.performEnsure().finally(() => {
      this.activeEnsure = null
    })
    return this.activeEnsure
  }

  prewarm(): Promise<PythonRuntimeStatus> {
    if (this.automaticPreparationAttempted) return this.activeEnsure ?? this.status()
    return this.ensure().catch(error => {
      if (error instanceof PythonRuntimeLoginRequiredError) return this.status()
      throw error
    })
  }

  resumeAfterLogin(): Promise<PythonRuntimeStatus> {
    // A login event may precede the pending request's login-required result.
    return (this.activeEnsure?.catch(() => undefined) ?? Promise.resolve()).then(() => {
      if (!this.waitingForLogin) return this.status()
      this.automaticPreparationAttempted = false
      return this.prewarm()
    })
  }

  private async performEnsure(): Promise<PythonRuntimeStatus> {
    this.log({
      event: 'python-runtime-ensure-started',
      version: PYTHON_VERSION,
      platform: this.platform,
      arch: this.arch,
    })
    const installed = await this.inspectInstalledPython()
    if (installed?.version === PYTHON_VERSION) {
      this.setStatus(installed)
      this.log({ event: 'python-runtime-ensure-completed', version: installed.version })
      return { ...installed }
    }

    let metadataDirectory: string | undefined
    try {
      this.waitingForLogin = false
      const downloads = await this.resolveDownloads()
      const uvPath = await this.ensureUv(downloads.uvUrl)
      this.setStatus(this.statusValue('downloading', { phase: 'install' }))
      this.log({ event: 'python-runtime-install-started', version: PYTHON_VERSION })
      await mkdir(this.runtimeBin, { recursive: true, mode: 0o700 })
      metadataDirectory = join(this.root, 'temporary', randomUUID())
      await mkdir(metadataDirectory, { recursive: true, mode: 0o700 })
      const record = pythonArtifact(this.platform, this.arch)
      const metadata = Object.fromEntries(
        Object.entries(record).filter(([key]) => key !== 'key' && key !== 'filename')
      )
      const metadataPath = join(metadataDirectory, 'downloads.json')
      await writeFile(
        metadataPath,
        JSON.stringify({ [record.key]: { ...metadata, url: downloads.pythonUrl } }),
        { mode: 0o600 }
      )
      const installResult = await this.runFile(
        uvPath,
        [
          '--native-tls',
          '--no-config',
          '--no-progress',
          'python',
          'install',
          '--force',
          '--managed-python',
          '--default',
          PYTHON_VERSION,
        ],
        {
          env: await this.bootstrapEnvironment(downloads.pythonUrl, metadataPath),
          timeout: 10 * 60_000,
        }
      )
      const warning = installResult.stderr.trim()
      if (warning) {
        this.log({
          event: 'python-runtime-install-warning',
          warning: redactDownloadUrls(warning).slice(0, 2_000),
        })
      }
      this.setStatus(this.statusValue('downloading', { phase: 'verify' }))
      const ready = await this.inspectInstalledPython()
      if (!ready) {
        throw new Error(`Python ${PYTHON_VERSION} installation completed without a usable launcher`)
      }
      this.setStatus(ready)
      this.log({ event: 'python-runtime-install-completed', version: ready.version })
      return { ...ready }
    } catch (error) {
      if (error instanceof PythonRuntimeLoginRequiredError) {
        this.waitingForLogin = true
        this.automaticPreparationAttempted = false
        const usable = installed ? await this.inspectInstalledPython() : null
        this.setStatus(usable ?? this.statusValue('notInstalled'))
        if (usable) return { ...usable }
        throw error
      }
      const message = errorMessage(error)
      const usable = installed ? await this.inspectInstalledPython() : null
      if (usable) {
        this.setStatus(usable)
        this.log({
          event: 'python-runtime-upgrade-failed',
          currentVersion: usable.version,
          targetVersion: PYTHON_VERSION,
          error: message,
        })
        return { ...usable }
      }
      this.setStatus(this.statusValue('error', { error: message }))
      this.log({ event: 'python-runtime-install-failed', error: message })
      throw downloadFailure(error)
    } finally {
      if (metadataDirectory) await rm(metadataDirectory, { recursive: true, force: true })
    }
  }

  private async inspectInstalledPython(): Promise<PythonRuntimeStatus | null> {
    const path = this.pythonPath()
    if (!(await isFile(path))) return null
    try {
      const { stdout, stderr } = await this.runFile(path, ['-I', '-c', PYTHON_HEALTH_CHECK], {
        env: isolatedPythonEnvironment(this.runtimeEnvironment, this.platform),
        timeout: 5_000,
      })
      const output = `${stdout}\n${stderr}`.trim()
      const match = /Python\s+(\d+)\.(\d+)\.(\d+)/.exec(output)
      if (!match || Number(match[1]) !== 3 || Number(match[2]) !== 12) return null
      const details = await stat(path)
      return this.statusValue('installed', {
        version: `${match[1]}.${match[2]}.${match[3]}`,
        installedBytes: details.size,
      })
    } catch (error) {
      this.log({ event: 'python-runtime-health-check-failed', error: errorMessage(error) })
      return null
    }
  }

  private async ensureUv(uvUrl: string): Promise<string> {
    const artifact = this.artifact()
    this.log({ event: 'python-runtime-uv-prepare-started', archive: artifact.archiveName })
    const executableName = this.platform === 'win32' ? 'uv.exe' : 'uv'
    const targetDirectory = join(this.root, 'bootstrap', `uv-${UV_VERSION}`)
    const targetPath = join(targetDirectory, executableName)
    if (await isFile(targetPath)) {
      try {
        if ((await this.fileSha256(targetPath)) === artifact.executableSha256) {
          this.log({ event: 'python-runtime-uv-cache-verified', version: UV_VERSION })
          return targetPath
        }
      } catch {
        // Treat unreadable cached files as invalid and restore them from the pinned archive.
      }
      this.log({ event: 'python-runtime-uv-cache-invalid', version: UV_VERSION })
      await rm(targetPath, { force: true })
    }

    const temporaryRoot = join(this.root, 'temporary', randomUUID())
    const archivePath = join(temporaryRoot, artifact.archiveName)
    const stagingDirectory = join(temporaryRoot, 'extracted')
    await mkdir(stagingDirectory, { recursive: true, mode: 0o700 })
    this.setStatus(
      this.statusValue('downloading', {
        phase: 'download',
        totalBytes: artifact.archiveBytes,
      })
    )

    let stage = 'download'
    try {
      await this.downloadUv(artifact, archivePath, uvUrl)
      stage = 'extract'
      this.log({ event: 'python-runtime-uv-extract-started', archive: artifact.archiveName })
      if (artifact.archiveName.endsWith('.zip')) {
        await extractPythonBootstrapZip(archivePath, stagingDirectory)
      } else {
        await tar.x({ file: archivePath, cwd: stagingDirectory })
      }
      this.log({ event: 'python-runtime-uv-extract-completed', archive: artifact.archiveName })
      stage = 'verify'
      const extractedPath = join(stagingDirectory, artifact.executablePath)
      if (!(await isFile(extractedPath))) {
        throw new Error(`uv archive does not contain ${artifact.executablePath}`)
      }
      if ((await this.fileSha256(extractedPath)) !== artifact.executableSha256) {
        throw new Error('uv executable checksum mismatch')
      }
      stage = 'publish'
      this.log({ event: 'python-runtime-uv-publish-started', version: UV_VERSION })
      await mkdir(dirname(targetPath), { recursive: true, mode: 0o700 })
      const pendingPath = `${targetPath}.${randomUUID()}.pending`
      await copyFile(extractedPath, pendingPath)
      if (this.platform !== 'win32') await chmod(pendingPath, 0o700)
      await rename(pendingPath, targetPath)
      this.log({ event: 'python-runtime-uv-publish-completed', version: UV_VERSION })
      return targetPath
    } catch (error) {
      this.log({
        event: 'python-runtime-uv-prepare-failed',
        stage,
        downloadedBytes: this.currentStatus.downloadedBytes,
        totalBytes: this.currentStatus.totalBytes,
      })
      throw error
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true })
    }
  }

  private async bootstrapEnvironment(
    pythonUrl: string,
    metadataPath: string
  ): Promise<NodeJS.ProcessEnv> {
    const inherited = Object.fromEntries(
      Object.entries(isolatedPythonEnvironment(this.runtimeEnvironment, this.platform)).filter(
        ([key]) => !key.toUpperCase().startsWith('UV_')
      )
    )
    const environment: NodeJS.ProcessEnv = {
      ...inherited,
      UV_CACHE_DIR: join(this.root, 'cache'),
      UV_MANAGED_PYTHON: 'true',
      UV_PYTHON_BIN_DIR: this.runtimeBin,
      UV_PYTHON_INSTALL_DIR: join(this.root, 'installations'),
      UV_PYTHON_INSTALL_REGISTRY: 'false',
      UV_PYTHON_DOWNLOADS_JSON_URL: metadataPath,
    }
    if (!this.resolveProxy) return environment

    try {
      const proxy = await this.resolveProxy(pythonUrl)
      if (proxy) {
        environment.HTTP_PROXY = proxy
        environment.HTTPS_PROXY = proxy
        environment.ALL_PROXY = proxy
      }
    } catch (error) {
      this.log({ event: 'python-runtime-proxy-resolution-failed', error: errorMessage(error) })
    }
    return environment
  }

  private async downloadUv(
    artifact: UvArtifact,
    destination: string,
    uvUrl: string
  ): Promise<void> {
    const controller = new AbortController()
    let timedOut = false
    this.log({
      event: 'python-runtime-uv-download-started',
      archive: artifact.archiveName,
      totalBytes: artifact.archiveBytes,
      timeoutMs: this.downloadTimeoutMs,
    })
    const timeout = setTimeout(() => {
      timedOut = true
      this.log({
        event: 'python-runtime-uv-download-aborting',
        downloadedBytes: this.currentStatus.downloadedBytes,
        totalBytes: artifact.archiveBytes,
      })
      controller.abort()
    }, this.downloadTimeoutMs)

    try {
      const response = await this.fetch(uvUrl, {
        signal: controller.signal,
      })
      if (!response.ok || !response.body) {
        throw new Error(`Failed to download uv: HTTP ${response.status}`)
      }
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
      let downloadedBytes = 0
      const hash = createHash('sha256')
      const tracker = new Transform({
        transform: (chunk: Buffer, _encoding, callback) => {
          downloadedBytes += chunk.length
          hash.update(chunk)
          this.setStatus(
            this.statusValue('downloading', {
              phase: 'download',
              downloadedBytes,
              totalBytes: artifact.archiveBytes,
            })
          )
          callback(null, chunk)
        },
      })
      await pipeline(
        Readable.fromWeb(response.body as import('node:stream/web').ReadableStream),
        tracker,
        createWriteStream(destination, { mode: 0o600 }),
        { signal: controller.signal }
      )
      const actualSha256 = hash.digest('hex')
      if (downloadedBytes !== artifact.archiveBytes) {
        throw new Error(
          `uv archive size mismatch: expected ${artifact.archiveBytes}, received ${downloadedBytes}`
        )
      }
      if (actualSha256 !== artifact.archiveSha256) {
        throw new Error('uv archive checksum mismatch')
      }
      this.log({ event: 'python-runtime-uv-download-completed', downloadedBytes })
    } catch (error) {
      this.log({
        event: 'python-runtime-uv-download-failed',
        timedOut,
        downloadedBytes: this.currentStatus.downloadedBytes,
        totalBytes: artifact.archiveBytes,
      })
      if (timedOut) {
        throw new Error(`uv download timed out after ${this.downloadTimeoutMs}ms`, {
          cause: error,
        })
      }
      throw error
    } finally {
      clearTimeout(timeout)
    }
  }

  private artifact(): UvArtifact {
    const artifact = UV_ARTIFACTS[`${this.platform}-${this.arch}`]
    if (!artifact) {
      throw new Error(`Managed Python is unavailable for ${this.platform}-${this.arch}`)
    }
    return artifact
  }

  private pythonPath(): string {
    return join(this.runtimeBin, this.platform === 'win32' ? 'python.exe' : 'python3')
  }

  private setStatus(status: PythonRuntimeStatus): void {
    if (status.state !== 'downloading') this.temporaryPythonVersion = undefined
    else if (this.temporaryPythonVersion)
      status = { ...status, temporaryPythonVersion: this.temporaryPythonVersion }
    const previous = this.currentStatus
    this.currentStatus = status
    if (JSON.stringify(previous) === JSON.stringify(status)) return
    const now = Date.now()
    if (
      status.state === 'downloading' &&
      previous.state === status.state &&
      previous.phase === status.phase &&
      previous.temporaryPythonVersion === status.temporaryPythonVersion &&
      now - this.lastStatusPublishedAt < 250
    )
      return
    this.lastStatusPublishedAt = now
    this.onStatusChange?.({ ...status })
  }

  private statusValue(
    state: PythonRuntimeStatus['state'],
    overrides: Partial<PythonRuntimeStatus> = {}
  ): PythonRuntimeStatus {
    return {
      id: 'python',
      managed: true,
      autoInstall: true,
      state,
      version: null,
      downloadedBytes: 0,
      totalBytes: 0,
      installedBytes: 0,
      path: this.pythonPath(),
      error: null,
      source: 'managed',
      phase: null,
      ...overrides,
    }
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

function errorMessage(error: unknown): string {
  return redactDownloadUrls(error instanceof Error ? error.message : String(error))
}

function downloadFailure(error: unknown): Error {
  // Expose the sanitized message only: subprocess output and nested causes can contain grants.
  return new Error(errorMessage(error))
}

function redactDownloadUrls(message: string): string {
  return message.replace(/(https?:\/\/[^\s?'"<>]+)\?[^\s'"<>]*/g, '$1?[redacted]')
}

function isolatedPythonEnvironment(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform
): NodeJS.ProcessEnv {
  const isolated = { ...environment }
  for (const key of Object.keys(isolated)) {
    const normalized = platform === 'win32' ? key.toUpperCase() : key
    if (['PYTHONHOME', 'PYTHONPATH', 'PYTHONUSERBASE', 'PYTHONNOUSERSITE'].includes(normalized)) {
      delete isolated[key]
    }
  }
  isolated.PYTHONNOUSERSITE = '1'
  return isolated
}
