import { SupersededConversationRead } from '@/features/workbench/runtimeConversationSynchronization'
import { useRuntimeConversationSnapshot } from '@/features/workbench/useRuntimeConversationSnapshot'
import { reduceWorkbenchMessages } from '@wegent/chat-core'
import { useDebugSnapshotPublisher } from '@/features/workbench/useDebugSnapshotPublisher'

import { syncRuntimeGoal } from '@/features/workbench/runtimeTaskLifecycle/goalSynchronization'
import {
  transcriptRangeFromPage,
  mergeTranscriptRanges,
  runtimeTurnNavigationLoadOptions,
} from '@wegent/chat-core/runtime-transcript-page'
export { runtimeTurnNavigationLoadOptions } from '@wegent/chat-core/runtime-transcript-page'
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type SetStateAction,
} from 'react'
import i18n from '@/i18n'
import { logRuntimeTaskCreateStage } from '@/lib/runtime-create-diagnostics'
import { useWorkbenchPaneContext } from '@/features/workbench/useWorkbench'
import {
  compareMessageStyles,
  summarizeRuntimePaneMemory,
  summarizeMessages,
  updateRuntimePaneDebugSnapshot,
} from '@/lib/debugPanel'
import type { RuntimePaneMessageAction } from '@/features/workbench/runtimePaneMessages'
import {
  deriveRuntimePaneStatus,
  isRuntimeTaskBusyError,
  resolveRuntimePaneLifecycleAddress,
} from '@/features/workbench/runtimePaneStatus'
import {
  runtimeTaskLifecycleTransitionChanged,
  type RuntimeTaskLifecycleSnapshot,
  useRuntimeTaskLifecycle,
  useRuntimeTaskLifecycleStore,
} from '@/features/workbench/runtimeTaskLifecycle'
import {
  resolveAutomaticModel,
  selectedModelExecutionFields,
} from '@/features/workbench/runtimeModelSelection'
import {
  findRuntimeTask,
  getRuntimeTaskRouteKey,
} from '@/features/workbench/workbenchRuntimeHelpers'
import { getRuntimeTaskChatScopeKey } from '@/features/workbench/workbenchProviderHelpers'
import { persistAttachmentReferences } from '@/lib/attachments'
import { localRuntimeAttachments, remoteAttachmentIds } from '@/lib/runtime-attachments'
import {
  applyRequestUserInputResponseToBlock,
  findRequestUserInputPayload,
  isAsyncRequestUserInputPayload,
  requestUserInputPayloadKey,
  requestUserInputResponseKey,
  requestUserInputResponseText,
} from '@/components/chat/requestUserInputMessages'
import type { RequestUserInputPayload } from '@/components/chat/RequestUserInputCard'
import { debugComposerEvent, textMetrics } from '@/components/chat/composer/composerDebug'
import {
  projectRuntimeGoalContinuing,
  runtimeGoalCreateInput,
  visibleRuntimeGoal,
} from '@/lib/runtime-goal'
import { appendCodeCommentContexts } from '@/lib/code-comment-context'
import { appendConversationMentionContext } from '@/lib/conversation-mentions'
import {
  markRuntimeTerminalAdditionalContextDelivered,
  readRuntimeTerminalAdditionalContext,
} from '@/lib/runtime-terminal-context'
import type {
  Attachment,
  ModelSelectionConfig,
  ModelOptions,
  RequestUserInputResponse,
  RuntimeGoal,
  RuntimeGoalCreateInput,
  RuntimePlanEventPayload,
  RuntimeGoalContinuationPayload,
  RuntimeName,
  RuntimeAdditionalContext,
  RuntimeRollbackRequest,
  RuntimeSupervisorCreateInput,
  RuntimeTaskAddress,
  RuntimeTaskCreateRequest,
  RuntimeTurnNavigationItem,
} from '@/types/api'
import { getDesktopE2ERuntimeConfig } from '@/e2e/runtime-config'
import type {
  GuidanceWorkbenchMessage,
  RuntimePaneQueuedMessage,
  RuntimePaneTranscript,
  RuntimeSubagentStatus,
  WorkbenchMessage,
} from '@/types/workbench'
import type { CodeCommentContext } from '@/types/workspace-files'
import type { BrowserAnnotationCommand, BrowserAnnotationScope } from '@/types/browser-annotation'
import {
  hasBrowserAnnotationScope,
  isBrowserAnnotationContext,
} from '@/lib/browser-annotation-context'
import {
  applyRuntimeConversationAction,
  appendOptimisticRuntimeConversationGuidance,
  beginRuntimeConversationOperation,
  beginRuntimeGoalSnapshot,
  cacheRuntimeConversationQueuedMessagesByKey,
  cacheRuntimeConversationQueuePausedByKey,
  clearInterruptedRuntimeConversationGuidanceExcept,
  getRuntimeConversationMessages,
  getRuntimeConversationTurns,
  getRuntimeConversationMetadata,
  getRuntimeConversationQueuedMessagesByKey,
  getRuntimeConversationQueueDiagnosticSnapshotByKey,
  getRuntimeConversationQueuePausedByKey,
  isRuntimeGoalSnapshotCurrent,
  markRuntimeConversationGuidanceInterrupted,
  optimisticallyInterruptRuntimeConversation,
  removeOptimisticRuntimeConversationGuidance,
  removeRuntimeConversationTurn,
  replaceRuntimeConversationFromUserMessage,
  runtimeConversationSnapshotSettlesLatestTurn,
  runtimeConversationKey,
  restoreOptimisticallyInterruptedRuntimeConversation,
  subscribeRuntimeConversation,
  takeInterruptedRuntimeConversationGuidance,
  updateRuntimeConversationBlocks,
  replaceRuntimeConversationSnapshot,
} from '@/features/workbench/runtimeConversationCache'
import {
  createRuntimeUserMessage,
  type RuntimeUserMessageOptions,
} from '@/features/workbench/runtimeUserMessage'
import { getRuntimeConversationQueueController } from '@/features/workbench/runtimeConversationQueueController'
import { logRuntimeQueueStage } from '@/features/workbench/runtimeQueueDiagnostics'
import {
  createRuntimeQueuedUserMessage,
  retainRuntimeQueuedMessage as retainQueuedMessage,
  sendRuntimeQueuedMessage,
} from '@/features/workbench/runtimeQueuedMessageSender'
import { RUNTIME_RETRY_CONTINUATION_PROMPT } from './runtimeRetry'
import { useRuntimeConversationSearch } from './useRuntimeConversationSearch'

interface WorkbenchPaneSessionOptions {
  currentRuntimeTask: RuntimeTaskAddress | null
  debugSnapshotEnabled?: boolean
}

interface SendRequestUserInputResponseOptions {
  appendUserMessage?: boolean
  forceDefaultCollaborationMode?: boolean
}

interface RuntimePaneSendOptions {
  guideWhenBusy?: boolean
  interruptWhenBusy?: boolean
  runtime?: RuntimeName
  runtimeExecutablePath?: string
  runtimePermissionMode?: 'default' | 'acceptEdits' | 'plan' | 'auto' | 'bypassPermissions'
  modelSelection?: ModelSelectionConfig | null
  additionalContext?: RuntimeAdditionalContext
  cloudProjectId?: string
  origin?: RuntimeTaskCreateRequest['origin']
  initialSupervisor?: RuntimeSupervisorCreateInput | null
  wegentTeamId?: number
  onRuntimeTaskCreated?: (address: RuntimeTaskAddress) => void
  onRuntimeTaskReady?: (address: RuntimeTaskAddress) => void
}

interface SendRuntimeMessageOptions {
  appendLocalMessage?: boolean
  initialGoal?: RuntimeGoalCreateInput | null
  onError?: (error: string) => void
  silentBusyRetry?: boolean
}

interface RuntimeMessageSendResult {
  accepted: boolean
  queued: boolean
  queuePosition?: number | null
}

interface LoadedTranscriptRange {
  start: number
  end: number
}

interface RuntimeTaskLoadTarget {
  key: string
  identityKey: string
  address: RuntimeTaskAddress
}

interface PendingRuntimeGoalState {
  goal: RuntimeGoal
  targetKey: string | null
  targetIdentityKey: string | null
}

const runtimePaneGoalSeeds = new Map<string, PendingRuntimeGoalState>()
const DEFAULT_RUNTIME_TRANSCRIPT_PAGE_SIZE = 5
const MAX_CACHED_RUNTIME_PANE_GOALS = 3
export { RUNTIME_RETRY_CONTINUATION_PROMPT } from './runtimeRetry'
const EMPTY_ATTACHMENT_STATE = {
  attachments: [],
  uploadingFiles: new Map(),
  errors: new Map(),
}

