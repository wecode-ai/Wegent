import { isDesktopRuntime } from '@/lib/runtime-environment'
import { disposeDesktopListener } from '@/desktop/disposeDesktopListener'
import {
  cancelMainWindowClose,
  closeMainWindowToTray,
  installRuntimeTaskCloseGuard,
  quitApplication,
} from '@/desktop/runtimeTaskCloseGuard'

/** A window close request owns the confirmation state consumed by its dialog. */
export function createRuntimeTaskCloseGuardState() {
  let snapshot = { open: false, closing: false }
  let generation = 0
  let request = 0
  let unlisten: (() => void) | undefined
  const listeners = new Set<() => void>()
  const publish = (next: typeof snapshot) => {
    snapshot = next
    listeners.forEach(listener => listener())
  }
  const close = async (action: 'quit' | 'background') => {
    const owner = generation
    const operation = ++request
    publish({ open: false, closing: true })
    try {
      if (action === 'quit') await quitApplication()
      else await closeMainWindowToTray()
    } catch (error) {
      console.error(
        action === 'quit'
          ? 'Failed to quit from close-to-tray confirmation:'
          : 'Failed to hide window after close-to-tray hint confirmation:',
        error
      )
      if (listeners.size && owner === generation && operation === request)
        publish({ open: true, closing: false })
    }
  }
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      if (listeners.size === 1 && isDesktopRuntime()) {
        const owner = ++generation
        void installRuntimeTaskCloseGuard(() => {
          if (owner !== generation || !listeners.size) return
          request++
          publish({ open: true, closing: false })
        })
          .then(nextUnlisten => {
            if (owner !== generation || !listeners.size)
              disposeDesktopListener(nextUnlisten, 'runtime task close guard')
            else unlisten = nextUnlisten
          })
          .catch(error => {
            console.error('Failed to install runtime task close guard:', error)
          })
      }
      return () => {
        listeners.delete(listener)
        if (listeners.size) return
        generation++
        if (unlisten) disposeDesktopListener(unlisten, 'runtime task close guard')
        unlisten = undefined
      }
    },
    async dismiss() {
      if (snapshot.closing) return
      request++
      publish({ ...snapshot, open: false })
      try {
        await cancelMainWindowClose()
      } catch (error) {
        console.error('Failed to cancel close-to-tray confirmation:', error)
      }
    },
    quit: () => close('quit'),
    keepInBackground: () => close('background'),
  }
}
