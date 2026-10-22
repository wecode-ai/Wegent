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
    history: IssueHistory
  } | null>(null)

  useEffect(() => {
    if (
      !enabled ||
      (statusHistory.length && task.assignment_history !== undefined) ||
      !api?.getLoopItem
    )
      return
    let active = true
    void api.getLoopItem(task.id).then(
      item => {
        if (active) setLoaded({ taskId: task.id, history: item })
      },
      () => undefined
    )
    return () => {
      active = false
    }
  }, [api, enabled, statusHistory.length, task.assignment_history, task.id, task.version])

  return useMemo(() => {
    const history = loaded?.taskId === task.id ? loaded.history : null
    return {
      statusHistory: statusHistory.length ? statusHistory : (history?.status_history ?? []),
      assignmentHistory: task.assignment_history ?? history?.assignment_history ?? [],
    }
  }, [loaded, statusHistory, task.assignment_history, task.id])
}
