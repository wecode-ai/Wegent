import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

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
  private readFailure: unknown = null

  constructor(
    private readonly dataDirectory: string,
    private readonly onUpdate?: (update: RendererStorageUpdate) => void
  ) {}

  close(): Promise<void> {
    this.closed = true
    return this.operation
  }

  prepareOrigin(origin: string, cleanup: RendererStorageCleanup): Promise<void> {
    return this.serial(async () => {
      if (!(await this.readFile())) return

      const state = await this.readOriginFile()
      if (!state) {
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
    return this.serial(async () => (await this.readFile())?.entries ?? {})
  }

  initialize(seed: Record<string, string>): Promise<Record<string, string>> {
    return this.serial(async () => {
      const state = await this.readFile()
      if (state) return state.entries
      if (this.readFailure) return seed

      await this.writeFile({ version: 1, entries: seed })
      this.notifyUpdate({ clear: false, changes: seed })
      return seed
    })
  }

  update(update: RendererStorageUpdate): Promise<void> {
    return this.serial(async () => {
      const state = await this.readFile()
      if (this.readFailure) throw this.readFailure
      const entries = Object.create(null) as Record<string, string>
      if (!update.clear && state) {
        for (const [key, value] of Object.entries(state.entries)) {
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
      this.notifyUpdate(update)
    })
  }

  clear(): Promise<void> {
    return this.serial(() => this.writeFile({ version: 1, entries: {} }))
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
      const value = JSON.parse(await readFile(this.path(), 'utf8')) as unknown
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Invalid renderer storage state')
      const record = value as Partial<RendererStorageState>
      if (record.version !== 1 || !validEntries(record.entries))
        throw new Error('Invalid renderer storage entries')
      return { version: 1, entries: record.entries }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      // JSON errors may include a source excerpt containing stored credentials.
      this.readFailure = new Error(
        'Stored application state is unreadable; the original file is preserved'
      )
      console.warn('[renderer-storage] Stored state is temporarily read-only', {
        errorType: error instanceof Error ? error.name : typeof error,
      })
      return null
    }
  }

  private async readOriginFile(): Promise<RendererStorageOriginState | null> {
    try {
      const value = JSON.parse(await readFile(this.originPath(), 'utf8')) as unknown
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null
      const record = value as Partial<RendererStorageOriginState>
      if (
        record.version !== 1 ||
        !Array.isArray(record.origins) ||
        record.origins.length === 0 ||
        record.origins.some(origin => typeof origin !== 'string')
      ) {
        return null
      }
      return { version: 1, origins: record.origins }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      console.warn('[renderer-storage] Origin history is unavailable', error)
      return null
    }
  }

  private async writeFile(state: RendererStorageState): Promise<void> {
    await this.writeJsonFile(this.path(), state)
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

function validEntries(value: unknown): value is Record<string, string> {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.values(value as Record<string, unknown>).every(entry => typeof entry === 'string')
  )
}
