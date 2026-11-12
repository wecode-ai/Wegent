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

type ReconciliationReason = 'event_lagged' | 'runtime_replaced' | 'system_resume' | 'retry'
const RECOVERY_PAGE_SIZE = 5
const RECOVERY_CONCURRENCY = 2
const RECOVERY_RETRY_DELAY_MS = 1_000
const RECOVERY_MAX_RETRY_DELAY_MS = 30_000
// A missed terminal notification must not leave an active pane streaming forever.
const ACTIVE_TURN_SETTLEMENT_CHECK_MS = 5_000

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
    refreshWorkList: boolean
  }>({ store, reason: null, addresses: [], refreshWorkList: false })

  useEffect(() => {
    if (interruptedRecoveryRef.current.store !== store) {
      interruptedRecoveryRef.current = {
        store,
        reason: null,
        addresses: [],
        refreshWorkList: false,
      }
    }
    const interruptedRecovery = interruptedRecoveryRef.current
    let disposed = false
    const reads = new AbortController()
    let reconciliation: Promise<void> | null = null
    let pendingReason: ReconciliationReason | null = null
    let activeReason: ReconciliationReason | null = null
    let recoveringAddresses: RuntimeTaskAddress[] = []
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    let retryAttempt = 0
    let retryWorkList = interruptedRecovery.refreshWorkList
    let refreshingWorkList = false
    interruptedRecovery.refreshWorkList = false
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
      if (typeof getRuntimeGoal !== 'function') return true
      const snapshotVersion = beginRuntimeGoalSnapshot(address)
      try {
        const response = await getRuntimeGoal({ address })
        if (
          disposed ||
          !response.accepted ||
          !isRuntimeGoalSnapshotCurrent(address, snapshotVersion)
        ) {
          return true
        }
        const goal = response.goal ?? null
        syncRuntimeGoal(store, address, goal)
        return true
      } catch (error) {
        console.warn('[Wework] Runtime Goal reconciliation failed', {
          reason,
          deviceId: address.deviceId,
          taskId: address.taskId,
          error,
        })
        return !isRetryableRecoveryError(error)
      }
    }

    const reconcileRuntimeTask = async (
      address: RuntimeTaskAddress,
      reason: ReconciliationReason
    ): Promise<boolean> => {
      const getTask = executorClient.runtime.getRuntimeTask
      if (!getTask) return true
      const expectedSnapshot = store.getTask(address)
      try {
        const task = await getTask(address, { signal: reads.signal })
        if (!disposed && task) store.syncRuntimeTask(address, task, expectedSnapshot)
        return true
      } catch (error) {
        if (disposed) return true
        console.warn('[Wework] Runtime task reconciliation failed', {
          reason,
          deviceId: address.deviceId,
          taskId: address.taskId,
          error,
        })
        return !isRetryableRecoveryError(error)
      }
    }

    const reconcileRuntimeTranscript = async (
      address: RuntimeTaskAddress,
      reason: ReconciliationReason
    ): Promise<boolean> => {
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
          (request, options) => executorClient.runtime.getRuntimeTranscript(request, options),
          address,
          {
            limit: RECOVERY_PAGE_SIZE,
            signal: reads.signal,
            ...(queriedClientUserMessageIds.length
              ? { reconcileClientUserMessageIds: queriedClientUserMessageIds }
              : {}),
          }
        )
        if (disposed) return true
        store.syncTranscript(address, transcript)
        if (queriedClientUserMessageIds.length) {
          const acceptedClientUserMessageIds = transcript.acceptedClientUserMessageIds
          const queried = new Set(queriedClientUserMessageIds)
          const receiptsValid =
            Array.isArray(acceptedClientUserMessageIds) &&
            acceptedClientUserMessageIds.every(id => queried.has(id))
          if (receiptsValid) {
            reconcileRuntimeConversationQueueAfterTransportReplacement(address, transcript.turns, {
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
        return reconcileRuntimeGoal(address, reason)
      } catch (error) {
        if (disposed) return true
        console.warn('[Wework] Runtime transcript reconciliation failed', {
          reason,
          deviceId: address.deviceId,
          taskId: address.taskId,
          error,
        })
        return !isRetryableRecoveryError(error)
      }
    }

    const runReconciliation = async (initialReason: ReconciliationReason) => {
      let reason: typeof pendingReason = initialReason
      while (!disposed && reason) {
        const reconciliationReason = reason
        activeReason = reason
        pendingReason = null
        const retained = replacedAddresses.splice(0)
        const recoveryAddresses =
          reason === 'retry' ? retained : runtimeRecoveryAddresses(store, retained)
        recoveringAddresses = []
        const visited = new Set(recoveryAddresses.map(runtimeConversationKey))
        const failed: RuntimeTaskAddress[] = []
        const refreshWorkList = reason !== 'retry' || retryWorkList
        retryWorkList = false
        refreshingWorkList = refreshWorkList
        // Catalog reads must not block recovery on another execution device.
        const workList = refreshWorkList
          ? executorClient.runtime
              .listRuntimeWork()
              .then(runtimeWork => {
                if (disposed) return []
                store.syncRuntimeWork(runtimeWork)
                return runtimeRecoveryAddresses(store).filter(
                  address => !visited.has(runtimeConversationKey(address))
                )
              })
              .catch(error => {
                if (!disposed) {
                  retryWorkList = isRetryableRecoveryError(error)
                  console.warn('[Wework] Runtime task lifecycle reconciliation failed', {
                    reason: reconciliationReason,
                    error,
                  })
                }
                return []
              })
              .finally(() => {
                refreshingWorkList = false
              })
          : Promise.resolve([])
        const recoverAddresses = async (addresses: RuntimeTaskAddress[]) => {
          recoveringAddresses.push(...addresses)
          let nextAddress = 0
          const recoverNext = async () => {
            while (!disposed && nextAddress < addresses.length) {
              const address = addresses[nextAddress++]
              const results = await Promise.all([
                reconcileRuntimeTask(address, reconciliationReason),
                reconcileRuntimeTranscript(address, reconciliationReason),
              ])
              if (results.includes(false)) failed.push(address)
            }
          }
          await Promise.all(
            Array.from({ length: Math.min(RECOVERY_CONCURRENCY, addresses.length) }, recoverNext)
          )
        }
        await recoverAddresses(recoveryAddresses)
        await recoverAddresses(await workList)
        recoveringAddresses = []
        if (!disposed && (failed.length || retryWorkList)) {
          replacedAddresses.push(...failed)
          if (!pendingReason) {
            const delay = Math.min(
              RECOVERY_RETRY_DELAY_MS * 2 ** Math.min(retryAttempt++, 5),
              RECOVERY_MAX_RETRY_DELAY_MS
            )
            retryTimer = setTimeout(() => {
              retryTimer = null
              reconcile('retry')
            }, delay)
          }
        } else {
          retryAttempt = 0
        }
        reason = pendingReason
      }
      activeReason = null
    }

    const reconcile = (reason: ReconciliationReason) => {
      diagnose('requested', { reason, disposed, alreadyRunning: Boolean(reconciliation) })
      if (disposed) return
      if (retryTimer !== null) {
        clearTimeout(retryTimer)
        retryTimer = null
      }
      if (reconciliation) {
        pendingReason = reason
        return
      }
      reconciliation = runReconciliation(reason).finally(() => {
        reconciliation = null
        if (!disposed && pendingReason) reconcile(pendingReason)
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
      const terminalTurnId = payload.subtaskId?.trim() || null
      const currentTurnId = store.getTask(address)?.turn.id
      const terminalTurnIsPrior = Boolean(
        terminalTurnId &&
        currentTurnId &&
        terminalTurnId !== currentTurnId &&
        store.isPriorTurn(address, terminalTurnId)
      )
      if (payload.task && !terminalTurnIsPrior) store.syncRuntimeTask(address, payload.task)
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
      const terminalTurnIsPrior = Boolean(
        terminalTurnId && store.isPriorTurn(address, terminalTurnId)
      )
      // Execution ownership is independent of the turn body and may outlive a Goal turn.
      // Confirm it through the owning executor without waiting for history projection.
      const getTask = executorClient.runtime.getRuntimeTask
      if (
        getTask &&
        !terminalTurnIsPrior &&
        (!hasAuthoritativeTask || expectedSnapshot?.execution.running)
      ) {
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
      // A cached terminal snapshot can predate the native completion. Only skip
      // history repair when its outcome agrees with the authoritative event.
      const terminal = getRuntimeConversationTurns(address).find(turn => turn.id === terminalTurnId)
      if (
        hasAuthoritativeTask &&
        terminal &&
        (outcome === 'succeeded'
          ? ['done', 'completed'].includes(terminal.status)
          : terminal.status === outcome)
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

    const settlementChecks = new Map<string, ReturnType<typeof setTimeout>>()
    const checkingSettlements = new Set<string>()
    const clearSettlementCheck = (address: RuntimeTaskAddress) => {
      const key = runtimeConversationKey(address)
      const timer = settlementChecks.get(key)
      if (timer === undefined) return
      clearTimeout(timer)
      settlementChecks.delete(key)
    }
    const watchActiveTurnSettlement = (address: RuntimeTaskAddress) => {
      if (disposed) return
      const getTask = executorClient.runtime.getRuntimeTask
      if (!getTask) return
      const key = runtimeConversationKey(address)
      if (settlementChecks.has(key) || checkingSettlements.has(key)) return

      const check = async () => {
        settlementChecks.delete(key)
        if (disposed) return
        checkingSettlements.add(key)
        const expected = store.getTask(address)
        try {
          if (!expected?.turn.active) return
          const activeTurnId = expected.turn.id
          const task = await getTask(address, { signal: reads.signal })
          if (disposed) return
          if (task) store.syncRuntimeTask(address, task, expected)
          const current = store.getTask(address)
          if (current?.turn.active) return
          const terminalTurnId = task?.executionState?.latestTurnId ?? activeTurnId
          if (!terminalTurnId) return
          const outcome = task?.executionState?.outcome ?? task?.executionState?.executionOutcome
          if (outcome) {
            await reconcileTerminalTranscript(address, outcome, terminalTurnId, true)
          }
        } catch (error) {
          if (disposed) return
          console.warn('[Wework] Runtime turn settlement check failed', {
            deviceId: address.deviceId,
            taskId: address.taskId,
            error,
          })
        } finally {
          checkingSettlements.delete(key)
          if (!disposed && store.getTask(address)?.turn.active) {
            watchActiveTurnSettlement(address)
          }
        }
      }

      settlementChecks.set(
        key,
        setTimeout(() => {
          void check()
        }, ACTIVE_TURN_SETTLEMENT_CHECK_MS)
      )
    }

    // Restored active turns may not replay a start event after a renderer reload.
    const refreshActiveSettlementChecks = () => {
      if (disposed) return
      const activeKeys = new Set<string>()
      for (const lifecycle of store.getSnapshot().tasks.values()) {
        if (!lifecycle?.turn.active) continue
        const key = runtimeConversationKey(lifecycle.address)
        activeKeys.add(key)
        watchActiveTurnSettlement(lifecycle.address)
      }
      for (const [key, timer] of settlementChecks) {
        if (activeKeys.has(key)) continue
        clearTimeout(timer)
        settlementChecks.delete(key)
      }
    }
    const unsubscribeStore = store.subscribe(refreshActiveSettlementChecks)
    refreshActiveSettlementChecks()

    const unsubscribe = services.chatStream.subscribe({
      onRuntimeTurnUpdated: payload => {
        const address = matchingLifecycleAddress(store, payload)
        if (address && payload.task) store.syncRuntimeTask(address, payload.task)
        if (address && payload.status === 'started') watchActiveTurnSettlement(address)
      },
      onChatStart: payload => {
        const address = matchingLifecycleAddress(store, payload)
        if (!address) return
        if (payload.task) store.syncRuntimeTask(address, payload.task)
        store.turnStarted(address, payload.subtaskId?.trim() || null)
        watchActiveTurnSettlement(address)
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
        if (!match) return
        if (match.settled) clearSettlementCheck(match.address)
        void reconcileTerminalTranscript(
          match.address,
          'succeeded',
          match.terminalTurnId,
          Boolean(payload.task)
        )
      },
      onChatError: payload => {
        const match = settleMatchingTask(
          payload,
          isCancelledTerminalEvent(payload) ? 'cancelled' : 'failed'
        )
        if (!match) return
        if (match.settled) clearSettlementCheck(match.address)
        void reconcileTerminalTranscript(
          match.address,
          isCancelledTerminalEvent(payload) ? 'cancelled' : 'failed',
          match.terminalTurnId,
          Boolean(payload.task)
        )
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
      if (activeReason || pendingReason || retryTimer !== null) {
        interruptedRecovery.reason = pendingReason ?? activeReason ?? 'retry'
        interruptedRecovery.addresses = [...recoveringAddresses, ...replacedAddresses]
        interruptedRecovery.refreshWorkList = retryWorkList || refreshingWorkList
      }
      disposed = true
      if (retryTimer !== null) clearTimeout(retryTimer)
      for (const timer of settlementChecks.values()) clearTimeout(timer)
      settlementChecks.clear()
      checkingSettlements.clear()
      reads.abort()
      unsubscribeStore()
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

function isRetryableRecoveryError(error: unknown): boolean {
  return !(error && typeof error === 'object' && 'retryable' in error && error.retryable === false)
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
