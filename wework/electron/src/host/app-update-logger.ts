import type { Logger } from 'electron-updater'
import { RotatingLog } from '../runtime/rotating-log.js'

export class AppUpdateLogger implements Logger {
  private readonly log: RotatingLog

  constructor(path: string) {
    this.log = new RotatingLog({ path })
  }

  debug(message: string): void {
    this.write('debug', message)
  }

  info(message?: unknown): void {
    this.write('info', message)
  }

  warn(message?: unknown): void {
    this.write('warn', message)
  }

  error(message?: unknown): void {
    this.write('error', message)
  }

  flush(): Promise<void> {
    return this.log.flush()
  }

  private write(level: 'debug' | 'info' | 'warn' | 'error', message: unknown): void {
    const source = level === 'error' || level === 'warn' ? 'stderr' : 'supervisor'
    void this.log
      .write(source, `[${level}] ${formatLogMessage(message)}`)
      .catch(error => console.error('[app-update] failed to persist updater log', error))
  }
}

function formatLogMessage(message: unknown): string {
  if (message instanceof Error) return message.stack || message.message
  if (typeof message === 'string') return message
  try {
    return JSON.stringify(message) ?? String(message)
  } catch {
    return String(message)
  }
}
