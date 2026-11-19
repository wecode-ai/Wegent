import { format } from 'node:util'

import { RotatingLog } from '../runtime/rotating-log.js'
import { e2eErrorLog } from './e2e-error-log.js'
import { installE2EProcessErrors } from './e2e-process-errors.js'

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
    await previous?.flush().catch(() => undefined)
  }

  install(): void {
    if (this.installed) return
    this.installed = true
    installE2EProcessErrors()
    e2eErrorLog.record('main', 'started', 'info', {})
    for (const method of CONSOLE_METHODS) {
      const original = console[method].bind(console)
      console[method] = (...args: unknown[]) => {
        if (method === 'error' || method === 'warn') {
          e2eErrorLog.record('main', 'console', method === 'error' ? 'error' : 'warning', {
            message: format(...args),
          })
        }
        original(...args)
        void this.write(
          method === 'error' || method === 'warn' ? 'stderr' : 'stdout',
          format(...args)
        )
      }
    }
    process.on('uncaughtExceptionMonitor', (error, origin) => {
      e2eErrorLog.record('main', 'uncaught-exception', 'error', {
        message: error.message,
        stack: error.stack,
        origin,
      })
      void this.write('stderr', `Uncaught exception: ${format(error)}`)
    })
  }

  write(source: 'stdout' | 'stderr' | 'supervisor', value: string): Promise<void> {
    const log = this.log
    if (!log) return Promise.resolve()
    return log.write(source, value).catch(() => undefined)
  }

  flush(): Promise<void> {
    return this.log?.flush().catch(() => undefined) ?? Promise.resolve()
  }

  get currentPath(): string | null {
    return this.path
  }

  get startupBootstrapPath(): string | null {
    return this.bootstrapPath
  }
}

export const mainProcessLog = new MainProcessLog()
