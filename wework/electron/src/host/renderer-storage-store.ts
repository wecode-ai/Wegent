import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { durableWrite } from './durable-file.js'

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
  transform: ((entries: Record<string, string>) => Promise<Record<string, string>>) | null = null
  protectDamaged: ((name: string, content: string) => Promise<void>) | null = null

  constructor(private readonly dataDirectory: string) {}

  close(): Promise<void> {
    this.closed = true
    return this.operation
  }

  prepareOrigin(origin: string, cleanup: RendererStorageCleanup): Promise<void> {
    return this.serial(async () => {
      const mirror = await this.readFile()
      if (!mirror) return
      if (this.transform)
        await this.writeFile({ version: 1, entries: await this.transform(mirror.entries) })

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
      const entries = this.transform
        ? await this.transform(state?.entries ?? seed)
        : (state?.entries ?? seed)
      await this.writeFile({ version: 1, entries })
      return entries
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
      await this.writeFile({
        version: 1,
        entries: this.transform ? await this.transform(entries) : entries,
      })
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
    let content: string
    try {
      content = await readFile(this.path(), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
    let value: Partial<RendererStorageState> | null
    try {
      value = JSON.parse(content) as typeof value
    } catch {
      return this.recoverDamaged(content)
    }
    if (!value || typeof value !== 'object' || Array.isArray(value))
      return this.recoverDamaged(content)
    if (value.version !== undefined && value.version !== 1)
      throw new Error('Unsupported renderer storage version')
    if (value.version !== 1 || !validEntries(value.entries)) return this.recoverDamaged(content)
    return { version: 1, entries: value.entries }
  }

  private async recoverDamaged(content: string): Promise<null> {
    if (!this.protectDamaged) throw new Error('Invalid renderer storage format')
    await this.protectDamaged('renderer-local-storage.json', content)
    await this.writeFile({ version: 1, entries: {} })
    return null
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
    await durableWrite(path, `${JSON.stringify(value)}\n`)
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
