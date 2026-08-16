import { useEffect, useMemo } from 'react'
import {
  createExecutorClientForWorkbenchServices,
  type WorkbenchServices,
} from '../workbenchServices'
import type { RuntimeTaskLifecycleStore } from './RuntimeTaskLifecycleStore'

const RUNNING_TASK_RECONCILIATION_INTERVAL_MS = 1_000

export function RuntimeTaskLifecycleStreamCoordinator({
  services,
  store,
}: {
  services: WorkbenchServices
  store: RuntimeTaskLifecycleStore
}) {
  const executorClient = useMemo(
    () => createExecutorClientForWorkbenchServices(services),
    [services]
  )

  useEffect(() => {
    let disposed = false
    let inFlight = false
    let timer: number | null = null

    const hasRunningTasks = () => store.getSnapshot().runningTaskKeys.size > 0
    const schedule = (delay: number) => {
      if (disposed || inFlight || timer !== null || !hasRunningTasks()) return
      timer = window.setTimeout(() => {
        timer = null
        void reconcile()
      }, delay)
    }
    const reconcile = async () => {
      if (disposed || inFlight || !hasRunningTasks()) return
      inFlight = true
      try {
        const snapshot = store.getSnapshot()
        const runningTasks = [...snapshot.runningTaskKeys].flatMap(key => {
          const task = snapshot.tasks.get(key)
          return task ? [task] : []
        })
        const transcripts = await Promise.allSettled(
          runningTasks.map(task =>
            executorClient.runtime.getRuntimeTranscript({
              ...task.address,
              limit: 1,
            })
          )
        )
        transcripts.forEach((result, index) => {
          if (result.status !== 'fulfilled') return
          const lifecycle = runningTasks[index]
          if (lifecycle) {
            store.syncRuntimeTranscriptSnapshot(lifecycle.address, result.value)
          }
        })
        const failures = transcripts.filter(
          (result): result is PromiseRejectedResult => result.status === 'rejected'
        )
        if (transcripts.length > 0 && failures.length === transcripts.length) {
          throw failures[0]?.reason
        }
      } catch (error) {
        console.warn('[Wework] Running runtime task reconciliation failed', { error })
      } finally {
        inFlight = false
        schedule(RUNNING_TASK_RECONCILIATION_INTERVAL_MS)
      }
    }
    const unsubscribe = store.subscribe(() => schedule(0))
    schedule(0)

    return () => {
      disposed = true
      unsubscribe()
      if (timer !== null) window.clearTimeout(timer)
    }
  }, [executorClient, store])

  return null
}
