import { open, readdir, stat, type FileHandle } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { StringDecoder } from 'node:string_decoder'

import { redactLog } from '../runtime/rotating-log.js'
import type { StartupProgressUpdate } from './startup-progress.js'

export interface StartupFailureSnapshot {
  message: string
  stack?: string
  pluginName?: string | null
  source?: string
  stage?: string
}

export interface StartupDiagnosticsOptions {
  appName: string
  appVersion: string
  platform: NodeJS.Platform
  arch: string
  osRelease?: string
  electronVersion?: string
  nodeVersion: string
  logDirectories: readonly string[]
  extraLogPaths?: readonly string[]
  progress: {
    current: StartupProgressUpdate | null
    history: readonly StartupProgressUpdate[]
  }
  failure: StartupFailureSnapshot | null
  runtimeError?: string | null
  runtimeState?: unknown
  now?: () => number
  maxLogFiles?: number
  maxLogTailBytes?: number
  maxLogScanBytes?: number
}

interface LogFile {
  path: string
  size: number
  modifiedAt: number
}

const DEFAULT_MAX_LOG_FILES = 12
const DEFAULT_MAX_LOG_TAIL_BYTES = 96 * 1024
const DEFAULT_MAX_LOG_SCAN_BYTES = 8 * 1024 * 1024
const LOG_SCAN_CHUNK_BYTES = 64 * 1024
const MAX_ERROR_LINE_CHARACTERS = 4 * 1024
const MAX_ERROR_LINES = 60
// Reserve the file budget for current startup sources before rotated logs.
const PRIORITY_LOG_NAMES = [
  'wework-main.log',
  'renderer-startup.log',
  'executor.log',
  'dsh-core-runtime.log',
  'app-update.log',
  'wework-startup-bootstrap.log',
  'runtime-launch.log',
] as const
const ERROR_LINE_PATTERN =
  /\b(error|failed|failure|fatal|exception|timeout|timed out|refused|crash|exit(?:ed)? code|EADDRINUSE|ENOENT|EACCES)\b/i

export async function buildStartupDiagnostics(options: StartupDiagnosticsOptions): Promise<string> {
  const now = options.now ?? Date.now
  const logFiles = await collectLogFiles(
    options.logDirectories,
    options.extraLogPaths ?? [],
    options.maxLogFiles ?? DEFAULT_MAX_LOG_FILES
  )
  const tails = await readLogTails(
    logFiles,
    options.maxLogTailBytes ?? DEFAULT_MAX_LOG_TAIL_BYTES,
    options.maxLogScanBytes ?? DEFAULT_MAX_LOG_SCAN_BYTES
  )
  const sections = [
    'Wework startup diagnostics',
    '====================',
    `Generated: ${new Date(now()).toISOString()}`,
    `App: ${options.appName} ${options.appVersion}`,
    `Platform: ${options.platform} ${options.arch}${options.osRelease ? ` (${options.osRelease})` : ''}`,
    `Electron: ${options.electronVersion ?? 'unknown'}`,
    `Node: ${options.nodeVersion}`,
    '',
    '[Startup result]',
    formatOutcome(options.progress, options.failure, options.runtimeError, now),
    '',
    '[Startup progress]',
    formatProgress(options.progress, now),
    '',
    '[Failure]',
    formatFailure(options.failure, options.runtimeError),
    '',
    '[Runtime state]',
    formatRuntimeState(options.runtimeState),
    '',
    '[Log directories]',
    options.logDirectories.length > 0 ? options.logDirectories.join('\n') : '(none)',
    '',
    '[Recent error lines]',
    formatRecentErrorLines(logFiles, tails),
    '',
    '[Log files]',
    formatLogFiles(logFiles, tails),
    '',
    '=== End of Wework startup diagnostics ===',
  ]
  return redactLog(sections.join('\n'))
}

function formatOutcome(
  progress: StartupDiagnosticsOptions['progress'],
  failure: StartupFailureSnapshot | null,
  runtimeError: string | null | undefined,
  now: () => number
): string {
  if (failure || runtimeError) {
    return `Startup failed: ${failure?.message ?? runtimeError}`
  }
  const current = progress.current
  if (!current) return 'Startup is in progress (no stage reported yet)'
  const elapsed = Math.max(0, now() - current.startedAt)
  const stage = `${current.stage.id} (${current.index + 1}/${current.total})`
  if (elapsed > current.stage.timeoutMs) {
    return `Startup is slow: stage ${stage} has been running for ${formatDuration(
      elapsed
    )}, beyond its ${formatDuration(current.stage.timeoutMs)} budget`
  }
  return `Startup is in progress at stage ${stage} for ${formatDuration(elapsed)}`
}

