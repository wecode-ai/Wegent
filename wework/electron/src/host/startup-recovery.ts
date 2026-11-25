import type { LocalJsonReadError } from '../runtime/local-json.js'

export type StartupRecoveryMode = 'retry' | 'workbench' | 'renderer-state' | 'app-state'

export interface StartupRecoveryDependencies {
  rendererStorage: {
    clear: () => Promise<void>
    canRepairStartup: (error: unknown) => boolean
    repairStartupState: () => Promise<string | null>
  }
  preferences: {
    clear: () => Promise<void>
  }
  cloudCredentials: {
    clear: () => Promise<void>
  }
  clearCache: () => Promise<void>
  clearAppStorage: () => Promise<void>
  clearUserStorage: () => Promise<void>
  prepareCleanup: () => Promise<void>
  clearRuntimeFiles: () => Promise<void>
  clearUserFiles: () => Promise<void>
  clearOpenAiCatalog: () => Promise<void>
  disablePlugin: (name: string) => Promise<void>
  log: (
    step: string,
    status: 'started' | 'completed' | 'failed',
    details?: Record<string, unknown>
  ) => void
  relaunch: () => void | Promise<void>
  shutdown: () => void
}

export function assertStartupRecoverySender(senderId: number, splashWebContentsId: number | null) {
  if (splashWebContentsId === null || senderId !== splashWebContentsId) {
    throw new Error('Startup recovery is only available from the startup splash')
  }
}

export class StartupRecoveryService {
  private operation: Promise<void> | null = null

  constructor(private readonly dependencies: StartupRecoveryDependencies) {}

  repairStartup(failure: LocalJsonReadError | null): Promise<void> {
    if (!failure) return this.run('workbench')
    if (this.dependencies.rendererStorage.canRepairStartup(failure))
      return this.run('renderer-state')
    return Promise.reject(new Error('This file requires manual recovery'))
  }

  run(mode: StartupRecoveryMode): Promise<void> {
    if (this.operation) return this.operation
    this.operation = this.runOnce(mode).catch(error => {
      this.operation = null
      throw error
    })
    return this.operation
  }

  disablePlugin(name: string): Promise<void> {
    if (this.operation) return this.operation
    this.operation = this.disablePluginOnce(name).catch(error => {
      this.operation = null
      throw error
    })
    return this.operation
  }

  private async runOnce(mode: StartupRecoveryMode): Promise<void> {
    this.dependencies.log(`startup-recovery-${mode}-cleanup`, 'started')
    try {
      if (mode !== 'retry') await this.dependencies.prepareCleanup()
      if (mode === 'renderer-state') {
        await this.cleanupStep('renderer-storage-backup', async () => {
          const backup = await this.dependencies.rendererStorage.repairStartupState()
          if (backup)
            this.dependencies.log('startup-recovery-renderer-storage-backed-up', 'completed', {
              path: backup,
            })
        })
      }
      if (mode === 'workbench' || mode === 'app-state') {
        await this.cleanupStep('runtime-files', this.dependencies.clearRuntimeFiles)
        await this.cleanupStep('cache', this.dependencies.clearCache)
        await this.cleanupStep('app-cache-storage', this.dependencies.clearAppStorage)
      }
      if (mode === 'app-state') {
        await this.cleanupStep('user-browser-storage', this.dependencies.clearUserStorage)
        await this.cleanupStep('user-files', this.dependencies.clearUserFiles)
        // A rebuildable catalog must not stop user data cleanup or relaunch.
        await this.cleanupStep('openai-catalog', this.dependencies.clearOpenAiCatalog).catch(
          () => {}
        )
        await this.cleanupStep('renderer-storage', () => this.dependencies.rendererStorage.clear())
        await this.cleanupStep('preferences', () => this.dependencies.preferences.clear())
        await this.cleanupStep('cloud-credentials', () =>
          this.dependencies.cloudCredentials.clear()
        )
      }
      this.dependencies.log(`startup-recovery-${mode}-cleanup`, 'completed')
    } catch (error) {
      this.dependencies.log(`startup-recovery-${mode}-cleanup`, 'failed', {
        errorType: error instanceof Error ? error.name : typeof error,
      })
      throw error
    }
    await this.dependencies.relaunch()
    this.dependencies.log('startup-recovery-relaunch', 'completed')
    this.dependencies.shutdown()
  }

  private async cleanupStep(name: string, cleanup: () => Promise<void>): Promise<void> {
    const step = `startup-recovery-clear-${name}`
    this.dependencies.log(step, 'started')
    try {
      await cleanup()
      this.dependencies.log(step, 'completed')
    } catch (error) {
      this.dependencies.log(step, 'failed', {
        errorType: error instanceof Error ? error.name : typeof error,
      })
      throw error
    }
  }

  private async disablePluginOnce(name: string): Promise<void> {
    this.dependencies.log('startup-recovery-disable-plugin', 'started', { plugin: name })
    try {
      await this.dependencies.disablePlugin(name)
      this.dependencies.log('startup-recovery-disable-plugin', 'completed', { plugin: name })
    } catch (error) {
      this.dependencies.log('startup-recovery-disable-plugin', 'failed', {
        errorType: error instanceof Error ? error.name : typeof error,
        plugin: name,
      })
      throw error
    }
    await this.dependencies.relaunch()
    this.dependencies.log('startup-recovery-relaunch', 'completed')
    this.dependencies.shutdown()
  }
}
