import { useCallback, useMemo, useSyncExternalStore } from 'react'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { DeviceInfo } from '@/types/api'
import { getStandInErrorMessage } from '@/lib/stand-in-error-message'
import { createStandInInstanceSource } from './standInInstanceSource'
import type { StandInEntry } from './standInEntry'
import type { StandInExecutorApi } from '@/api/standIn'

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
    entry,
    entryApi,
    legacyOnly = false,
  }: {
    entryRequestKey?: number
    requireSetupConfirmation?: boolean
    entry?: StandInEntry
    legacyOnly?: boolean
    entryApi?: Pick<StandInExecutorApi, 'personalGet'>
  } = {}
) {
  const api = services.standInApi
  const source = useMemo(
    () =>
      createStandInInstanceSource({
        services,
        api,
        userId,
        backendUrl,
        requireSetupConfirmation,
        legacyOnly,
      }),
    [services, api, userId, backendUrl, requireSetupConfirmation, legacyOnly]
  )
  const subscribe = useCallback(
    (listener: () => void) =>
      source.subscribe({ devices, connected, active, entryRequestKey, entry, entryApi }, listener),
    [source, devices, connected, active, entryRequestKey, entry, entryApi]
  )
  const snapshot = useSyncExternalStore(subscribe, source.getSnapshot, source.getSnapshot)
  return {
    ...snapshot,
    entryError: snapshot.entryFailure?.entry === entry ? snapshot.entryFailure?.error : undefined,
    error: snapshot.error
      ? getStandInErrorMessage(snapshot.error.cause, snapshot.error.fallback)
      : null,
    errorCause: snapshot.error?.cause,
    setup: source.setup,
    stop: source.stop,
    bind: source.bind,
    migrate: source.migrate,
    initializeOnDevice: source.initializeOnDevice,
    reload: source.reload,
  }
}
