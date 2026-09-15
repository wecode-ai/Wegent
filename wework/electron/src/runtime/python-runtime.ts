import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { chmod, copyFile, mkdir, rename, rm, stat } from 'node:fs/promises'
import { delimiter, dirname, join, win32 } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import extractZip from 'extract-zip'
import * as tar from 'tar'

const execFileAsync = promisify(execFile)

const PYTHON_VERSION = '3.12'
const UV_VERSION = '0.9.5'
const UV_DOWNLOAD_BASE_URL = `https://mjs.sinaimg.cn/umd/cs-packages/uv/${UV_VERSION}`
const PYTHON_DOWNLOAD_MIRROR_URL =
  'https://python-standalone.org/mirror/astral-sh/python-build-standalone/'

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
}

interface RunFileResult {
  stdout: string
  stderr: string
}

type RunFile = (
  file: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; timeout: number }
) => Promise<RunFileResult>

export interface PythonRuntimeManagerOptions {
  dataDirectory: string
  environment: NodeJS.ProcessEnv
  runtimeBin: string
  platform?: NodeJS.Platform
  arch?: string
  fetch?: typeof fetch
  runFile?: RunFile
  fileSha256?: (path: string) => Promise<string>
  log?: (event: Record<string, unknown>) => void
}

export class PythonRuntimeManager {
  private readonly root: string
  private readonly environmentValue: NodeJS.ProcessEnv
  private readonly runtimeBin: string
  private readonly platform: NodeJS.Platform
  private readonly arch: string
  private readonly fetch: typeof fetch
  private readonly runFile: RunFile
  private readonly fileSha256: (path: string) => Promise<string>
  private readonly log: (event: Record<string, unknown>) => void
  private activeEnsure: Promise<PythonRuntimeStatus> | null = null
  private currentStatus: PythonRuntimeStatus

  constructor(options: PythonRuntimeManagerOptions) {
    this.root = join(options.dataDirectory, 'managed-runtimes', 'python')
    this.runtimeBin = options.runtimeBin
    this.platform = options.platform ?? process.platform
    this.arch = options.arch ?? process.arch
    this.fetch = options.fetch ?? globalThis.fetch
    this.fileSha256 = options.fileSha256 ?? sha256File
    this.runFile =
      options.runFile ??
      (async (file, args, runOptions) => {
        const result = await execFileAsync(file, args, runOptions)
        return { stdout: result.stdout, stderr: result.stderr }
      })
    this.log = options.log ?? (() => undefined)
    this.environmentValue = {
      ...withPrependedPath(options.environment, this.runtimeBin, this.platform),
      UV_CACHE_DIR: join(this.root, 'cache'),
      UV_MANAGED_PYTHON: 'true',
      UV_PYTHON_BIN_DIR: this.runtimeBin,
      UV_PYTHON_INSTALL_DIR: join(this.root, 'installations'),
      UV_PYTHON_INSTALL_REGISTRY: 'false',
      UV_PYTHON_INSTALL_MIRROR_URL: PYTHON_DOWNLOAD_MIRROR_URL,
      WEGENT_PYTHON_PATH: this.pythonPath(),
      WEWORK_RUNTIME_BIN: this.runtimeBin,
    }
    this.currentStatus = this.statusValue('idle')
  }

  environment(): NodeJS.ProcessEnv {
    return { ...this.environmentValue }
  }

  async status(): Promise<PythonRuntimeStatus> {
    if (this.activeEnsure) return { ...this.currentStatus }
    const installed = await this.inspectInstalledPython()
    this.currentStatus =
      installed ??
      (this.currentStatus.state === 'error' ? this.currentStatus : this.statusValue('notInstalled'))
    return { ...this.currentStatus }
  }

  ensure(): Promise<PythonRuntimeStatus> {
    if (this.activeEnsure) return this.activeEnsure
    this.activeEnsure = this.performEnsure().finally(() => {
      this.activeEnsure = null
    })
    return this.activeEnsure
  }

  startBackgroundEnsure(): void {
    void this.ensure().catch(error => {
      this.log({ event: 'python-runtime-background-ensure-failed', error: errorMessage(error) })
    })
  }

