import { useMemo, useSyncExternalStore } from 'react'
import {
  createAsyncResource,
  getIdleResourceSnapshot,
  subscribeIdleResource,
} from '@wegent/chat-core/async-resource'
import type {
  RuntimeWorkspaceSearchItem,
  WorkspaceMentionSearchApi,
  WorkspaceMentionTarget,
} from './workspaceMentionTypes'

const EMPTY_MATCHES: RuntimeWorkspaceSearchItem[] = []

export function useWorkspaceMentionSearch(
  query: string,
  target?: WorkspaceMentionTarget | null,
  workspaceFileApi?: WorkspaceMentionSearchApi
) {
  const normalizedQuery = query.trim()
  const deviceId = target?.deviceId
  const workspacePath = target?.path
  const search = workspaceFileApi?.searchWorkspaceEntries
  const resource = useMemo(() => {
    if (!normalizedQuery || !deviceId || !workspacePath || !search) return null
    const key = `${deviceId}\0${workspacePath}\0${normalizedQuery}`
    return createAsyncResource(
      key,
      async () => {
        const cancellationToken = `composer-${Date.now()}-${Math.random().toString(36).slice(2)}`
        const response = await search(deviceId, workspacePath, normalizedQuery, cancellationToken)
        return response.files.slice(0, 50)
      },
      { delayMs: 80 }
    )
  }, [deviceId, normalizedQuery, search, workspacePath])
  const snapshot = useSyncExternalStore(
    resource?.subscribe ?? subscribeIdleResource,
    resource?.getSnapshot ?? getIdleResourceSnapshot,
    getIdleResourceSnapshot
  )
  return {
    retry: () => {
      void resource?.reload()
    },
    matches: snapshot.data ?? EMPTY_MATCHES,
    loading: Boolean(resource) && (snapshot.status === 'idle' || snapshot.status === 'loading'),
    error: snapshot.status === 'error',
  }
}
