import type { TFunction } from 'i18next'
import type { ExecutorClient } from '@/api/executorAccess'
import type { WorkbenchSession } from './workbenchSession'
import type { WorkbenchSessionState } from './workbenchSessionState'
import type { WorkbenchSessionOperations } from './workbenchSessionOperations'
import type { useWorkbenchDataRefresh } from './useWorkbenchDataRefresh'
import type { useWorkbenchRuntimeTasks } from './useWorkbenchRuntimeTasks'
import type { useWorkbenchRuntimeMessaging } from './useWorkbenchRuntimeMessaging'
import type { useResolveRuntimeContextUsage } from './useWorkbenchContextCallbacks'
import type {
  RuntimeTaskAddress,
  RuntimeContextUsage,
  RuntimeTaskQueueReorderRequest,
} from '@/types/api'
import {
  applyRuntimeConversationAction,
  settleRuntimeConversationGuidance,
  runtimeConversationKey,
  reconcileRuntimeConversationSnapshot,
  beginRuntimeGoalSnapshot,
  getRuntimeConversationMetadata,
  getRuntimeConversationMessages,
  getRuntimeConversationQueuedMessages,
  isRuntimeGoalSnapshotCurrent,
} from './runtimeConversationCache'
import { syncRuntimeGoal } from './runtimeTaskLifecycle/goalSynchronization'
import { getRuntimeConversationQueueController } from './runtimeConversationQueueController'
import {
  logRuntimeQueueStage,
  runtimeMessagePresentationDiagnostic,
} from './runtimeQueueDiagnostics'
import { notifyMainRuntimeWorkChanged } from '@/desktop/runtimeWorkSync'
import { recordPluginUsageFromInput } from '@/features/plugins/pluginTrial'
const RUNTIME_TASK_SETTLE_SYNC_DELAYS_MS = [0, 250, 500, 1000, 2000, 3000] as const
interface Input {
  session: WorkbenchSession
  stateSource: WorkbenchSessionState
  runtimeTasks: ReturnType<typeof useWorkbenchRuntimeTasks>
  runtimeMessaging: ReturnType<typeof useWorkbenchRuntimeMessaging>
  resolveRuntimeContextUsage: ReturnType<typeof useResolveRuntimeContextUsage>
  executorClient: ExecutorClient
  t: TFunction<'common'>
  refreshRuntimeTask: ReturnType<typeof useWorkbenchDataRefresh>['refreshRuntimeTask']
  updateLocalRuntimeTaskSnapshot: ReturnType<
    typeof useWorkbenchDataRefresh
  >['updateLocalRuntimeTaskSnapshot']
  refreshWorkLists: ReturnType<typeof useWorkbenchDataRefresh>['refreshWorkLists']
  refreshDevices: ReturnType<typeof useWorkbenchDataRefresh>['refreshDevices']
  draftStore: import('./scopedDraftStore').ScopedDraftStore
  projectChatScopeKey: string
}
export function createWorkbenchRuntimeOperations({
  session,
  stateSource,
  runtimeTasks,
  runtimeMessaging,
  resolveRuntimeContextUsage,
  executorClient,
  t,
  refreshRuntimeTask,
  updateLocalRuntimeTaskSnapshot,
  refreshWorkLists,
  refreshDevices,
  draftStore,
  projectChatScopeKey,
}: Input): Pick<
  WorkbenchSessionOperations,
  | 'refreshDevicesAfterRestart'
  | 'stableLoadRuntimeTranscriptForPane'
  | 'stableSubscribeRuntimeTaskStream'
  | 'applyCanonicalRuntimeAction'
  | 'settleCanonicalRuntimeGuidance'
  | 'syncRuntimeTaskSnapshot'
  | 'syncRuntimeTaskUntilExecutorSettles'
  | 'syncRuntimeGoalSnapshot'
  | 'updateCanonicalRuntimeContextUsage'
  | 'stableCancelRuntimeTask'
  | 'stableForceStartRuntimeTask'
  | 'stableReorderQueuedRuntimeTask'
  | 'stableSendCurrentInput'