  private async performEnsure(): Promise<PythonRuntimeStatus> {
    const installed = await this.inspectInstalledPython()
    if (installed) {
      this.currentStatus = installed
      return { ...installed }
    }

    try {
      const uvPath = await this.ensureUv()
      this.currentStatus = this.statusValue('downloading')
      this.log({ event: 'python-runtime-install-started', version: PYTHON_VERSION })
      await mkdir(this.runtimeBin, { recursive: true, mode: 0o700 })
      const installResult = await this.runFile(
        uvPath,
        [
          '--no-config',
          '--no-progress',
          'python',
          'install',
          '--managed-python',
          '--default',
          PYTHON_VERSION,
        ],
        { env: this.environmentValue, timeout: 10 * 60_000 }
      )
      const warning = installResult.stderr.trim()
      if (warning) {
        this.log({ event: 'python-runtime-install-warning', warning: warning.slice(0, 2_000) })
      }
      const ready = await this.inspectInstalledPython()
      if (!ready) {
        throw new Error(`Python ${PYTHON_VERSION} installation completed without a usable launcher`)
      }
      this.currentStatus = ready
      this.log({ event: 'python-runtime-install-completed', version: ready.version })
      return { ...ready }
    } catch (error) {
      const message = errorMessage(error)
      this.currentStatus = this.statusValue('error', { error: message })
      this.log({ event: 'python-runtime-install-failed', error: message })
      throw error
    }
  }

  private async inspectInstalledPython(): Promise<PythonRuntimeStatus | null> {
    const path = this.pythonPath()
    try {
      const { stdout, stderr } = await this.runFile(path, ['--version'], {
        env: this.environmentValue,
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
    } catch {
      return null
    }
  }

  private async ensureUv(): Promise<string> {
    const artifact = this.artifact()
    const executableName = this.platform === 'win32' ? 'uv.exe' : 'uv'
    const targetDirectory = join(this.root, 'bootstrap', `uv-${UV_VERSION}`)
    const targetPath = join(targetDirectory, executableName)
    if (await isFile(targetPath)) {
      try {
        if ((await this.fileSha256(targetPath)) === artifact.executableSha256) return targetPath
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
    this.currentStatus = this.statusValue('downloading', {
      totalBytes: artifact.archiveBytes,
    })

    try {
      await this.downloadUv(artifact, archivePath)
      if (artifact.archiveName.endsWith('.zip')) {
        await extractZip(archivePath, { dir: stagingDirectory })
      } else {
        await tar.x({ file: archivePath, cwd: stagingDirectory })
      }
      const extractedPath = join(stagingDirectory, artifact.executablePath)
      if (!(await isFile(extractedPath))) {
        throw new Error(`uv archive does not contain ${artifact.executablePath}`)
      }
      if ((await this.fileSha256(extractedPath)) !== artifact.executableSha256) {
        throw new Error('uv executable checksum mismatch')
      }
      await mkdir(dirname(targetPath), { recursive: true, mode: 0o700 })
      const pendingPath = `${targetPath}.${randomUUID()}.pending`
      await copyFile(extractedPath, pendingPath)
      if (this.platform !== 'win32') await chmod(pendingPath, 0o700)
      await rename(pendingPath, targetPath)
      return targetPath
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true })
    }
  }

  private async downloadUv(artifact: UvArtifact, destination: string): Promise<void> {
    const response = await this.fetch(`${UV_DOWNLOAD_BASE_URL}/${artifact.archiveName}`)
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
        this.currentStatus = this.statusValue('downloading', {
          downloadedBytes,
          totalBytes: artifact.archiveBytes,
        })
        callback(null, chunk)
      },
    })
    await pipeline(
      Readable.fromWeb(response.body as import('node:stream/web').ReadableStream),
      tracker,
      createWriteStream(destination, { mode: 0o600 })
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
  return error instanceof Error ? error.message : String(error)
}

function withPrependedPath(
  environment: NodeJS.ProcessEnv,
  directory: string,
  platform: NodeJS.Platform
): NodeJS.ProcessEnv {
  const normalized = { ...environment }
  const currentPath =
    environment.PATH ??
    (platform === 'win32'
      ? Object.entries(environment).find(([key]) => key.toLowerCase() === 'path')?.[1]
      : undefined)
  if (platform === 'win32') {
    for (const key of Object.keys(normalized)) {
      if (key !== 'PATH' && key.toLowerCase() === 'path') delete normalized[key]
    }
  }
  const separator = platform === 'win32' ? win32.delimiter : delimiter
  const entries = currentPath?.split(separator).filter(Boolean) ?? []
  normalized.PATH = [directory, ...entries.filter(entry => entry !== directory)].join(separator)
  return normalized
}
