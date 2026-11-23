import { mkdir, readFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { serializePathOperation } from '../runtime/path-operation-queue.js'
import { atomicReleaseWrite } from '../runtime/release-store.js'

export class OpenAiCatalogStore {
  private readonly path: string
  constructor(dataDirectory: string) {
    this.path = join(dataDirectory, 'plugin-cache', 'openai-official-catalog.json')
  }

  read(): Promise<string | null> {
    return serializePathOperation(this.path, async () => {
      try {
        return await readFile(this.path, 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      }
    })
  }

  write(snapshot: string): Promise<void> {
    return serializePathOperation(this.path, async () => {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
      await atomicReleaseWrite(this.path, snapshot)
    })
  }

  clear(): Promise<void> {
    return serializePathOperation(this.path, () => rm(this.path, { force: true }))
  }

  flush(): Promise<void> {
    return serializePathOperation(this.path, async () => {})
  }
}
