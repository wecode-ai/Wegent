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
  {
    entryRequestKey,
    requireSetupConfirmation = true,
    legacyEntryDeviceId,
  }: {
    entryRequestKey?: number
    requireSetupConfirmation?: boolean
    legacyEntryDeviceId?: string
  } = {}
) {
  const api = services.standInApi
  const source = useMemo(
    () =>
      createStandInInstanceSource({ services, api, userId, backendUrl, requireSetupConfirmation }),
    [services, api, userId, backendUrl, requireSetupConfirmation]
  )
  const subscribe = useCallback(
    (listener: () => void) =>
      source.subscribe(
        { devices, connected, active, entryRequestKey, legacyEntryDeviceId },
        listener
      ),
    [source, devices, connected, active, entryRequestKey, legacyEntryDeviceId]
  )
  const snapshot = useSyncExternalStore(subscribe, source.getSnapshot, source.getSnapshot)
  return {
    ...snapshot,
    error: snapshot.error
      ? getStandInErrorMessage(snapshot.error.cause, snapshot.error.fallback)
      : null,
    errorCause: snapshot.error?.cause,
    setup: source.setup,
    stop: source.stop,
    bind: source.bind,
    migrate: source.migrate,
    reload: source.reload,
  }
}
