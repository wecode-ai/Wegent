import { watch, type FSWatcher } from 'node:fs'
import { lstat, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { sha256 } from './component-content-hash.mjs'
import type { PluginDevelopmentStatus } from './plugin-development-manager.js'

interface PluginDevelopmentChildRuntimeOptions {
  statePath: string
  sourceRoot: string
  focus: () => Promise<void>
  openDevTools: () => void
  restartCoreDsh: () => Promise<void>
  requestStop: () => void
  getCoreDshPid: () => number | null
  isShuttingDown: () => boolean
}

export class PluginDevelopmentChildRuntime {
  private watcher: FSWatcher | null = null
  private reloadTimer: NodeJS.Timeout | null = null
  private reloadPromise: Promise<void> = Promise.resolve()
  private pendingChanges = new Set<string | null>()
  private sourceDigests = new Map<string, string | null>()
  private hmrGeneration = 0
  private hmrUpdatedAt: string | null = null

  constructor(private readonly options: PluginDevelopmentChildRuntimeOptions) {}

  async handleCommand(command: string): Promise<void> {
    if (command === 'focus') {
      await this.options.focus()
      return
    }
    if (command === 'open-devtools') {
      this.options.openDevTools()
      return
    }
    if (command === 'restart-core-dsh') {
      try {
        await this.options.restartCoreDsh()
        await this.writeState('ready')
      } catch (reason) {
        const error = reason instanceof Error ? reason : new Error(String(reason))
        await this.writeState('error', error).catch(stateError => {
          console.error('[plugin-development] Failed to persist restart error state', stateError)
        })
        throw error
      }
      return
    }
    if (command === 'stop') this.options.requestStop()
  }

  async writeState(status: PluginDevelopmentStatus, error: Error | null = null): Promise<void> {
    const updatedAt = new Date().toISOString()
    await mkdir(dirname(this.options.statePath), { recursive: true, mode: 0o700 })
    await writeFile(
      this.options.statePath,
      `${JSON.stringify(
        {
          status,
          coreDshPid: this.options.getCoreDshPid(),
          hmrGeneration: this.hmrGeneration,
          updatedAt,
          hmrUpdatedAt: this.hmrUpdatedAt,
          lastError: error
            ? {
                stage: 'core-dsh',
                message: error.message,
                timestamp: new Date().toISOString(),
              }
            : null,
        },
        null,
        2
      )}\n`,
      { mode: 0o600 }
    )
  }

  startWatcher(): void {
    if (this.watcher) return
    this.watcher = watch(
      this.options.sourceRoot,
      { persistent: false, recursive: true },
      (event, filename) => {
        if (isPluginDevelopmentSourceChange(filename)) {
          console.info('[plugin-development] source changed', {
            event,
            filename: filename?.toString() ?? null,
            hmrGeneration: this.hmrGeneration,
          })
          this.scheduleReload(filename?.toString() ?? null)
        }
      }
    )
    this.watcher.on('error', error => {
      console.error('[plugin-development] source watcher failed', error)
      void this.writeState('error', error)
    })
  }

  stopWatcher(): void {
    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer)
      this.reloadTimer = null
    }
    this.watcher?.close()
    this.watcher = null
  }

  private scheduleReload(filename: string | null): void {
    this.pendingChanges.add(filename)
    if (this.reloadTimer) clearTimeout(this.reloadTimer)
    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = null
      const filenames = [...this.pendingChanges]
      this.pendingChanges.clear()
      this.reloadPromise = this.reloadPromise
        .catch(() => undefined)
        .then(async () => {
          if (this.options.isShuttingDown()) return
          try {
            const { changed, digests } = await this.readSourceChanges(filenames)
            if (!changed) return
            console.info('[plugin-development] hot reload started', {
              hmrGeneration: this.hmrGeneration,
            })
            await this.writeState('reloading')
            await this.options.restartCoreDsh()
            this.hmrGeneration += 1
            this.hmrUpdatedAt = new Date().toISOString()
            await this.writeState('ready')
            for (const [path, digest] of digests) this.sourceDigests.set(path, digest)
            console.info('[plugin-development] hot reload completed', {
              hmrGeneration: this.hmrGeneration,
            })
          } catch (reason) {
            const error = reason instanceof Error ? reason : new Error(String(reason))
            await this.writeState('error', error)
            console.error('[plugin-development] hot reload failed', error)
          }
        })
    }, 300)
  }

  private async readSourceChanges(filenames: Array<string | null>): Promise<{
    changed: boolean
    digests: Map<string, string | null>
  }> {
    const digests = new Map<string, string | null>()
    let changed = false
    for (const filename of filenames) {
      if (filename === null) {
        changed = true
        continue
      }
      const digest = await sourceDigest(join(this.options.sourceRoot, filename))
      if (digest === undefined) {
        changed = true
        continue
      }
      digests.set(filename, digest)
      changed ||= !this.sourceDigests.has(filename) || this.sourceDigests.get(filename) !== digest
    }
    return { changed, digests }
  }
}

async function sourceDigest(path: string): Promise<string | null | undefined> {
  try {
    const metadata = await lstat(path)
    return metadata.isFile() ? `${metadata.mode}:${await sha256(path)}` : undefined
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

export function isPluginDevelopmentSourceChange(filename: string | Buffer | null): boolean {
  if (!filename) return true
  const segments = filename.toString().split(/[\\/]/)
  return !segments.some(segment => segment === '.git' || segment === 'node_modules')
}