async function collectLogFiles(
  directories: readonly string[],
  extraPaths: readonly string[],
  maxFiles: number
): Promise<LogFile[]> {
  const files = new Map<string, LogFile>()
  const explicitPaths = new Set(extraPaths.map(path => resolve(path)))
  for (const path of extraPaths) {
    const resolved = resolve(path)
    const metadata = await stat(resolved).catch(() => null)
    if (metadata?.isFile()) {
      files.set(resolved, {
        path: resolved,
        size: metadata.size,
        modifiedAt: metadata.mtimeMs,
      })
    }
  }
  for (const directory of new Set(directories.map(directory => resolve(directory)))) {
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isFile() || !isLogName(entry.name)) continue
      const path = join(directory, entry.name)
      const metadata = await stat(path).catch(() => null)
      if (!metadata?.isFile()) continue
      files.set(path, {
        path,
        size: metadata.size,
        modifiedAt: metadata.mtimeMs,
      })
    }
  }
  return [...files.values()]
    .sort((left, right) => {
      const priority =
        logPriority(basename(left.path), explicitPaths.has(left.path)) -
        logPriority(basename(right.path), explicitPaths.has(right.path))
      return priority !== 0
        ? priority
        : right.modifiedAt - left.modifiedAt || left.path.localeCompare(right.path)
    })
    .slice(0, maxFiles)
}

function isLogName(name: string): boolean {
  return /\.log(?:\.\d+|\.bak)?$/i.test(name) || /\.log\.[^.]+$/i.test(name)
}

function logPriority(name: string, explicit: boolean): number {
  const index = PRIORITY_LOG_NAMES.indexOf(
    name.toLowerCase() as (typeof PRIORITY_LOG_NAMES)[number]
  )
  if (index !== -1) return index
  if (explicit) return PRIORITY_LOG_NAMES.length
  return PRIORITY_LOG_NAMES.length + (/\.log$/i.test(name) ? 1 : 2)
}

function formatProgress(
  progress: StartupDiagnosticsOptions['progress'],
  now: () => number
): string {
  const lines: string[] = []
  const history = progress.history
  if (history.length === 0) {
    lines.push('(no startup stages recorded)')
  } else {
    const base = history[0].startedAt
    for (const [index, update] of history.entries()) {
      const next = history[index + 1]
      const duration = next ? next.startedAt - update.startedAt : now() - update.startedAt
      lines.push(
        `+${formatDuration(update.startedAt - base)}  ${update.stage.id}  (stage ${update.index + 1}/${update.total}, ${formatDuration(duration)})`
      )
    }
  }
  if (progress.current) {
    const current = progress.current
    const elapsed = now() - current.startedAt
    lines.push(
      '',
      `Current stage: ${current.stage.id} (${current.index + 1}/${current.total}), elapsed ${formatDuration(elapsed)}`
    )
    if (current.activity) {
      lines.push(`Current activity: ${current.activity.kind} ${current.activity.path}`)
    }
  }
  return lines.join('\n')
}

function formatFailure(
  failure: StartupFailureSnapshot | null,
  runtimeError: string | null | undefined
): string {
  const lines: string[] = []
  if (failure) {
    if (failure.pluginName) lines.push(`Plugin: ${failure.pluginName}`)
    if (failure.source) lines.push(`Source: ${failure.source}`)
    if (failure.stage) lines.push(`Stage: ${failure.stage}`)
    lines.push(`Message: ${failure.message}`)
    if (failure.stack) lines.push('', failure.stack)
  }
  if (runtimeError && runtimeError !== failure?.message) {
    lines.push(`Runtime error: ${runtimeError}`)
  }
  return lines.length > 0 ? lines.join('\n') : '(no startup failure recorded)'
}

function formatRuntimeState(runtimeState: unknown): string {
  if (runtimeState === undefined || runtimeState === null) return '(unavailable)'
  try {
    return JSON.stringify(runtimeState, null, 2)
  } catch {
    return String(runtimeState)
  }
}

interface LogWindow {
  tail: string
  /** First matching error before the included tail, within the scan budget. */
  firstErrorLine: string | null
  firstErrorScanLimit?: number
}

async function readLogTails(
  files: readonly LogFile[],
  maxTailBytes: number,
  maxScanBytes: number
): Promise<Map<string, LogWindow>> {
  const windows = new Map<string, LogWindow>()
  for (const file of files) {
    windows.set(file.path, await readLogWindow(file.path, maxTailBytes, maxScanBytes))
  }
  return windows
}

