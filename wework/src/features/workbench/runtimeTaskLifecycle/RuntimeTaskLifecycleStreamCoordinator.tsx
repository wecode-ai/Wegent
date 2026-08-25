import { useEffect, useMemo } from 'react'
import {
  createExecutorClientForWorkbenchServices,
  type WorkbenchServices,
} from '../workbenchServices'
import {
  reconcileRuntimeConversationQueueAfterTransportReplacement,
  reconcileRuntimeConversationSnapshot,
  runtimeConversationKey,
} from '../runtimeConversationCache'
import { subscribeSystemResume } from '@/desktop/systemResume'
import type { RuntimeTaskLifecycleStore } from './RuntimeTaskLifecycleStore'
import { runtimeTaskLifecycleTransitionChanged } from './RuntimeTaskLifecycleStore'
import { isRuntimePaneTranscriptConfirmedIdle, projectRuntimePaneTranscript } from './projection'
import type { RuntimeTaskAddress } from '@/types/api'

type ReconciliationReason = 'event_lagged' | 'runtime_replaced' | 'system_resume'

interface TerminalEventPayload {
  taskId?: string
  subtaskId?: string
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
  const recoverRuntimeConnections = services.recoverRuntimeConnections

  useEffect(() => {
    let disposed = false
    let reconciliation: Promise<void> | null = null
    let pendingReason: ReconciliationReason | null = null

    const runReconciliation = async (initialReason: ReconciliationReason) => {
      let reason: typeof pendingReason = initialReason
      while (!disposed && reason) {
        pendingReason = null
        try {
          const recoveryAddresses = runtimeRecoveryAddresses(store)
          const runtimeWork = await executorClient.runtime.listRuntimeWork()
          if (!disposed) {
            store.syncRuntimeWork(runtimeWork)
            for (const address of runtimeRecoveryAddresses(store, recoveryAddresses)) {
              if (disposed) break
              try {
                const transcriptResponse = await executorClient.runtime.getRuntimeTranscript({
                  ...address,
                  limit: 50,
                  refresh: true,
                })
                if (disposed) break
                const transcript = projectRuntimePaneTranscript(transcriptResponse)
                const turns = transcript.turns
                reconcileRuntimeConversationSnapshot(address, turns)
                if (reason === 'runtime_replaced') {
                  reconcileRuntimeConversationQueueAfterTransportReplacement(address, turns)
                }
                store.syncTranscript(address, transcript)
              } catch (error) {
                console.warn('[Wework] Runtime transcript reconciliation failed', {
                  reason,
                  deviceId: address.deviceId,
                  taskId: address.taskId,
                  error,
                })
              }
            }
          }
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

    const unsubscribeSystemResume = subscribeSystemResume(() => {
      void Promise.resolve()
        .then(() => recoverRuntimeConnections?.())
        .catch(error => {
          console.warn('[Wework] Runtime transport recovery after system resume failed', error)
        })
        .finally(() => reconcile('system_resume'))
    })

    const settleMatchingTask = (
      payload: TerminalEventPayload,
      outcome: 'succeeded' | 'failed' | 'cancelled'
    ): { address: RuntimeTaskAddress; settled: boolean } | null => {
      if (!payload.taskId) return null
      const snapshot = store.getSnapshot()
      for (const lifecycle of snapshot.tasks.values()) {
        if (!lifecycle || lifecycle.address.taskId !== payload.taskId) continue
        if (
          payload.deviceId &&
          lifecycle.address.deviceId !== payload.deviceId &&
          store.getTask({ ...lifecycle.address, deviceId: payload.deviceId })?.key !== lifecycle.key
        ) {
          continue
        }
        const terminalTurnId = payload.subtaskId?.trim() || null
        const activeTurnId = lifecycle.turn.id
        if (terminalTurnId && activeTurnId && terminalTurnId !== activeTurnId) {
          return { address: lifecycle.address, settled: false }
        }
        store.turnSettled(lifecycle.address, terminalTurnId, outcome)
        return { address: lifecycle.address, settled: true }
      }
      return null
    }

    const reconcileTerminalTranscript = async (
      address: RuntimeTaskAddress,
      outcome?: 'succeeded' | 'failed' | 'cancelled'
    ) => {
      const expectedSnapshot = store.getTask(address)
      try {
        const transcriptResponse = await executorClient.runtime.getRuntimeTranscript({
          ...address,
          limit: 50,
          refresh: true,
        })
        if (disposed) return
        if (runtimeTaskLifecycleTransitionChanged(expectedSnapshot, store.getTask(address))) return
        const transcript = projectRuntimePaneTranscript(transcriptResponse)
        reconcileRuntimeConversationSnapshot(address, transcript.turns)
        store.syncTranscript(address, transcript)
        if (outcome && isRuntimePaneTranscriptConfirmedIdle(transcript)) {
          store.turnSettled(address, null, outcome)
        }
      } catch (error) {
        console.warn('[Wework] Runtime terminal transcript reconciliation failed', {
          deviceId: address.deviceId,
          taskId: address.taskId,
          error,
        })
      }
    }

    const unsubscribe = services.chatStream.subscribe({
      onChatDone: payload => {
        const match = settleMatchingTask(payload, 'succeeded')
        if (match) {
          void reconcileTerminalTranscript(match.address, 'succeeded')
        }
      },
      onChatError: payload => {
        const match = settleMatchingTask(
          payload,
          isCancelledTerminalEvent(payload) ? 'cancelled' : 'failed'
        )
        if (match && !match.settled) {
          void reconcileTerminalTranscript(
            match.address,
            isCancelledTerminalEvent(payload) ? 'cancelled' : 'failed'
          )
        }
      },
      onRuntimeEventLagged: payload => {
        console.warn('[Wework] Runtime event stream lagged; reconciling task state', payload)
        reconcile('event_lagged')
      },
      onRuntimeTransportReplaced: () => reconcile('runtime_replaced'),
    })

    return () => {
      disposed = true
      unsubscribeSystemResume()
      unsubscribe()
    }
  }, [executorClient, recoverRuntimeConnections, services.chatStream, store])

  return null
}

function runtimeRecoveryAddresses(
  store: RuntimeTaskLifecycleStore,
  retained: RuntimeTaskAddress[] = []
): RuntimeTaskAddress[] {
  const snapshot = store.getSnapshot()
  const addresses = new Map(retained.map(address => [runtimeConversationKey(address), address]))
  const current = store.getCurrentTask()
  if (current) addresses.set(runtimeConversationKey(current.address), current.address)
  for (const key of snapshot.runningTaskKeys) {
    const lifecycle = snapshot.tasks.get(key)
    if (lifecycle) {
      addresses.set(runtimeConversationKey(lifecycle.address), lifecycle.address)
    }
  }
  return [...addresses.values()]
}

function isCancelledTerminalEvent(payload: { error: string; type?: string }): boolean {
  const error = payload.error.trim().toLowerCase()
  const type = payload.type?.trim().toLowerCase()
  return [error, type].some(value =>
    value ? ['interrupted', 'cancelled', 'canceled', 'aborted'].includes(value) : false
  )
}
