import { appendFile, mkdir, rename, stat, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface RotatingLogOptions {
  path: string
  maxBytes?: number
  maxEntryBytes?: number
  retainedFiles?: number
}

const DEFAULT_MAX_ENTRY_BYTES = 256 * 1024
const TRUNCATION_MARKER = '… [truncated]'

export class RotatingLog {
  private readonly maxBytes: number
  private readonly maxEntryBytes: number
  private readonly retainedFiles: number
  private size = 0
  private initialized = false
  private queue = Promise.resolve()

  constructor(private readonly options: RotatingLogOptions) {
    this.maxBytes = options.maxBytes ?? 5 * 1024 * 1024
    this.maxEntryBytes = options.maxEntryBytes ?? DEFAULT_MAX_ENTRY_BYTES
    this.retainedFiles = options.retainedFiles ?? 3
    if (this.maxEntryBytes < 64) {
      throw new Error('maxEntryBytes must be at least 64 bytes')
    }
  }

  write(source: 'stdout' | 'stderr' | 'supervisor', value: string): Promise<void> {
    const line = formatLogLine(source, value, this.maxEntryBytes)
    this.queue = this.queue.then(async () => {
      await this.initialize()
      const bytes = Buffer.byteLength(line)
      if (this.size > 0 && this.size + bytes > this.maxBytes) await this.rotate()
      await appendFile(this.options.path, line, { encoding: 'utf8', mode: 0o600 })
      this.size += bytes
    })
    return this.queue
  }

  flush(): Promise<void> {
    return this.queue
  }

  private async initialize(): Promise<void> {
    if (this.initialized) return
    this.initialized = true
    await mkdir(dirname(this.options.path), { recursive: true, mode: 0o700 })
    try {
      this.size = (await stat(this.options.path)).size
    } catch {
      this.size = 0
    }
  }

  private async rotate(): Promise<void> {
    for (let index = this.retainedFiles; index >= 1; index -= 1) {
      const source = index === 1 ? this.options.path : `${this.options.path}.${index - 1}`
      const destination = `${this.options.path}.${index}`
      if (index === this.retainedFiles) {
        await unlink(destination).catch(ignoreMissing)
      }
      await rename(source, destination).catch(ignoreMissing)
    }
    this.size = 0
  }
}

function formatLogLine(
  source: 'stdout' | 'stderr' | 'supervisor',
  value: string,
  maxEntryBytes: number
): string {
  const prefix = `${new Date().toISOString()} [${source}] `
  const content = redactLog(value).trimEnd()
  const line = `${prefix}${content}\n`
  if (Buffer.byteLength(line) <= maxEntryBytes) return line

  const suffix = `${TRUNCATION_MARKER}\n`
  const contentBudget = maxEntryBytes - Buffer.byteLength(prefix) - Buffer.byteLength(suffix)
  return `${prefix}${truncateUtf8(content, Math.max(0, contentBudget))}${suffix}`
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes === 0) return ''
  const bytes = Buffer.from(value)
  if (bytes.length <= maxBytes) return value
  let end = maxBytes
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1
  return bytes.subarray(0, end).toString('utf8')
}

export function redactLog(value: string): string {
  return value
    .replace(/\b(authorization\s*[:=]\s*)(?:bearer\s+)?[^\s,;"']+/gi, '$1[REDACTED]')
    .replace(
      /(["']?(?:access_token|auth_token|api_key|cookie|password|refresh_token|secret|token)["']?\s*[:=]\s*["']?)[^"',\s}]+/gi,
      '$1[REDACTED]'
    )
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]')
}

function ignoreMissing(error: unknown): void {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
}
