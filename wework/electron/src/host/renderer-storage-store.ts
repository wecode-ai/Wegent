import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  isJsonObject,
  LocalJsonReadError,
  parseLocalJson,
  readLocalJson,
} from '../runtime/local-json.js'
import { atomicReleaseWrite } from '../runtime/release-store.js'

interface RendererStorageState {
  version: 1
  entries: Record<string, string>
}

interface RendererStorageOriginState {
  version: 1
  origins: string[]
}

export interface RendererStorageUpdate {
  clear: boolean
  changes: Record<string, string | null>
}

export interface RendererStorageCleanup {
  clearAll(): Promise<void>
  clearOrigin(origin: string): Promise<void>
}

export class RendererStorageStore {
  private operation = Promise.resolve()
  private closed = false
  private readFailure: LocalJsonReadError | null = null
  private pendingSeed: Record<string, string> | null = null
  private readonly writes = new Set<Promise<unknown>>()
  private closing?: Promise<void>

  constructor(
    private readonly dataDirectory: string,
    private readonly onUpdate?: (update: RendererStorageUpdate) => void
  ) {}

  close(): Promise<void> {
    if (this.closing) return this.closing
    this.closed = true
    const writes = Promise.allSettled(this.writes)
    this.closing = this.operation.then(async () => {
      const failed = (await writes).find(write => write.status === 'rejected')
      if (failed) throw failed.reason
      if (!this.pendingSeed) return
      const state = await this.readFile()
      if (this.readFailure) throw this.readFailure
      if (!state && this.pendingSeed) {
        await this.writeFile({ version: 1, entries: this.pendingSeed })
      }
    })
    return this.closing
  }

  validate(): Promise<void> {
    return this.serial(async () => {
      await readLocalJson(this.path(), validRendererStorage)
      await this.readOriginFile()
    })
  }

  canRepairStartup(error: unknown): boolean {
    return (
      error instanceof LocalJsonReadError &&
      error.path === this.path() &&
      (error.code === 'INVALID_JSON' || error.code === 'INVALID_DATA')
    )
  }

