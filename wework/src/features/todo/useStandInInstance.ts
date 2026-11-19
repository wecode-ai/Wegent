import { useCallback, useMemo, useSyncExternalStore } from 'react'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { DeviceInfo } from '@/types/api'
import { getStandInErrorMessage } from '@/lib/stand-in-error-message'
import { createStandInInstanceSource } from './standInInstanceSource'

/** An instance has one durable binding; failed cancellation never unlocks rebinding. */
export function useStandInInstance(
  services: WorkbenchServices,
  userId: number,
  devices: DeviceInfo[],
  connected: boolean,
  active: boolean,
  backendUrl = '',
  initialDeviceId?: string,
  entryRequestKey?: number
) {
  const api = services.standInApi
  const source = useMemo(
    () => createStandInInstanceSource({ services, api, userId, backendUrl, initialDeviceId }),
    [services, api, userId, backendUrl, initialDeviceId]
  )
  const subscribe = useCallback(
    (listener: () => void) =>
      source.subscribe({ devices, connected, active, entryRequestKey }, listener),
    [source, devices, connected, active, entryRequestKey]
  )
  const snapshot = useSyncExternalStore(subscribe, source.getSnapshot, source.getSnapshot)
  return {
    ...snapshot,
    error: snapshot.error
      ? getStandInErrorMessage(snapshot.error.cause, snapshot.error.fallback)
      : null,
    errorCause: snapshot.error?.cause,
    stop: source.stop,
    bind: source.bind,
    migrate: source.migrate,
    reload: source.reload,
  }
}
