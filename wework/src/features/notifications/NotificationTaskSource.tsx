import { CloudConnectionContext } from '@/features/cloud-connection/CloudConnectionContext'
import { useAppPreferencesState } from '@/features/app-preferences/useAppPreferencesState'
import { useSessionTelemetryConsent } from '@/telemetry/sessionConsent'
import { useTelemetryEnabled } from '@/telemetry/client'
import { getDesktopWindowLabel } from '@/lib/runtime-environment'
import {
  useCallback,
  useContext,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import {
  NotificationTaskContext,
  NotificationTaskRegistryContext,
} from './NotificationTaskSourceContext'
import { createNotificationTaskRegistry } from './notificationTaskRegistry'

export function NotificationTaskSourceProvider({ children }: { children: ReactNode }) {
  const [registry] = useState(createNotificationTaskRegistry)
  const cloud = useContext(CloudConnectionContext)
  const preferences = useAppPreferencesState()
  const sessionConsent = useSessionTelemetryConsent()
  const enabled = useTelemetryEnabled()
  const policy =
    sessionConsent === false ||
    (preferences?.loaded &&
      preferences.preferences.telemetryConsentAsked === true &&
      preferences.preferences.telemetryEnabled !== true)
      ? false
      : enabled
        ? true
        : null
  const subscribe = useCallback(
    (listener: () => void) =>
      registry.subscribe(listener, {
        mainWindow: getDesktopWindowLabel() === 'main',
        backendUrl: cloud?.apiBaseUrl ?? 'local',
        userId: cloud?.user?.id,
        policy,
      }),
    [registry, cloud?.apiBaseUrl, cloud?.user?.id, policy]
  )
  const taskSource = useSyncExternalStore(subscribe, registry.getSnapshot, registry.getSnapshot)
  const value = useMemo(() => ({ taskSource }), [taskSource])
  return (
    <NotificationTaskRegistryContext.Provider value={registry}>
      <NotificationTaskContext.Provider value={value}>{children}</NotificationTaskContext.Provider>
    </NotificationTaskRegistryContext.Provider>
  )
}
