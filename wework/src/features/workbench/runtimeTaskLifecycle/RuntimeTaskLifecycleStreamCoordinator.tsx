import { useEffect, useMemo } from 'react'
import {
  createExecutorClientForWorkbenchServices,
  type WorkbenchServices,
} from '../workbenchServices'
import type { RuntimeTaskLifecycleStore } from './RuntimeTaskLifecycleStore'

type ReconciliationReason = 'terminal_event' | 'event_lagged' | 'runtime_replaced'

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
    let reconciliation: Promise<void> | null = null
    let pendingReason: ReconciliationReason | null = null

    const runReconciliation = async (initialReason: ReconciliationReason) => {
      let reason: typeof pendingReason = initialReason
      while (!disposed && reason) {
        pendingReason = null
        try {
          const runtimeWork = await executorClient.runtime.listRuntimeWork()
          if (!disposed) store.syncRuntimeWork(runtimeWork)
        } catch (error) {
          console.warn('[Wework] Runtime task lifecycle reconciliation failed', {
            reason,
            error,
          })
        }
        reason = pendingReason
      }
    }

    const reconcile = (reason: ReconciliationReason) => {
      if (disposed) return
      if (reconciliation) {
        pendingReason = reason
        return
      }
      reconciliation = runReconciliation(reason).finally(() => {
        reconciliation = null
      })
    }

    const reconcileUnhandledTerminalEvent = (payload: { taskId?: string; deviceId?: string }) => {
      queueMicrotask(() => {
        if (disposed) return
        const snapshot = store.getSnapshot()
        const matchingTaskStillRunning = [...snapshot.runningTaskKeys].some(key => {
          const lifecycle = snapshot.tasks.get(key)
          if (!lifecycle) return false
          if (payload.taskId && lifecycle.address.taskId !== payload.taskId) return false
          if (payload.deviceId && lifecycle.address.deviceId !== payload.deviceId) return false
          return true
        })
        if (matchingTaskStillRunning) reconcile('terminal_event')
      })
    }

    const unsubscribe = services.chatStream.subscribe({
      onChatDone: reconcileUnhandledTerminalEvent,
      onChatError: reconcileUnhandledTerminalEvent,
      onRuntimeEventLagged: payload => {
        console.warn('[Wework] Runtime event stream lagged; reconciling task state', payload)
        reconcile('event_lagged')
      },
      onRuntimeTransportReplaced: () => reconcile('runtime_replaced'),
    })

    return () => {
      disposed = true
      unsubscribe()
    }
  }, [executorClient, services.chatStream, store])

  return null
}