export function useWorkbenchPaneSession({
  currentRuntimeTask,
  debugSnapshotEnabled = true,
}: WorkbenchPaneSessionOptions) {
  const queueDiagnosticSessionId = useId()
  const runtimeTranscriptPageSize = resolveRuntimeTranscriptPageSize()
  const {
    state: workbenchState,
    projectChat,
    loadRuntimeTranscriptForPane,
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
  } = useWorkbenchPaneContext()
  const lifecycleStore = useRuntimeTaskLifecycleStore()
  const queuedMessageScopeKey = currentRuntimeTask
    ? runtimeConversationKey(currentRuntimeTask)
    : null
  const queueController = useMemo(
    () => (currentRuntimeTask ? getRuntimeConversationQueueController(currentRuntimeTask) : null),
    [currentRuntimeTask]
  )
  const queuedMessageBusyBlocks = useMemo(
    () => queueController?.busyBlocks ?? new Map<string, RuntimeTaskLifecycleSnapshot | null>(),
    [queueController]
  )
  useEffect(
    () => queueController?.attach({ lifecycleStore, sendRuntimePaneMessage }),
    [lifecycleStore, queueController, sendRuntimePaneMessage]
  )
  const [queuedMessages, setQueuedMessagesState] = useState<RuntimePaneQueuedMessage[]>(() =>
    queuedMessageScopeKey ? getRuntimeConversationQueuedMessagesByKey(queuedMessageScopeKey) : []
  )
  const [queuedMessagesPaused, setQueuedMessagesPausedState] = useState(() =>
    queuedMessageScopeKey ? getRuntimeConversationQueuePausedByKey(queuedMessageScopeKey) : false
  )
  const setQueuedMessages = useCallback(
    (update: SetStateAction<RuntimePaneQueuedMessage[]>) => {
      if (!queuedMessageScopeKey) return
      const previous = getRuntimeConversationQueuedMessagesByKey(queuedMessageScopeKey)
      const next = typeof update === 'function' ? update(previous) : update
      if (next === previous) return
      cacheRuntimeConversationQueuedMessagesByKey(queuedMessageScopeKey, next)
      setQueuedMessagesState(next)
    },
    [queuedMessageScopeKey]
  )
  const setQueuedMessagesPaused = useCallback(
    (update: SetStateAction<boolean>) => {
      if (!queuedMessageScopeKey) return
      const previous = getRuntimeConversationQueuePausedByKey(queuedMessageScopeKey)
      const next = typeof update === 'function' ? update(previous) : update
      if (next === previous) return
      cacheRuntimeConversationQueuePausedByKey(queuedMessageScopeKey, next)
      setQueuedMessagesPausedState(next)
    },
    [queuedMessageScopeKey]
  )
  const [guidanceMessages] = useState<GuidanceWorkbenchMessage[]>([])
  const [codeCommentContexts, setCodeCommentContexts] = useState<CodeCommentContext[]>([])
  const codeCommentContextsRef = useRef(codeCommentContexts)
  useLayoutEffect(() => {
    codeCommentContextsRef.current = codeCommentContexts
  }, [codeCommentContexts])
  const [browserAnnotationCommand, setBrowserAnnotationCommand] =
    useState<BrowserAnnotationCommand | null>(null)
  const browserAnnotationCommandSequenceRef = useRef(0)
  const inputScopeKey = currentRuntimeTask
    ? getRuntimeTaskChatScopeKey(currentRuntimeTask)
    : projectChat.scopeKey
  const attachmentState =
    projectChat.attachmentStateByScope[inputScopeKey] ?? EMPTY_ATTACHMENT_STATE
  const addExistingAttachmentForScope = projectChat.addExistingAttachmentForScope
  const addExistingAttachment = useCallback(
    (attachment: Attachment) => addExistingAttachmentForScope(inputScopeKey, attachment),
    [addExistingAttachmentForScope, inputScopeKey]
  )
  const handleFileSelect = useCallback(
    (files: File | File[]) => projectChat.handleFileSelectForScope(inputScopeKey, files),
    [inputScopeKey, projectChat]
  )
  const removeAttachment = useCallback(
    (attachmentId: number) => projectChat.removeAttachmentForScope(inputScopeKey, attachmentId),
    [inputScopeKey, projectChat]
  )
  const resetAttachments = useCallback(
    () => projectChat.resetAttachmentsForScope(inputScopeKey),
    [inputScopeKey, projectChat]
  )
  const dismissAttachmentError = useCallback(
    (filename: string) => projectChat.dismissAttachmentErrorForScope(inputScopeKey, filename),
    [inputScopeKey, projectChat]
  )
  const input = projectChat.inputByScope[inputScopeKey] ?? ''
  const setInputForScope = projectChat.setInputForScope
  const getInputRevisionForScope = projectChat.getInputRevisionForScope
  const sharedInputRevision = getInputRevisionForScope(inputScopeKey)
  const mountedRef = useRef(false)
  useLayoutEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])
  const [inputRevision, setInputRevision] = useState(0)
  const inputRevisionRef = useRef(0)
  const activeInputScopeRef = useRef(inputScopeKey)
  useLayoutEffect(() => {
    if (activeInputScopeRef.current === inputScopeKey) return
    activeInputScopeRef.current = inputScopeKey
    inputRevisionRef.current += 1
    setInputRevision(inputRevisionRef.current)
  }, [inputScopeKey])
  const scopedSetInput = useCallback(
    (value: string) => {
      inputRevisionRef.current += 1
      setInputRevision(inputRevisionRef.current)
      setInputForScope(inputScopeKey, value)
    },
    [inputScopeKey, setInputForScope]
  )
  const [localError, setLocalError] = useState<string | null>(null)
  const error = projectChat.composerErrorByScope
    ? (projectChat.composerErrorByScope[inputScopeKey] ?? null)
    : projectChat.setComposerError
      ? (projectChat.composerError ?? null)
      : localError
  const setErrorForScope = useCallback(
    (scopeKey: string, nextError: string | null) => {
      if (projectChat.setComposerErrorForScope) {
        projectChat.setComposerErrorForScope(scopeKey, nextError)
        return
      }
      if (projectChat.setComposerError) {
        projectChat.setComposerError(nextError)
        return
      }
      setLocalError(nextError)
    },
    [projectChat]
  )
  const setError = useCallback(
    (nextError: string | null) => setErrorForScope(inputScopeKey, nextError),
    [inputScopeKey, setErrorForScope]
  )
  const clearError = useCallback(() => setError(null), [setError])
  const setInput = scopedSetInput
  const restoreInputAfterFailure = useCallback(
    (value: string) => {
      scopedSetInput(value)
    },
    [scopedSetInput]
  )

  const clearCodeCommentsAfterCommit = useCallback(
    (reason: BrowserAnnotationCommand['reason'], contexts: CodeCommentContext[]) => {
      // Native cleanup clears the entire page; retain an edited annotation batch.
      const submittedAnnotations = contexts.filter(isBrowserAnnotationContext)
      const currentAnnotations = codeCommentContextsRef.current.filter(isBrowserAnnotationContext)
      const preserveAnnotations =
        reason === 'send_success' &&
        (submittedAnnotations.length !== currentAnnotations.length ||
          currentAnnotations.some(context => !submittedAnnotations.includes(context)))
      setCodeCommentContexts(current =>
        current.filter(
          context =>
            !contexts.includes(context) ||
            (preserveAnnotations && isBrowserAnnotationContext(context))
        )
      )
      if (preserveAnnotations || !contexts.some(isBrowserAnnotationContext)) return

      browserAnnotationCommandSequenceRef.current += 1
      setBrowserAnnotationCommand({
        sequence: browserAnnotationCommandSequenceRef.current,
        type: 'clear_all_and_exit',
        reason,
      })
    },
    []
  )
  const [answeredRequestUserInputIds, setAnsweredRequestUserInputIds] = useState<
    ReadonlySet<string>
  >(() => new Set())
  const [transcriptLoadingKey, setTranscriptLoadingKey] = useState<string | null>(() =>
    currentRuntimeTask ? runtimeTaskLoadAddressKey(currentRuntimeTask) : null
  )
  const [transcriptError, setTranscriptError] = useState<string | null>(null)
  const [transcriptReloadVersion, setTranscriptReloadVersion] = useState(0)
  const [transcriptHasMoreBefore, setTranscriptHasMoreBefore] = useState(false)
  const [transcriptBeforeCursor, setTranscriptBeforeCursor] = useState<string | null>(null)
  const [transcriptLoadingMoreBeforeKey, setTranscriptLoadingMoreBeforeKey] = useState<
    string | null
  >(null)
  const [transcriptFullContent, setTranscriptFullContent] = useState(false)
  const [loadedTranscriptRanges, setLoadedTranscriptRanges] = useState<LoadedTranscriptRange[]>([])
  const [turnNavigation, setTurnNavigation] = useState<RuntimeTurnNavigationItem[]>([])
  const [subagentStatuses, setSubagentStatuses] = useState<RuntimeSubagentStatus[]>([])
  const [threadGoal, setThreadGoal] = useState<RuntimeGoal | null>(null)
  const [goalContinuation, setGoalContinuation] = useState<RuntimeGoalContinuationPayload | null>(
    null
  )
  const [taskPlan, setTaskPlan] = useState<RuntimePlanEventPayload | null>(null)
  const [pendingGoalState, setPendingGoalState] = useState<PendingRuntimeGoalState | null>(null)
  const [goalDraftActive, setGoalDraftActive] = useState(false)
  const loadedRuntimeTranscriptKeyRef = useRef<string | null>(null)
  const loadRuntimeTranscriptForPaneRef = useRef(loadRuntimeTranscriptForPane)
  const refreshWorkListsRef = useRef(refreshWorkLists)
  const currentRuntimeTaskRef = useRef(currentRuntimeTask)
  const runtimeTaskLoadTargetRef = useRef<RuntimeTaskLoadTarget | null>(null)
  const displayedTranscriptIdentityRef = useRef<string | null>(null)
  const loadedTranscriptRangesRef = useRef<LoadedTranscriptRange[]>([])
  const interruptAndSendInFlightRef = useRef(false)
  const lastQueueDiagnosticRef = useRef<string | null>(null)
  const continuationInFlightRef = useRef(false)
  const currentRuntimeTaskLoadTarget = useMemo(
    () => (currentRuntimeTask ? runtimeTaskLoadTargetFromAddress(currentRuntimeTask) : null),
    [currentRuntimeTask]
  )
  const [retainedRuntimeTaskLoadTarget, setRetainedRuntimeTaskLoadTarget] =
    useState<RuntimeTaskLoadTarget | null>(() =>
      currentRuntimeTask ? runtimeTaskLoadTargetFromAddress(currentRuntimeTask) : null
    )
  const runtimeTaskLoadTarget =
    currentRuntimeTaskLoadTarget?.key === retainedRuntimeTaskLoadTarget?.key
      ? retainedRuntimeTaskLoadTarget
      : (currentRuntimeTaskLoadTarget ?? retainedRuntimeTaskLoadTarget)
  const transcriptLoading =
    runtimeTaskLoadTarget !== null && transcriptLoadingKey === runtimeTaskLoadTarget.key
  const transcriptLoadingMoreBefore =
    runtimeTaskLoadTarget !== null && transcriptLoadingMoreBeforeKey === runtimeTaskLoadTarget.key
  const [draftMessages, setDraftMessages] = useState<WorkbenchMessage[]>([])
  const conversation = useRuntimeConversationSnapshot(runtimeTaskLoadTarget?.address ?? null)
  const messages = runtimeTaskLoadTarget ? conversation.messages : draftMessages
  const turns = conversation.turns
  const messagesRef = useRef<WorkbenchMessage[]>(messages)
  const dispatchMessages = useCallback((action: RuntimePaneMessageAction) => {
    const address = runtimeTaskLoadTargetRef.current?.address ?? currentRuntimeTaskRef.current
    if (address) {
      applyRuntimeConversationAction(address, action)
    } else {
      setDraftMessages(current => reduceWorkbenchMessages(current, action) as WorkbenchMessage[])
    }
  }, [])
  const lifecycleAddress = resolveRuntimePaneLifecycleAddress(
    currentRuntimeTask,
    runtimeTaskLoadTarget?.address
  )
  const taskLifecycle = useRuntimeTaskLifecycle(lifecycleAddress)
  const taskGoalStatus = taskLifecycle?.goalStatus ?? null
  const goalExecutionStatus = taskLifecycle?.task?.goalExecutionStatus ?? null
  const currentRuntime =
    currentRuntimeTask?.runtime ??
    findRuntimeTask(workbenchState.runtimeWork, currentRuntimeTask)?.runtime ??
    null
  const paneStatus = useMemo(
    () =>
      deriveRuntimePaneStatus({
        messages,
        currentRuntimeTask,
        lifecycle: taskLifecycle,
      }),
    [currentRuntimeTask, messages, taskLifecycle]
  )
  const readCurrentPaneBusy = useCallback(
    () =>
      currentRuntimeTask
        ? (lifecycleStore.getTask(currentRuntimeTask)?.derived.isBusy ?? paneStatus.isBusy)
        : paneStatus.isBusy,
    [currentRuntimeTask, lifecycleStore, paneStatus.isBusy]
  )
  const diagnosticTaskId = lifecycleAddress?.taskId
  const diagnosticDeviceId = lifecycleAddress?.deviceId
  const diagnosticHasActiveAssistant = Boolean(paneStatus.activeAssistantMessage)
  useEffect(() => {
    if (!diagnosticTaskId) return
    logRuntimeTaskCreateStage('pane-waiting-state', {
      taskId: diagnosticTaskId,
      deviceId: diagnosticDeviceId,
      sendPhase: paneStatus.sendPhase,
      running: paneStatus.taskExecution.running,
      waiting: paneStatus.isWaitingForAssistantIndicator,
      hasActiveAssistant: diagnosticHasActiveAssistant,
    })
  }, [
    diagnosticTaskId,
    diagnosticDeviceId,
    paneStatus.sendPhase,
    paneStatus.taskExecution.running,
    paneStatus.isWaitingForAssistantIndicator,
    diagnosticHasActiveAssistant,
  ])
  const activeAssistantMessage = paneStatus.activeAssistantMessage
  const goal = useMemo(() => {
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
  }, [currentRuntimeTaskLoadTarget, pendingGoalState, threadGoal])

  useEffect(() => {
    currentRuntimeTaskRef.current = currentRuntimeTask
  }, [currentRuntimeTask])

  useEffect(() => {
    if (!queuedMessageScopeKey) return
    lastQueueDiagnosticRef.current = null
    const logPaneQueue = (stage: string) => {
      logRuntimeTaskCreateStage(stage, {
        conversationKey: queuedMessageScopeKey,
        paneSessionId: queueDiagnosticSessionId,
        ...getRuntimeConversationQueueDiagnosticSnapshotByKey(queuedMessageScopeKey),
      })
    }
    logPaneQueue('queue-pane-attached')
    return () => logPaneQueue('queue-pane-detached')
  }, [queuedMessageScopeKey, queueDiagnosticSessionId])

  useEffect(() => {
    if (!queuedMessageScopeKey) return
    // Read the scoped cache because React state can still belong to the previous pane.
    const queueSnapshot = getRuntimeConversationQueueDiagnosticSnapshotByKey(queuedMessageScopeKey)
    if (queueSnapshot.queueLength === 0 && lastQueueDiagnosticRef.current === null) return
    const details = {
      conversationKey: queuedMessageScopeKey,
      paneSessionId: queueDiagnosticSessionId,
      ...queueSnapshot,
      canSendQueuedMessage: paneStatus.canSendQueuedMessage,
      continuable: paneStatus.taskExecution.continuable,
      responseActive: paneStatus.isResponseActive,
      executionPhase: taskLifecycle?.execution.phase ?? null,
      turnPhase: taskLifecycle?.turn.phase ?? null,
      turnId: taskLifecycle?.turn.id ?? null,
      busyBlockedMessageIds: queueSnapshot.messages
        .filter(message => queuedMessageBusyBlocks.has(message.id))
        .map(message => message.id),
    }
    const signature = JSON.stringify(details)
    if (signature === lastQueueDiagnosticRef.current) return
    lastQueueDiagnosticRef.current = queueSnapshot.queueLength > 0 ? signature : null
    logRuntimeTaskCreateStage('queue-state', details)
  }, [
    queuedMessageScopeKey,
    queueDiagnosticSessionId,
    queuedMessageBusyBlocks,
    queuedMessages,
    queuedMessagesPaused,
    paneStatus.canSendQueuedMessage,
    paneStatus.taskExecution.continuable,
    paneStatus.isResponseActive,
    taskLifecycle?.execution.phase,
    taskLifecycle?.turn.phase,
    taskLifecycle?.turn.id,
  ])

  useEffect(() => {
    setQueuedMessagesState(
      queuedMessageScopeKey ? getRuntimeConversationQueuedMessagesByKey(queuedMessageScopeKey) : []
    )
    setQueuedMessagesPausedState(
      queuedMessageScopeKey ? getRuntimeConversationQueuePausedByKey(queuedMessageScopeKey) : false
    )
  }, [queuedMessageScopeKey])

  useEffect(() => {
    if (currentRuntimeTaskLoadTarget) {
      setRetainedRuntimeTaskLoadTarget(current =>
        current?.key === currentRuntimeTaskLoadTarget.key ? current : currentRuntimeTaskLoadTarget
      )
    }
  }, [currentRuntimeTaskLoadTarget])

  useEffect(() => {
    runtimeTaskLoadTargetRef.current = runtimeTaskLoadTarget
  }, [runtimeTaskLoadTarget])

  useEffect(() => {
    if (!runtimeTaskLoadTarget) {
      setSubagentStatuses([])
      setTaskPlan(null)
      return
    }
    const { address } = runtimeTaskLoadTarget
    const syncConversationState = () => {
      const metadata = getRuntimeConversationMetadata(address)
      if (metadata.goal && metadata.goal.threadId !== 'pending') {
        clearRuntimePaneGoalSeed(address)
        setPendingGoalState(current =>
          current && isPendingGoalVisibleForRuntimeTarget(current, address) ? null : current
        )
      }
      setSubagentStatuses(metadata.subagentStatuses)
      setTaskPlan(metadata.taskPlan)
      setGoalContinuation(metadata.goalContinuation)
      setThreadGoal(metadata.goal)
    }
    syncConversationState()
    return subscribeRuntimeConversation(address, () => {
      syncConversationState()
      setQueuedMessagesState(
        getRuntimeConversationQueuedMessagesByKey(runtimeConversationKey(address))
      )
      setQueuedMessagesPausedState(
        getRuntimeConversationQueuePausedByKey(runtimeConversationKey(address))
      )
    })
  }, [runtimeTaskLoadTarget])

  useEffect(() => {
    messagesRef.current = messages
  }, [messages])

  useEffect(() => {
    setAnsweredRequestUserInputIds(new Set())
  }, [runtimeTaskLoadTarget?.key])

  useEffect(() => {
    loadedTranscriptRangesRef.current = loadedTranscriptRanges
  }, [loadedTranscriptRanges])

  useEffect(() => {
    loadRuntimeTranscriptForPaneRef.current = loadRuntimeTranscriptForPane
  }, [loadRuntimeTranscriptForPane])

  useEffect(() => {
    refreshWorkListsRef.current = refreshWorkLists
  }, [refreshWorkLists])

  useEffect(() => {
    if (!runtimeTaskLoadTarget) {
      setThreadGoal(null)
      setGoalContinuation(null)
      return
    }

    const seededGoal = getRuntimePaneGoalSeed(runtimeTaskLoadTarget.address)
    if (seededGoal) {
      lifecycleStore.goalStatusReceived(runtimeTaskLoadTarget.address, seededGoal.goal.status)
      setPendingGoalState(current =>
        current && isPendingGoalVisibleForRuntimeTarget(current, runtimeTaskLoadTarget.address)
          ? current
          : seededGoal
      )
    }

    let cancelled = false
    const snapshotVersion = beginRuntimeGoalSnapshot(runtimeTaskLoadTarget.address)
    void getRuntimeGoal(runtimeTaskLoadTarget.address)
      .then(response => {
        if (
          !cancelled &&
          response.accepted &&
          isRuntimeGoalSnapshotCurrent(runtimeTaskLoadTarget.address, snapshotVersion)
        ) {
          const loadedGoal = response.goal ?? null
          const resolvedGoal = resolveHydratedRuntimeGoal(
            runtimeTaskLoadTarget.address,
            loadedGoal,
            seededGoal
          )
          if (import.meta.env.VITE_WEWORK_RUNTIME_DEBUG === '1') {
            console.info('[Wework] Runtime goal hydration resolved', {
              address: runtimeAddressDebug(runtimeTaskLoadTarget.address),
              accepted: response.accepted,
              goalStatus: loadedGoal?.status ?? null,
            })
          }
          syncRuntimeGoal(lifecycleStore, runtimeTaskLoadTarget.address, resolvedGoal)
          if (loadedGoal?.status === 'active') {
            void refreshWorkListsRef.current().catch(() => undefined)
          }
          clearRuntimePaneGoalSeed(runtimeTaskLoadTarget.address)
          setPendingGoalState(current =>
            current && isPendingGoalVisibleForRuntimeTarget(current, runtimeTaskLoadTarget.address)
              ? null
              : current
          )
        }
      })
      .catch(error => {
        if (!cancelled) {
          console.error('[Wework] Runtime goal load failed', {
            address: runtimeAddressDebug(runtimeTaskLoadTarget.address),
            error,
          })
        }
      })

    return () => {
      cancelled = true
    }
  }, [getRuntimeGoal, lifecycleStore, runtimeTaskLoadTarget])

  useEffect(() => {
    if (!runtimeTaskLoadTarget) {
      setTranscriptLoadingKey(null)
      setTranscriptError(null)
      setTranscriptLoadingMoreBeforeKey(null)
      return
    }

    const { key: loadKey, address } = runtimeTaskLoadTarget
    if (
      loadedRuntimeTranscriptKeyRef.current === loadKey &&
      displayedTranscriptIdentityRef.current === runtimeTaskLoadTarget.identityKey
    ) {
      setTranscriptLoadingKey(current => (current === loadKey ? null : current))
      return
    }

    let cancelled = false
    let cancelNavigationLoad = () => {}
    const cachedSeededMessages = getRuntimeConversationMessages(address)
    const seededMessages =
      displayedTranscriptIdentityRef.current === runtimeTaskLoadTarget.identityKey
        ? messagesRef.current.length > 0
          ? messagesRef.current
          : cachedSeededMessages
        : cachedSeededMessages
    displayedTranscriptIdentityRef.current = runtimeTaskLoadTarget.identityKey
    debugRuntimePaneMessageFlow('transcript-load-start', {
      address: runtimeAddressDebug(address),
      key: loadKey,
      seededCount: seededMessages.length,
      seededMessages: summarizeWorkbenchMessages(seededMessages),
    })
    setTranscriptLoadingKey(loadKey)
    setTranscriptError(null)
    setTranscriptHasMoreBefore(false)
    setTranscriptBeforeCursor(null)
    setTranscriptLoadingMoreBeforeKey(null)
    setTranscriptFullContent(false)
    setLoadedTranscriptRanges([])
    setTurnNavigation([])
    const turnsAtLoadStart = getRuntimeConversationTurns(address)
    void Promise.resolve()
      .then(() =>
        loadRuntimeTranscriptForPaneRef.current(address, {
          limit: runtimeTranscriptPageSize,
        })
      )
      .then(transcript => {
        logRuntimeTaskCreateStage('pane-transcript-received', {
          taskId: address.taskId,
          deviceId: address.deviceId,
          cancelled,
          messageCount: transcript.messages.length,
          turnCount: transcript.turns.length,
        })
        if (!cancelled) {
          const preserveActiveTurn =
            getRuntimeConversationTurns(address) !== turnsAtLoadStart &&
            (lifecycleStore.getTask(address)?.derived.isRunning ?? false) &&
            !runtimeConversationSnapshotSettlesLatestTurn(address, transcript.turns)
          lifecycleStore.syncTranscript(address, transcript, { preserveActiveTurn })
          const nextMessages = getRuntimeConversationMessages(address)
          loadedRuntimeTranscriptKeyRef.current = loadKey
          setTranscriptFullContent(transcript.fullContent === true)
          setTranscriptHasMoreBefore(runtimeTranscriptHasMoreBefore(transcript))
          setTranscriptBeforeCursor(transcript.beforeCursor ?? null)
          setLoadedTranscriptRanges(transcriptRangeFromPage(transcript))
          setTurnNavigation(transcript.turnNavigation ?? [])
          debugRuntimePaneMessageFlow('transcript-load-resolved', {
            address: runtimeAddressDebug(address),
            key: loadKey,
            transcriptCount: transcript.messages.length,
            seededCount: seededMessages.length,
            resetSource: transcript.messages.length > 0 ? 'transcript' : 'seed',
            nextMessages: summarizeWorkbenchMessages(nextMessages),
          })
          if (
            transcript.runtime === 'codex' &&
            transcript.fullContent !== true &&
            runtimeTranscriptHasMoreBefore(transcript) &&
            (!transcript.turnNavigation || transcript.turnNavigation.length === 0)
          ) {
            cancelNavigationLoad = scheduleRuntimeTurnNavigationLoad(() => {
              void loadRuntimeTranscriptForPaneRef
                .current(address, { navigationOnly: true })
                .then(navigationTranscript => {
                  if (!cancelled && navigationTranscript.turnNavigation) {
                    setTurnNavigation(navigationTranscript.turnNavigation)
                  }
                })
                .catch(error => {
                  if (!cancelled) {
                    console.error('[Wework] Runtime turn navigation load failed', {
                      address,
                      error,
                    })
                  }
                })
            })
          }
        }
      })
      .catch(error => {
        if (error instanceof SupersededConversationRead) return
        if (!cancelled) {
          loadedRuntimeTranscriptKeyRef.current = null
          setTranscriptFullContent(false)
          setTranscriptHasMoreBefore(false)
          setTranscriptBeforeCursor(null)
          setLoadedTranscriptRanges([])
          setTurnNavigation([])
          setTranscriptError(error instanceof Error ? error.message : String(error))
          console.error('[Wework] Runtime pane transcript load failed', {
            key: loadKey,
            address,
            error,
          })
        }
      })
      .finally(() => {
        debugRuntimePaneMessageFlow('transcript-load-settled', {
          key: loadKey,
          cancelled,
          activeKey: runtimeTaskLoadTargetRef.current?.key,
        })
        if (!cancelled) {
          setTranscriptLoadingKey(current => (current === loadKey ? null : current))
        }
      })

    return () => {
      debugRuntimePaneMessageFlow('transcript-load-cancelled', {
        key: loadKey,
        activeKey: runtimeTaskLoadTargetRef.current?.key,
      })
      cancelled = true
      cancelNavigationLoad()
    }
  }, [lifecycleStore, runtimeTaskLoadTarget, runtimeTranscriptPageSize, transcriptReloadVersion])
  const reloadRuntimeTranscript = useCallback(() => {
    loadedRuntimeTranscriptKeyRef.current = null
    setTranscriptError(null)
    setTranscriptReloadVersion(version => version + 1)
  }, [])

  const loadMoreTranscriptBefore = useCallback(async () => {
    if (
      !runtimeTaskLoadTarget ||
      !transcriptBeforeCursor ||
      transcriptLoadingMoreBefore ||
      transcriptFullContent
    )
      return

    const { key: loadKey, address } = runtimeTaskLoadTarget
    const beforeCursor = transcriptBeforeCursor
    setTranscriptLoadingMoreBeforeKey(loadKey)
    try {
      const transcript = await loadRuntimeTranscriptForPaneRef.current(address, {
        limit: runtimeTranscriptPageSize,
        beforeCursor,
      })
      if (runtimeTaskLoadTargetRef.current?.key !== loadKey) return
      setTranscriptError(null)
      const nextRanges = mergeTranscriptRanges(
        loadedTranscriptRangesRef.current,
        transcriptRangeFromPage(transcript)
      )
      setTranscriptHasMoreBefore(runtimeTranscriptHasMoreBefore(transcript))
      setTranscriptBeforeCursor(transcript.beforeCursor ?? null)
      setLoadedTranscriptRanges(nextRanges)
      setTurnNavigation(current =>
        transcript.turnNavigation && transcript.turnNavigation.length > 0
          ? transcript.turnNavigation
          : current
      )
    } catch (error) {
      if (runtimeTaskLoadTargetRef.current?.key !== loadKey) return
      setTranscriptError(error instanceof Error ? error.message : String(error))
      console.error('[Wework] Runtime pane older transcript load failed', {
        key: loadKey,
        address,
        beforeCursor,
        error,
      })
    } finally {
      setTranscriptLoadingMoreBeforeKey(current => (current === loadKey ? null : current))
    }
  }, [
    runtimeTaskLoadTarget,
    runtimeTranscriptPageSize,
    transcriptBeforeCursor,
    transcriptFullContent,
    transcriptLoadingMoreBefore,
  ])

  const loadTranscriptTurnNavigationItem = useCallback(
    async (item: RuntimeTurnNavigationItem) => {
      if (!runtimeTaskLoadTarget || !item.cursor) {
        return
      }
      if (transcriptFullContent) {
        return
      }
      if (messagesRef.current.some(message => message.id === item.id)) {
        return
      }

      const { key: loadKey, address } = runtimeTaskLoadTarget
      const loadOptions = runtimeTurnNavigationLoadOptions(
        item,
        loadedTranscriptRangesRef.current,
        runtimeTranscriptPageSize
      )
      const transcript = await loadRuntimeTranscriptForPaneRef.current(address, loadOptions)
      if (runtimeTaskLoadTargetRef.current?.key !== loadKey) return
      const nextHasMoreBefore =
        loadOptions.beforeCursor === undefined
          ? transcriptHasMoreBefore
          : runtimeTranscriptHasMoreBefore(transcript)
      const nextBeforeCursor =
        loadOptions.beforeCursor === undefined
          ? transcriptBeforeCursor
          : (transcript.beforeCursor ?? null)
      const nextRanges = mergeTranscriptRanges(
        loadedTranscriptRangesRef.current,
        transcriptRangeFromPage(transcript)
      )
      setTranscriptHasMoreBefore(nextHasMoreBefore)
      setTranscriptBeforeCursor(nextBeforeCursor)
      setLoadedTranscriptRanges(nextRanges)
      setTurnNavigation(current =>
        transcript.turnNavigation && transcript.turnNavigation.length > 0
          ? transcript.turnNavigation
          : current
      )
    },
    [
      runtimeTaskLoadTarget,
      runtimeTranscriptPageSize,
      transcriptBeforeCursor,
      transcriptFullContent,
      transcriptHasMoreBefore,
    ]
  )

  const loadTranscriptGap = useCallback(
    async (gap: LoadedTranscriptRange) => {
      if (!runtimeTaskLoadTarget || transcriptFullContent || gap.end <= gap.start) return

      const { key: loadKey, address } = runtimeTaskLoadTarget
      const limit = Math.min(runtimeTranscriptPageSize, gap.end - gap.start)
      const loadOptions = {
        limit,
        afterCursor: `offset:${gap.start}`,
      }
      const transcript = await loadRuntimeTranscriptForPaneRef.current(address, loadOptions)
      if (runtimeTaskLoadTargetRef.current?.key !== loadKey) return
      const nextRanges = mergeTranscriptRanges(
        loadedTranscriptRangesRef.current,
        transcriptRangeFromPage(transcript)
      )
      setLoadedTranscriptRanges(nextRanges)
      setTurnNavigation(current =>
        transcript.turnNavigation && transcript.turnNavigation.length > 0
          ? transcript.turnNavigation
          : current
      )
    },
    [runtimeTaskLoadTarget, runtimeTranscriptPageSize, transcriptFullContent]
  )

  const conversationSearch = useRuntimeConversationSearch({
    target: runtimeTaskLoadTarget,
    targetRef: runtimeTaskLoadTargetRef,
    searchTranscript: searchRuntimeTranscriptForPane,
    loadTranscript: loadRuntimeTranscriptForPane,
  })

  const getRuntimeModelFields = useCallback(
    (modelOptionsOverride?: ModelOptions) => {
      const selectedModel =
        projectChat.getSelectedModel?.() ??
        projectChat.selectedModel ??
        resolveAutomaticModel(projectChat.models)
      const selectedModelOptions =
        projectChat.getSelectedModelOptions?.() ?? projectChat.selectedModelOptions
      return selectedModelExecutionFields(selectedModel, {
        ...selectedModelOptions,
        ...modelOptionsOverride,
      })
    },
    [projectChat]
  )

  const appendLocalUserMessage = useCallback(
    (content: string, attachments?: Attachment[], options?: RuntimeUserMessageOptions) => {
      dispatchMessages({
        type: 'user_added',
        message: createRuntimeUserMessage(content, attachments, options),
      })
    },
    [dispatchMessages]
  )

  const applyLocalRequestUserInputResponse = useCallback(
    (response: RequestUserInputResponse) => {
      if (!currentRuntimeTask) return
      const previousCount = messagesRef.current.length
      const nextMessages = updateRuntimeConversationBlocks(currentRuntimeTask, block =>
        applyRequestUserInputResponseToBlock(block, response)
      )
      debugRuntimePaneMessageFlow('request-user-input-response-applied', {
        address: runtimeAddressDebug(currentRuntimeTask),
        requestUserInputKey: requestUserInputResponseKey(response),
        previousCount,
        nextCount: nextMessages.length,
        nextMessages: summarizeWorkbenchMessages(nextMessages),
      })
    },
    [currentRuntimeTask]
  )

  const sendRuntimeMessage = useCallback(
    async (
      message: RuntimePaneQueuedMessage,
      options: SendRuntimeMessageOptions = {}
    ): Promise<RuntimeMessageSendResult> => {
      if (!currentRuntimeTask) return { accepted: false, queued: false }
      const operation = beginRuntimeConversationOperation(currentRuntimeTask)
      try {
        const appendedLocalMessage = options.appendLocalMessage !== false
        if (appendedLocalMessage) {
          applyRuntimeConversationAction(currentRuntimeTask, {
            type: 'user_added',
            message: createRuntimeQueuedUserMessage(message),
          })
        }
        const result = await sendRuntimeQueuedMessage(
          currentRuntimeTask,
          message,
          { lifecycleStore, sendRuntimePaneMessage },
          {
            ...options,
            isCurrent: operation.isCurrent,
            appendAcceptedMessage: !appendedLocalMessage,
            onError: options.onError ?? setError,
          }
        )
        if (!operation.isCurrent()) return { accepted: false, queued: false }
        const { accepted: sent, queued } = result
        if ((!sent || queued) && appendedLocalMessage) {
          rollbackRejectedRuntimeConversationTurn(
            currentRuntimeTask,
            currentRuntimeTaskRef.current,
            message.id
          )
        }
        return result
      } finally {
        operation.dispose()
      }
    },
    [currentRuntimeTask, lifecycleStore, sendRuntimePaneMessage, setError]
  )

  const retainRuntimeQueuedMessage = useCallback(
    (message: RuntimePaneQueuedMessage, queuePosition?: number | null) => {
      if (currentRuntimeTask) retainQueuedMessage(currentRuntimeTask, message, queuePosition)
    },
    [currentRuntimeTask]
  )

  const interruptAndSendQueuedMessage = useCallback(
    async (message: RuntimePaneQueuedMessage): Promise<boolean> => {
      if (!currentRuntimeTask) return false
      if (interruptAndSendInFlightRef.current) return false
      interruptAndSendInFlightRef.current = true
      const interruptedGuidanceIds = new Set<string>()
      const interruptedGuidances = queuedMessages.filter(isInterruptedGuidance)
      interruptedGuidances.forEach(guidance => {
        interruptedGuidanceIds.add(guidance.id)
        const id = guidance.id
        removeOptimisticRuntimeConversationGuidance(currentRuntimeTask, id)
      })
      markRuntimeConversationGuidanceInterrupted(currentRuntimeTask, interruptedGuidanceIds)
      const interruptedTurn = optimisticallyInterruptRuntimeConversation(currentRuntimeTask)
      setQueuedMessages(messages => [
        ...messages.filter(item => item.id !== message.id),
        { ...message, status: 'sending', notice: '正在打断并发送' },
      ])
      const messageAttachments = message.attachments ?? []
      const attachmentIds = remoteAttachmentIds(messageAttachments)
      const attachments = localRuntimeAttachments(messageAttachments)
      const terminalContext = readRuntimeTerminalAdditionalContext(currentRuntimeTask)
      const additionalContext = { ...message.additionalContext, ...terminalContext }
      appendLocalUserMessage(message.displayContent ?? message.content, message.attachments, {
        id: message.id,
        createdAt: message.createdAt,
        runtimeGoalRequest: message.runtimeGoalRequest,
        codeComments: message.codeComments,
      })
      const sent = await interruptAndSendRuntimePaneMessage(
        {
          address: currentRuntimeTask,
          message: message.content,
          clientUserMessageId: message.id,
          ...(message.modelId ? { modelId: message.modelId, modelType: message.modelType } : {}),
          ...(message.modelOptions ? { modelOptions: message.modelOptions } : {}),
          ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
          ...(attachments.length > 0 ? { attachments } : {}),
          ...(Object.keys(additionalContext).length > 0 ? { additionalContext } : {}),
          ...(message.cloudProjectId ? { cloudProjectId: message.cloudProjectId } : {}),
          ...(message.origin ? { origin: message.origin } : {}),
        },
        { onError: setError }
      )
      interruptAndSendInFlightRef.current = false
      if (!sent) {
        if (interruptedTurn) {
          restoreOptimisticallyInterruptedRuntimeConversation(currentRuntimeTask, interruptedTurn)
          if (interruptedTurn.turnId) {
            interruptedGuidances.forEach(guidance => {
              appendOptimisticRuntimeConversationGuidance(
                currentRuntimeTask,
                interruptedTurn.turnId!,
                guidance
              )
            })
          }
        }
        clearInterruptedRuntimeConversationGuidanceExcept(currentRuntimeTask, message.id)
        setQueuedMessages(messages =>
          messages
            .filter(item => item.id !== message.id)
            .map(item =>
              interruptedGuidanceIds.has(item.id) && !isInterruptedGuidance(item)
                ? { ...item, status: 'queued', notice: undefined }
                : item
            )
        )
        removeRuntimeConversationTurn(currentRuntimeTask, {
          clientUserMessageId: message.id,
        })
        return false
      }

      markRuntimeTerminalAdditionalContextDelivered(terminalContext)
      setQueuedMessages(messages =>
        messages.filter(item => item.id !== message.id && !interruptedGuidanceIds.has(item.id))
      )
      return true
    },
    [
      appendLocalUserMessage,
      currentRuntimeTask,
      interruptAndSendRuntimePaneMessage,
      queuedMessages,
      setError,
      setQueuedMessages,
    ]
  )

  const dispatchContinuation = useCallback(
    async (input: string, displayContent?: string): Promise<boolean> => {
      if (!currentRuntimeTask) return false
      const message: RuntimePaneQueuedMessage = {
        id: `runtime-retry-continuation-${crypto.randomUUID()}`,
        content: input,
        ...(displayContent === undefined ? {} : { displayContent }),
        status: 'queued',
        createdAt: new Date().toISOString(),
        ...getRuntimeModelFields(),
      }
      const lifecycleBeforeSend = lifecycleStore.getTask(currentRuntimeTask)
      let sendError: string | null = null
      const result = await sendRuntimeMessage(message, {
        appendLocalMessage: false,
        onError: error => {
          sendError = error
        },
      })
      if (result.queued) retainRuntimeQueuedMessage(message, result.queuePosition)
      if (result.accepted) return true
      if (!isRuntimeTaskBusyError(sendError)) {
        setError(sendError ?? i18n.t('workbench.project_chat_send_failed'))
        return false
      }
      const lifecycleAfterSend = lifecycleStore.getTask(currentRuntimeTask)
      if (!runtimeTaskLifecycleTransitionChanged(lifecycleBeforeSend, lifecycleAfterSend)) {
        queuedMessageBusyBlocks.set(message.id, lifecycleBeforeSend)
      }
      setQueuedMessages(messages => [...messages, message])
      return true
    },
    [
      currentRuntimeTask,
      getRuntimeModelFields,
      lifecycleStore,
      queuedMessageBusyBlocks,
      retainRuntimeQueuedMessage,
      sendRuntimeMessage,
      setError,
      setQueuedMessages,
    ]
  )

  const sendContinuation = useCallback(
    async (input: string, displayContent?: string): Promise<boolean> => {
      if (!currentRuntimeTask || !input.trim() || continuationInFlightRef.current) return false
      continuationInFlightRef.current = true
      setError(null)
      try {
        return await dispatchContinuation(input.trim(), displayContent)
      } catch (error) {
        setError(
          error instanceof Error ? error.message : i18n.t('workbench.project_chat_send_failed')
        )
        return false
      } finally {
        continuationInFlightRef.current = false
      }
    },
    [currentRuntimeTask, dispatchContinuation, setError]
  )

  const retryFailedMessageInPane = useCallback(
    async (message: WorkbenchMessage): Promise<boolean> => {
      if (!currentRuntimeTask || continuationInFlightRef.current) return false
      const failedMessage = messagesRef.current.find(
        currentMessage =>
          currentMessage.id === message.id &&
          currentMessage.role === 'assistant' &&
          currentMessage.status === 'failed'
      )
      if (!failedMessage) {
        setError('未找到可重试的失败消息')
        return false
      }
      debugRuntimePaneMessageFlow('retry-failed-message', {
        address: runtimeAddressDebug(currentRuntimeTask),
        failedMessageId: message.id,
        failedTurnId: failedMessage.turnId ?? failedMessage.subtaskId ?? null,
      })
      return sendContinuation(
        RUNTIME_RETRY_CONTINUATION_PROMPT,
        i18n.t('workbench.retry_continue_message', '继续')
      )
    },
    [currentRuntimeTask, sendContinuation, setError]
  )

  const editLastUserMessageInPane = useCallback(
    async (message: WorkbenchMessage, content: string): Promise<boolean> => {
      const submittedContent = content.trim()
      if (!submittedContent) return false
      if (!currentRuntimeTask) return false
      if (paneStatus.isBusy) {
        setError('当前回复仍在进行中，完成后再编辑')
        return false
      }

      const currentMessages = messagesRef.current
      const messageIndex = currentMessages.findIndex(item => item.id === message.id)
      if (!isEditableLastUserMessage(currentMessages, messageIndex)) {
        setError('只能编辑最后一轮已完成的问题')
        return false
      }

      const previousTurns = getRuntimeConversationTurns(currentRuntimeTask)
      const messageAttachments = message.attachments ?? []
      const attachmentIds = remoteAttachmentIds(messageAttachments)
      const attachments = localRuntimeAttachments(messageAttachments)
      const additionalContext = readRuntimeTerminalAdditionalContext(currentRuntimeTask)
      const editedMessage = createRuntimeUserMessage(submittedContent, messageAttachments, {
        runtimeGoalRequest: message.runtimeGoalRequest === true,
      })
      const request: RuntimeRollbackRequest = {
        address: currentRuntimeTask,
        message: submittedContent,
        messageId: message.id,
        clientUserMessageId: editedMessage.id,
        retrySourceTurnId: message.turnId ?? message.subtaskId,
        ...getRuntimeModelFields(),
        ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
        ...(attachments.length > 0 ? { attachments } : {}),
        ...(additionalContext ? { additionalContext } : {}),
      }

      replaceRuntimeConversationFromUserMessage(currentRuntimeTask, message.id, {
        ...editedMessage,
        role: 'user',
      })
      try {
        const sent = await editLastUserMessage(request)
        if (sent) {
          markRuntimeTerminalAdditionalContextDelivered(additionalContext)
          return true
        }
        await loadRuntimeTranscriptForPaneRef.current(currentRuntimeTask, {
          limit: runtimeTranscriptPageSize,
          refresh: true,
        })
        removeRuntimeConversationTurn(currentRuntimeTask, {
          clientUserMessageId: editedMessage.id,
        })
        return false
      } catch (error) {
        const transcript = await loadRuntimeTranscriptForPaneRef
          .current(currentRuntimeTask, {
            limit: runtimeTranscriptPageSize,
            refresh: true,
          })
          .catch(() => null)
        removeRuntimeConversationTurn(currentRuntimeTask, {
          clientUserMessageId: editedMessage.id,
        })
        if (!transcript) {
          replaceRuntimeConversationSnapshot(currentRuntimeTask, previousTurns)
        }
        console.error('[Wework] Runtime last user message edit failed', {
          address: runtimeAddressDebug(currentRuntimeTask),
          messageId: message.id,
          error,
        })
        setError('编辑失败')
        return false
      }
    },
    [
      currentRuntimeTask,
      editLastUserMessage,
      getRuntimeModelFields,
      paneStatus.isBusy,
      runtimeTranscriptPageSize,
      setError,
    ]
  )

  const ignoreRequestUserInput = useCallback(
    async (payload: RequestUserInputPayload) => {
      const requestUserInputKey = requestUserInputPayloadKey(payload)
      if (requestUserInputKey) {
        setAnsweredRequestUserInputIds(current => {
          if (current.has(requestUserInputKey)) return current
          const next = new Set(current)
          next.add(requestUserInputKey)
          return next
        })
      }

      if (!currentRuntimeTask) {
        return
      }

      const cancelled = await cancelRuntimePaneTask(currentRuntimeTask)
      if (!cancelled) {
        if (requestUserInputKey) {
          setAnsweredRequestUserInputIds(current => {
            if (!current.has(requestUserInputKey)) return current
            const next = new Set(current)
            next.delete(requestUserInputKey)
            return next
          })
        }
        return
      }

      if (!activeAssistantMessage) return
      const activeTurnId = activeAssistantMessage.turnId ?? activeAssistantMessage.subtaskId
      if (!activeTurnId) return

      dispatchMessages({
        type: 'assistant_cancelled',
        subtaskId: activeTurnId,
      })
    },
    [activeAssistantMessage, cancelRuntimePaneTask, currentRuntimeTask, dispatchMessages]
  )

  const sendQueuedMessage = useCallback(
    async (message: RuntimePaneQueuedMessage) => {
      await queueController?.send(message)
    },
    [queueController]
  )

  const loadFullTranscriptForExport = useCallback(async () => {
    if (!runtimeTaskLoadTarget) return messagesRef.current

    const transcript = await loadRuntimeTranscriptForPaneRef.current(
      runtimeTaskLoadTarget.address,
      {
        includeFullContent: true,
        refresh: true,
      }
    )
    if (transcript.fullContent !== true) {
      throw new Error('The complete task transcript is unavailable')
    }
    return transcript.messages.length > 0 ? transcript.messages : messagesRef.current
  }, [runtimeTaskLoadTarget])

  const sendQueuedMessageAsGuidance = useCallback(
    async (queuedMessage: RuntimePaneQueuedMessage, forceActiveTurn = false): Promise<boolean> => {
      const id = queuedMessage.id
      queuedMessageBusyBlocks.delete(id)
      if (!currentRuntimeTask) {
        setQueuedMessages(messages =>
          messages.map(message =>
            message.id === id
              ? { ...message, status: 'failed', error: '当前回复缺少引导上下文' }
              : message
          )
        )
        return false
      }
      if (currentRuntimeTask.runtime && currentRuntimeTask.runtime !== 'codex') return false

      if (queuedMessage.status === 'sending') return false

      setError(null)
      if (!readCurrentPaneBusy() && !forceActiveTurn) {
        setQueuedMessages(messages =>
          messages.map(message =>
            message.id === id
              ? { ...message, status: 'sending', error: undefined, notice: undefined }
              : message
          )
        )
        try {
          const result = await sendRuntimeMessage(queuedMessage)
          if (result.queued) {
            retainRuntimeQueuedMessage(queuedMessage, result.queuePosition)
            return true
          }
          setQueuedMessages(messages =>
            result.accepted
              ? messages.filter(message => message.id !== id)
              : messages.map(message =>
                  message.id === id
                    ? { ...message, status: 'failed', notice: undefined, error: '发送失败' }
                    : message
                )
          )
          return result.accepted
        } catch (error) {
          console.error('[Wework] Queued runtime message send failed', {
            id,
            error,
          })
          setQueuedMessages(messages =>
            messages.map(message =>
              message.id === id
                ? { ...message, status: 'failed', notice: undefined, error: '发送失败' }
                : message
            )
          )
          return false
        }
      }

      try {
        const additionalContext = readRuntimeTerminalAdditionalContext(currentRuntimeTask)
        const messageAttachments = queuedMessage.attachments ?? []
        const attachmentIds = remoteAttachmentIds(messageAttachments)
        const attachments = localRuntimeAttachments(messageAttachments)
        const guidanceRequest = sendRuntimePaneGuidance({
          address: currentRuntimeTask,
          message: queuedMessage.content,
          clientGuidanceId: id,
          ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
          ...(attachments.length > 0 ? { attachments } : {}),
          ...(additionalContext ? { additionalContext } : {}),
        })
        setQueuedMessages(messages =>
          messages.map(message =>
            message.id === id
              ? {
                  ...message,
                  status: 'sending',
                  deliveryMode: 'guidance',
                  awaitingGuidanceAcceptance: true,
                  error: undefined,
                  notice: '正在引导当前对话',
                }
              : message
          )
        )
        const result = await guidanceRequest
        if (result.sent) {
          setQueuedMessages(messages =>
            messages.map(message =>
              message.id === id ? { ...message, awaitingGuidanceAcceptance: undefined } : message
            )
          )
          markRuntimeTerminalAdditionalContextDelivered(additionalContext)
          if (result.turnId) {
            appendOptimisticRuntimeConversationGuidance(
              currentRuntimeTask,
              result.turnId,
              queuedMessage
            )
          }
          return true
        }
        removeOptimisticRuntimeConversationGuidance(currentRuntimeTask, id)
        if (takeInterruptedRuntimeConversationGuidance(currentRuntimeTask, id)) {
          setQueuedMessages(messages => messages.filter(message => message.id !== id))
          return true
        }
        setQueuedMessages(messages =>
          messages.map(message =>
            message.id === id
              ? {
                  ...message,
                  status: 'failed',
                  awaitingGuidanceAcceptance: undefined,
                  notice: undefined,
                  error: '引导发送失败',
                }
              : message
          )
        )
        return false
      } catch (error) {
        removeOptimisticRuntimeConversationGuidance(currentRuntimeTask, id)
        if (takeInterruptedRuntimeConversationGuidance(currentRuntimeTask, id)) {
          setQueuedMessages(messages => messages.filter(message => message.id !== id))
          return true
        }
        console.error('[Wework] Queued guidance send failed', {
          id,
          error,
        })
        setQueuedMessages(messages =>
          messages.map(message =>
            message.id === id
              ? {
                  ...message,
                  status: 'failed',
                  awaitingGuidanceAcceptance: undefined,
                  notice: undefined,
                  error: '引导发送失败',
                }
              : message
          )
        )
        return false
      }
    },
    [
      currentRuntimeTask,
      readCurrentPaneBusy,
      queuedMessageBusyBlocks,
      retainRuntimeQueuedMessage,
      sendRuntimeMessage,
      sendRuntimePaneGuidance,
      setError,
      setQueuedMessages,
    ]
  )

  const sendRequestUserInputResponse = useCallback(
    async (
      response: RequestUserInputResponse,
      options: SendRequestUserInputResponseOptions = {}
    ): Promise<boolean> => {
      if (!currentRuntimeTask) return false

      const message = requestUserInputResponseText(response)
      const requestUserInputKey = requestUserInputResponseKey(response)
      const operation = beginRuntimeConversationOperation(currentRuntimeTask, {
        requestUserInputKey,
      })
      try {
        const runtimeModelOverride = options.forceDefaultCollaborationMode
          ? { collaborationMode: 'default' }
          : undefined
        if (options.forceDefaultCollaborationMode) {
          projectChat.setSelectedModelOption('collaborationMode', 'default')
        }
        // A question that is answered by the next user message - a non-blocking
        // Codex question or an implementation-plan confirmation - is delivered like
        // any other user message. Codex then steers the running turn while the model
        // is still working and starts a new turn once it has stopped, instead of
        // rejecting the answer for arriving mid-turn.
        const answerIsUserMessage =
          options.appendUserMessage ||
          isAsyncRequestUserInputPayload(
            findRequestUserInputPayload(messagesRef.current, requestUserInputKey)
          )
        if (answerIsUserMessage) {
          const answerMessage: RuntimePaneQueuedMessage = {
            id: `queued-runtime-pane-${Date.now()}-${queuedMessages.length}`,
            content: message,
            status: 'queued',
            createdAt: new Date().toISOString(),
            ...getRuntimeModelFields(runtimeModelOverride),
          }
          setQueuedMessages(messages => [...messages, answerMessage])
          if (!(await sendQueuedMessageAsGuidance(answerMessage))) return false
        } else {
          const additionalContext = readRuntimeTerminalAdditionalContext(currentRuntimeTask)
          const sent = await sendRuntimePaneMessage({
            address: currentRuntimeTask,
            message,
            requestUserInputResponse: response,
            ...(additionalContext ? { additionalContext } : {}),
          })
          if (!sent) return false
          markRuntimeTerminalAdditionalContextDelivered(additionalContext)
        }
        if (!operation.isCurrent()) return false
        if (answerIsUserMessage) lifecycleStore.userInputResponded(currentRuntimeTask)
        if (requestUserInputKey) {
          setAnsweredRequestUserInputIds(current => {
            if (current.has(requestUserInputKey)) return current
            const next = new Set(current)
            next.add(requestUserInputKey)
            return next
          })
        }
        applyLocalRequestUserInputResponse(response)
        return true
      } finally {
        operation.dispose()
      }
    },
    [
      applyLocalRequestUserInputResponse,
      currentRuntimeTask,
      getRuntimeModelFields,
      lifecycleStore,
      projectChat,
      queuedMessages.length,
      sendQueuedMessageAsGuidance,
      sendRuntimePaneMessage,
      setAnsweredRequestUserInputIds,
      setQueuedMessages,
    ]
  )

  const send: (inputOverride?: string, options?: RuntimePaneSendOptions) => Promise<boolean> =
    useCallback(
      async (inputOverride, options = {}) => {
        const submittedInput = (inputOverride ?? input).trim()
        // Capture the rendered revision, before asynchronous submission preparation.
        let submittedInputRevision = inputRevision
        let submittedSharedInputRevision = sharedInputRevision
        const ownsSubmittedInput = () =>
          getInputRevisionForScope(inputScopeKey) === submittedSharedInputRevision &&
          inputRevisionRef.current === submittedInputRevision &&
          activeInputScopeRef.current === inputScopeKey
        const clearSubmittedInput = () => {
          if (!mountedRef.current || !ownsSubmittedInput()) return
          setInput('')
          submittedInputRevision = inputRevisionRef.current
          submittedSharedInputRevision = getInputRevisionForScope(inputScopeKey)
        }
        const restoreSubmittedInput = (scopeKey: string, value: string) => {
          if (ownsSubmittedInput()) setInputForScope(scopeKey, value)
        }
        const currentAttachments = attachmentState.attachments
        const hasCodeComments = codeCommentContexts.length > 0
        const paneIsBusy = readCurrentPaneBusy()
        debugComposerEvent('pane-send-called', {
          hasSubmittedValue: inputOverride !== undefined,
          submittedValue: textMetrics(inputOverride),
          stateInput: textMetrics(input),
          submittedInput: textMetrics(submittedInput),
          attachmentsCount: currentAttachments.length,
          codeCommentsCount: codeCommentContexts.length,
          hasCodeComments,
          goalDraftActive,
          guideWhenBusy: options.guideWhenBusy === true,
          interruptWhenBusy: options.interruptWhenBusy === true,
          hasCurrentRuntimeTask: Boolean(currentRuntimeTask),
          paneBusy: paneIsBusy,
        })

        if (goalDraftActive) {
          if (!submittedInput) {
            setError(i18n.t('workbench.goal_objective_required'))
            return false
          }
          if (hasCodeComments) {
            setError(i18n.t('workbench.runtime_task_code_comments_not_supported'))
            return false
          }

          // Errors belong to the previous action; a new goal submission starts fresh.
          setError(null)
          if (currentRuntimeTask) {
            const draftGoal = createPendingRuntimeGoal(submittedInput)
            const initialGoal = runtimeGoalCreateInput(draftGoal)
            const baseMessage: RuntimePaneQueuedMessage = {
              id: `queued-runtime-pane-${Date.now()}-${queuedMessages.length}`,
              content: submittedInput,
              status: 'queued',
              createdAt: new Date().toISOString(),
              attachments: persistAttachmentReferences(currentAttachments),
              runtimeGoalRequest: true,
              additionalContext: options.additionalContext,
              cloudProjectId: options.cloudProjectId,
              origin: options.origin,
              ...getRuntimeModelFields(),
            }

            resetAttachments()
            if (paneIsBusy && options.guideWhenBusy) {
              const response = await setRuntimeGoal({
                address: currentRuntimeTask,
                objective: submittedInput,
                status: 'active',
              })
              if (!response.accepted) {
                currentAttachments.forEach(addExistingAttachment)
                setError(response.error || i18n.t('workbench.goal_set_failed'))
                return false
              }
              clearSubmittedInput()
              syncRuntimeGoal(lifecycleStore, currentRuntimeTask, response.goal)
              setGoalDraftActive(false)
              setQueuedMessages(messages => [...messages, baseMessage])
              await sendQueuedMessageAsGuidance(baseMessage, true)
              return true
            }

            const queuedMessage: RuntimePaneQueuedMessage = {
              ...baseMessage,
              initialGoal,
            }
            if (paneIsBusy) {
              clearSubmittedInput()
              syncRuntimeGoal(lifecycleStore, currentRuntimeTask, draftGoal)
              setGoalDraftActive(false)
              setQueuedMessages(messages => [...messages, queuedMessage])
              return true
            }

            let sendError: string | null = null
            const result = await sendRuntimeMessage(queuedMessage, {
              initialGoal,
              onError: nextError => {
                sendError = nextError
              },
            })
            if (result.queued) {
              retainRuntimeQueuedMessage(queuedMessage, result.queuePosition)
            }
            if (result.accepted) {
              clearSubmittedInput()
              syncRuntimeGoal(lifecycleStore, currentRuntimeTask, draftGoal)
              setGoalDraftActive(false)
              clearCodeCommentsAfterCommit('send_success', codeCommentContexts)
            } else {
              currentAttachments.forEach(addExistingAttachment)
              setError(sendError ?? i18n.t('workbench.project_chat_send_failed'))
            }
            return result.accepted
          }

          const draftGoal = createPendingRuntimeGoal(submittedInput)
          const initialGoal = runtimeGoalCreateInput(draftGoal)
          clearSubmittedInput()
          setPendingGoalState({ goal: draftGoal, targetKey: null, targetIdentityKey: null })
          setGoalDraftActive(false)
          const optimisticMessage = createRuntimeUserMessage(submittedInput, currentAttachments, {
            runtimeGoalRequest: true,
          })
          let seededGoalAddress: RuntimeTaskAddress | null = null
          let errorScopeKey = inputScopeKey
          const sent = await sendCurrentInput(submittedInput, {
            optimisticUserMessage: optimisticMessage,
            initialGoal,
            additionalContext: options.additionalContext,
            cloudProjectId: options.cloudProjectId,
            origin: options.origin,
            initialSupervisor: options.initialSupervisor,
            ...(options.runtime ? { runtime: options.runtime } : {}),
            ...(options.runtimeExecutablePath
              ? { runtimeExecutablePath: options.runtimeExecutablePath }
              : {}),
            ...(options.runtimePermissionMode
              ? { runtimePermissionMode: options.runtimePermissionMode }
              : {}),
            ...(options.wegentTeamId ? { wegentTeamId: options.wegentTeamId } : {}),
            ...(Object.prototype.hasOwnProperty.call(options, 'modelSelection')
              ? { modelSelection: options.modelSelection }
              : {}),
            onError: nextError => setErrorForScope(errorScopeKey, nextError),
            onRuntimeTaskOptimisticOpen: (address, context) => {
              errorScopeKey = getRuntimeTaskChatScopeKey(address)
              options.onRuntimeTaskCreated?.(address)
              setPendingGoalState(current =>
                current
                  ? {
                      ...current,
                      targetKey: runtimeTranscriptPaneKey(address),
                      targetIdentityKey: runtimeTranscriptPaneIdentityKey(address),
                    }
                  : current
              )
              seedRuntimePaneGoal(address, draftGoal)
              seededGoalAddress = address
              debugRuntimePaneMessageFlow('seed-goal-first-open', {
                address: runtimeAddressDebug(address),
                previousAddress: context?.previousAddress
                  ? runtimeAddressDebug(context.previousAddress)
                  : null,
                seededMessages: summarizeWorkbenchMessages([optimisticMessage]),
              })
            },
          })
          if (sent) {
            clearSubmittedInput()
            if (!isRuntimeTaskAddress(sent)) {
              appendLocalUserMessage(submittedInput, currentAttachments, {
                runtimeGoalRequest: true,
              })
            } else {
              options.onRuntimeTaskReady?.(sent)
              setPendingGoalState(current =>
                current
                  ? {
                      ...current,
                      targetKey: runtimeTranscriptPaneKey(sent),
                      targetIdentityKey: runtimeTranscriptPaneIdentityKey(sent),
                    }
                  : current
              )
            }
          } else {
            if (seededGoalAddress) {
              clearRuntimePaneGoalSeed(seededGoalAddress)
            }
            restoreSubmittedInput(inputScopeKey, submittedInput)
            setGoalDraftActive(true)
            setPendingGoalState(null)
          }
          return Boolean(sent)
        }

        if (submittedInput === '/compact') {
          if (!currentRuntimeTask) {
            setError('当前对话还没有可压缩的 Codex 线程')
            return false
          }
          if (paneIsBusy) {
            setError('当前回复进行中，完成后再压缩上下文')
            return false
          }
          if (currentAttachments.length > 0 || hasCodeComments) {
            setError('/compact 不能和附件或代码评论一起发送')
            return false
          }
          if (currentRuntimeTask.runtime === 'codex') {
            const compacted = await compactRuntimePaneTask(currentRuntimeTask, {
              onError: setError,
            })
            if (compacted) clearSubmittedInput()
            return compacted
          }
        }

        const pendingInitialGoal =
          !currentRuntimeTask && pendingGoalState && isUnboundPendingGoalState(pendingGoalState)
            ? runtimeGoalCreateInput(pendingGoalState.goal)
            : null
        const effectiveSubmittedInput = submittedInput || pendingInitialGoal?.objective.trim() || ''
        if (!effectiveSubmittedInput && currentAttachments.length === 0 && !hasCodeComments) {
          void sendCurrentInput('', {
            codeCommentContexts,
            additionalContext: options.additionalContext,
            cloudProjectId: options.cloudProjectId,
            origin: options.origin,
            ...(options.runtime ? { runtime: options.runtime } : {}),
            ...(options.runtimeExecutablePath
              ? { runtimeExecutablePath: options.runtimeExecutablePath }
              : {}),
            ...(options.runtimePermissionMode
              ? { runtimePermissionMode: options.runtimePermissionMode }
              : {}),
            ...(options.wegentTeamId ? { wegentTeamId: options.wegentTeamId } : {}),
            ...(Object.prototype.hasOwnProperty.call(options, 'modelSelection')
              ? { modelSelection: options.modelSelection }
              : {}),
          })
          return true
        }

        let resolvedAdditionalContext: RuntimeAdditionalContext | undefined
        try {
          resolvedAdditionalContext = await appendConversationMentionContext(
            effectiveSubmittedInput,
            options.additionalContext,
            loadRuntimeTranscriptForPane
          )
        } catch (cause) {
          console.warn('[Wework composer] failed to load referenced conversation', cause)
          setError(i18n.t('workbench.mention_conversation_load_failed'))
          return false
        }

        // Do not keep an earlier action error visible once the user sends a new message.
        setError(null)
        const visibleSubmittedInput =
          effectiveSubmittedInput ||
          (hasCodeComments ? i18n.t('workbench.code_comment_fallback') : '')
        if (!currentRuntimeTask) {
          clearSubmittedInput()
          resetAttachments()
          let errorScopeKey = inputScopeKey
          let submissionScopeKey = inputScopeKey
          const optimisticMessage = createRuntimeUserMessage(
            visibleSubmittedInput,
            currentAttachments,
            {
              runtimeGoalRequest: Boolean(pendingInitialGoal),
              codeComments: codeCommentContexts,
            }
          )
          let sent: boolean | RuntimeTaskAddress
          try {
            sent = await sendCurrentInput(visibleSubmittedInput, {
              attachments: currentAttachments,
              preserveAttachments: true,
              optimisticUserMessage: optimisticMessage,
              codeCommentContexts,
              initialGoal: pendingInitialGoal,
              additionalContext: resolvedAdditionalContext,
              cloudProjectId: options.cloudProjectId,
              origin: options.origin,
              initialSupervisor: options.initialSupervisor,
              ...(options.runtime ? { runtime: options.runtime } : {}),
              ...(options.runtimeExecutablePath
                ? { runtimeExecutablePath: options.runtimeExecutablePath }
                : {}),
              ...(options.runtimePermissionMode
                ? { runtimePermissionMode: options.runtimePermissionMode }
                : {}),
              ...(options.wegentTeamId ? { wegentTeamId: options.wegentTeamId } : {}),
              ...(Object.prototype.hasOwnProperty.call(options, 'modelSelection')
                ? { modelSelection: options.modelSelection }
                : {}),
              onError: nextError => setErrorForScope(errorScopeKey, nextError),
              onRuntimeTaskOptimisticOpen: (address, context) => {
                errorScopeKey = getRuntimeTaskChatScopeKey(address)
                submissionScopeKey = errorScopeKey
                options.onRuntimeTaskCreated?.(address)
                if (pendingInitialGoal) {
                  setPendingGoalState(current =>
                    current
                      ? {
                          ...current,
                          targetKey: runtimeTranscriptPaneKey(address),
                          targetIdentityKey: runtimeTranscriptPaneIdentityKey(address),
                        }
                      : current
                  )
                }
                if (pendingInitialGoal && pendingGoalState) {
                  seedRuntimePaneGoal(address, pendingGoalState.goal)
                }
                debugRuntimePaneMessageFlow('seed-optimistic-open', {
                  address: runtimeAddressDebug(address),
                  previousAddress: context?.previousAddress
                    ? runtimeAddressDebug(context.previousAddress)
                    : null,
                  seededMessages: summarizeWorkbenchMessages([optimisticMessage]),
                })
              },
              onRuntimeTaskOptimisticRemoved: () => {
                errorScopeKey = inputScopeKey
                submissionScopeKey = inputScopeKey
              },
            })
          } catch (error) {
            restoreSubmittedInput(submissionScopeKey, visibleSubmittedInput)
            currentAttachments.forEach(attachment =>
              addExistingAttachmentForScope(submissionScopeKey, attachment)
            )
            throw error
          }
          if (sent) {
            if (!isRuntimeTaskAddress(sent)) {
              appendLocalUserMessage(visibleSubmittedInput, currentAttachments, {
                runtimeGoalRequest: Boolean(pendingInitialGoal),
                codeComments: codeCommentContexts,
              })
            } else {
              options.onRuntimeTaskReady?.(sent)
              if (pendingInitialGoal) {
                setPendingGoalState(current =>
                  current
                    ? {
                        ...current,
                        targetKey: runtimeTranscriptPaneKey(sent),
                        targetIdentityKey: runtimeTranscriptPaneIdentityKey(sent),
                      }
                    : current
                )
              }
            }
            if (isRuntimeTaskAddress(sent)) {
              setDraftMessages([])
            }
            clearCodeCommentsAfterCommit('send_success', codeCommentContexts)
          } else {
            restoreSubmittedInput(submissionScopeKey, visibleSubmittedInput)
            currentAttachments.forEach(attachment =>
              addExistingAttachmentForScope(submissionScopeKey, attachment)
            )
          }
          return Boolean(sent)
        }

        if (hasCodeComments) {
          resetAttachments()
          const queuedMessage: RuntimePaneQueuedMessage = {
            id: `queued-runtime-pane-${Date.now()}-${queuedMessages.length}`,
            content: appendCodeCommentContexts(visibleSubmittedInput, codeCommentContexts),
            displayContent: visibleSubmittedInput,
            codeComments: codeCommentContexts,
            status: 'queued',
            createdAt: new Date().toISOString(),
            attachments: persistAttachmentReferences(currentAttachments),
            additionalContext: resolvedAdditionalContext,
            cloudProjectId: options.cloudProjectId,
            origin: options.origin,
            ...getRuntimeModelFields(),
          }

          if (paneIsBusy) {
            if (options.interruptWhenBusy) {
              const sent = await interruptAndSendQueuedMessage(queuedMessage)
              if (!sent) {
                currentAttachments.forEach(addExistingAttachment)
              } else {
                clearSubmittedInput()
                clearCodeCommentsAfterCommit('send_success', codeCommentContexts)
              }
              return sent
            }
            setQueuedMessages(messages => [...messages, queuedMessage])
            clearSubmittedInput()
            clearCodeCommentsAfterCommit('send_success', codeCommentContexts)
            if (options.guideWhenBusy) {
              await sendQueuedMessageAsGuidance(queuedMessage, true)
            }
            return true
          }

          let sendError: string | null = null
          const lifecycleBeforeSend = currentRuntimeTask
            ? lifecycleStore.getTask(currentRuntimeTask)
            : null
          const result = await sendRuntimeMessage(queuedMessage, {
            onError: nextError => {
              sendError = nextError
            },
          })
          if (result.queued) {
            retainRuntimeQueuedMessage(queuedMessage, result.queuePosition)
          }
          if (result.accepted) {
            clearSubmittedInput()
            clearCodeCommentsAfterCommit('send_success', codeCommentContexts)
          } else if (isRuntimeTaskBusyError(sendError)) {
            const lifecycleAfterSend = currentRuntimeTask
              ? lifecycleStore.getTask(currentRuntimeTask)
              : null
            if (runtimeTaskLifecycleTransitionChanged(lifecycleBeforeSend, lifecycleAfterSend)) {
              queuedMessageBusyBlocks.delete(queuedMessage.id)
            } else {
              queuedMessageBusyBlocks.set(queuedMessage.id, lifecycleBeforeSend)
            }
            setQueuedMessages(messages => [...messages, queuedMessage])
            clearSubmittedInput()
            clearCodeCommentsAfterCommit('send_success', codeCommentContexts)
          } else {
            currentAttachments.forEach(addExistingAttachment)
            setError(sendError ?? i18n.t('workbench.project_chat_send_failed'))
          }
          return result.accepted || isRuntimeTaskBusyError(sendError)
        }

        const queuedMessage: RuntimePaneQueuedMessage = {
          id: `queued-runtime-pane-${Date.now()}-${queuedMessages.length}`,
          content: submittedInput,
          status: 'queued',
          createdAt: new Date().toISOString(),
          attachments: persistAttachmentReferences(currentAttachments),
          additionalContext: resolvedAdditionalContext,
          cloudProjectId: options.cloudProjectId,
          origin: options.origin,
          ...getRuntimeModelFields(),
        }

        resetAttachments()
        if (paneIsBusy) {
          if (options.interruptWhenBusy) {
            const sent = await interruptAndSendQueuedMessage(queuedMessage)
            if (!sent) {
              currentAttachments.forEach(addExistingAttachment)
            } else {
              clearSubmittedInput()
            }
            return sent
          }
          setQueuedMessages(messages => [...messages, queuedMessage])
          clearSubmittedInput()
          if (options.guideWhenBusy) {
            await sendQueuedMessageAsGuidance(queuedMessage, true)
          }
          return true
        }

        let sendError: string | null = null
        const lifecycleBeforeSend = currentRuntimeTask
          ? lifecycleStore.getTask(currentRuntimeTask)
          : null
        const result = await sendRuntimeMessage(queuedMessage, {
          onError: nextError => {
            sendError = nextError
          },
        })
        if (result.queued) {
          retainRuntimeQueuedMessage(queuedMessage, result.queuePosition)
        }
        if (result.accepted) {
          clearSubmittedInput()
          clearCodeCommentsAfterCommit('send_success', codeCommentContexts)
        } else if (isRuntimeTaskBusyError(sendError)) {
          const lifecycleAfterSend = currentRuntimeTask
            ? lifecycleStore.getTask(currentRuntimeTask)
            : null
          if (runtimeTaskLifecycleTransitionChanged(lifecycleBeforeSend, lifecycleAfterSend)) {
            queuedMessageBusyBlocks.delete(queuedMessage.id)
          } else {
            queuedMessageBusyBlocks.set(queuedMessage.id, lifecycleBeforeSend)
          }
          setQueuedMessages(messages => [...messages, queuedMessage])
          clearSubmittedInput()
        } else {
          currentAttachments.forEach(addExistingAttachment)
          setError(sendError ?? i18n.t('workbench.project_chat_send_failed'))
        }
        return result.accepted || isRuntimeTaskBusyError(sendError)
      },
      [
        addExistingAttachment,
        appendLocalUserMessage,
        attachmentState.attachments,
        clearCodeCommentsAfterCommit,
        codeCommentContexts,
        compactRuntimePaneTask,
        currentRuntimeTask,
        goalDraftActive,
        getRuntimeModelFields,
        input,
        inputRevision,
        sharedInputRevision,
        getInputRevisionForScope,
        inputScopeKey,
        interruptAndSendQueuedMessage,
        lifecycleStore,
        loadRuntimeTranscriptForPane,
        pendingGoalState,
        addExistingAttachmentForScope,
        queuedMessages.length,
        queuedMessageBusyBlocks,
        readCurrentPaneBusy,
        retainRuntimeQueuedMessage,
        resetAttachments,
        sendCurrentInput,
        sendQueuedMessageAsGuidance,
        sendRuntimeMessage,
        setErrorForScope,
        setError,
        setInput,
        setInputForScope,
        setQueuedMessages,
        setRuntimeGoal,
      ]
    )

  const addCodeComment = useCallback((context: CodeCommentContext) => {
    setCodeCommentContexts(current => [...current.filter(item => item.id !== context.id), context])
  }, [])

  const replaceBrowserCodeComments = useCallback(
    (scope: BrowserAnnotationScope, contexts: CodeCommentContext[]) => {
      setCodeCommentContexts(current => {
        const replacementById = new Map(contexts.map(context => [context.id, context]))
        const existingOrder = current
          .filter(context => hasBrowserAnnotationScope(context, scope))
          .map(context => context.id)
        const orderedReplacement = [
          ...existingOrder
            .map(id => replacementById.get(id))
            .filter((context): context is CodeCommentContext => Boolean(context)),
          ...contexts.filter(context => !existingOrder.includes(context.id)),
        ]
        if (existingOrder.length === 0) return [...current, ...orderedReplacement]

        let replacementInserted = false
        return current.flatMap(context => {
          if (!hasBrowserAnnotationScope(context, scope)) return [context]
          if (replacementInserted) return []
          replacementInserted = true
          return orderedReplacement
        })
      })
    },
    []
  )

  const removeBrowserCodeComments = useCallback((scope: BrowserAnnotationScope) => {
    setCodeCommentContexts(current =>
      current.filter(context => !hasBrowserAnnotationScope(context, scope))
    )
  }, [])

  const clearCodeComments = useCallback(() => {
    clearCodeCommentsAfterCommit('composer_clear', codeCommentContexts)
  }, [clearCodeCommentsAfterCommit, codeCommentContexts])

  const cancelQueuedMessage = useCallback(
    async (id: string) => {
      const queuedMessage = queuedMessages.find(message => message.id === id)
      if (queuedMessage?.runtimeQueued && currentRuntimeTask) {
        setQueuedMessages(messages =>
          messages.map(message =>
            message.id === id ? { ...message, status: 'sending', notice: '正在取消排队' } : message
          )
        )
        try {
          await cancelRuntimeTask(currentRuntimeTask)
        } catch (error) {
          setQueuedMessages(messages =>
            messages.map(message =>
              message.id === id
                ? {
                    ...message,
                    status: 'failed',
                    notice: undefined,
                    error: error instanceof Error ? error.message : '取消排队失败',
                  }
                : message
            )
          )
          return
        }
      }
      queuedMessageBusyBlocks.delete(id)
      setQueuedMessages(messages => messages.filter(message => message.id !== id))
    },
    [
      cancelRuntimeTask,
      currentRuntimeTask,
      queuedMessageBusyBlocks,
      queuedMessages,
      setQueuedMessages,
    ]
  )

  const forceStartQueuedMessage = useCallback(
    async (id: string) => {
      const queuedMessage = queuedMessages.find(message => message.id === id)
      if (!queuedMessage?.runtimeQueued || !currentRuntimeTask) return
      setQueuedMessages(messages =>
        messages.map(message =>
          message.id === id ? { ...message, status: 'sending', notice: '正在插队' } : message
        )
      )
      try {
        await forceStartRuntimeTask(currentRuntimeTask)
      } catch (error) {
        setQueuedMessages(messages =>
          messages.map(message =>
            message.id === id
              ? {
                  ...message,
                  status: 'failed',
                  notice: undefined,
                  error: error instanceof Error ? error.message : '插队失败',
                }
              : message
          )
        )
      }
    },
    [currentRuntimeTask, forceStartRuntimeTask, queuedMessages, setQueuedMessages]
  )

  const resumeQueuedMessages = useCallback(() => {
    if (currentRuntimeTask) {
      logRuntimeQueueStage(currentRuntimeTask, 'queue-resume-requested', {
        source: 'resume',
        hasInput: false,
        hasInterruptedGuidance: queuedMessages.some(isInterruptedGuidance),
      })
    }
    setQueuedMessagesPaused(false)
    const interruptedGuidance = queuedMessages.find(isInterruptedGuidance)
    const queuedMessage =
      interruptedGuidance ??
      queuedMessages.find(message => message.status === 'queued' && !message.runtimeQueued)
    if (queuedMessage) {
      queuedMessageBusyBlocks.delete(queuedMessage.id)
      void sendQueuedMessage(queuedMessage)
    }
  }, [
    currentRuntimeTask,
    queuedMessageBusyBlocks,
    queuedMessages,
    sendQueuedMessage,
    setQueuedMessagesPaused,
  ])

  const resumeQueuedMessagesWithInput = useCallback(
    async (inputOverride?: string, options?: RuntimePaneSendOptions) => {
      const interruptedGuidance = queuedMessages.find(isInterruptedGuidance)
      if (currentRuntimeTask) {
        logRuntimeQueueStage(currentRuntimeTask, 'queue-resume-requested', {
          source: 'resume-with-input',
          hasInput: Boolean((inputOverride ?? input).trim()),
          hasInterruptedGuidance: Boolean(interruptedGuidance),
        })
      }
      if (!interruptedGuidance) {
        const queuedMessage = queuedMessages.find(
          message => message.status === 'queued' && !message.runtimeQueued
        )
        const lifecycle = currentRuntimeTask ? lifecycleStore.getTask(currentRuntimeTask) : null
        if (queuedMessage && queuedMessageScopeKey) {
          queueController?.resumeAfterTurn(lifecycle)
        }
        const sent = await send(inputOverride, options)
        if (!sent) {
          queueController?.cancelResumeAfterTurn()
          return
        }
        if (!queuedMessage) {
          setQueuedMessagesPaused(false)
          return
        }
        return
      }

      const submittedInput = (inputOverride ?? input).trim()
      const combinedMessage = {
        ...interruptedGuidance,
        content: [interruptedGuidance.content, submittedInput].filter(Boolean).join('\n\n'),
        notice: undefined,
      }
      setQueuedMessagesPaused(false)
      await sendQueuedMessage(combinedMessage)
    },
    [
      currentRuntimeTask,
      input,
      lifecycleStore,
      queueController,
      queuedMessageScopeKey,
      queuedMessages,
      send,
      sendQueuedMessage,
      setQueuedMessagesPaused,
    ]
  )

  const clearQueuedMessages = useCallback(() => {
    queuedMessageBusyBlocks.clear()
    const runtimeQueuedMessage = queuedMessages.find(message => message.runtimeQueued)
    setQueuedMessages(messages => messages.filter(message => message.runtimeQueued))
    setQueuedMessagesPaused(false)
    if (runtimeQueuedMessage) {
      void cancelQueuedMessage(runtimeQueuedMessage.id)
    }
  }, [
    cancelQueuedMessage,
    queuedMessageBusyBlocks,
    queuedMessages,
    setQueuedMessages,
    setQueuedMessagesPaused,
  ])

  const reorderQueuedMessages = useCallback(
    (sourceId: string, targetId: string) => {
      setQueuedMessages(messages => {
        const sourceIndex = messages.findIndex(message => message.id === sourceId)
        const targetIndex = messages.findIndex(message => message.id === targetId)
        if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return messages

        const source = messages[sourceIndex]
        const target = messages[targetIndex]
        if (source.status !== 'queued' || target.status !== 'queued') return messages

        const reordered = [...messages]
        reordered.splice(sourceIndex, 1)
        const insertIndex = sourceIndex < targetIndex ? targetIndex - 1 : targetIndex
        reordered.splice(insertIndex, 0, source)
        return reordered
      })
    },
    [setQueuedMessages]
  )

  const editQueuedMessage = useCallback(
    (id: string) => {
      const queuedMessage = queuedMessages.find(message => message.id === id)
      if (!queuedMessage || queuedMessage.status === 'sending' || queuedMessage.runtimeQueued)
        return

      queuedMessageBusyBlocks.delete(id)
      setInput(queuedMessage.content)
      queuedMessage.attachments?.forEach(attachment => {
        addExistingAttachment(attachment)
      })
      setQueuedMessages(messages => messages.filter(message => message.id !== id))
    },
    [addExistingAttachment, queuedMessageBusyBlocks, queuedMessages, setInput, setQueuedMessages]
  )

  const sendQueuedAsGuidance = useCallback(
    async (id: string) => {
      const queuedMessage = queuedMessages.find(message => message.id === id)
      if (!queuedMessage || queuedMessage.runtimeQueued) return
      await sendQueuedMessageAsGuidance(queuedMessage)
    },
    [queuedMessages, sendQueuedMessageAsGuidance]
  )

  const interruptAndSendQueued = useCallback(
    async (id: string) => {
      const queuedMessage = queuedMessages.find(message => message.id === id)
      if (!queuedMessage || queuedMessage.runtimeQueued) return
      queuedMessageBusyBlocks.delete(id)
      const submittedInput = input.trim()
      const currentAttachments = attachmentState.attachments
      const combinedMessage: RuntimePaneQueuedMessage = {
        ...queuedMessage,
        content: [queuedMessage.content, submittedInput].filter(Boolean).join('\n\n'),
        displayContent: [queuedMessage.displayContent ?? queuedMessage.content, submittedInput]
          .filter(Boolean)
          .join('\n\n'),
        attachments: [...(queuedMessage.attachments ?? []), ...currentAttachments],
        notice: undefined,
      }
      setInput('')
      resetAttachments()
      const sent = await interruptAndSendQueuedMessage(combinedMessage)
      if (sent) return
      restoreInputAfterFailure(combinedMessage.displayContent ?? combinedMessage.content)
      combinedMessage.attachments?.forEach(addExistingAttachment)
      if (combinedMessage.codeComments && combinedMessage.codeComments.length > 0) {
        setCodeCommentContexts(combinedMessage.codeComments)
      }
    },
    [
      addExistingAttachment,
      attachmentState.attachments,
      input,
      interruptAndSendQueuedMessage,
      queuedMessageBusyBlocks,
      queuedMessages,
      resetAttachments,
      restoreInputAfterFailure,
      setInput,
    ]
  )

  const compactContext = useCallback(async () => {
    if (!currentRuntimeTask) {
      setError('当前对话还没有可压缩的 Codex 线程')
      return false
    }
    const currentTaskIsBusy =
      lifecycleStore.getTask(currentRuntimeTask)?.derived.isBusy ?? paneStatus.isBusy
    if (currentTaskIsBusy) {
      setError('当前回复进行中，完成后再压缩上下文')
      return false
    }
    if (currentRuntimeTask.runtime === 'claude_code') {
      return send('/compact')
    }
    return compactRuntimePaneTask(currentRuntimeTask, { onError: setError })
  }, [
    compactRuntimePaneTask,
    currentRuntimeTask,
    lifecycleStore,
    paneStatus.isBusy,
    send,
    setError,
  ])

  const setCurrentGoal = useCallback(async () => {
    projectChat.setSelectedModelOption('collaborationMode', 'default')
    setGoalDraftActive(true)
    return true
  }, [projectChat])

  const cancelGoalDraft = useCallback(() => {
    setGoalDraftActive(false)
  }, [])

  const editCurrentGoal = useCallback(() => {
    if (!goal) return
    setInput(goal.objective)
    setGoalDraftActive(true)
  }, [goal, setInput])

  const updateCurrentGoalStatus = useCallback(
    async (status: RuntimeGoal['status']) => {
      if (!currentRuntimeTask) {
        if (!goal) return false
        setPendingGoalState(current =>
          current
            ? {
                ...current,
                goal: {
                  ...current.goal,
                  status,
                  updatedAt: Date.now(),
                },
              }
            : current
        )
        return true
      }

      try {
        const response = await setRuntimeGoal({
          address: currentRuntimeTask,
          status,
        })
        if (!response.accepted) return false

        syncRuntimeGoal(lifecycleStore, currentRuntimeTask, response.goal)
        if (response.goal.status === 'active') {
          await refreshWorkLists()
        }
        return true
      } catch (error) {
        console.error('[Wework] Runtime goal status update failed', {
          address: runtimeAddressDebug(currentRuntimeTask),
          status,
          error,
        })
        return false
      }
    },
    [currentRuntimeTask, goal, lifecycleStore, refreshWorkLists, setRuntimeGoal]
  )

  const pauseCurrentGoal = useCallback(
    () => updateCurrentGoalStatus('paused'),
    [updateCurrentGoalStatus]
  )

  const resumeCurrentGoal = useCallback(async () => {
    if (
      currentRuntime !== 'claude_code' ||
      !goal ||
      (goal.status !== 'paused' && goal.status !== 'blocked')
    ) {
      return updateCurrentGoalStatus('active')
    }
    if (paneStatus.isBusy) {
      setError('当前回复进行中，完成后再继续目标')
      return false
    }

    const resumed = await updateCurrentGoalStatus('active')
    if (!resumed) return false

    const resumedGoal: RuntimeGoal = {
      ...goal,
      status: 'active',
      updatedAt: Date.now(),
    }
    const initialGoal = runtimeGoalCreateInput(resumedGoal)
    const message: RuntimePaneQueuedMessage = {
      id: `runtime-goal-resume-${Date.now()}`,
      content: resumedGoal.objective,
      status: 'queued',
      createdAt: new Date().toISOString(),
      runtimeGoalRequest: true,
      initialGoal,
      ...getRuntimeModelFields(),
    }
    let sendError: string | null = null
    const result = await sendRuntimeMessage(message, {
      initialGoal,
      onError: error => {
        sendError = error
      },
    })
    if (result.queued) {
      retainRuntimeQueuedMessage(message, result.queuePosition)
    }
    if (result.accepted) return true

    await updateCurrentGoalStatus('paused')
    setError(sendError ?? i18n.t('workbench.project_chat_send_failed'))
    return false
  }, [
    currentRuntime,
    getRuntimeModelFields,
    goal,
    paneStatus.isBusy,
    retainRuntimeQueuedMessage,
    sendRuntimeMessage,
    setError,
    updateCurrentGoalStatus,
  ])

  const pauseCurrentResponse = useCallback(async () => {
    if (!currentRuntimeTask) return
    logRuntimeQueueStage(currentRuntimeTask, 'queue-stop-requested', {
      source: 'composer',
      goalPauseRequired: goal?.status === 'active' || taskGoalStatus === 'active',
    })
    let accepted: boolean | null = null
    let queuePauseRequested = false
    let restoreQueue: (() => void) | undefined
    let abortReason: 'goal-pause-rejected' | null = null
    try {
      if (goal?.status === 'active' || taskGoalStatus === 'active') {
        const paused = await updateCurrentGoalStatus('paused')
        if (!paused) {
          abortReason = 'goal-pause-rejected'
          return
        }
      }

      restoreQueue = queueController?.pauseForCancellation()
      queuePauseRequested = getRuntimeConversationQueuePausedByKey(
        runtimeConversationKey(currentRuntimeTask)
      )
      const cancelled = await cancelRuntimePaneTask(currentRuntimeTask)
      accepted = cancelled
      if (!cancelled) return

      optimisticallyInterruptRuntimeConversation(currentRuntimeTask)
      void refreshWorkLists()
    } finally {
      if (accepted !== true) restoreQueue?.()
      logRuntimeQueueStage(currentRuntimeTask, 'queue-stop-result', {
        source: 'composer',
        accepted,
        queuePauseRequested,
        abortReason,
      })
    }
  }, [
    cancelRuntimePaneTask,
    currentRuntimeTask,
    goal?.status,
    queueController,
    refreshWorkLists,
    taskGoalStatus,
    updateCurrentGoalStatus,
  ])

  const clearCurrentGoal = useCallback(async () => {
    if (!goal) return false
    if (!currentRuntimeTask) {
      setPendingGoalState(null)
      return true
    }

    try {
      const response = await clearRuntimeGoal(currentRuntimeTask)
      if (!response.accepted) return false

      syncRuntimeGoal(lifecycleStore, currentRuntimeTask, null)
      await refreshWorkLists()
      return true
    } catch (error) {
      console.error('[Wework] Runtime goal clear failed', {
        address: runtimeAddressDebug(currentRuntimeTask),
        error,
      })
      return false
    }
  }, [clearRuntimeGoal, currentRuntimeTask, goal, lifecycleStore, refreshWorkLists])

  const cancelGuidanceMessage = useCallback(() => undefined, [])
  const goalProjectionInput = {
    goal,
    continuation: goalContinuation,
    taskRunning: paneStatus.taskExecution.running,
    messages,
    activeAssistantMessage,
  }
  const goalContinuing = projectRuntimeGoalContinuing(goalProjectionInput)
  useDebugSnapshotPublisher(debugSnapshotEnabled, () => {
    updateRuntimePaneDebugSnapshot(
      {
        currentRuntimeTask,
        status: paneStatus,
        messageSummary: summarizeMessages(messages),
        messageStyleComparison: compareMessageStyles(messages),
        memory: summarizeRuntimePaneMemory({
          messages,
          currentRuntimeTask,
          loadedRanges: loadedTranscriptRanges,
        }),
        queuedMessages,
        guidanceMessages,
        codeCommentContextCount: codeCommentContexts.length,
        inputLength: input.length,
        transcript: {
          loading: transcriptLoading,
          hasMoreBefore: transcriptHasMoreBefore,
          loadingMoreBefore: transcriptLoadingMoreBefore,
          turnNavigationCount: turnNavigation.length,
          loadedRanges: loadedTranscriptRanges,
        },
        subagentStatuses,
        goal,
        goalDraftActive,
      },
      { enabled: debugSnapshotEnabled }
    )
  })

  return {
    scopeKey: inputScopeKey,
    attachments: attachmentState.attachments,
    uploadingFiles: attachmentState.uploadingFiles,
    attachmentErrors: attachmentState.errors,
    dismissAttachmentError,
    handleFileSelect,
    removeAttachment,
    messages,
    turns,
    queuedMessages,
    queuedMessagesPaused,
    guidanceMessages,
    codeCommentContexts,
    browserAnnotationCommand,
    input,
    setInput,
    error,
    setError,
    clearError,
    status: paneStatus,
    sending: paneStatus.isSubmitting,
    waitingForAssistant: paneStatus.isWaitingForAssistantIndicator,
    answeredRequestUserInputIds,
    transcriptLoading,
    transcriptError,
    reloadRuntimeTranscript,
    transcriptHasMoreBefore,
    transcriptLoadingMoreBefore,
    transcriptFullContent,
    loadedTranscriptRanges,
    turnNavigation,
    subagentStatuses,
    goal,
    goalContinuing,
    goalExecutionStatus,
    taskPlan,
    goalDraftActive,
    loadMoreTranscriptBefore,
    loadFullTranscriptForExport,
    loadTranscriptTurnNavigationItem,
    loadTranscriptGap,
    searchTranscript: runtimeTaskLoadTarget ? conversationSearch.search : undefined,
    ensureSearchMatch: runtimeTaskLoadTarget ? conversationSearch.ensureMatch : undefined,
    searchPage: conversationSearch.page,
    loadSearchContext: conversationSearch.loadMoreContext,
    releaseSearchPage: conversationSearch.releasePage,
    send,
    sendContinuation,
    retryFailedMessage: retryFailedMessageInPane,
    editLastUserMessage: editLastUserMessageInPane,
    sendRequestUserInputResponse,
    ignoreRequestUserInput,
    addCodeComment,
    replaceBrowserCodeComments,
    removeBrowserCodeComments,
    clearCodeComments,
    cancelQueuedMessage,
    forceStartQueuedMessage,
    resumeQueuedMessages,
    resumeQueuedMessagesWithInput,
    clearQueuedMessages,
    reorderQueuedMessages,
    sendQueuedAsGuidance,
    interruptAndSendQueued,
    editQueuedMessage,
    cancelGuidanceMessage,
    pauseCurrentResponse,
    compactContext,
    setCurrentGoal,
    cancelGoalDraft,
    editCurrentGoal,
    pauseCurrentGoal,
    resumeCurrentGoal,
    clearCurrentGoal,
  }
}

