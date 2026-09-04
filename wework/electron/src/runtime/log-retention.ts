import { lstat, readdir, unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const DAY_MS = 24 * 60 * 60 * 1000
const LOG_FILE_NAME_PATTERN = /\.log(?:\.\d+|\.bak)?$/i

export const DEFAULT_LOG_RETENTION_POLICY: LogRetentionPolicy = {
  activeFileGraceMs: 15 * 60 * 1000,
  cleanupIntervalMs: 60 * 60 * 1000,
  maxAgeMs: 14 * DAY_MS,
  maxTotalBytes: 256 * 1024 * 1024,
}

export interface LogRetentionPolicy {
  activeFileGraceMs: number
  cleanupIntervalMs: number
  maxAgeMs: number
  maxTotalBytes: number
}

export interface LogCleanupFailure {
  operation: 'scan' | 'delete'
  path: string
  message: string
}

export interface LogCleanupResult {
  failures: LogCleanupFailure[]
  remainingBytes: number
  removedBytes: number
  removedFiles: number
  scannedFiles: number
}

export interface CleanupLogDirectoriesOptions {
  directories: string[]
  now?: number
  policy?: Partial<LogRetentionPolicy>
}

export interface LogRetentionServiceOptions {
  directories: string[]
  onResult?: (result: LogCleanupResult) => void
  policy?: Partial<LogRetentionPolicy>
}

interface LogFile {
  mtimeMs: number
  path: string
  size: number
}

export class LogRetentionService {
  private readonly policy: LogRetentionPolicy
  private timer: NodeJS.Timeout | null = null
  private cleanupPromise: Promise<LogCleanupResult> | null = null

  constructor(private readonly options: LogRetentionServiceOptions) {
    this.policy = retentionPolicy(options.policy)
  }

  async start(): Promise<LogCleanupResult> {
    const result = await this.cleanup()
    if (!this.timer) {
      this.timer = setInterval(() => {
        void this.cleanup()
      }, this.policy.cleanupIntervalMs)
      this.timer.unref()
    }
    return result
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    await this.cleanupPromise
  }

  cleanup(): Promise<LogCleanupResult> {
    this.cleanupPromise ??= cleanupLogDirectories({
      directories: this.options.directories,
      policy: this.policy,
    })
      .then(result => {
        this.options.onResult?.(result)
        return result
      })
      .finally(() => {
        this.cleanupPromise = null
      })
    return this.cleanupPromise
  }
}

export async function cleanupLogDirectories(
  options: CleanupLogDirectoriesOptions
): Promise<LogCleanupResult> {
  const policy = retentionPolicy(options.policy)
  const now = options.now ?? Date.now()
  const failures: LogCleanupFailure[] = []
  const files: LogFile[] = []
  for (const directory of uniqueDirectories(options.directories)) {
    await collectLogFiles(directory, files, failures)
  }
  files.sort((left, right) => left.mtimeMs - right.mtimeMs || left.path.localeCompare(right.path))

  let remainingBytes = files.reduce((total, file) => total + file.size, 0)
  let removedBytes = 0
  let removedFiles = 0
  const removedPaths = new Set<string>()
  const activeCutoff = now - policy.activeFileGraceMs
  const ageCutoff = now - policy.maxAgeMs

  const remove = async (file: LogFile): Promise<void> => {
    if (!(await removeLogFile(file.path, failures))) return
    removedPaths.add(file.path)
    remainingBytes -= file.size
    removedBytes += file.size
    removedFiles += 1
  }

  for (const file of files) {
    if (file.mtimeMs < ageCutoff) await remove(file)
  }
  if (remainingBytes > policy.maxTotalBytes) {
    for (const file of files) {
      if (remainingBytes <= policy.maxTotalBytes) break
      if (removedPaths.has(file.path) || file.mtimeMs >= activeCutoff) continue
      await remove(file)
    }
  }

  return {
    failures,
    remainingBytes,
    removedBytes,
    removedFiles,
    scannedFiles: files.length,
  }
}

function retentionPolicy(overrides?: Partial<LogRetentionPolicy>): LogRetentionPolicy {
  const policy = { ...DEFAULT_LOG_RETENTION_POLICY, ...overrides }
  for (const [name, value] of Object.entries(policy)) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`${name} must be a positive finite number`)
    }
  }
  return policy
}

function uniqueDirectories(directories: string[]): string[] {
  return [...new Set(directories.filter(path => path.trim()).map(path => resolve(path)))]
}

async function collectLogFiles(
  directory: string,
  files: LogFile[],
  failures: LogCleanupFailure[]
): Promise<void> {
  let entries
  try {
    entries = await readdir(directory)
  } catch (error) {
    if (isMissing(error)) return
    failures.push(failure('scan', directory, error))
    return
  }

  for (const entry of entries) {
    const path = join(directory, entry)
    try {
      const metadata = await lstat(path)
      if (metadata.isFile() && LOG_FILE_NAME_PATTERN.test(entry)) {
        files.push({ mtimeMs: metadata.mtimeMs, path, size: metadata.size })
      }
    } catch (error) {
      if (!isMissing(error)) failures.push(failure('scan', path, error))
    }
  }
}

async function removeLogFile(path: string, failures: LogCleanupFailure[]): Promise<boolean> {
  try {
    await unlink(path)
    return true
  } catch (error) {
    if (isMissing(error)) return true
    failures.push(failure('delete', path, error))
    return false
  }
}

function failure(
  operation: LogCleanupFailure['operation'],
  path: string,
  error: unknown
): LogCleanupFailure {
  return {
    operation,
    path,
    message: error instanceof Error ? error.message : String(error),
  }
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}
