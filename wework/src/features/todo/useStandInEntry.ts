import type { StandInBindingTarget, StandInExecutorApi } from '@/api/standIn'
import {
  createAsyncResource,
  getIdleResourceSnapshot,
  subscribeIdleResource,
} from '@wegent/chat-core/async-resource'
import { useMemo, useSyncExternalStore } from 'react'
import { parseStandInEntry, resolveStandInEntry } from './standInEntry'

/** A route can request a read of an authorized target, independently of the binding lifecycle. */
export function useStandInEntry(
  route: string,
  api: StandInExecutorApi | undefined,
  binding: StandInBindingTarget | undefined,
  devices: ReadonlySet<string>,
  active: boolean,
  entryRequestKey?: number
) {
  const entry = useMemo(() => parseStandInEntry(route), [route])
  const resource = useMemo(
    () =>
      api && binding && entry.kind === 'identity'
        ? createAsyncResource(`stand-in-entry:${entryRequestKey ?? 0}`, () =>
            resolveStandInEntry(api, entry, binding, devices)
          )
        : null,
    [api, binding, entry, devices, entryRequestKey]
  )
  const snapshot = useSyncExternalStore(
    active && resource ? resource.subscribe : subscribeIdleResource,
    resource?.getSnapshot ?? getIdleResourceSnapshot,
    getIdleResourceSnapshot
  )
  return { entry, result: snapshot.data, retry: resource?.reload }
}
