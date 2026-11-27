import { useCallback, useMemo, useSyncExternalStore } from 'react'
import type { PersonalAssistantAccount } from '@/api/personalAssistantAccount'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { DeviceInfo } from '@/types/api'
import { getStandInErrorMessage } from '@/lib/stand-in-error-message'
import { createStandInInstanceSource } from './standInInstanceSource'

/** Resolve the account-owned primary assistant device and per-device stop/start state. */
export function useStandInInstance(
  services: WorkbenchServices,
  userId: number,
  devices: DeviceInfo[],
  connected: boolean,
  active: boolean,
  backendUrl = '',
  initialDeviceId?: string,
  entryRequestKey?: number,
  account?: PersonalAssistantAccount,
  publishAccount?: (account: PersonalAssistantAccount) => void,
  readAccount?: () => PersonalAssistantAccount | undefined
) {
  const api = services.standInApi
  const source = useMemo(
    () => createStandInInstanceSource({ services, api, userId, backendUrl, initialDeviceId }),
    [services, api, userId, backendUrl, initialDeviceId]
  )
  const subscribe = useCallback(
    (listener: () => void) =>
      source.subscribe(
        {
          account,
          publishAccount,
          readAccount,
          devices,
          connected,
          active,
          entryRequestKey,
        },
        listener
      ),
    [source, account, publishAccount, readAccount, devices, connected, active, entryRequestKey]
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
