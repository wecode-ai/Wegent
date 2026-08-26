import { appendFile, mkdir, rename, stat, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface RotatingLogOptions {
  path: string
  maxBytes?: number
  retainedFiles?: number
}

export class RotatingLog {
  private readonly maxBytes: number
  private readonly retainedFiles: number
  private size = 0
  private initialized = false
  private queue = Promise.resolve()

  constructor(private readonly options: RotatingLogOptions) {
    this.maxBytes = options.maxBytes ?? 5 * 1024 * 1024
    this.retainedFiles = options.retainedFiles ?? 3
  }

  write(source: 'stdout' | 'stderr' | 'supervisor', value: string): Promise<void> {
    const line = `${new Date().toISOString()} [${source}] ${redactLog(value).trimEnd()}\n`
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
