import { useMemo, useSyncExternalStore } from 'react'
import { subscribeIdleResource } from '@wegent/chat-core/async-resource'
import { useWindowEvent } from '@wegent/collaboration/dom-events'
import { useNotificationTaskSource } from './NotificationTaskSourceContext'
import { isRuntimeTaskExecutionRunning } from '@/features/workbench/runtimeTaskLifecycle/projection'
import { projectIssueNeedsInput } from './pendingProjectWork'
import { createPendingProjectIssuesStore } from './pendingProjectIssuesStore'
export type { PendingProjectIssue } from './pendingProjectIssuesStore'

function issueKey(store: string, projectId: string | number, itemId: string) {
  return JSON.stringify([store, String(projectId), itemId])
}

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
  const tasks = source?.items
  const runningIssues = useMemo(() => {
    const keys = new Set<string>()
    for (const { task } of tasks ?? []) {
      const origin = task.runtimeHandle?.origin as Record<string, unknown> | undefined
      if (!origin || typeof origin.loopItemId !== 'string') continue
      if (!isRuntimeTaskExecutionRunning(task)) continue
      keys.add(
        issueKey(
          origin.projectStore === 'local' ? 'local' : 'backend',
          String(origin.cloudProjectId),
          origin.loopItemId
        )
      )
    }
    return keys
  }, [tasks])
  const items = useMemo(
    () =>
      snapshot.items.filter(row =>
        projectIssueNeedsInput(
          runningIssues.has(issueKey(row.store, row.item.cloud_project_id, row.item.id))
            ? { ...row.item, execution_state: 'running' }
            : row.item,
          row.userId
        )
      ),
    [snapshot.items, runningIssues]
  )
  return {
    items,
    errors: snapshot.errors,
    loading: active && (snapshot.loading.local || snapshot.loading.backend),
    refresh: store.refresh,
  }
}