  repairStartupState(): Promise<string | null> {
    return this.write(async () => {
      const path = this.path()
      const info = await lstat(path).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      })
      if (!info) return null
      if (!info.isFile()) throw new LocalJsonReadError(path, 'NOT_REGULAR_FILE')
      const original = await readFile(path)
      try {
        parseLocalJson(path, original.toString('utf8'), validRendererStorage)
        return null
      } catch (error) {
        if (!this.canRepairStartup(error)) throw error
      }

      const backup = `${path}.corrupt-${Date.now()}-${randomUUID()}`
      // Save the exact bytes before replacing the active file. An interruption
      // leaves either the original in place or a durable backup beside it.
      await writeFile(backup, original, { flag: 'wx', flush: true, mode: 0o600 })
      await atomicReleaseWrite(path, `${JSON.stringify({ version: 1, entries: {} })}\n`)
      this.pendingSeed = null
      this.readFailure = null
      return backup
    })
  }

  prepareOrigin(origin: string, cleanup: RendererStorageCleanup): Promise<void> {
    return this.write(async () => {
      const storage = await this.readFile()
      if (this.readFailure) throw this.readFailure
      if (!storage) return

      const state = await this.readOriginFile()
      if (!state?.origins.length) {
        await cleanup.clearAll()
      } else {
        await Promise.all(
          state.origins
            .filter(previousOrigin => previousOrigin !== origin)
            .map(previousOrigin => cleanup.clearOrigin(previousOrigin))
        )
      }
      if (state?.origins.length === 1 && state.origins[0] === origin) return
      await this.writeOriginFile({ version: 1, origins: [origin] })
    })
  }

  read(): Promise<Record<string, string>> {
    return this.serial(async () => (await this.readFile())?.entries ?? this.pendingSeed ?? {})
  }

  initialize(seed: Record<string, string>): Promise<Record<string, string>> {
    return this.write(async () => {
      const state = await this.readFile()
      if (state) return state.entries
      if (this.readFailure) return seed

      const entries = (this.pendingSeed ??= { ...seed })
      try {
        await this.writeFile({ version: 1, entries })
      } catch (error) {
        console.warn('[renderer-storage] Initial state remains temporary', {
          errorType: error instanceof Error ? error.name : typeof error,
        })
        return entries
      }
      this.notifyUpdate({ clear: false, changes: entries })
      return entries
    })
  }

  update(update: RendererStorageUpdate): Promise<void> {
    return this.write(async () => {
      const state = await this.readFile()
      if (this.readFailure) throw this.readFailure
      const seed = state ? null : this.pendingSeed
      const entries = Object.create(null) as Record<string, string>
      if (!update.clear) {
        for (const [key, value] of Object.entries(state?.entries ?? this.pendingSeed ?? {})) {
          entries[key] = value
        }
      }
      for (const [key, value] of Object.entries(update.changes)) {
        if (value === null) {
          delete entries[key]
        } else {
          entries[key] = value
        }
      }
      await this.writeFile({ version: 1, entries })
      this.notifyUpdate({
        clear: update.clear,
        changes: { ...(!update.clear ? seed : null), ...update.changes },
      })
    })
  }

  clear(): Promise<void> {
    return this.write(async () => {
      await this.writeFile({ version: 1, entries: {} })
      await this.writeOriginFile({ version: 1, origins: [] })
    })
  }

  private notifyUpdate(update: RendererStorageUpdate): void {
    try {
      this.onUpdate?.(update)
    } catch {
      console.warn('[renderer-storage] Change observer failed after persistence')
    }
  }

  private path(): string {
    return join(this.dataDirectory, 'renderer-local-storage.json')
  }

  private originPath(): string {
    return join(this.dataDirectory, 'renderer-local-storage-origins.json')
  }

  private async readFile(): Promise<RendererStorageState | null> {
    this.readFailure = null
    try {
      const state = await readLocalJson(this.path(), validRendererStorage)
      if (state) this.pendingSeed = null
      return state
    } catch (error) {
      if (!(error instanceof LocalJsonReadError)) throw error
      this.readFailure = error
      console.warn('[renderer-storage] Stored state is temporarily read-only', {
        code: error.code,
      })
      return null
    }
  }

  private readOriginFile(): Promise<RendererStorageOriginState | null> {
    return readLocalJson(
      this.originPath(),
      (value): value is RendererStorageOriginState =>
        isJsonObject(value) &&
        value.version === 1 &&
        Array.isArray(value.origins) &&
        value.origins.every(origin => typeof origin === 'string')
    )
  }

  private async writeFile(state: RendererStorageState): Promise<void> {
    await this.writeJsonFile(this.path(), state)
    this.pendingSeed = null
  }

  private async writeOriginFile(state: RendererStorageOriginState): Promise<void> {
    await this.writeJsonFile(this.originPath(), state)
  }

  private async writeJsonFile(path: string, value: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const temporary = `${path}.${process.pid}.tmp`
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 })
    await rename(temporary, path)
  }

  private write<Result>(operation: () => Promise<Result>): Promise<Result> {
    const result = this.serial(operation)
    this.writes.add(result)
    const done = () => this.writes.delete(result)
    void result.then(done, done)
    return result
  }

  private serial<Result>(operation: () => Promise<Result>): Promise<Result> {
    if (this.closed) return Promise.reject(new Error('Renderer storage is closed'))
    const result = this.operation.then(operation, operation)
    this.operation = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }
}

function validRendererStorage(value: unknown, path: string): value is RendererStorageState {
  if (!isJsonObject(value)) return false
  if (Object.hasOwn(value, 'version') && value.version !== 1)
    throw new LocalJsonReadError(path, 'UNSUPPORTED_VERSION')
  return value.version === 1 && validEntries(value.entries)
}

function validEntries(value: unknown): value is Record<string, string> {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.values(value as Record<string, unknown>).every(entry => typeof entry === 'string')
  )
}
