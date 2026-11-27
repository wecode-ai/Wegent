import { useContext, useMemo, useSyncExternalStore } from 'react'
import { invokeDesktopHost, subscribeDesktopHostEvents } from '@/api/dsh/desktopHost'
import { CloudConnectionContext } from '@/features/cloud-connection/CloudConnectionContext'
import { isElectronRuntime } from '@/lib/runtime-environment'
import {
  NOTIFICATION_DELIVERY_FAILED_EVENT,
  NOTIFICATION_PREFERENCES_CHANGED_EVENT,
  notificationPreferenceAccountKey,
  readCachedNotificationPreferences,
} from './notificationPreferences'

function createAvailabilitySource(accountKey: string) {
  const desktop = isElectronRuntime()
  let supported: boolean | undefined = desktop ? undefined : false
  let deliveryFailed = false

  return {
    getSnapshot: () =>
      supported === false ||
      deliveryFailed ||
      readCachedNotificationPreferences(accountKey).stand_in.system !== true,
    subscribe(listener: () => void) {
      let subscribed = true
      window.addEventListener(NOTIFICATION_PREFERENCES_CHANGED_EVENT, listener)
      const reportDeliveryFailure = () => {
        deliveryFailed = true
        listener()
      }
      window.addEventListener(NOTIFICATION_DELIVERY_FAILED_EVENT, reportDeliveryFailure)
      const releaseHostEvents = desktop
        ? subscribeDesktopHostEvents(
            event => {
              if (event.type !== 'notification-lifecycle') return
              const payload = event.payload as { status?: unknown } | null
              if (payload?.status !== 'failed') return
              deliveryFailed = true
              listener()
            },
            {
              replay: event => event.type === 'notification-lifecycle',
            }
          )
        : undefined
      if (desktop && supported === undefined) {
        void invokeDesktopHost<boolean>('notification.isSupported').then(
          result => {
            if (!subscribed) return
            supported = result
            listener()
          },
          () => {
            if (!subscribed) return
            supported = false
            listener()
          }
        )
      }
      return () => {
        subscribed = false
        releaseHostEvents?.()
        window.removeEventListener(NOTIFICATION_DELIVERY_FAILED_EVENT, reportDeliveryFailure)
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
