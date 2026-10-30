import { open, readdir, stat } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'

import { redactLog } from '../runtime/rotating-log.js'
import type { StartupProgressUpdate } from './startup-progress.js'

export interface StartupFailureSnapshot {
  message: string
  stack?: string
  pluginName?: string | null
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
}

interface LogFile {
  path: string
  size: number
  modifiedAt: number
}

const DEFAULT_MAX_LOG_FILES = 12
const DEFAULT_MAX_LOG_TAIL_BYTES = 16 * 1024
const MAX_ERROR_LINES = 60
const ERROR_LINE_PATTERN =
  /\b(error|failed|failure|fatal|exception|timeout|timed out|refused|crash|exit(?:ed)? code|EADDRINUSE|ENOENT|EACCES)\b/i

export async function buildStartupDiagnostics(options: StartupDiagnosticsOptions): Promise<string> {
  const now = options.now ?? Date.now
  const logFiles = await collectLogFiles(
    options.logDirectories,
    options.extraLogPaths ?? [],
    options.maxLogFiles ?? DEFAULT_MAX_LOG_FILES
  )
  const tails = await readLogTails(logFiles, options.maxLogTailBytes ?? DEFAULT_MAX_LOG_TAIL_BYTES)
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
    .sort(
      (left, right) => right.modifiedAt - left.modifiedAt || left.path.localeCompare(right.path)
    )
    .slice(0, maxFiles)
}

function isLogName(name: string): boolean {
  return /\.log(?:\.\d+|\.bak)?$/i.test(name) || /\.log\.[^.]+$/i.test(name)
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

async function readLogTails(
  files: readonly LogFile[],
  maxTailBytes: number
): Promise<Map<string, string>> {
  const tails = new Map<string, string>()
  for (const file of files) {
    tails.set(file.path, await readLogTail(file.path, maxTailBytes))
  }
  return tails
}

function formatLogFiles(files: readonly LogFile[], tails: ReadonlyMap<string, string>): string {
  if (files.length === 0) return '(no log files found)'
  const sections: string[] = []
  for (const file of files) {
    const tail = tails.get(file.path) ?? ''
    sections.push(
      `--- ${basename(file.path)} (${formatBytes(file.size)}, modified ${new Date(
        file.modifiedAt
      ).toISOString()}) ---`,
      `path: ${file.path}`,
      tail.trimEnd() || '(empty)'
    )
  }
  return sections.join('\n\n')
}

function formatRecentErrorLines(
  files: readonly LogFile[],
  tails: ReadonlyMap<string, string>
): string {
  const matches: string[] = []
  for (const file of files) {
    for (const line of (tails.get(file.path) ?? '').split('\n')) {
      if (!ERROR_LINE_PATTERN.test(line)) continue
      matches.push(`${basename(file.path)}: ${line.trim()}`)
      if (matches.length >= MAX_ERROR_LINES) break
    }
    if (matches.length >= MAX_ERROR_LINES) break
  }
  return matches.length > 0 ? matches.join('\n') : '(no error lines found in recent logs)'
}

async function readLogTail(path: string, maxBytes: number): Promise<string> {
  try {
    const handle = await open(path, 'r')
    try {
      const metadata = await handle.stat()
      const length = Math.min(metadata.size, maxBytes)
      const buffer = Buffer.alloc(length)
      await handle.read(buffer, 0, length, Math.max(0, metadata.size - length))
      return buffer.toString('utf8')
    } finally {
      await handle.close()
    }
  } catch (error) {
    return `(unable to read log: ${error instanceof Error ? error.message : String(error)})`
  }
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
