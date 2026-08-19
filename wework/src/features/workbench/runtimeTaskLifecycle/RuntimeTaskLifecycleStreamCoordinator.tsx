import { useEffect, useMemo } from 'react'
import {
  createExecutorClientForWorkbenchServices,
  type WorkbenchServices,
} from '../workbenchServices'
import type { RuntimeTaskLifecycleStore } from './RuntimeTaskLifecycleStore'

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
    let pendingReason: 'event_lagged' | 'runtime_replaced' | null = null

    const runReconciliation = async (initialReason: 'event_lagged' | 'runtime_replaced') => {
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

    const reconcile = (reason: 'event_lagged' | 'runtime_replaced') => {
      if (disposed) return
      if (reconciliation) {
        pendingReason = reason
        return
      }
      reconciliation = runReconciliation(reason).finally(() => {
        reconciliation = null
      })
    }

    const unsubscribe = services.chatStream.subscribe({
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
