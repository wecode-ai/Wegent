// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

/** Rollback switch for collab.projectSnapshotRevalidate.v1. */
export const projectSnapshotRevalidateEnabled =
  import.meta.env.VITE_COLLAB_PROJECT_SNAPSHOT_REVALIDATE_V1 !== 'false'

export type ProjectSnapshotSyncState = 'fresh' | 'revalidating' | 'offline' | 'stale'

export function useProjectSnapshotRefresh({
  scope,
  active,
  refreshKey,
  enabled = projectSnapshotRevalidateEnabled,
  requiresNetwork = true,
  refresh,
}: {
  scope: object | null
  active: boolean
  refreshKey: string
  enabled?: boolean
  requiresNetwork?: boolean
  refresh(isCurrent: () => boolean): Promise<void>
}) {
  const refreshRef = useRef(refresh)
  const visit = useMemo(
    () => ({ scope, active, refreshKey, requiresNetwork }),
    [scope, active, refreshKey, requiresNetwork]
  )
  const retryRef = useRef<() => Promise<void>>(async () => {})
  const [result, setResult] = useState<{
    visit: object | null
    state: ProjectSnapshotSyncState
  }>({ visit: null, state: 'revalidating' })
  useLayoutEffect(() => {
    refreshRef.current = refresh
  }, [refresh])

  useEffect(() => {
    if (!enabled || !active || !scope) return
    let current = true
    let pending: Promise<void> | null = null
    let generation = 0
    const publish = (state: ProjectSnapshotSyncState) => {
      if (current) setResult({ visit, state })
    }
    const revalidate = (): Promise<void> => {
      if (!current || document.visibilityState === 'hidden') return Promise.resolve()
      if (requiresNetwork && !navigator.onLine) {
        generation += 1
        pending = null
        publish('offline')
        return Promise.resolve()
      }
      if (pending) return pending
      const request = ++generation
      const isCurrent = () => current && generation === request
      publish('revalidating')
      pending = Promise.resolve()
        .then(() => (isCurrent() ? refreshRef.current(isCurrent) : undefined))
        .then(
          () => {
            if (isCurrent()) publish('fresh')
          },
          () => {
            if (isCurrent()) publish(requiresNetwork && !navigator.onLine ? 'offline' : 'stale')
          }
        )
        .finally(() => {
          if (isCurrent()) pending = null
        })
      return pending
    }
    const onActivate = () => void revalidate()
    const suspend = () => {
      generation += 1
      pending = null
      publish(requiresNetwork && !navigator.onLine ? 'offline' : 'revalidating')
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') suspend()
      else onActivate()
    }
    const onOffline = () => {
      if (!requiresNetwork) return
      generation += 1
      pending = null
      publish('offline')
    }
    retryRef.current = revalidate
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('focus', onActivate)
    window.addEventListener('blur', suspend)
    window.addEventListener('online', onActivate)
    window.addEventListener('offline', onOffline)
    onActivate()
    return () => {
      current = false
      retryRef.current = async () => {}
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('focus', onActivate)
      window.removeEventListener('blur', suspend)
      window.removeEventListener('online', onActivate)
      window.removeEventListener('offline', onOffline)
    }
  }, [active, enabled, requiresNetwork, scope, visit])

  const state: ProjectSnapshotSyncState =
    !enabled || !scope ? 'fresh' : !active || result.visit !== visit ? 'revalidating' : result.state
  const retry = useCallback(() => retryRef.current(), [])
  return { state, canWrite: state === 'fresh', retry }
}
