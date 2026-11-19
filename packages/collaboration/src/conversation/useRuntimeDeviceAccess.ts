import { useMemo, useState, useSyncExternalStore } from 'react'
import {
  createAsyncResource,
  getIdleResourceSnapshot,
  subscribeIdleResource,
} from '@wegent/chat-core/async-resource'
import type { SharedWorkspaceRuntimeApi, RuntimeDeviceAccess } from '../ports/SharedWorkspaceApi'

/** Hosts with remote restrictions resolve access before mounting runtime readers. */
export function useRuntimeDeviceAccess(runtime: SharedWorkspaceRuntimeApi, deviceIds: string[]) {
  const key = JSON.stringify([...new Set(deviceIds)].sort())
  const [revision, setRevision] = useState(0)
  const ids: string[] = useMemo(() => JSON.parse(key), [key])
  const resource = useMemo(
    () =>
      runtime.checkDeviceAccess && ids.length
        ? createAsyncResource(JSON.stringify([key, revision]), () =>
            runtime.checkDeviceAccess!(ids)
          )
        : null,
    [runtime, ids, key, revision]
  )
  const snapshot = useSyncExternalStore(
    resource?.subscribe ?? subscribeIdleResource,
    resource?.getSnapshot ?? getIdleResourceSnapshot,
    getIdleResourceSnapshot
  )
  const error =
    snapshot.status === 'error'
      ? snapshot.error instanceof Error
        ? snapshot.error.message
        : String(snapshot.error)
      : snapshot.status === 'ready'
        ? null
        : undefined
  return {
    get: (deviceId: string): RuntimeDeviceAccess | 'loading' | 'error' =>
      !runtime.checkDeviceAccess
        ? 'allowed'
        : snapshot.status === 'error'
          ? 'error'
          : snapshot.status === 'ready'
            ? (snapshot.data?.[deviceId] ?? 'unavailable')
            : 'loading',
    error,
    retry: () => setRevision(value => value + 1),
  }
}
