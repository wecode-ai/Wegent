import { useEffect, useMemo, useState } from 'react'
import type { SharedWorkspaceRuntimeApi, RuntimeDeviceAccess } from '../ports/SharedWorkspaceApi'

/** Hosts with remote restrictions resolve access before mounting runtime readers. */
export function useRuntimeDeviceAccess(runtime: SharedWorkspaceRuntimeApi, deviceIds: string[]) {
  const key = JSON.stringify([...new Set(deviceIds)].sort())
  const [revision, setRevision] = useState(0)
  const [snapshot, setSnapshot] = useState<{
    runtime: SharedWorkspaceRuntimeApi
    key: string
    revision: number
    values: Record<string, RuntimeDeviceAccess>
    error: string | null
  } | null>(null)
  const ids: string[] = useMemo(() => JSON.parse(key), [key])
  useEffect(() => {
    if (!runtime.checkDeviceAccess || !ids.length) return
    let active = true
    void runtime.checkDeviceAccess(ids).then(
      values => {
        if (active) setSnapshot({ runtime, key, revision, values, error: null })
      },
      cause => {
        if (active)
          setSnapshot({
            runtime,
            key,
            revision,
            values: {},
            error: cause instanceof Error ? cause.message : String(cause),
          })
      }
    )
    return () => {
      active = false
    }
  }, [runtime, ids, key, revision])
  const current =
    snapshot?.runtime === runtime && snapshot.key === key && snapshot.revision === revision
      ? snapshot
      : null
  return {
    get: (deviceId: string): RuntimeDeviceAccess | 'loading' | 'error' =>
      !runtime.checkDeviceAccess
        ? 'allowed'
        : current?.error
          ? 'error'
          : current
            ? (current.values[deviceId] ?? 'unavailable')
            : 'loading',
    error: current?.error,
    retry: () => setRevision(value => value + 1),
  }
}
