import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import { initializeBundledPluginMarketplace } from '@/desktop/localExecutor'
import { isElectronRuntime } from '@/lib/runtime-environment'
import {
  recordIdleTaskUserActivity,
  scheduleIdleTask,
  startIdleTaskScheduler,
  stopIdleTaskScheduler,
} from './idleTaskScheduler'

const USER_ACTIVITY_EVENTS = ['keydown', 'pointerdown', 'touchstart', 'wheel'] as const
let windowOwner = 0

/** The main window owns its pending maintenance and enables draining after startup readiness. */
export function createWorkbenchIdleMaintenance() {
  const owner = ++windowOwner
  let ready: boolean | undefined
  let disposed = false
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
  const recordActivity = () => {
    if (!disposed && owner === windowOwner && ready) recordIdleTaskUserActivity()
  }
  const stopActivity = () => {
    for (const event of USER_ACTIVITY_EVENTS)
      window.removeEventListener(event, recordActivity, true)
    if (owner === windowOwner) stopIdleTaskScheduler()
  }
  return {
    setReady(next: boolean) {
      if (disposed || owner !== windowOwner || ready === next) return
      ready = next
      if (!ready) {
        stopActivity()
        return
      }
      for (const event of USER_ACTIVITY_EVENTS)
        window.addEventListener(event, recordActivity, { passive: true, capture: true })
      startIdleTaskScheduler()
    },
    dispose() {
      if (disposed) return
      disposed = true
      stopActivity()
      cancelBundledMarketplace()
      cancelTemporaryImageCleanup()
    },
  }
}
