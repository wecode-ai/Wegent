import { useEffect } from 'react'
import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import { getDesktopWindowLabel, isElectronRuntime } from '@/lib/runtime-environment'
import {
  type RuntimeTaskLifecycleStore,
  useRuntimeTaskLifecycleStoreSnapshot,
} from './runtimeTaskLifecycle'

interface RuntimeTaskSystemSleepBridgeProps {
  store: RuntimeTaskLifecycleStore
}

export function RuntimeTaskSystemSleepBridge({ store }: RuntimeTaskSystemSleepBridgeProps) {
  const lifecycle = useRuntimeTaskLifecycleStoreSnapshot(store)
  const active = lifecycle.runningTaskKeys.size > 0 || lifecycle.queuedTaskKeys.size > 0

  useEffect(() => {
    if (!isElectronRuntime()) return
    void invokeDesktopHost<void>('systemSleep.setTaskActivity', {
      active,
      source: getDesktopWindowLabel(),
    }).catch(error => {
      console.error('[Wework] Failed to synchronize Electron system sleep state', error)
    })
  }, [active])

  return null
}
