export type StartupRecoveryMode = 'retry' | 'workbench' | 'app-state'

export interface StartupRecoveryDependencies {
  rendererStorage: {
    clear: () => Promise<void>
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
  disablePlugin: (name: string) => Promise<void>
  log: (
    step: string,
    status: 'started' | 'completed' | 'failed',
    details?: Record<string, unknown>
  ) => void
  relaunch: () => void
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
      if (mode !== 'retry') {
        await this.dependencies.prepareCleanup()
        await this.cleanupStep('runtime-files', this.dependencies.clearRuntimeFiles)
        await this.cleanupStep('cache', this.dependencies.clearCache)
        await this.cleanupStep('app-cache-storage', this.dependencies.clearAppStorage)
      }
      if (mode === 'app-state') {
        await this.cleanupStep('user-browser-storage', this.dependencies.clearUserStorage)
        await this.cleanupStep('user-files', this.dependencies.clearUserFiles)
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
    this.dependencies.relaunch()
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
    this.dependencies.relaunch()
    this.dependencies.log('startup-recovery-relaunch', 'completed')
    this.dependencies.shutdown()
  }
}
