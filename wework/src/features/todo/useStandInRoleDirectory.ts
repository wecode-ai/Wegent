import { useCallback, useMemo, useSyncExternalStore } from 'react'
import type { StandInExecutorApi } from '@/api/standIn'
import { getStandInErrorMessage } from '@/lib/stand-in-error-message'
import { subscribeIdleResource } from '@wegent/chat-core/async-resource'
import { createStandInRoleDirectoryResource } from './standInRoleDirectoryResource'

export type { StandInRoleLocation } from './standInRoleDirectoryResource'
const getMissingDirectory = () => undefined

/** Discover available role locations without changing the primary conversation's device. */
export function useStandInRoleDirectory(
  api: StandInExecutorApi | undefined,
  userId: number,
  rootDevice: string | undefined,
  active: boolean,
  localDevice?: string,
  entryRequestKey?: number,
  availableDevices: readonly string[] = []
) {
  const devicesKey = JSON.stringify([...new Set(availableDevices)].sort())
  const request = useMemo(
    () => ({
      devices: JSON.parse(devicesKey) as string[],
      entryRequestKey,
    }),
    [devicesKey, entryRequestKey]
  )
  const resource = useMemo(
    () =>
      api && rootDevice
        ? createStandInRoleDirectoryResource(api, userId, rootDevice, localDevice)
        : undefined,
    [api, userId, rootDevice, localDevice]
  )
  const subscribe = useCallback(
    (listener: () => void) => (resource ? resource.subscribe(listener, request) : () => {}),
    [resource, request]
  )
  const data = useSyncExternalStore(
    active ? subscribe : subscribeIdleResource,
    resource?.getSnapshot ?? getMissingDirectory
  )
  const error = data?.failure ? getStandInErrorMessage(data.failure.cause) : undefined
  return useMemo(
    () =>
      data && {
        scope: data.scope,
        roles: data.roles,
        error,
        rootUnavailable: data.rootUnavailable,
      },
    [data, error]
  )
}
