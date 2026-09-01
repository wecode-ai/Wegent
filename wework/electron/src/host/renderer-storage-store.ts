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

  constructor(private readonly dataDirectory: string) {}

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

  initialize(seed: Record<string, string>): Promise<Record<string, string>> {
    return this.serial(async () => {
      const state = await this.readFile()
      if (state) return state.entries

      await this.writeFile({ version: 1, entries: seed })
      return seed
    })
  }

  update(update: RendererStorageUpdate): Promise<void> {
    return this.serial(async () => {
      const state = await this.readFile()
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
    })
  }

  removeByPrefixes(prefixes: readonly string[]): Promise<void> {
    return this.serial(async () => {
      const state = await this.readFile()
      if (!state) return
      const entries = Object.fromEntries(
        Object.entries(state.entries).filter(
          ([key]) => !prefixes.some(prefix => key.startsWith(prefix))
        )
      )
      await this.writeFile({ version: 1, entries })
    })
  }

  clear(): Promise<void> {
    return this.serial(() => this.writeFile({ version: 1, entries: {} }))
  }

  private path(): string {
    return join(this.dataDirectory, 'renderer-local-storage.json')
  }

  private originPath(): string {
    return join(this.dataDirectory, 'renderer-local-storage-origins.json')
  }

  private async readFile(): Promise<RendererStorageState | null> {
    try {
      const value = JSON.parse(await readFile(this.path(), 'utf8')) as unknown
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null
      const record = value as Partial<RendererStorageState>
      if (record.version !== 1 || !validEntries(record.entries)) return null
      return { version: 1, entries: record.entries }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
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
      throw error
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