function formatLogFiles(files: readonly LogFile[], tails: ReadonlyMap<string, LogWindow>): string {
  if (files.length === 0) return '(no log files found)'
  const sections: string[] = []
  for (const file of files) {
    const window = tails.get(file.path)
    sections.push(
      `--- ${basename(file.path)} (${formatBytes(file.size)}, modified ${new Date(
        file.modifiedAt
      ).toISOString()}) ---`,
      `path: ${file.path}`,
      ...(window?.firstErrorLine
        ? [`[first error before the included tail] ${window.firstErrorLine}`, '']
        : []),
      ...(window?.firstErrorScanLimit !== undefined
        ? [
            `[first-error scan limited to ${formatBytes(window.firstErrorScanLimit)}; middle log content was not scanned]`,
            '',
          ]
        : []),
      window?.tail.trimEnd() || '(empty)'
    )
  }
  return sections.join('\n\n')
}

function formatRecentErrorLines(
  files: readonly LogFile[],
  tails: ReadonlyMap<string, LogWindow>
): string {
  const matches: string[] = []
  for (const file of files) {
    const window = tails.get(file.path)
    if (window?.firstErrorLine) {
      matches.push(`${basename(file.path)}: ${window.firstErrorLine}`)
      if (matches.length >= MAX_ERROR_LINES) break
    }
    for (const line of (window?.tail ?? '').split('\n')) {
      if (!ERROR_LINE_PATTERN.test(line)) continue
      matches.push(`${basename(file.path)}: ${line.trim()}`)
      if (matches.length >= MAX_ERROR_LINES) break
    }
    if (matches.length >= MAX_ERROR_LINES) break
  }
  return matches.length > 0 ? matches.join('\n') : '(no error lines found in recent logs)'
}

async function readLogWindow(
  path: string,
  maxBytes: number,
  maxScanBytes: number
): Promise<LogWindow> {
  try {
    const handle = await open(path, 'r')
    try {
      const metadata = await handle.stat()
      const tailLength = Math.min(metadata.size, maxBytes)
      const tailStart = Math.max(0, metadata.size - tailLength)
      const tailBuffer = Buffer.alloc(tailLength)
      await handle.read(tailBuffer, 0, tailLength, tailStart)
      const tail = tailBuffer.toString('utf8')
      if (tailStart === 0) return { tail, firstErrorLine: null }

      const scan = await scanFirstErrorLine(handle, tailStart, maxScanBytes)
      return { tail, ...scan }
    } finally {
      await handle.close()
    }
  } catch (error) {
    return {
      tail: `(unable to read log: ${error instanceof Error ? error.message : String(error)})`,
      firstErrorLine: null,
    }
  }
}

async function scanFirstErrorLine(
  handle: FileHandle,
  endPosition: number,
  maxBytes: number
): Promise<Omit<LogWindow, 'tail'>> {
  const scanLength = Math.max(0, Math.min(endPosition, maxBytes))
  const buffer = Buffer.alloc(Math.min(scanLength, LOG_SCAN_CHUNK_BYTES))
  const decoder = new StringDecoder('utf8')
  let pending = ''
  let position = 0
  while (position < scanLength) {
    const { bytesRead } = await handle.read(
      buffer,
      0,
      Math.min(buffer.length, scanLength - position),
      position
    )
    if (bytesRead === 0) break
    position += bytesRead
    const lines = (pending + decoder.write(buffer.subarray(0, bytesRead))).split('\n')
    pending = lines.pop() ?? ''
    const firstErrorLine = findErrorLine(lines)
    if (firstErrorLine) return { firstErrorLine }
  }
  return {
    firstErrorLine: findErrorLine([pending + decoder.end()]),
    ...(position < endPosition ? { firstErrorScanLimit: position } : {}),
  }
}

function findErrorLine(lines: readonly string[]): string | null {
  const line = lines.find(line => ERROR_LINE_PATTERN.test(line))?.trim()
  if (!line) return null
  return line.length > MAX_ERROR_LINE_CHARACTERS
    ? `${line.slice(0, MAX_ERROR_LINE_CHARACTERS)}… [truncated]`
    : line
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, milliseconds) / 1000
  return seconds < 60
    ? `${seconds.toFixed(1)}s`
    : `${Math.floor(seconds / 60)}m ${String(Math.floor(seconds % 60)).padStart(2, '0')}s`
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
