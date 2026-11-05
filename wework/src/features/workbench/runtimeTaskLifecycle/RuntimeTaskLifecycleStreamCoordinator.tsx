import { synchronizeRuntimeConversation } from '../runtimeConversationSynchronization'
import { logRuntimeTaskCreateStage } from '@/lib/runtime-create-diagnostics'
import { syncRuntimeGoal } from '@/features/workbench/runtimeTaskLifecycle/goalSynchronization'
import { useEffect, useMemo, useRef } from 'react'
import {
  createExecutorClientForWorkbenchServices,
  type WorkbenchServices,
} from '../workbenchServices'
import {
  beginRuntimeGoalSnapshot,
  getRuntimeConversationQueuedMessages,
  getRuntimeConversationTurns,
  isRuntimeGoalSnapshotCurrent,
  reconcileRuntimeConversationQueueAfterTransportReplacement,
  runtimeConversationKey,
} from '../runtimeConversationCache'
import { subscribeSystemResume } from '@/desktop/systemResume'
import type { RuntimeTaskLifecycleStore } from './RuntimeTaskLifecycleStore'
import { isRuntimePaneTranscriptConfirmedIdle } from './projection'
import type { RuntimeTaskAddress } from '@/types/api'
import type { RequestUserInputPayload } from '@/components/chat/RequestUserInputCard'
import {
  hasRequestUserInputResponse,
  isAsyncRequestUserInputPayload,
} from '@/components/chat/requestUserInputMessages'

function pendingRequestUserInputBlockPayload(payload: {
  block: { type: string; status?: string; renderPayload?: unknown; render_payload?: unknown }
}): RequestUserInputPayload | null {
  if (payload.block.type !== 'tool' || payload.block.status === 'error') return null
  const renderPayload = payload.block.renderPayload ?? payload.block.render_payload
  if (!renderPayload || typeof renderPayload !== 'object' || Array.isArray(renderPayload)) {
    return null
  }
  const request = renderPayload as RequestUserInputPayload
  return request.kind === 'request_user_input' && !hasRequestUserInputResponse(request)
    ? request
    : null
}

type ReconciliationReason = 'event_lagged' | 'runtime_replaced' | 'system_resume'
const RECOVERY_PAGE_SIZE = 5
const RECOVERY_CONCURRENCY = 2

interface LifecycleEventPayload {
  task?: import('@/types/api').RuntimeTaskSummary
  taskId?: string
  subtaskId?: string
  deviceId?: string
}

