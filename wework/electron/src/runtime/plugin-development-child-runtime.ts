import { watch, type FSWatcher } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
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
      (_event, filename) => {
        if (isPluginDevelopmentSourceChange(filename)) this.scheduleReload()
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

  private scheduleReload(): void {
    if (this.reloadTimer) clearTimeout(this.reloadTimer)
    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = null
      this.reloadPromise = this.reloadPromise
        .catch(() => undefined)
        .then(async () => {
          if (this.options.isShuttingDown()) return
          await this.writeState('reloading')
          try {
            await this.options.restartCoreDsh()
            this.hmrGeneration += 1
            this.hmrUpdatedAt = new Date().toISOString()
            await this.writeState('ready')
          } catch (reason) {
            const error = reason instanceof Error ? reason : new Error(String(reason))
            await this.writeState('error', error)
            console.error('[plugin-development] hot reload failed', error)
          }
        })
    }, 300)
  }
}

export function isPluginDevelopmentSourceChange(filename: string | Buffer | null): boolean {
  if (!filename) return true
  const segments = filename.toString().split(/[\\/]/)
  return !segments.some(segment => segment === '.git' || segment === 'node_modules')
}
