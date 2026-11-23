import { useCallback, useMemo, useSyncExternalStore } from 'react'
import { createAsyncResource, getIdleResourceSnapshot } from '@wegent/chat-core/async-resource'
import type { SharedWorkspaceRuntimeApi, WorkspaceTaskBinding } from '../ports/SharedWorkspaceApi'

export function useBrowserBoardRuntimeWork(
  runtime: SharedWorkspaceRuntimeApi | undefined,
  bindings: WorkspaceTaskBinding[]
) {
  const resource = useMemo(
    () =>
      runtime
        ? createAsyncResource(
            'board-runtime-work',
            signal => runtime.work.listRuntimeWork({ signal }),
            { refreshOnSubscribe: true }
          )
        : null,
    [runtime]
  )
  const subscribe = useCallback(
    (listener: () => void) =>
      bindings.length && resource ? resource.subscribe(listener) : () => {},
    [resource, bindings]
  )
  const snapshot = useSyncExternalStore(
    subscribe,
    resource?.getSnapshot ?? getIdleResourceSnapshot,
    getIdleResourceSnapshot
  )
  if (!runtime || !snapshot.settled) return null
  const failed = snapshot.status === 'error' || snapshot.error !== undefined
  return {
    runtime,
    work: failed ? null : (snapshot.data ?? null),
    error: failed
      ? String(snapshot.error instanceof Error ? snapshot.error.message : snapshot.error)
      : null,
  }
}