export function resolveRuntimeTranscriptPageSize(
  configuredPageSize = Number(
    getDesktopE2ERuntimeConfig().transcriptPageSize ??
      import.meta.env.VITE_WEWORK_E2E_TRANSCRIPT_PAGE_SIZE
  )
): number {
  return Number.isInteger(configuredPageSize) && configuredPageSize > 0
    ? configuredPageSize
    : DEFAULT_RUNTIME_TRANSCRIPT_PAGE_SIZE
}

export function runtimeTranscriptHasMoreBefore(transcript: RuntimePaneTranscript): boolean {
  return Boolean(transcript.beforeCursor || transcript.hasMoreBefore)
}

export type WorkbenchPaneSession = ReturnType<typeof useWorkbenchPaneSession>

export function rollbackRejectedRuntimeConversationTurn(
  target: RuntimeTaskAddress,
  activeTarget: RuntimeTaskAddress | null,
  clientUserMessageId: string
): WorkbenchMessage[] | null {
  const messages = removeRuntimeConversationTurn(target, { clientUserMessageId })
  if (
    !activeTarget ||
    runtimeTranscriptPaneIdentityKey(activeTarget) !== runtimeTranscriptPaneIdentityKey(target)
  ) {
    return null
  }
  return messages
}

function isInterruptedGuidance(message: RuntimePaneQueuedMessage): boolean {
  return message.status === 'sending' && message.deliveryMode === 'guidance'
}

