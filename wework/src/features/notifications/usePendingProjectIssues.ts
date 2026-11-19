import { useMemo, useSyncExternalStore } from 'react'
import { subscribeIdleResource } from '@wegent/chat-core/async-resource'
import { useWindowEvent } from '@wegent/collaboration/dom-events'
import { useNotificationTaskSource } from './NotificationTaskSourceContext'
import { isRuntimeTaskExecutionRunning } from '@/features/workbench/runtimeTaskLifecycle/projection'
import { projectIssueNeedsInput } from './pendingProjectWork'
import { createPendingProjectIssuesStore } from './pendingProjectIssuesStore'
export type { PendingProjectIssue } from './pendingProjectIssuesStore'

/** This page owns its reads; project failures do not erase another store's results. */
export function usePendingProjectIssues(active: boolean) {
  const source = useNotificationTaskSource()
  const local = source?.services?.projectSpaceApis?.local
  const cloud =
    source?.services?.projectSpaceApis?.cloud ??
    (source?.services?.issueHumanRequestsApi ? source.services.deliveryApi : undefined)
  const userId = source?.userId
  const localViewer = source?.services?.localParticipationIdentity?.viewerUserIds ?? 0
  const localClient = source?.services?.localProjectChatClient
  const cloudClient = source?.services?.projectChatClient
  const store = useMemo(
    () =>
      createPendingProjectIssuesStore({
        local,
        cloud,
        userId,
        localViewer,
        localClient,
        cloudClient,
      }),
    [local, cloud, userId, localViewer, localClient, cloudClient]
  )
  const snapshot = useSyncExternalStore(
    active ? store.subscribe : subscribeIdleResource,
    store.getSnapshot,
    store.getSnapshot
  )
  useWindowEvent('focus', () => void store.refresh(), { enabled: active })
  return {
    items: snapshot.items.filter(row => {
      const running = source?.items.some(task => {
        const origin = task.task.runtimeHandle?.origin as Record<string, unknown> | undefined
        return (
          isRuntimeTaskExecutionRunning(task.task) &&
          origin &&
          String(origin.cloudProjectId) === String(row.item.cloud_project_id) &&
          origin.loopItemId === row.item.id &&
          (origin.projectStore === 'local' ? 'local' : 'backend') === row.store
        )
      })
      return projectIssueNeedsInput(
        running ? { ...row.item, execution_state: 'running' } : row.item,
        row.userId
      )
    }),
    errors: snapshot.errors,
    loading: active && (snapshot.loading.local || snapshot.loading.backend),
    refresh: store.refresh,
  }
}
