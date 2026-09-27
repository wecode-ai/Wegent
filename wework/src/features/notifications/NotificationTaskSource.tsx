import { useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useWorkbench } from '@/features/workbench/useWorkbench'
import {
  NotificationTaskContext,
  type IssueDispatchNotificationAction,
  type TaskSource,
} from './NotificationTaskSourceContext'

export function NotificationTaskSourceProvider({ children }: { children: ReactNode }) {
  const [sources, setSources] = useState<Map<string, { source: TaskSource; active: boolean }>>(
    () => new Map()
  )
  const [issueDispatchActions, setIssueDispatchActions] = useState<
    Map<string, { action: IssueDispatchNotificationAction; active: boolean }>
  >(() => new Map())
  const registerTaskSource = useCallback(
    (id: string, source: TaskSource | null, active: boolean) => {
      setSources(current => {
        const next = new Map(current)
        if (source) next.set(id, { source, active })
        else next.delete(id)
        return next
      })
    },
    []
  )
  const taskSource =
    [...sources.values()].find(entry => entry.active)?.source ??
    sources.values().next().value?.source ??
    null
  const issueDispatchAction =
    [...issueDispatchActions.values()].find(entry => entry.active)?.action ??
    issueDispatchActions.values().next().value?.action ??
    null
  const registerIssueDispatchAction = useCallback(
    (id: string, action: IssueDispatchNotificationAction | null, active: boolean) => {
      setIssueDispatchActions(current => {
        const next = new Map(current)
        if (action) next.set(id, { action, active })
        else next.delete(id)
        return next
      })
    },
    []
  )
  const value = useMemo(
    () => ({
      taskSource,
      registerTaskSource,
      issueDispatchAction,
      registerIssueDispatchAction,
    }),
    [issueDispatchAction, registerIssueDispatchAction, registerTaskSource, taskSource]
  )
  return (
    <NotificationTaskContext.Provider value={value}>{children}</NotificationTaskContext.Provider>
  )
}

export function NotificationTaskSourceBridge({ active, id }: { active: boolean; id: string }) {
  const context = useContext(NotificationTaskContext)
  const registerTaskSource = context?.registerTaskSource
  const { runtimeTaskReminders } = useWorkbench()

  useEffect(() => {
    if (!registerTaskSource) return
    registerTaskSource(id, runtimeTaskReminders, active)
    return () => registerTaskSource(id, null, active)
  }, [active, id, registerTaskSource, runtimeTaskReminders])

  return null
}
