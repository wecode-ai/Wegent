import { useEffect, useMemo } from 'react'
import {
  createExecutorClientForWorkbenchServices,
  type WorkbenchServices,
} from '../workbenchServices'
import type { RuntimeTaskLifecycleStore } from './RuntimeTaskLifecycleStore'

type ReconciliationReason = 'event_lagged' | 'runtime_replaced'

interface TerminalEventPayload {
  taskId?: string
  deviceId?: string
}

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

    const settleMatchingTask = (
      payload: TerminalEventPayload,
      outcome: 'succeeded' | 'failed' | 'cancelled'
    ) => {
      if (!payload.taskId) return
      const snapshot = store.getSnapshot()
      for (const key of snapshot.runningTaskKeys) {
        const lifecycle = snapshot.tasks.get(key)
        if (!lifecycle || lifecycle.address.taskId !== payload.taskId) continue
        if (payload.deviceId && lifecycle.address.deviceId !== payload.deviceId) continue
        store.turnSettled(lifecycle.address, null, outcome)
      }
    }

    const unsubscribe = services.chatStream.subscribe({
      onChatDone: payload => settleMatchingTask(payload, 'succeeded'),
      onChatError: payload =>
        settleMatchingTask(payload, isCancelledTerminalEvent(payload) ? 'cancelled' : 'failed'),
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

function isCancelledTerminalEvent(payload: { error: string; type?: string }): boolean {
  const error = payload.error.trim().toLowerCase()
  const type = payload.type?.trim().toLowerCase()
  return [error, type].some(value =>
    value ? ['interrupted', 'cancelled', 'canceled', 'aborted'].includes(value) : false
  )
}