function runtimeTaskLoadTargetFromAddress(address: RuntimeTaskAddress): RuntimeTaskLoadTarget {
  return {
    key: runtimeTaskLoadAddressKey(address),
    identityKey: runtimeTranscriptPaneIdentityKey(address),
    address,
  }
}

const runtimeTranscriptPaneKey = runtimeConversationKey

function runtimeTaskLoadAddressKey(address: RuntimeTaskAddress): string {
  const runtimeHandleThreadId =
    typeof address.runtimeHandle?.threadId === 'string'
      ? address.runtimeHandle.threadId.trim()
      : typeof address.runtimeHandle?.thread_id === 'string'
        ? address.runtimeHandle.thread_id.trim()
        : ''

  return JSON.stringify({
    route: getRuntimeTaskRouteKey(address),
    projectSession: address.projectSession ?? null,
    runtime: address.runtime ?? null,
    threadId: address.threadId?.trim() || runtimeHandleThreadId || null,
    workspaceKind: address.workspaceKind ?? null,
    worktreeId: address.worktreeId ?? null,
  })
}

function runtimeTranscriptPaneIdentityKey(address: RuntimeTaskAddress): string {
  return `${address.deviceId}:${address.taskId}`
}

function isPendingGoalVisibleForRuntimeTarget(
  pendingGoalState: PendingRuntimeGoalState,
  address: RuntimeTaskAddress
): boolean {
  if (!pendingGoalState.targetKey && !pendingGoalState.targetIdentityKey) return true
  return (
    pendingGoalState.targetKey === runtimeTranscriptPaneKey(address) ||
    pendingGoalState.targetIdentityKey === runtimeTranscriptPaneIdentityKey(address)
  )
}