> {
  const { lifecycleStore, setContextUsageByRuntimeTask } = stateSource
  const {
    runtimeTaskSettleSyncActiveRef,
    runtimeTaskSettleSyncGenerationCounterRef,
    runtimeTaskSettleSyncGenerationRef,
  } = stateSource.resources
  return {
    refreshDevicesAfterRestart: () => refreshDevices({ useCacheFallback: false }),
    stableLoadRuntimeTranscriptForPane: async (
      address: RuntimeTaskAddress,
      options?: Parameters<typeof runtimeTasks.loadRuntimeTranscriptForPane>[1]
    ) => {
      const transcript = await runtimeTasks.loadRuntimeTranscriptForPane(address, options)
      if (!options?.threadOnly && transcript.contextUsage) {
        const contextUsage = resolveRuntimeContextUsage(address, transcript.contextUsage)
        setContextUsageByRuntimeTask(current => ({
          ...current,
          [runtimeConversationKey(address)]: contextUsage,
        }))
      }
      return transcript
    },
    stableSubscribeRuntimeTaskStream: (
      address: RuntimeTaskAddress,
      handlers: Parameters<typeof runtimeTasks.subscribeRuntimeTaskStream>[1]
    ) =>
      runtimeTasks.subscribeRuntimeTaskStream(address, {
        ...handlers,
        onContextUsageUpdated: usage => {
          const contextUsage = resolveRuntimeContextUsage(address, usage)
          setContextUsageByRuntimeTask(current => ({
            ...current,
            [runtimeConversationKey(address)]: contextUsage,
          }))
          handlers.onContextUsageUpdated?.(contextUsage)
        },
      }),
    applyCanonicalRuntimeAction: (
      address: RuntimeTaskAddress,
      action: Parameters<typeof applyRuntimeConversationAction>[1]
    ) => {
      applyRuntimeConversationAction(address, action)
    },
    settleCanonicalRuntimeGuidance: (
      address: RuntimeTaskAddress,
      payload: Parameters<typeof settleRuntimeConversationGuidance>[1]
    ) => {
      const queued = getRuntimeConversationQueuedMessages(address).find(
        message => message.id === payload.clientGuidanceId
      )
      const previous = getRuntimeConversationMessages(address).find(
        message => message.id === payload.clientGuidanceId
      )
      const settled = settleRuntimeConversationGuidance(address, payload)
      logRuntimeQueueStage(address, 'guidance-applied-presentation', {
        messageId: payload.clientGuidanceId ?? null,
        turnId: payload.subtaskId ?? null,
        queuedMessagePresent: Boolean(queued),
        previousMessagePresent: Boolean(previous),
        payload: runtimeMessagePresentationDiagnostic(payload.message),
        queued: runtimeMessagePresentationDiagnostic(queued?.content),
        previous: runtimeMessagePresentationDiagnostic(previous?.content),
        settled: runtimeMessagePresentationDiagnostic(settled?.content),
        queuedAttachmentCount: queued?.attachments?.length ?? 0,
        settledAttachmentCount: settled?.attachments?.length ?? 0,
      })
      return settled
    },
    syncRuntimeTaskSnapshot: (address: RuntimeTaskAddress) => {
      const expectedLifecycle = lifecycleStore.getTask(address)
      void refreshRuntimeTask(address)
        .then(task => {
          if (task && lifecycleStore.syncRuntimeTask(address, task, expectedLifecycle)) {
            updateLocalRuntimeTaskSnapshot(address, task)
          }
        })
        .catch(error => {
          console.warn('[Wework] Runtime task snapshot sync failed', {
            deviceId: address.deviceId,
            taskId: address.taskId,
            error,
          })
        })
    },
    syncRuntimeTaskUntilExecutorSettles: async (address: RuntimeTaskAddress) => {
      if (!runtimeTaskSettleSyncActiveRef.current) return
      const key = runtimeConversationKey(address)
      const generation = ++runtimeTaskSettleSyncGenerationCounterRef.current
      runtimeTaskSettleSyncGenerationRef.current.set(key, generation)

      try {
        for (const delayMs of RUNTIME_TASK_SETTLE_SYNC_DELAYS_MS) {
          if (delayMs > 0) {
            await new Promise(resolve => globalThis.setTimeout(resolve, delayMs))
          }
          if (!runtimeTaskSettleSyncActiveRef.current) return
          if (
            !runtimeTaskSettleSyncActiveRef.current ||
            runtimeTaskSettleSyncGenerationRef.current.get(key) !== generation
          )
            return

          const expectedLifecycle = lifecycleStore.getTask(address)
          if (expectedLifecycle?.turn.phase === 'streaming') return

          try {
            const task = await refreshRuntimeTask(address)
            if (
              !runtimeTaskSettleSyncActiveRef.current ||
              runtimeTaskSettleSyncGenerationRef.current.get(key) !== generation
            )
              return
            if (!task) {
              const transcript = await runtimeTasks.loadRuntimeTranscriptForPane(address, {
                refresh: true,
              })
              if (
                !runtimeTaskSettleSyncActiveRef.current ||
                runtimeTaskSettleSyncGenerationRef.current.get(key) !== generation
              )
                return
              reconcileRuntimeConversationSnapshot(address, transcript.turns)
              lifecycleStore.syncTranscript(address, transcript)
              if (lifecycleStore.getTask(address)?.execution.phase === 'idle') return
              continue
            }
            const applied = lifecycleStore.syncRuntimeTask(address, task, expectedLifecycle)
            if (applied) updateLocalRuntimeTaskSnapshot(address, task)

            const currentLifecycle = lifecycleStore.getTask(address)
            if (
              currentLifecycle?.execution.phase === 'idle' ||
              currentLifecycle?.turn.phase === 'streaming'
            ) {
              return
            }
          } catch (error) {
            console.warn('[Wework] Runtime task settle snapshot sync failed', {
              deviceId: address.deviceId,
              taskId: address.taskId,
              delayMs,
              error,
            })
          }
        }

        const lifecycle = lifecycleStore.getTask(address)
        console.warn('[Wework] Runtime task remained busy after turn settlement polling', {
          deviceId: address.deviceId,
          taskId: address.taskId,
          executionPhase: lifecycle?.execution.phase ?? null,
          turnPhase: lifecycle?.turn.phase ?? null,
          executorSnapshotRunning: lifecycle?.task?.running ?? null,
        })
      } finally {
        if (runtimeTaskSettleSyncGenerationRef.current.get(key) === generation) {
          runtimeTaskSettleSyncGenerationRef.current.delete(key)
        }
      }
    },
    syncRuntimeGoalSnapshot: (address: RuntimeTaskAddress) => {
      const expectedGoalStatus = lifecycleStore.getTask(address)?.goalStatus
      const conversationGoal = getRuntimeConversationMetadata(address).goal
      if (
        (expectedGoalStatus === null || expectedGoalStatus === undefined) &&
        conversationGoal === null
      ) {
        return
      }

      const snapshotVersion = beginRuntimeGoalSnapshot(address)
      void runtimeTasks
        .getRuntimeGoal(address)
        .then(response => {
          if (
            !session.isHeld() ||
            !response.accepted ||
            !isRuntimeGoalSnapshotCurrent(address, snapshotVersion)
          )
            return
          const goal = response.goal ?? null
          syncRuntimeGoal(lifecycleStore, address, goal)
        })
        .catch(error => {
          console.warn('[Wework] Runtime Goal snapshot sync failed', {
            deviceId: address.deviceId,
            taskId: address.taskId,
            error,
          })
        })
    },
    updateCanonicalRuntimeContextUsage: (
      address: RuntimeTaskAddress,
      usage: RuntimeContextUsage
    ) => {
      const currentTask = stateSource.getSnapshot().state.currentRuntimeTask
      const currentAddress =
        currentTask?.deviceId === address.deviceId && currentTask.taskId === address.taskId
          ? currentTask
          : address
      const contextUsage = resolveRuntimeContextUsage(currentAddress, usage)
      setContextUsageByRuntimeTask(current => ({
        ...current,
        [runtimeConversationKey(address)]: contextUsage,
      }))
    },
    stableCancelRuntimeTask: async (address: RuntimeTaskAddress) => {
      logRuntimeQueueStage(address, 'queue-stop-requested', { source: 'execution-action' })
      const restoreQueue = getRuntimeConversationQueueController(address).pauseForCancellation()
      let accepted: boolean | null = null
      try {
        const response = await executorClient.runtime.cancelRuntimeTask(address)
        accepted = response.accepted
        if (!response.accepted) {
          throw new Error(response.error || t('workbench.runtime_task_cancel_failed'))
        }
        await notifyMainRuntimeWorkChanged(address)
        await refreshWorkLists()
      } catch (error) {
        if (accepted !== true) restoreQueue()
        throw error
      } finally {
        logRuntimeQueueStage(address, 'queue-stop-result', {
          source: 'execution-action',
          accepted,
        })
      }
    },
    stableForceStartRuntimeTask: async (address: RuntimeTaskAddress) => {
      const response = await executorClient.runtime.forceStartRuntimeTask(address)
      if (!response.accepted) {
        throw new Error(response.error || t('workbench.runtime_task_force_start_failed'))
      }
      await notifyMainRuntimeWorkChanged(address)
      await refreshWorkLists()
    },
    stableReorderQueuedRuntimeTask: async (data: RuntimeTaskQueueReorderRequest) => {
      const response = await executorClient.runtime.reorderQueuedRuntimeTask(data)
      if (!response.accepted) {
        throw new Error(response.error || t('workbench.runtime_task_queue_reorder_failed'))
      }
      await notifyMainRuntimeWorkChanged(data)
      await refreshWorkLists()
    },
    stableSendCurrentInput: async (
      inputOverride?: string,
      options?: Parameters<typeof runtimeMessaging.sendCurrentInput>[1]
    ) => {
      const submittedInput = inputOverride ?? draftStore.read(projectChatScopeKey).value
      const sent = await runtimeMessaging.sendCurrentInput(submittedInput, options)
      if (sent) {
        recordPluginUsageFromInput(submittedInput)
      }
      return sent
    },
  }
}
