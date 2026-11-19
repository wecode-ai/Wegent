import { useCallback, useMemo, useSyncExternalStore } from 'react'
import { useDOMEvent } from '@wegent/collaboration/dom-events'
import { useTranslation } from '@/hooks/useTranslation'
import type { DeviceInfo } from '@/types/devices'
import {
  createDeviceOnboardingSession,
  type DeviceOnboardingEvent,
} from './deviceOnboardingSession'

export interface DeviceOnboardingConnection {
  isConnected: boolean
  apiBaseUrl?: string
  token: string | null
  user?: { id: number } | null
}

export function deviceOnboardingScope(connection: DeviceOnboardingConnection): string {
  return JSON.stringify([
    connection.apiBaseUrl,
    connection.user?.id || connection.token,
    connection.isConnected,
  ])
}

export interface DeviceOnboardingProps {
  cloudConnection: DeviceOnboardingConnection
  hasCloudDevice?: boolean
  onCreated?: (devices: DeviceInfo[] | undefined, createdDeviceId: number) => void | Promise<void>
  onConnected: (devices: DeviceInfo[], device: DeviceInfo) => void | Promise<void>
  onCreatingChange?: (creating: boolean) => void
  onBusyChange?: (busy: boolean) => void
  onPendingChange?: (pending: boolean) => void
}

export function useDeviceOnboarding(props: DeviceOnboardingProps) {
  const { t } = useTranslation('common')
  const { cloudConnection, hasCloudDevice = false } = props
  const { apiBaseUrl, token, isConnected } = cloudConnection
  const scope = deviceOnboardingScope(cloudConnection)
  const session = useMemo(() => createDeviceOnboardingSession(scope), [scope])
  useDOMEvent<DeviceOnboardingEvent>(session.events, 'onboarding', event => {
    const detail = event.detail
    switch (detail.kind) {
      case 'busy':
        props.onBusyChange?.(detail.value)
        break
      case 'pending':
        props.onPendingChange?.(detail.value)
        break
      case 'creating':
        props.onCreatingChange?.(detail.value)
        break
      case 'created':
        event.complete(() => props.onCreated?.(undefined, detail.id))
        break
      case 'connected':
        event.complete(() => props.onConnected(detail.devices, detail.device))
        break
    }
  })
  const subscribe = useCallback(
    (listener: () => void) => session.subscribe(listener, { apiBaseUrl, token, isConnected }),
    [session, apiBaseUrl, token, isConnected]
  )
  const snapshot = useSyncExternalStore(subscribe, session.getSnapshot, session.getServerSnapshot)
  return {
    loading: snapshot.loading,
    remoteLoading: snapshot.remoteLoading,
    error: snapshot.error,
    remoteCommand: snapshot.remoteCommand,
    remoteStatus: snapshot.remoteStatus,
    copied: snapshot.copied,
    cloudCreated: Boolean(snapshot.pending?.cloud),
    disconnected: !isConnected || !apiBaseUrl || !token,
    handleCreate: () => session.createCloud(hasCloudDevice, t),
    handleCreateRemoteDocker: () => session.createRemote(t),
    handleCopyRemoteCommand: () => session.copy(t),
    retryConnection: () => session.retry(t),
  }
}
