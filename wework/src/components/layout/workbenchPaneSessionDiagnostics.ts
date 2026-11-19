import { logRuntimeTaskCreateStage } from '@/lib/runtime-create-diagnostics'
import {
  DEBUG_SNAPSHOT_INTERVAL_MS,
  compareMessageStyles,
  summarizeRuntimePaneMemory,
  summarizeMessages,
  updateRuntimePaneDebugSnapshot,
} from '@/lib/debugPanel'
import { getRuntimeConversationQueueDiagnosticSnapshotByKey } from '@/features/workbench/runtimeConversationCache'
import type { PaneSessionFrame } from './workbenchPaneSessionFrame'

export function createPaneSessionDiagnostics(owner: {
  readFrame(): PaneSessionFrame
  isActive(): boolean
}) {
  let timer: ReturnType<typeof setTimeout> | undefined
  let waitingSignature: string | null = null
  let queueSignature: string | null = null
  let attached: { key: string; paneSessionId: string } | null = null
  const logQueue = (stage: string, scope: NonNullable<typeof attached>) => {
    logRuntimeTaskCreateStage(stage, {
      conversationKey: scope.key,
      paneSessionId: scope.paneSessionId,
      ...getRuntimeConversationQueueDiagnosticSnapshotByKey(scope.key),
    })
  }
  const clearTimer = () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }
  const publishDebugSnapshot = () => {
    timer = undefined
    if (!owner.isActive()) return
    const frame = owner.readFrame()
    if (!frame.debugSnapshotEnabled) return
    updateRuntimePaneDebugSnapshot(
      {
        currentRuntimeTask: frame.currentRuntimeTask,
        status: frame.paneStatus,
        messageSummary: summarizeMessages(frame.messages),
        messageStyleComparison: compareMessageStyles(frame.messages),
        memory: summarizeRuntimePaneMemory({
          messages: frame.messages,
          currentRuntimeTask: frame.currentRuntimeTask,
          loadedRanges: frame.loadedTranscriptRanges,
        }),
        queuedMessages: frame.queuedMessages,
        guidanceMessages: frame.guidanceMessages,
        codeCommentContextCount: frame.codeCommentContexts.length,
        inputLength: frame.input.length,
        transcript: {
          loading: frame.transcriptLoading,
          hasMoreBefore: frame.transcriptHasMoreBefore,
          loadingMoreBefore: frame.transcriptLoadingMoreBefore,
          beforeCursor: frame.transcriptBeforeCursor,
          turnNavigationCount: frame.turnNavigation.length,
          loadedRanges: frame.loadedTranscriptRanges,
        },
        subagentStatuses: frame.subagentStatuses,
        goal: frame.goal,
        goalDraftActive: frame.goalDraftActive,
      },
      { enabled: frame.debugSnapshotEnabled }
    )
  }
  return {
    observe(frame: PaneSessionFrame) {
      if (!owner.isActive()) return
      if (frame.diagnosticTaskId) {
        const details = {
          taskId: frame.diagnosticTaskId,
          deviceId: frame.diagnosticDeviceId,
          sendPhase: frame.paneStatus.sendPhase,
          running: frame.paneStatus.taskExecution.running,
          waiting: frame.paneStatus.isWaitingForAssistantIndicator,
          hasActiveAssistant: frame.diagnosticHasActiveAssistant,
        }
        const signature = JSON.stringify(details)
        if (signature !== waitingSignature) {
          waitingSignature = signature
          logRuntimeTaskCreateStage('pane-waiting-state', details)
        }
      } else waitingSignature = null
      if (attached?.key !== frame.queuedMessageScopeKey) {
        if (attached) logQueue('queue-pane-detached', attached)
        attached = frame.queuedMessageScopeKey
          ? { key: frame.queuedMessageScopeKey, paneSessionId: frame.queueDiagnosticSessionId }
          : null
        queueSignature = null
        if (attached) logQueue('queue-pane-attached', attached)
      }
      if (attached) {
        const queue = getRuntimeConversationQueueDiagnosticSnapshotByKey(attached.key)
        if (queue.queueLength > 0 || queueSignature !== null) {
          const details = {
            conversationKey: attached.key,
            paneSessionId: attached.paneSessionId,
            ...queue,
            canSendQueuedMessage: frame.paneStatus.canSendQueuedMessage,
            continuable: frame.paneStatus.taskExecution.continuable,
            responseActive: frame.paneStatus.isResponseActive,
            executionPhase: frame.taskLifecycle?.execution.phase ?? null,
            turnPhase: frame.taskLifecycle?.turn.phase ?? null,
            turnId: frame.taskLifecycle?.turn.id ?? null,
            busyBlockedMessageIds: queue.messages
              .filter(message => frame.queuedMessageBusyBlocks.has(message.id))
              .map(message => message.id),
          }
          const signature = JSON.stringify(details)
          if (signature !== queueSignature) {
            queueSignature = queue.queueLength > 0 ? signature : null
            logRuntimeTaskCreateStage('queue-state', details)
          }
        }
      }
      if (!frame.debugSnapshotEnabled) clearTimer()
      else if (timer === undefined)
        timer = setTimeout(publishDebugSnapshot, DEBUG_SNAPSHOT_INTERVAL_MS)
    },
    dispose() {
      clearTimer()
      if (attached) logQueue('queue-pane-detached', attached)
      attached = null
      waitingSignature = null
      queueSignature = null
    },
  }
}
