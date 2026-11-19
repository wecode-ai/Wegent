import { createAsyncResource, subscribeIdleResource } from '@wegent/chat-core/async-resource'
import { useSyncExternalStore } from 'react'
import { listLocalWorkspaceOpeners } from '@/lib/local-terminal'

const resource = createAsyncResource('local-workspace-openers', () => listLocalWorkspaceOpeners(), {
  refreshOnSubscribe: true,
  failure(error) {
    console.error('[Wework] Failed to discover workspace openers:', error)
  },
})

export function useLocalWorkspaceOpeners(enabled: boolean) {
  const snapshot = useSyncExternalStore(
    enabled ? resource.subscribe : subscribeIdleResource,
    resource.getSnapshot,
    resource.getSnapshot
  )
  return {
    ...snapshot,
    failure: snapshot.status === 'error' ? snapshot : undefined,
    refresh: resource.reload,
  }
}
