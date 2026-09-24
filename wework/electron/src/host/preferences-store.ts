import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export class PreferencesStore {
  private operation = Promise.resolve()

  constructor(private readonly dataDirectory: string) {}

  read(): Promise<Record<string, unknown>> {
    return this.serial(() => this.readFile())
  }

  update(patch: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.serial(async () => {
      const preferences = { ...(await this.readFile()), ...patch }
      const path = this.path()
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      const temporary = `${path}.${process.pid}.tmp`
      await writeFile(temporary, `${JSON.stringify(preferences, null, 2)}\n`, {
        mode: 0o600,
      })
      await rename(temporary, path)
      return preferences
    })
  }

  clear(): Promise<void> {
    return this.serial(() => rm(this.path(), { force: true }))
  }

  private path(): string {
    return join(this.dataDirectory, 'app-preferences.json')
  }

  private async readFile(): Promise<Record<string, unknown>> {
    let content: string
    try {
      content = await readFile(this.path(), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
      await this.quarantineUnreadableFile(error)
      return {}
    }
    try {
      const value = JSON.parse(content) as unknown
      return value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {}
    } catch (error) {
      await this.quarantineUnreadableFile(error)
      return {}
    }
  }

  /**
   * A damaged preferences file must not break every consumer: keep the original
   * bytes for diagnosis, then continue with defaults so the store heals itself
   * on the next write instead of failing permanently.
   */
  private async quarantineUnreadableFile(reason: unknown): Promise<void> {
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
    const result = this.operation.then(operation, operation)
    this.operation = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
