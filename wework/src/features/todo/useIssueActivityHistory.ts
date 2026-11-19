import { useCallback, useMemo, useState, useSyncExternalStore } from 'react'
import {
  createAsyncResource,
  getIdleResourceSnapshot,
  subscribeIdleResource,
} from '@wegent/chat-core/async-resource'
import type { SharedIssueStatusHistoryEntry } from '@wegent/collaboration'
import type { CloudLoopItem, createDeliveryApi } from '@/api/deliveries'

type IssueHistory = Pick<CloudLoopItem, 'assignment_history' | 'status_history'>
type HistoryApi = Pick<ReturnType<typeof createDeliveryApi>, 'getLoopItem'> | undefined

function createHistorySelection(
  api: HistoryApi,
  taskId: string,
  version: number,
  initialData?: IssueHistory
) {
  return {
    api,
    taskId,
    version,
    resource: api
      ? createAsyncResource<IssueHistory>(
          JSON.stringify([taskId, version]),
          () => api.getLoopItem(taskId),
          { initialData }
        )
      : null,
  }
}

export function useIssueActivityHistory(
  task: CloudLoopItem,
  statusHistory: SharedIssueStatusHistoryEntry[],
  enabled: boolean,
  api: HistoryApi
) {
  const [selection, setSelection] = useState(() =>
    createHistorySelection(api, task.id, task.version)
  )
  const ownerMatches = selection.api === api && selection.taskId === task.id
  const current = ownerMatches && selection.version === task.version
  if (!current)
    setSelection(
      createHistorySelection(
        api,
        task.id,
        task.version,
        ownerMatches ? selection.resource?.getSnapshot().data : undefined
      )
    )
  const resource = current ? selection.resource : null
  const needsHistory =
    enabled &&
    !(statusHistory.length > 0 && task.assignment_history !== undefined) &&
    Boolean(api?.getLoopItem)
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!needsHistory || !resource) return subscribeIdleResource()
      const unsubscribe = resource.subscribe(listener)
      if (resource.getSnapshot().status === 'ready') void resource.reload()
      return unsubscribe
    },
    [needsHistory, resource]
  )
  const snapshot = useSyncExternalStore(
    subscribe,
    resource?.getSnapshot ?? getIdleResourceSnapshot,
    getIdleResourceSnapshot
  )
  return useMemo(
    () => ({
      loading: needsHistory && !snapshot.settled,
      statusHistory: statusHistory.length ? statusHistory : (snapshot.data?.status_history ?? []),
      assignmentHistory: task.assignment_history ?? snapshot.data?.assignment_history ?? [],
    }),
    [needsHistory, snapshot, statusHistory, task.assignment_history]
  )
}
