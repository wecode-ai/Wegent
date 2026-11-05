import { useEffect, useMemo, useState } from 'react'
import type { SharedIssueStatusHistoryEntry } from '@wegent/collaboration'
import type { CloudLoopItem, createDeliveryApi } from '@/api/deliveries'

type IssueHistory = Pick<CloudLoopItem, 'assignment_history' | 'status_history'>

export function useIssueActivityHistory(
  task: CloudLoopItem,
  statusHistory: SharedIssueStatusHistoryEntry[],
  enabled: boolean,
  api: Pick<ReturnType<typeof createDeliveryApi>, 'getLoopItem'> | undefined
) {
  const [loaded, setLoaded] = useState<{
    taskId: string
    version: number
    api: typeof api
    history: IssueHistory | null
  } | null>(null)
  const needsHistory =
    enabled &&
    !(statusHistory.length > 0 && task.assignment_history !== undefined) &&
    Boolean(api?.getLoopItem)

  useEffect(() => {
    if (!needsHistory || !api?.getLoopItem) return
    let active = true
    void api.getLoopItem(task.id).then(
      item => {
        if (active) setLoaded({ taskId: task.id, version: task.version, api, history: item })
      },
      () => {
        if (active)
          setLoaded(previous => ({
            taskId: task.id,
            version: task.version,
            api,
            history: previous?.taskId === task.id && previous.api === api ? previous.history : null,
          }))
      }
    )
    return () => {
      active = false
    }
  }, [api, needsHistory, task.id, task.version])

  return useMemo(() => {
    const current = loaded?.taskId === task.id && loaded.api === api
    const history = current ? loaded.history : null
    return {
      loading: needsHistory && !(current && loaded.version === task.version),
      statusHistory: statusHistory.length ? statusHistory : (history?.status_history ?? []),
      assignmentHistory: task.assignment_history ?? history?.assignment_history ?? [],
    }
  }, [api, loaded, needsHistory, statusHistory, task.assignment_history, task.id, task.version])
}
