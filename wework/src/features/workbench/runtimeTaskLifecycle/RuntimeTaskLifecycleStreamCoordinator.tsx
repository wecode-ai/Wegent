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
import {
  runtimeMessagesToWorkbenchMessages,
  runtimeTranscriptTurnsToConversationTurns,
} from '../runtimePaneMessages'
import type { RuntimeTaskLifecycleStore } from './RuntimeTaskLifecycleStore'
import type { RuntimeTaskAddress, RuntimeTranscriptResponse } from '@/types/api'
import type { RuntimePaneTranscript } from '@/types/workbench'

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
                const transcript = runtimePaneTranscript(transcriptResponse)
                const turns = runtimeTranscriptTurnsToConversationTurns(
                  transcriptResponse.turns ?? []
                )
                reconcileRuntimeConversationSnapshot(address, turns)
                if (reason === 'runtime_replaced') {
                  reconcileRuntimeConversationQueueAfterTransportReplacement(address, turns)
                }
                store.syncTranscript(
                  address,
                  transcript,
                  reason === 'event_lagged' ? { preserveActiveTurn: true } : undefined
                )
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

function runtimePaneTranscript(transcript: RuntimeTranscriptResponse): RuntimePaneTranscript {
  return {
    messages: runtimeMessagesToWorkbenchMessages(transcript.messages ?? []),
    turns: runtimeTranscriptTurnsToConversationTurns(transcript.turns ?? []),
    contextUsage: transcript.contextUsage ?? null,
    turnNavigation: transcript.turnNavigation ?? [],
    fullContent: transcript.fullContent === true,
    rangeStart: transcript.rangeStart ?? null,
    rangeEnd: transcript.rangeEnd ?? null,
    hasMoreBefore: Boolean(transcript.hasMoreBefore),
    beforeCursor: transcript.beforeCursor ?? null,
    hasMoreAfter: Boolean(transcript.hasMoreAfter),
    afterCursor: transcript.afterCursor ?? null,
  }
}

function isCancelledTerminalEvent(payload: { error: string; type?: string }): boolean {
  const error = payload.error.trim().toLowerCase()
  const type = payload.type?.trim().toLowerCase()
  return [error, type].some(value =>
    value ? ['interrupted', 'cancelled', 'canceled', 'aborted'].includes(value) : false
  )
}
