import { format } from 'node:util'

import { RotatingLog } from '../runtime/rotating-log.js'

type ConsoleMethod = 'debug' | 'info' | 'log' | 'warn' | 'error'

const CONSOLE_METHODS: readonly ConsoleMethod[] = ['debug', 'info', 'log', 'warn', 'error']

/**
 * Captures the Electron main-process console into a rotating log. Startup
 * failures are reported through console.error, so this file is the durable
 * record used by the splash diagnostics.
 */
export class MainProcessLog {
  private log: RotatingLog | null = null
  private path: string | null = null
  private installed = false
  private bootstrapPath: string | null = null

  async setPath(path: string): Promise<void> {
    if (this.bootstrapPath === null) this.bootstrapPath = path
    if (this.currentPath === path) return
    const previous = this.log
    this.path = path
    this.log = new RotatingLog({
      path,
      maxBytes: 10 * 1024 * 1024,
      retainedFiles: 5,
      maxEntryBytes: 256 * 1024,
    })
    await previous?.flush()
  }

  install(): void {
    if (this.installed) return
    this.installed = true
    for (const method of CONSOLE_METHODS) {
      const original = console[method].bind(console)
      console[method] = (...args: unknown[]) => {
        original(...args)
        void this.write(
          method === 'error' || method === 'warn' ? 'stderr' : 'stdout',
          format(...args)
        )
      }
    }
    process.on('uncaughtExceptionMonitor', error => {
      void this.write('stderr', `Uncaught exception: ${format(error)}`)
    })
  }

  write(source: 'stdout' | 'stderr' | 'supervisor', value: string): Promise<void> {
    const log = this.log
    if (!log) return Promise.resolve()
    return log.write(source, value).catch(() => undefined)
  }

  flush(): Promise<void> {
    return this.log?.flush() ?? Promise.resolve()
  }

  get currentPath(): string | null {
    return this.path
  }

  get startupBootstrapPath(): string | null {
    return this.bootstrapPath
  }
}

export const mainProcessLog = new MainProcessLog()