function isUnboundPendingGoalState(pendingGoalState: PendingRuntimeGoalState): boolean {
  return !pendingGoalState.targetKey && !pendingGoalState.targetIdentityKey
}

function pendingRuntimeGoalState(
  goal: RuntimeGoal,
  address: RuntimeTaskAddress
): PendingRuntimeGoalState {
  return {
    goal,
    targetKey: runtimeTranscriptPaneKey(address),
    targetIdentityKey: runtimeTranscriptPaneIdentityKey(address),
  }
}

function seedRuntimePaneGoal(address: RuntimeTaskAddress, goal: RuntimeGoal) {
  setLruMapValue(
    runtimePaneGoalSeeds,
    runtimeTranscriptPaneIdentityKey(address),
    pendingRuntimeGoalState(goal, address),
    MAX_CACHED_RUNTIME_PANE_GOALS
  )
}

function getRuntimePaneGoalSeed(address: RuntimeTaskAddress): PendingRuntimeGoalState | null {
  return getLruMapValue(runtimePaneGoalSeeds, runtimeTranscriptPaneIdentityKey(address)) ?? null
}

function clearRuntimePaneGoalSeed(address: RuntimeTaskAddress) {
  runtimePaneGoalSeeds.delete(runtimeTranscriptPaneIdentityKey(address))
}

