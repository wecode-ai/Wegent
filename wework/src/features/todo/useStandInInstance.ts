import { useCallback, useMemo, useSyncExternalStore } from 'react'
import type { PersonalAssistantAccount } from '@/api/personalAssistantAccount'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { DeviceInfo } from '@/types/api'
import { getStandInErrorMessage } from '@/lib/stand-in-error-message'
import { createStandInInstanceSource } from './standInInstanceSource'
import type { StandInEntry } from './standInEntry'
import type { StandInExecutorApi } from '@/api/standIn'

/** Resolve the account-owned primary assistant device and per-device stop/start state. */
export function useStandInInstance(
  services: WorkbenchServices,
  userId: number,
  devices: DeviceInfo[],
  connected: boolean,
  active: boolean,
  backendUrl = '',
  {
    initialDeviceId,
    entryRequestKey,
    requireSetupConfirmation = true,
    entry,
    entryApi,
    account,
    publishAccount,
    readAccount,
    newAccount,
  }: {
    initialDeviceId?: string
    entryRequestKey?: number
    requireSetupConfirmation?: boolean
    entry?: StandInEntry
    entryApi?: Pick<StandInExecutorApi, 'personalGet'>
    account?: PersonalAssistantAccount
    publishAccount?: (account: PersonalAssistantAccount) => void
    readAccount?: () => PersonalAssistantAccount | undefined
    newAccount?: boolean
  } = {}
) {
  const api = services.standInApi
  const accountMode = Boolean(account)
  const source = useMemo(
    () =>
      createStandInInstanceSource({
        services,
        api,
        userId,
        backendUrl,
        requireSetupConfirmation,
        initialDeviceId,
        accountMode,
      }),
    [services, api, userId, backendUrl, requireSetupConfirmation, initialDeviceId, accountMode]
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
          entry,
          entryApi,
          newAccount,
        },
        listener
      ),
    [
      source,
      account,
      publishAccount,
      readAccount,
      devices,
      connected,
      active,
      entryRequestKey,
      entry,
      entryApi,
      newAccount,
    ]
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
