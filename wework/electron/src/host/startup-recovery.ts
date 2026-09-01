export type StartupRecoveryMode = 'retry' | 'workbench' | 'app-state'

export const WORKBENCH_RECOVERY_STORAGE_PREFIXES = [
  'wework:workbench-split-groups:',
  'wework:workbench-split-layout:',
  'wework.workspaceTabs.v3:',
  'wework.workspaceTabTransfer.v1:',
] as const

export interface StartupRecoveryDependencies {
  rendererStorage: {
    clear: () => Promise<void>
    removeByPrefixes: (prefixes: readonly string[]) => Promise<void>
  }
  preferences: {
    clear: () => Promise<void>
  }
  cloudCredentials: {
    clear: () => Promise<void>
  }
  clearCache: () => Promise<void>
  clearAppStorage: () => Promise<void>
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
    this.operation = this.runOnce(mode)
    return this.operation
  }

  private async runOnce(mode: StartupRecoveryMode): Promise<void> {
    this.dependencies.log(`startup-recovery-${mode}-cleanup`, 'started')
    try {
      if (mode === 'workbench') {
        await this.dependencies.rendererStorage.removeByPrefixes(
          WORKBENCH_RECOVERY_STORAGE_PREFIXES
        )
      } else if (mode === 'app-state') {
        await Promise.all([
          this.dependencies.rendererStorage.clear(),
          this.dependencies.preferences.clear(),
          this.dependencies.cloudCredentials.clear(),
          this.dependencies.clearCache(),
          this.dependencies.clearAppStorage(),
        ])
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
}
