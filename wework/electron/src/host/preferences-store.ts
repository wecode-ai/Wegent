import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export class PreferencesStore {
  private operation = Promise.resolve()
  private closed = false
  private readFailure: unknown = null

  constructor(private readonly dataDirectory: string) {}

  close(): Promise<void> {
    this.closed = true
    return this.operation
  }

  read(): Promise<Record<string, unknown>> {
    return this.readSnapshot().then(snapshot => snapshot.preferences)
  }

  readSnapshot(): Promise<{ preferences: Record<string, unknown>; readable: boolean }> {
    return this.serial(async () => {
      const preferences = await this.readFile()
      return { preferences, readable: this.readFailure === null }
    })
  }

  update(
    patch: Record<string, unknown>,
    expectedTelemetryConsentRevision?: number
  ): Promise<Record<string, unknown>> {
    return this.serial(async () => {
      const current = await this.readFile()
      if (this.readFailure) throw this.readFailure
      const revision =
        Number.isSafeInteger(current.telemetryConsentRevision) &&
        Number(current.telemetryConsentRevision) >= 0
          ? Number(current.telemetryConsentRevision)
          : 0
      if (
        patch.telemetryEnabled === true &&
        expectedTelemetryConsentRevision !== undefined &&
        expectedTelemetryConsentRevision !== revision
      )
        throw new Error('Telemetry preference changed in another window; refresh and retry')
      const preferences = { ...current, ...patch }
      delete preferences.telemetryConsentRevision
      if (typeof patch.telemetryEnabled === 'boolean') {
        preferences.telemetryConsentRevision = revision + 1
      } else if (Object.hasOwn(current, 'telemetryConsentRevision')) {
        preferences.telemetryConsentRevision = revision
      }
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
    this.readFailure = null
    let content: string
    try {
      content = await readFile(this.path(), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
      // A permission, sharing, or I/O error says nothing about the contents:
      // keep the file where it is instead of moving valid settings aside.
      this.readFailure = error
      console.warn('[Preferences] Settings are temporarily read-only', {
        reason: describeError(error),
      })
      return {}
    }
    try {
      const value = JSON.parse(content) as unknown
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Invalid application preferences')
      return value as Record<string, unknown>
    } catch (error) {
      this.readFailure = new Error(
        'Application preferences are damaged; the original file is preserved'
      )
      console.warn('[Preferences] Damaged settings are read-only', {
        errorType: error instanceof Error ? error.name : typeof error,
      })
      return {}
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
  return error instanceof Error ? error.message : String(error)
}
