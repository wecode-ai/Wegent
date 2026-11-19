import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import { getDesktopWindowLabel, isElectronRuntime } from '@/lib/runtime-environment'
import type { RuntimeTaskLifecycleStore } from './runtimeTaskLifecycle'

let windowOwner = 0
let publication: Promise<void> = Promise.resolve()

function publishActivity(active: boolean, owner: number) {
  publication = publication
    .then(async () => {
      if (owner !== windowOwner) return
      await invokeDesktopHost<void>('systemSleep.setTaskActivity', {
        active,
        source: getDesktopWindowLabel(),
      })
    })
    .catch(error => {
      console.error('[Wework] Failed to synchronize Electron system sleep state', error)
    })
}

/** Publish one route owner's real task activity without allowing old owners to overwrite it. */
export function retainRuntimeTaskSystemSleep(store: RuntimeTaskLifecycleStore): () => void {
  if (!isElectronRuntime()) return () => undefined
  const owner = ++windowOwner
  let previousActive: boolean | undefined
  let released = false
  const synchronize = () => {
    if (released || windowOwner !== owner) return
    const lifecycle = store.getSnapshot()
    const active = lifecycle.runningTaskKeys.size > 0 || lifecycle.queuedTaskKeys.size > 0
    if (previousActive === active) return
    previousActive = active
    publishActivity(active, owner)
  }
  const unsubscribe = store.subscribe(synchronize)
  synchronize()
  return () => {
    if (released) return
    released = true
    unsubscribe()
    if (windowOwner === owner) publishActivity(false, ++windowOwner)
  }
}
