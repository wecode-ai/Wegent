import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { isJsonObject, LocalJsonReadError, readLocalJson } from '../runtime/local-json.js'

export class PreferencesStore {
  private operation = Promise.resolve()
  private closed = false
  private failure: LocalJsonReadError | null = null
  private readonly writes = new Set<Promise<unknown>>()
  private closing?: Promise<void>

  constructor(private readonly dataDirectory: string) {}

  close(): Promise<void> {
    if (this.closing) return this.closing
    this.closed = true
    const writes = Promise.allSettled(this.writes)
    this.closing = this.operation.then(async () => {
      const failed = (await writes).find(write => write.status === 'rejected')
      if (failed) throw failed.reason
    })
    return this.closing
  }

  get readFailure(): LocalJsonReadError | null {
    return this.failure
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
    return this.trackWrite(async () => {
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
    return this.trackWrite(() => rm(this.path(), { force: true }))
  }

  private path(): string {
    return join(this.dataDirectory, 'app-preferences.json')
  }

  private async readFile(): Promise<Record<string, unknown>> {
    this.failure = null
    try {
      return (await readLocalJson(this.path(), isJsonObject)) ?? {}
    } catch (error) {
      if (!(error instanceof LocalJsonReadError)) throw error
      this.failure = error
      console.warn('[Preferences] Settings are temporarily read-only', {
        code: error.code,
      })
      return {}
    }
  }

  private trackWrite<Result>(operation: () => Promise<Result>): Promise<Result> {
    const result = this.serial(operation)
    this.writes.add(result)
    const done = () => this.writes.delete(result)
    void result.then(done, done)
    return result
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
