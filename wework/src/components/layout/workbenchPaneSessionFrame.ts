import type { useTranslation } from '@/hooks/useTranslation'
import {
  findWorkbenchDevice,
  getWorkbenchDeviceUnavailableDisplayName,
} from '@/lib/workbench-device'
import { useWorkbenchPaneContext } from '@/features/workbench/useWorkbench'
import { useScopedComposerAttachments } from '@/features/workbench/useScopedComposerAttachments'

import {
  deriveRuntimePaneStatus,
  resolveRuntimePaneLifecycleAddress,
} from '@/features/workbench/runtimePaneStatus'
import {
  type RuntimeTaskLifecycleSnapshot,
  useRuntimeTaskLifecycleStore,
} from '@/features/workbench/runtimeTaskLifecycle'

import { findRuntimeTask } from '@/features/workbench/workbenchRuntimeHelpers'
import { getRuntimeTaskChatScopeKey } from '@/features/workbench/workbenchProviderHelpers'

import { projectRuntimeGoalContinuing, visibleRuntimeGoal } from '@/lib/runtime-goal'

import type { RuntimeGoal, RuntimeTaskAddress } from '@/types/api'

import {
  getRuntimeConversationMetadata,
  getRuntimeConversationQueuedMessagesByKey,
  getRuntimeConversationQueuePausedByKey,
  isRuntimeConversationArchived,
  runtimeConversationKey,
} from '@/features/workbench/runtimeConversationCache'

import { getRuntimeConversationQueueController } from '@/features/workbench/runtimeConversationQueueController'

import {
  EMPTY_PANE_GUIDANCE_MESSAGES,
  resolveRuntimeTranscriptPageSize,
  runtimeTaskLoadTargetFromAddress,
  isPendingGoalVisibleForRuntimeTarget,
  isUnboundPendingGoalState,
} from './workbenchPaneSessionHelpers'

