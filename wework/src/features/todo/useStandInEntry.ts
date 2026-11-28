import type { StandInBindingTarget, StandInExecutorApi } from '@/api/standIn'
import {
  createAsyncResource,
  getIdleResourceSnapshot,
  subscribeIdleResource,
} from '@wegent/chat-core/async-resource'
import { useCallback, useMemo, useSyncExternalStore } from 'react'
import { parseStandInEntry, resolveStandInEntry } from './standInEntry'

/** A route can request a read of an authorized target, independently of the binding lifecycle. */
export function useStandInEntry(
  route: string,
  api: Pick<StandInExecutorApi, 'personalGet'> | undefined,
  binding: StandInBindingTarget | undefined,
  devices: ReadonlySet<string>,
  active: boolean,
  entryRequestKey?: number,
  verifyIndependentDevice?: (deviceId: string, profileId: string) => Promise<boolean>,
  independentScope?: string
) {
  const entry = useMemo(() => parseStandInEntry(route), [route])
  const userId = binding?.userId
  const deviceId = binding?.deviceId
  // Inventory refreshes can replace the rows without changing the authorized devices.
  const deviceScope = JSON.stringify([...devices].sort())
  const resourceKey = verifyIndependentDevice
    ? JSON.stringify([route, independentScope, entryRequestKey, active])
    : route
  const resource = useMemo(
    () =>
      api && userId !== undefined && deviceId && entry.kind === 'identity'
        ? createAsyncResource(resourceKey, () =>
            resolveStandInEntry(
              api,
              entry,
              { userId, deviceId },
              new Set<string>(JSON.parse(deviceScope)),
              { verifyIndependentDevice }
            )
          )
        : null,
    [api, userId, deviceId, resourceKey, entry, deviceScope, verifyIndependentDevice]
  )
  const subscribe = useCallback(
    (listener: () => void) => resource?.subscribe(listener, entryRequestKey) ?? (() => {}),
    [resource, entryRequestKey]
  )
  const snapshot = useSyncExternalStore(
    active && resource ? subscribe : subscribeIdleResource,
    resource?.getSnapshot ?? getIdleResourceSnapshot,
    getIdleResourceSnapshot
  )
  return { entry, result: snapshot.data, retry: resource?.reload }
}