function matchingLifecycleAddress(
  store: RuntimeTaskLifecycleStore,
  payload: LifecycleEventPayload
): RuntimeTaskAddress | null {
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
    return lifecycle.address
  }
  if (!payload.deviceId) return null
  return {
    deviceId: payload.deviceId,
    taskId: payload.taskId,
  }
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
  const interruptedRecoveryRef = useRef<{
    store: RuntimeTaskLifecycleStore
    reason: ReconciliationReason | null
    addresses: RuntimeTaskAddress[]
  }>({ store, reason: null, addresses: [] })

  useEffect(() => {
    if (interruptedRecoveryRef.current.store !== store) {
      interruptedRecoveryRef.current = { store, reason: null, addresses: [] }
    }
    const interruptedRecovery = interruptedRecoveryRef.current
    let disposed = false
    const reads = new AbortController()
    let reconciliation: Promise<void> | null = null
    let pendingReason: ReconciliationReason | null = null
    let activeReason: ReconciliationReason | null = null
    let recoveringAddresses: RuntimeTaskAddress[] = []
    const replacedAddresses = interruptedRecovery.addresses.splice(0)
    const diagnose = (stage: string, details: Record<string, unknown> = {}) => {
      if (import.meta.env.VITE_WEWORK_E2E === 'true') {
        logRuntimeTaskCreateStage('lifecycle-reconciliation', { phase: stage, ...details }, 'debug')
      }
    }
    diagnose('subscribed')

    const reconcileRuntimeGoal = async (
      address: RuntimeTaskAddress,
      reason: ReconciliationReason
    ) => {
      const getRuntimeGoal = executorClient.runtime.getRuntimeGoal
      if (typeof getRuntimeGoal !== 'function') return
      const snapshotVersion = beginRuntimeGoalSnapshot(address)
      try {
        const response = await getRuntimeGoal({ address })
        if (
          disposed ||
          !response.accepted ||
          !isRuntimeGoalSnapshotCurrent(address, snapshotVersion)
        ) {
          return
        }
        const goal = response.goal ?? null
        syncRuntimeGoal(store, address, goal)
      } catch (error) {
        console.warn('[Wework] Runtime Goal reconciliation failed', {
          reason,
          deviceId: address.deviceId,
          taskId: address.taskId,
          error,
        })
      }
    }

    const runReconciliation = async (initialReason: ReconciliationReason) => {
      let reason: typeof pendingReason = initialReason
      while (!disposed && reason) {
        const reconciliationReason = reason
        activeReason = reason
        pendingReason = null
        try {
          const recoveryAddresses = runtimeRecoveryAddresses(store, replacedAddresses.splice(0))
          recoveringAddresses = recoveryAddresses
          diagnose('list-start', {
            reason,
            taskIds: recoveryAddresses.map(address => address.taskId),
          })
          const runtimeWork = await executorClient.runtime.listRuntimeWork()
          diagnose('list-resolved', { reason, disposed })
          if (!disposed) {
            store.syncRuntimeWork(runtimeWork)
            const addresses = runtimeRecoveryAddresses(store, recoveryAddresses)
            recoveringAddresses = addresses
            let nextAddress = 0
            const recoverNext = async () => {
              while (!disposed && nextAddress < addresses.length) {
                const address = addresses[nextAddress++]
                try {
                  const queriedClientUserMessageIds = getRuntimeConversationQueuedMessages(address)
                    .filter(message => message.status === 'sending')
                    .map(message => message.id)
                  diagnose('transcript-start', {
                    reason,
                    taskId: address.taskId,
                    receiptCount: queriedClientUserMessageIds.length,
                  })
                  const transcript = await synchronizeRuntimeConversation(
                    (request, options) =>
                      executorClient.runtime.getRuntimeTranscript(request, options),
                    address,
                    {
                      limit: RECOVERY_PAGE_SIZE,
                      signal: reads.signal,
                      ...(queriedClientUserMessageIds.length
                        ? { reconcileClientUserMessageIds: queriedClientUserMessageIds }
                        : {}),
                    }
                  )
                  if (disposed) return
                  const turns = transcript.turns
                  store.syncTranscript(address, transcript)
                  if (queriedClientUserMessageIds.length) {
                    const acceptedClientUserMessageIds = transcript.acceptedClientUserMessageIds
                    const queried = new Set(queriedClientUserMessageIds)
                    const receiptsValid =
                      Array.isArray(acceptedClientUserMessageIds) &&
                      acceptedClientUserMessageIds.every(id => queried.has(id))
                    if (receiptsValid) {
                      reconcileRuntimeConversationQueueAfterTransportReplacement(address, turns, {
                        acceptedClientUserMessageIds,
                      })
                    }
                    const unconfirmed = getRuntimeConversationQueuedMessages(address).filter(
                      message => message.status === 'sending' && queried.has(message.id)
                    )
                    if (!receiptsValid || unconfirmed.length) {
                      console.warn('[Wework] Runtime message receipt confirmation unavailable', {
                        taskId: address.taskId,
                        reason: 'Incomplete acceptance evidence; pending sends remain unconfirmed',
                        pendingCount: unconfirmed.length,
                      })
                    }
                  }
                  await reconcileRuntimeGoal(address, reconciliationReason)
                } catch (error) {
                  if (disposed) return
                  console.warn('[Wework] Runtime transcript reconciliation failed', {
                    reason,
                    deviceId: address.deviceId,
                    taskId: address.taskId,
                    error,
                  })
                }
              }
            }
            await Promise.all(
              Array.from({ length: Math.min(RECOVERY_CONCURRENCY, addresses.length) }, recoverNext)
            )
          }
        } catch (error) {
          console.warn('[Wework] Runtime task lifecycle reconciliation failed', {
            reason,
            error,
          })
        }
        reason = pendingReason
      }
      activeReason = null
    }

    const reconcile = (reason: ReconciliationReason) => {
      diagnose('requested', { reason, disposed, alreadyRunning: Boolean(reconciliation) })
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
      payload: LifecycleEventPayload,
      outcome: 'succeeded' | 'failed' | 'cancelled'
    ): { address: RuntimeTaskAddress; settled: boolean; terminalTurnId: string | null } | null => {
      const address = matchingLifecycleAddress(store, payload)
      if (!address) return null
      if (payload.task) store.syncRuntimeTask(address, payload.task)
      const terminalTurnId = payload.subtaskId?.trim() || null
      const activeTurnId = store.getTask(address)?.turn.id
      if (terminalTurnId && activeTurnId && terminalTurnId !== activeTurnId) {
        return { address, settled: false, terminalTurnId }
      }
      store.turnSettled(address, terminalTurnId, outcome)
      return { address, settled: true, terminalTurnId }
    }

    const reconcileTerminalTranscript = async (
      address: RuntimeTaskAddress,
      outcome?: 'succeeded' | 'failed' | 'cancelled',
      terminalTurnId?: string | null,
      hasAuthoritativeTask = false
    ) => {
      const expectedSnapshot = store.getTask(address)
      // Execution ownership is independent of the turn body and may outlive a Goal turn.
      // Confirm it through the owning executor without waiting for history projection.
      const getTask = executorClient.runtime.getRuntimeTask
      if (getTask && (!hasAuthoritativeTask || expectedSnapshot?.execution.running)) {
        void getTask(address, { signal: reads.signal })
          .then(task => {
            if (
              !disposed &&
              task &&
              !didStartNewerTurn(expectedSnapshot, store.getTask(address), terminalTurnId)
            ) {
              store.syncRuntimeTask(address, task, expectedSnapshot)
            }
          })
          .catch(error => {
            if (!disposed)
              console.warn('[Wework] Runtime terminal task lookup failed', {
                taskId: address.taskId,
                error,
              })
          })
      }
      // Complete live content and an authoritative task snapshot need no history repair.
      const terminal = getRuntimeConversationTurns(address).find(turn => turn.id === terminalTurnId)
      if (
        hasAuthoritativeTask &&
        terminal &&
        ['done', 'completed', 'failed', 'cancelled'].includes(terminal.status)
      )
        return
      try {
        const transcript = await synchronizeRuntimeConversation(
          (request, options) => executorClient.runtime.getRuntimeTranscript(request, options),
          address,
          {
            limit: RECOVERY_PAGE_SIZE,
            signal: reads.signal,
          }
        )
        if (disposed) return
        const currentSnapshot = store.getTask(address)
        if (
          didStartNewerTurn(expectedSnapshot, currentSnapshot, terminalTurnId) ||
          (currentSnapshot?.turn.active &&
            terminalTurnId &&
            store.isPriorTurn(address, terminalTurnId))
        ) {
          return
        }
        store.syncTranscript(address, transcript)
        if (outcome && isRuntimePaneTranscriptConfirmedIdle(transcript)) {
          store.turnSettled(address, null, outcome)
        }
      } catch (error) {
        if (disposed) return
        console.warn('[Wework] Runtime terminal transcript reconciliation failed', {
          deviceId: address.deviceId,
          taskId: address.taskId,
          error,
        })
      }
    }

    const unsubscribe = services.chatStream.subscribe({
      onRuntimeTurnUpdated: payload => {
        const address = matchingLifecycleAddress(store, payload)
        if (address && payload.task) store.syncRuntimeTask(address, payload.task)
      },
      onChatStart: payload => {
        const address = matchingLifecycleAddress(store, payload)
        if (!address) return
        if (payload.task) store.syncRuntimeTask(address, payload.task)
        store.turnStarted(address, payload.subtaskId?.trim() || null)
      },
      onBlockCreated: payload => {
        const request = pendingRequestUserInputBlockPayload(payload)
        if (!request) return
        const address = matchingLifecycleAddress(store, payload)
        if (!address) return
        store.userInputRequested(
          address,
          isAsyncRequestUserInputPayload(request) ? 'async' : undefined
        )
      },
      onChatDone: payload => {
        const match = settleMatchingTask(payload, 'succeeded')
        if (match) {
          void reconcileTerminalTranscript(
            match.address,
            'succeeded',
            match.terminalTurnId,
            Boolean(payload.task)
          )
        }
      },
      onChatError: payload => {
        const match = settleMatchingTask(
          payload,
          isCancelledTerminalEvent(payload) ? 'cancelled' : 'failed'
        )
        if (match) {
          void reconcileTerminalTranscript(
            match.address,
            isCancelledTerminalEvent(payload) ? 'cancelled' : 'failed',
            match.terminalTurnId,
            Boolean(payload.task)
          )
        }
      },
      onRuntimeEventLagged: payload => {
        console.warn('[Wework] Runtime event stream lagged; reconciling task state', payload)
        reconcile('event_lagged')
      },
      onRuntimeTransportReplaced: () => {
        replacedAddresses.push(...store.invalidateNativeExecutions())
        reconcile('runtime_replaced')
      },
    })

    if (interruptedRecovery.reason) {
      const reason = interruptedRecovery.reason
      interruptedRecovery.reason = null
      reconcile(reason)
    }

    return () => {
      diagnose('disposed', { reconciliationPending: Boolean(reconciliation), pendingReason })
      if (activeReason || pendingReason) {
        interruptedRecovery.reason = pendingReason ?? activeReason
        interruptedRecovery.addresses = [...recoveringAddresses, ...replacedAddresses]
      }
      disposed = true
      reads.abort()
      unsubscribeSystemResume()
      unsubscribe()
    }
  }, [executorClient, recoverRuntimeConnections, services.chatStream, store])

  return null
}

function didStartNewerTurn(
  expected: ReturnType<RuntimeTaskLifecycleStore['getTask']>,
  current: ReturnType<RuntimeTaskLifecycleStore['getTask']>,
  terminalTurnId: string | null | undefined
): boolean {
  // A newly submitted action is active before its first stream event arrives.
  if (!current || !current.turn.active) return false
  if (terminalTurnId && current.turn.id === terminalTurnId) return false
  return expected?.turn.phase !== current.turn.phase || expected.turn.id !== current.turn.id
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
