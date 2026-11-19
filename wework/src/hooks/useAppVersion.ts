import { useSyncExternalStore } from 'react'
import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import { isDesktopRuntime } from '@/lib/runtime-environment'

export function createAppVersionStore(readVersion: () => Promise<string>) {
  let version: string | null = null
  let pending = false
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => version,
    subscribe(listener: () => void) {
      listeners.add(listener)
      if (version === null && !pending) {
        pending = true
        void readVersion()
          .then(next => {
            version = next
            listeners.forEach(notify => notify())
          })
          .catch(error => {
            console.error('Failed to read the Wework app version', error)
          })
          .finally(() => {
            pending = false
          })
      }
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

const appVersion = createAppVersionStore(() =>
  invokeDesktopHost<{ version: string }>('app.getVersion').then(result => result.version)
)
const noSubscription = () => () => {}
const browserVersion = () => __WEWORK_APP_VERSION__

export function useAppVersion(): string | null {
  const desktop = isDesktopRuntime()
  return useSyncExternalStore(
    desktop ? appVersion.subscribe : noSubscription,
    desktop ? appVersion.getSnapshot : browserVersion
  )
}
