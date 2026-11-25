import { useContext, useMemo, useSyncExternalStore } from 'react'
import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import { CloudConnectionContext } from '@/features/cloud-connection/CloudConnectionContext'
import { isElectronRuntime } from '@/lib/runtime-environment'
import {
  NOTIFICATION_PREFERENCES_CHANGED_EVENT,
  notificationPreferenceAccountKey,
  readCachedNotificationPreferences,
} from './notificationPreferences'

function createAvailabilitySource(accountKey: string) {
  const desktop = isElectronRuntime()
  let supported: boolean | undefined = desktop ? undefined : false

  return {
    getSnapshot: () =>
      supported === false || readCachedNotificationPreferences(accountKey).stand_in.system !== true,
    subscribe(listener: () => void) {
      let subscribed = true
      window.addEventListener(NOTIFICATION_PREFERENCES_CHANGED_EVENT, listener)
      if (desktop && supported === undefined) {
        void invokeDesktopHost<boolean>('notification.isSupported').then(
          result => {
            if (!subscribed) return
            supported = result
            listener()
          },
          error => {
            if (subscribed)
              console.error('[Wework] Failed to read native notification support', error)
          }
        )
      }
      return () => {
        subscribed = false
        window.removeEventListener(NOTIFICATION_PREFERENCES_CHANGED_EVENT, listener)
      }
    },
  }
}

export function useStandInNotificationUnavailable(): boolean {
  const connection = useContext(CloudConnectionContext)
  const accountKey = notificationPreferenceAccountKey(connection?.apiBaseUrl, connection?.user?.id)
  const source = useMemo(() => createAvailabilitySource(accountKey), [accountKey])
  return useSyncExternalStore(source.subscribe, source.getSnapshot, () => false)
}
