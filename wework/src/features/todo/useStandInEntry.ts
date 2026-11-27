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
  entryRequestKey?: number
) {
  const entry = useMemo(() => parseStandInEntry(route), [route])
  const userId = binding?.userId
  const deviceId = binding?.deviceId
  const resource = useMemo(
    () =>
      api && userId !== undefined && deviceId && entry.kind === 'identity'
        ? createAsyncResource(route, () =>
            resolveStandInEntry(api, entry, { userId, deviceId }, devices)
          )
        : null,
    [api, userId, deviceId, route, entry, devices]
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