import type { PaneSessionState } from './workbenchPaneSessionState'
import type { RuntimeTranscriptLoader } from '@/types/workbench'
import {
  EMPTY_RUNTIME_CONVERSATION_SNAPSHOT,
  EMPTY_RUNTIME_CONVERSATION_METADATA,
  EMPTY_RUNTIME_QUEUED_MESSAGES,
  getRuntimeConversationSnapshot,
} from '@/features/workbench/runtimeConversationCache'
export interface PaneSessionExternal {
  t: ReturnType<typeof useTranslation>['t']
  draftEditVersions: Map<string, number>
  currentRuntimeTask: RuntimeTaskAddress | null
  debugSnapshotEnabled: boolean
  queueDiagnosticSessionId: string
  workbench: ReturnType<typeof useWorkbenchPaneContext>
  lifecycleStore: ReturnType<typeof useRuntimeTaskLifecycleStore>
  attachmentState: ReturnType<typeof useScopedComposerAttachments>
}
export interface PaneTranscriptReader {
  read: RuntimeTranscriptLoader
  isCurrent(): boolean
}
export function createPaneSessionFrame(
  external: PaneSessionExternal,
  state: PaneSessionState,
  reader: PaneTranscriptReader
) {
  const { currentRuntimeTask, debugSnapshotEnabled } = external
  const queueDiagnosticSessionId = external.queueDiagnosticSessionId
  const runtimeTranscriptPageSize = resolveRuntimeTranscriptPageSize()
  const {
    state: workbenchState,
    projectChat,
    loadRuntimeTranscriptForPane: readRuntimeTranscriptForPane,
    searchRuntimeTranscriptForPane,
    getRuntimeGoal,
    setRuntimeGoal,
    clearRuntimeGoal,
    sendRuntimePaneMessage,
    interruptAndSendRuntimePaneMessage,
    sendRuntimePaneGuidance,
    compactRuntimePaneTask,
    editLastUserMessage,
    cancelRuntimePaneTask,
    cancelRuntimeTask,
    forceStartRuntimeTask,
    sendCurrentInput,
    refreshWorkLists,
  } = external.workbench
  const lifecycleStore = external.lifecycleStore
  const queuedMessageScopeKey = currentRuntimeTask
    ? runtimeConversationKey(currentRuntimeTask)
    : null
  const queueController = (() =>
    currentRuntimeTask ? getRuntimeConversationQueueController(currentRuntimeTask) : null)()
  const queuedMessageBusyBlocks = (() =>
    queueController?.busyBlocks ?? new Map<string, RuntimeTaskLifecycleSnapshot | null>())()
  const { messages: queuedMessages, paused: queuedMessagesPaused } = {
    messages: currentRuntimeTask
      ? getRuntimeConversationQueuedMessagesByKey(runtimeConversationKey(currentRuntimeTask))
      : EMPTY_RUNTIME_QUEUED_MESSAGES,
    paused: currentRuntimeTask
      ? getRuntimeConversationQueuePausedByKey(runtimeConversationKey(currentRuntimeTask))
      : false,
  }
  const guidanceMessages = EMPTY_PANE_GUIDANCE_MESSAGES
  const codeCommentContexts = state.codeCommentContexts
  const browserAnnotationCommand = state.browserAnnotationCommand
  const inputScopeKey = currentRuntimeTask
    ? getRuntimeTaskChatScopeKey(currentRuntimeTask)
    : projectChat.scopeKey
  const attachmentState = external.attachmentState
  const addExistingAttachmentForScope = projectChat.addExistingAttachmentForScope
  const {
    addExistingAttachment,
    handleFileSelect,
    removeAttachment,
    resetAttachments,
    dismissAttachmentError,
  } = attachmentState
  const input = projectChat.inputByScope[inputScopeKey] ?? ''
  const setInputForScope = projectChat.setInputForScope
  const getInputRevisionForScope = projectChat.getInputRevisionForScope
  const sharedInputRevision = getInputRevisionForScope(inputScopeKey)
  const inputRevision = state.inputRevision
  const replaceDraftKey = state.replaceDraftKey
  const localError = state.localError
  const error = projectChat.composerErrorByScope
    ? (projectChat.composerErrorByScope[inputScopeKey] ?? null)
    : projectChat.setComposerError
      ? (projectChat.composerError ?? null)
      : localError
  const answeredRequestUserInputIds = state.answeredRequestUserInputIds
  const transcriptLoadingKey = state.transcriptLoadingKey
  const transcriptFailure = state.transcriptError
  const transcriptError =
    transcriptFailure == null
      ? null
      : typeof transcriptFailure === 'object' &&
          'code' in transcriptFailure &&
          transcriptFailure.code === 'device_offline'
        ? external.t('workbench.conversation_device_offline_notice', {
            device:
              getWorkbenchDeviceUnavailableDisplayName(
                currentRuntimeTask
                  ? findWorkbenchDevice(workbenchState.devices ?? [], currentRuntimeTask.deviceId)
                  : null
              ) || external.t('workbench.current_device', '当前设备'),
          })
        : transcriptFailure instanceof Error
          ? transcriptFailure.message
          : String(transcriptFailure)
  const transcriptReloadVersion = state.transcriptReloadVersion
  const transcriptHasMoreBefore = state.transcriptHasMoreBefore
  const transcriptBeforeCursor = state.transcriptBeforeCursor
  const transcriptLoadingMoreBeforeKey = state.transcriptLoadingMoreBeforeKey
  const transcriptFullContent = state.transcriptFullContent
  const loadedTranscriptRanges = state.loadedTranscriptRanges
  const turnNavigation = state.turnNavigation
  const pendingGoalState = state.pendingGoalState
  const goalDraftActive = projectChat.goalDraftActiveByScope?.[inputScopeKey] ?? false
  const setGoalDraftActiveForScope = projectChat.setGoalDraftActiveForScope
  const currentRuntimeTaskLoadTarget = (() =>
    currentRuntimeTask ? runtimeTaskLoadTargetFromAddress(currentRuntimeTask) : null)()
  const retainedRuntimeTaskLoadTarget = state.retainedRuntimeTaskLoadTarget
  const candidateRuntimeTaskLoadTarget =
    currentRuntimeTaskLoadTarget ?? retainedRuntimeTaskLoadTarget
  const ownerArchived = candidateRuntimeTaskLoadTarget
    ? isRuntimeConversationArchived(candidateRuntimeTaskLoadTarget.address)
    : false
  const runtimeTaskLoadTarget = ownerArchived ? null : candidateRuntimeTaskLoadTarget
  const { read: loadRuntimeTranscriptForPane, isCurrent: isTranscriptScopeCurrent } = reader
  const transcriptLoading =
    runtimeTaskLoadTarget !== null && transcriptLoadingKey === runtimeTaskLoadTarget.key
  const transcriptLoadingMoreBefore =
    runtimeTaskLoadTarget !== null && transcriptLoadingMoreBeforeKey === runtimeTaskLoadTarget.key
  const draftMessages = state.draftMessages
  const conversation = runtimeTaskLoadTarget
    ? getRuntimeConversationSnapshot(runtimeTaskLoadTarget.address)
    : EMPTY_RUNTIME_CONVERSATION_SNAPSHOT
  const {
    goal: threadGoal,
    taskPlan,
    subagentStatuses,
  } = runtimeTaskLoadTarget
    ? getRuntimeConversationMetadata(runtimeTaskLoadTarget.address)
    : EMPTY_RUNTIME_CONVERSATION_METADATA
  const messages = runtimeTaskLoadTarget ? conversation.messages : draftMessages
  const turns = conversation.turns
  const lifecycleAddress = resolveRuntimePaneLifecycleAddress(
    currentRuntimeTask,
    runtimeTaskLoadTarget?.address
  )
  const taskLifecycle = lifecycleStore.getTask(lifecycleAddress)
  const taskGoalStatus = taskLifecycle?.goalStatus ?? null
  const goalExecutionStatus = taskLifecycle?.task?.goalExecutionStatus ?? null
  const quotaWaitPending = Boolean(taskLifecycle?.task?.runtimeHandle?.quotaWait)
  const currentRuntime =
    currentRuntimeTask?.runtime ??
    findRuntimeTask(workbenchState.runtimeWork, currentRuntimeTask)?.runtime ??
    null
  const paneStatus = (() =>
    deriveRuntimePaneStatus({
      messages,
      currentRuntimeTask,
      lifecycle: taskLifecycle,
    }))()
  const diagnosticTaskId = lifecycleAddress?.taskId
  const diagnosticDeviceId = lifecycleAddress?.deviceId
  const diagnosticHasActiveAssistant = Boolean(paneStatus.activeAssistantMessage)
  const activeAssistantMessage = paneStatus.activeAssistantMessage
  const goal = (() => {
    let resolvedGoal: RuntimeGoal | null
    if (!currentRuntimeTaskLoadTarget) {
      if (pendingGoalState && isUnboundPendingGoalState(pendingGoalState)) {
        resolvedGoal = visibleRuntimeGoal(pendingGoalState.goal)
      } else {
        resolvedGoal = null
      }
    } else {
      const visibleThreadGoal = visibleRuntimeGoal(threadGoal)
      if (visibleThreadGoal) {
        resolvedGoal = visibleThreadGoal
      } else if (
        pendingGoalState &&
        isPendingGoalVisibleForRuntimeTarget(pendingGoalState, currentRuntimeTaskLoadTarget.address)
      ) {
        resolvedGoal = visibleRuntimeGoal(pendingGoalState.goal)
      } else {
        resolvedGoal = null
      }
    }

    return resolvedGoal
  })()
  const goalContinuing = projectRuntimeGoalContinuing({
    goal,
    execution: taskLifecycle?.task?.executionState,
    activeAssistantMessage,
  })
  return {
    currentRuntimeTask,
    debugSnapshotEnabled,
    queueDiagnosticSessionId,
    runtimeTranscriptPageSize,
    workbenchState,
    projectChat,
    readRuntimeTranscriptForPane,
    searchRuntimeTranscriptForPane,
    getRuntimeGoal,
    setRuntimeGoal,
    clearRuntimeGoal,
    sendRuntimePaneMessage,
    interruptAndSendRuntimePaneMessage,
    sendRuntimePaneGuidance,
    compactRuntimePaneTask,
    editLastUserMessage,
    cancelRuntimePaneTask,
    cancelRuntimeTask,
    forceStartRuntimeTask,
    sendCurrentInput,
    refreshWorkLists,
    lifecycleStore,
    queuedMessageScopeKey,
    queueController,
    queuedMessageBusyBlocks,
    queuedMessages,
    queuedMessagesPaused,
    guidanceMessages,
    codeCommentContexts,
    browserAnnotationCommand,
    inputScopeKey,
    attachmentState,
    addExistingAttachmentForScope,
    addExistingAttachment,
    handleFileSelect,
    removeAttachment,
    resetAttachments,
    dismissAttachmentError,
    input,
    setInputForScope,
    getInputRevisionForScope,
    sharedInputRevision,
    inputRevision,
    replaceDraftKey,
    localError,
    error,
    answeredRequestUserInputIds,
    transcriptLoadingKey,
    transcriptError,
    transcriptReloadVersion,
    transcriptHasMoreBefore,
    transcriptBeforeCursor,
    transcriptLoadingMoreBeforeKey,
    transcriptFullContent,
    loadedTranscriptRanges,
    turnNavigation,
    pendingGoalState,
    goalDraftActive,
    setGoalDraftActiveForScope,
    currentRuntimeTaskLoadTarget,
    retainedRuntimeTaskLoadTarget,
    candidateRuntimeTaskLoadTarget,
    ownerArchived,
    runtimeTaskLoadTarget,
    loadRuntimeTranscriptForPane,
    isTranscriptScopeCurrent,
    transcriptLoading,
    transcriptLoadingMoreBefore,
    draftMessages,
    conversation,
    threadGoal,
    taskPlan,
    subagentStatuses,
    messages,
    turns,
    lifecycleAddress,
    taskLifecycle,
    taskGoalStatus,
    goalExecutionStatus,
    quotaWaitPending,
    currentRuntime,
    paneStatus,
    diagnosticTaskId,
    diagnosticDeviceId,
    diagnosticHasActiveAssistant,
    activeAssistantMessage,
    goal,
    goalContinuing,
  }
}
export type PaneSessionFrame = ReturnType<typeof createPaneSessionFrame>
