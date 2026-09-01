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
    try {
      const value = JSON.parse(await readFile(this.path(), 'utf8')) as unknown
      return value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {}
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
      throw error
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
