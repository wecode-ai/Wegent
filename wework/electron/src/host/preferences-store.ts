import { mkdir, readFile, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { durableWrite } from './durable-file.js'

export class PreferencesStore {
  private operation = Promise.resolve()
  private closed = false
  transform: ((value: Record<string, unknown>) => Promise<Record<string, unknown>>) | null = null
  protectDamaged: ((name: string, content: string) => Promise<void>) | null = null

  constructor(private readonly dataDirectory: string) {}

  close(): Promise<void> {
    this.closed = true
    return this.operation
  }

  read(): Promise<Record<string, unknown>> {
    return this.serial(async () => this.sanitize(await this.readFile()))
  }

  update(patch: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.serial(async () => {
      const preferences = await this.sanitize({ ...(await this.readFile()), ...patch })
      const path = this.path()
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      await durableWrite(path, `${JSON.stringify(preferences, null, 2)}\n`)
      return preferences
    })
  }

  clear(): Promise<void> {
    return this.serial(() => rm(this.path(), { force: true }))
  }

  private path(): string {
    return join(this.dataDirectory, 'app-preferences.json')
  }

  private async sanitize(value: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.transform) return value
    const safe = await this.transform(value)
    if (JSON.stringify(safe) !== JSON.stringify(value))
      await durableWrite(this.path(), `${JSON.stringify(safe, null, 2)}\n`)
    return safe
  }

  private async readFile(): Promise<Record<string, unknown>> {
    let content: string
    try {
      content = await readFile(this.path(), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
      // A permission, sharing, or I/O error says nothing about the contents:
      // keep the file where it is instead of moving valid settings aside.
      throw error
    }
    try {
      const value = JSON.parse(content) as unknown
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Invalid preferences format')
      return value as Record<string, unknown>
    } catch (error) {
      if (this.protectDamaged) {
        await this.protectDamaged('app-preferences.json', content)
        await durableWrite(this.path(), '{}\n')
        return {}
      }
      await this.quarantineDamagedFile(error)
      return {}
    }
  }

  /**
   * Content that cannot be parsed must not break every consumer: keep the
   * original bytes for diagnosis, then continue with defaults so the store
   * heals itself on the next write instead of failing permanently.
   */
  private async quarantineDamagedFile(reason: unknown): Promise<void> {
    const path = this.path()
    const quarantined = `${path}.corrupt-${Date.now()}`
    try {
      await rename(path, quarantined)
      console.warn('[Preferences] Moved an unreadable preferences file aside', {
        path,
        quarantined,
        reason: describeError(reason),
      })
    } catch (error) {
      console.warn('[Preferences] Could not move an unreadable preferences file aside', {
        path,
        reason: describeError(error),
      })
    }
  }

  private serial<Result>(operation: () => Promise<Result>): Promise<Result> {
    if (this.closed) return Promise.reject(new Error('Preferences are closed'))
    const result = this.operation.then(operation, operation)
    this.operation = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.name : 'Unknown error'
}