function resolveHydratedRuntimeGoal(
  address: RuntimeTaskAddress,
  loadedGoal: RuntimeGoal | null,
  seededGoal: PendingRuntimeGoalState | null
): RuntimeGoal | null {
  if (loadedGoal) return loadedGoal

  const hasQueuedGoal = getRuntimeConversationQueuedMessagesByKey(
    runtimeConversationKey(address)
  ).some(
    message =>
      Boolean(message.initialGoal) && (message.status === 'queued' || message.status === 'sending')
  )
  if (hasQueuedGoal) {
    const optimisticGoal = getRuntimeConversationMetadata(address).goal
    if (optimisticGoal) return optimisticGoal
  }

  if (seededGoal?.goal.threadId === 'pending' && getRuntimePaneGoalSeed(address) === seededGoal) {
    return seededGoal.goal
  }

  return null
}

function runtimeAddressDebug(address: RuntimeTaskAddress): Record<string, unknown> {
  return {
    deviceId: address.deviceId,
    taskId: address.taskId,
    workspacePath: address.workspacePath ?? null,
    hasRuntimeHandle: Boolean(address.runtimeHandle),
    runtimeHandleKeys: address.runtimeHandle ? Object.keys(address.runtimeHandle).sort() : [],
  }
}

function summarizeWorkbenchMessages(messages: WorkbenchMessage[]): Record<string, unknown>[] {
  return messages.map(message => ({
    id: message.id,
    role: message.role,
    status: message.status,
    runtimeStatus: message.runtimeStatus,
    contentLength: message.content.length,
    subtaskId: message.subtaskId ?? null,
    turnId: message.turnId ?? null,
  }))
}

