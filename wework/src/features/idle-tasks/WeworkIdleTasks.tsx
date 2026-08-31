import { useEffect } from 'react'
import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import { initializeBundledPluginMarketplace } from '@/desktop/localExecutor'
import { isElectronRuntime } from '@/lib/runtime-environment'
import { scheduleIdleTask } from './idleTaskScheduler'

export function WeworkIdleTasks() {
  useEffect(() => {
    const cancelBundledMarketplace = scheduleIdleTask(
      'plugins.initialize-bundled-marketplace',
      async () => {
        await initializeBundledPluginMarketplace()
      }
    )
    const cancelTemporaryImageCleanup = isElectronRuntime()
      ? scheduleIdleTask('maintenance.cleanup-temporary-images', () =>
          invokeDesktopHost('maintenance.cleanupTemporaryImages')
        )
      : () => undefined

    return () => {
      cancelBundledMarketplace()
      cancelTemporaryImageCleanup()
    }
  }, [])

  return null
}