function debugRuntimePaneMessageFlow(event: string, details: Record<string, unknown>) {
  if (!event.startsWith('transcript-load-') && !isRuntimeDebugEnabled()) return
  if (
    event.startsWith('transcript-load-') &&
    (import.meta.env.MODE === 'e2e' || import.meta.env.VITE_WEWORK_E2E === 'true')
  ) {
    logRuntimeTaskCreateStage(event, details)
  }
  if (isRuntimeDebugEnabled()) {
    console.debug('[Wework] Runtime pane message flow', {
      event,
      ...details,
    })
  }
}

function isRuntimeDebugEnabled(): boolean {
  return globalThis.localStorage?.getItem('wework:debug-runtime') === '1'
}

function isEditableLastUserMessage(messages: WorkbenchMessage[], targetIndex: number): boolean {
  if (targetIndex < 0 || targetIndex >= messages.length) return false

  const target = messages[targetIndex]
  if (target.role !== 'user') return false

  const followingMessages = messages.slice(targetIndex + 1)
  if (followingMessages.length === 0) return false
  if (followingMessages.some(message => message.role === 'user')) return false
  if (followingMessages.some(message => message.status === 'streaming')) return false

  return followingMessages.some(message => message.role === 'assistant')
}

function getLruMapValue<K, V>(map: Map<K, V>, key: K): V | undefined {
  const value = map.get(key)
  if (value === undefined) return undefined
  map.delete(key)
  map.set(key, value)
  return value
}

function setLruMapValue<K, V>(map: Map<K, V>, key: K, value: V, maxSize: number) {
  map.delete(key)
  map.set(key, value)

  while (map.size > maxSize) {
    const oldestKey = map.keys().next().value
    if (oldestKey === undefined) return
    map.delete(oldestKey)
  }
}

export function scheduleRuntimeTurnNavigationLoad(callback: () => void): () => void {
  if (typeof window.requestIdleCallback === 'function') {
    const requestId = window.requestIdleCallback(callback, { timeout: 2000 })
    return () => window.cancelIdleCallback(requestId)
  }
  const timeoutId = window.setTimeout(callback, 0)
  return () => window.clearTimeout(timeoutId)
}

function isRuntimeTaskAddress(value: unknown): value is RuntimeTaskAddress {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<RuntimeTaskAddress>
  return typeof candidate.deviceId === 'string' && typeof candidate.taskId === 'number'
}

function createPendingRuntimeGoal(objective: string): RuntimeGoal {
  const now = Date.now()
  return {
    threadId: 'pending',
    objective,
    status: 'active',
    tokenBudget: null,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    createdAt: now,
    updatedAt: now,
  }
}
