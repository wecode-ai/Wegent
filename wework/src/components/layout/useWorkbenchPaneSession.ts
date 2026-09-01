import { useCallback, useEffect, useMemo, useRef, useState, type SetStateAction } from 'react'
import i18n from '@/i18n'
import { useWorkbenchPaneContext } from '@/features/workbench/useWorkbench'
import {
  compareMessageStyles,
  summarizeRuntimePaneMemory,
  summarizeMessages,
  updateRuntimePaneDebugSnapshot,
  DEBUG_SNAPSHOT_DEBOUNCE_MS,
} from '@/lib/debugPanel'
import type { RuntimePaneMessageAction } from '@/features/workbench/runtimePaneMessages'
import { appendBufferedRuntimePaneMessageAction } from '@/features/workbench/runtimePaneMessageBuffer'
import {
  deriveRuntimePaneStatus,
  isRuntimeTaskBusyError,
} from '@/features/workbench/runtimePaneStatus'
import {
  consumeRuntimeTaskLifecycleBlock,
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
  requestUserInputPayloadKey,
  requestUserInputResponseKey,
} from '@/components/chat/requestUserInputMessages'
import type { RequestUserInputPayload } from '@/components/chat/RequestUserInputCard'
import { debugComposerEvent, textMetrics } from '@/components/chat/composer/composerDebug'
import {
  projectRuntimeGoalContinuing,
  runtimeGoalCreateInput,
  shouldReconcileActiveRuntimeGoalTranscript,
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
  abortRuntimeConversationHydration,
  appendAcceptedRuntimeConversationMessage,
  applyRuntimeConversationAction,
  appendOptimisticRuntimeConversationGuidance,
  beginRuntimeConversationHydration,
  cacheRuntimeConversationQueuedMessagesByKey,
  cacheRuntimeConversationQueuePausedByKey,
  clearInterruptedRuntimeConversationGuidanceExcept,
  completeRuntimeConversationHydration,
  getRuntimeConversationMessages,
  getRuntimeConversationMetadata,
  getRuntimeConversationQueuedMessagesByKey,
  getRuntimeConversationQueuePausedByKey,
  getRuntimeConversationTurnIds,
  markRuntimeConversationGuidanceInterrupted,
  optimisticallyInterruptRuntimeConversation,
  removeOptimisticRuntimeConversationGuidance,
  removeRuntimeConversationTurn,
  reconcileRuntimeConversationSnapshot,
  replaceRuntimeConversationFromUserMessage,
  runtimeConversationMessageHasStartedTurn,
  runtimeConversationSnapshotSettlesLatestTurn,
  runtimeConversationKey,
  restoreOptimisticallyInterruptedRuntimeConversation,
  setRuntimeConversationGoal,
  settleRuntimeConversationAcceptedMessage,
  subscribeRuntimeConversation,
  subscribeRuntimeTransportReplaced,
  takeInterruptedRuntimeConversationGuidance,
  updateRuntimeConversationBlocks,
} from '@/features/workbench/runtimeConversationCache'
import {
  createRuntimeUserMessage,
  type RuntimeUserMessageOptions,
} from '@/features/workbench/runtimeUserMessage'

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
  onRuntimeTaskCreated?: (address: RuntimeTaskAddress) => void
  onRuntimeTaskReady?: (address: RuntimeTaskAddress) => void
}

interface SendRuntimeMessageOptions {
  appendLocalMessage?: boolean
  initialGoal?: RuntimeGoalCreateInput | null
  onError?: (error: string) => void
  silentBusyRetry?: boolean
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
const DEFAULT_RUNTIME_TRANSCRIPT_PAGE_SIZE = 50
const MAX_CACHED_RUNTIME_PANE_GOALS = 3
export const RUNTIME_RETRY_CONTINUATION_PROMPT =
  'Continue the unfinished work from the previous turn. Use the existing conversation context and do not repeat work that is already complete.'
const EMPTY_ATTACHMENT_STATE = {
  attachments: [],
  uploadingFiles: new Map(),
  errors: new Map(),
}

export function useWorkbenchPaneSession({
  currentRuntimeTask,
  debugSnapshotEnabled = true,
}: WorkbenchPaneSessionOptions) {
  const runtimeTranscriptPageSize = resolveRuntimeTranscriptPageSize()
  const {
    state: workbenchState,
    projectChat,
    loadRuntimeTranscriptForPane,
    getRuntimeGoal,
    setRuntimeGoal,
    clearRuntimeGoal,
    sendRuntimePaneMessage,
    interruptAndSendRuntimePaneMessage,
    sendRuntimePaneGuidance,
    compactRuntimePaneTask,
    editLastUserMessage,
    cancelRuntimePaneTask,
    sendCurrentInput,
    refreshWorkLists,
  } = useWorkbenchPaneContext()
  const lifecycleStore = useRuntimeTaskLifecycleStore()
  const queuedMessageScopeKey = currentRuntimeTask
    ? runtimeConversationKey(currentRuntimeTask)
    : null
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
  const [browserAnnotationCommand, setBrowserAnnotationCommand] =
    useState<BrowserAnnotationCommand | null>(null)
  const browserAnnotationCommandSequenceRef = useRef(0)
  const inputScopeKey = currentRuntimeTask
    ? getRuntimeTaskChatScopeKey(currentRuntimeTask)
    : projectChat.scopeKey
  const attachmentState =
    projectChat.attachmentStateByScope[inputScopeKey] ?? EMPTY_ATTACHMENT_STATE
  const addExistingAttachment = useCallback(
    (attachment: Attachment) =>
      projectChat.addExistingAttachmentForScope(inputScopeKey, attachment),
    [inputScopeKey, projectChat]
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
  const input = projectChat.inputByScope[inputScopeKey] ?? ''
  const setInputForScope = projectChat.setInputForScope
  const scopedSetInput = useCallback(
    (value: string) => setInputForScope(inputScopeKey, value),
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
  const setInput = useCallback(
    (value: string) => {
      scopedSetInput(value)
    },
    [scopedSetInput]
  )
  const restoreInputAfterFailure = useCallback(
    (value: string) => {
      scopedSetInput(value)
    },
    [scopedSetInput]
  )

  const clearCodeCommentsAfterCommit = useCallback(
    (reason: BrowserAnnotationCommand['reason'], contexts: CodeCommentContext[]) => {
      setCodeCommentContexts([])
      if (!contexts.some(isBrowserAnnotationContext)) return

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
  const [transcriptLoading, setTranscriptLoading] = useState(() => Boolean(currentRuntimeTask))
  const [transcriptError, setTranscriptError] = useState<string | null>(null)
  const [transcriptReloadVersion, setTranscriptReloadVersion] = useState(0)
  const [transcriptHasMoreBefore, setTranscriptHasMoreBefore] = useState(false)
  const [transcriptBeforeCursor, setTranscriptBeforeCursor] = useState<string | null>(null)
  const [transcriptLoadingMoreBefore, setTranscriptLoadingMoreBefore] = useState(false)
  const [transcriptLoadingFullContent, setTranscriptLoadingFullContent] = useState(false)
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
  const queuedMessageSendInFlightIdsRef = useRef(new Set<string>())
  const queuedMessageBusyBlockSnapshotsRef = useRef(
    new Map<string, RuntimeTaskLifecycleSnapshot | null>()
  )
  const resumePausedQueueAfterTurnRef = useRef<{
    scopeKey: string
    previousLifecycle: RuntimeTaskLifecycleSnapshot | null
    observedManualTurn: boolean
  } | null>(null)
  const pendingMessageActionsRef = useRef<RuntimePaneMessageAction[]>([])
  const rebuildingTranscriptRef = useRef(false)
  const rebuildingTranscriptIdentityRef = useRef<string | null>(null)
  const goalTranscriptReconciliationRef = useRef<{
    key: string
    attempts: number
  } | null>(null)
  const messageActionFrameRef = useRef<number | null>(null)
  const retryInFlightRef = useRef(false)
  const currentRuntimeTaskLoadTarget = useMemo(
    () => (currentRuntimeTask ? runtimeTaskLoadTargetFromAddress(currentRuntimeTask) : null),
    [currentRuntimeTask]
  )
  const [retainedRuntimeTaskLoadTarget, setRetainedRuntimeTaskLoadTarget] =
    useState<RuntimeTaskLoadTarget | null>(() =>
      currentRuntimeTask ? runtimeTaskLoadTargetFromAddress(currentRuntimeTask) : null
    )
  const runtimeTaskLoadTarget = retainedRuntimeTaskLoadTarget
  const [messages, setMessages] = useState<WorkbenchMessage[]>(() =>
    currentRuntimeTask ? getRuntimeConversationMessages(currentRuntimeTask) : []
  )
  const messagesRef = useRef<WorkbenchMessage[]>(messages)
  const applyMessageActions = useCallback((actions: RuntimePaneMessageAction[]) => {
    if (actions.length === 0) return
    setMessages(currentMessages => {
      const activeRuntimeTask =
        runtimeTaskLoadTargetRef.current?.address ?? currentRuntimeTaskRef.current
      let nextMessages = currentMessages
      for (const action of actions) {
        if (action.type === 'reset') {
          nextMessages = action.messages
          continue
        }
        if (activeRuntimeTask) {
          nextMessages = applyRuntimeConversationAction(activeRuntimeTask, action)
        }
      }
      if (activeRuntimeTask) {
        debugRuntimePaneMessageFlow('message-action', {
          address: runtimeAddressDebug(activeRuntimeTask),
          actionType: actions.length === 1 ? actions[0].type : 'batched',
          actionCount: actions.length,
          previousCount: currentMessages.length,
          nextCount: nextMessages.length,
          nextMessages: summarizeWorkbenchMessages(nextMessages),
        })
      }
      return nextMessages
    })
  }, [])
  const flushPendingMessageActions = useCallback(() => {
    if (messageActionFrameRef.current !== null) {
      cancelAnimationFrame(messageActionFrameRef.current)
      messageActionFrameRef.current = null
    }
    const pendingActions = pendingMessageActionsRef.current
    if (pendingActions.length === 0) return
    pendingMessageActionsRef.current = []
    applyMessageActions(pendingActions)
  }, [applyMessageActions])
  const dispatchMessages = useCallback(
    (action: RuntimePaneMessageAction) => {
      if (!isBatchableRuntimePaneMessageAction(action)) {
        flushPendingMessageActions()
        applyMessageActions([action])
        return
      }

      appendBufferedRuntimePaneMessageAction(pendingMessageActionsRef.current, action)
      if (messageActionFrameRef.current !== null) return
      messageActionFrameRef.current = requestAnimationFrame(() => {
        messageActionFrameRef.current = null
        const pendingActions = pendingMessageActionsRef.current
        if (pendingActions.length === 0) return
        pendingMessageActionsRef.current = []
        applyMessageActions(pendingActions)
      })
    },
    [applyMessageActions, flushPendingMessageActions]
  )
  const lifecycleAddress = runtimeTaskLoadTarget?.address ?? currentRuntimeTask
  const taskLifecycle = useRuntimeTaskLifecycle(lifecycleAddress)
  const taskGoalStatus = taskLifecycle?.goalStatus ?? null
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

  /* eslint-disable react-hooks/set-state-in-effect -- Runtime task changes reset pane transcript state before the async transcript load completes. */
  useEffect(() => {
    currentRuntimeTaskRef.current = currentRuntimeTask
  }, [currentRuntimeTask])

  useEffect(() => {
    resumePausedQueueAfterTurnRef.current = null
    setQueuedMessagesState(
      queuedMessageScopeKey ? getRuntimeConversationQueuedMessagesByKey(queuedMessageScopeKey) : []
    )
    setQueuedMessagesPausedState(
      queuedMessageScopeKey ? getRuntimeConversationQueuePausedByKey(queuedMessageScopeKey) : false
    )
  }, [queuedMessageScopeKey])

  useEffect(() => {
    const lifecycle = currentRuntimeTask ? lifecycleStore.getTask(currentRuntimeTask) : null
    const pendingResume = resumePausedQueueAfterTurnRef.current
    if (!pendingResume || pendingResume.scopeKey !== queuedMessageScopeKey || !lifecycle) return

    if (!pendingResume.observedManualTurn) {
      const previousTurn = pendingResume.previousLifecycle?.turn
      const turnChanged =
        !previousTurn ||
        previousTurn.id !== lifecycle.turn.id ||
        previousTurn.phase !== lifecycle.turn.phase ||
        previousTurn.outcome !== lifecycle.turn.outcome
      if (!turnChanged) return
      pendingResume.observedManualTurn = true
    }

    if (lifecycle.turn.phase === 'streaming' || lifecycle.turn.outcome === null) return

    resumePausedQueueAfterTurnRef.current = null
    setQueuedMessagesPaused(false)
  }, [
    currentRuntimeTask,
    lifecycleStore,
    queuedMessageScopeKey,
    setQueuedMessagesPaused,
    taskLifecycle?.turn.outcome,
    taskLifecycle?.turn.phase,
  ])

  useEffect(() => {
    if (currentRuntimeTaskLoadTarget) {
      setRetainedRuntimeTaskLoadTarget(current =>
        current?.key === currentRuntimeTaskLoadTarget.key ? current : currentRuntimeTaskLoadTarget
      )
    }
  }, [currentRuntimeTaskLoadTarget])

  useEffect(() => {
    return () => {
      if (messageActionFrameRef.current !== null) {
        cancelAnimationFrame(messageActionFrameRef.current)
        messageActionFrameRef.current = null
      }
      pendingMessageActionsRef.current = []
    }
  }, [])

  useEffect(() => {
    runtimeTaskLoadTargetRef.current = runtimeTaskLoadTarget
  }, [runtimeTaskLoadTarget])

  useEffect(() => {
    if (!runtimeTaskLoadTarget) {
      setMessages([])
      setSubagentStatuses([])
      setTaskPlan(null)
      return
    }
    const { address } = runtimeTaskLoadTarget
    const syncConversationState = () => {
      const metadata = getRuntimeConversationMetadata(address)
      setMessages(getRuntimeConversationMessages(address))
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
    void getRuntimeGoal(runtimeTaskLoadTarget.address)
      .then(response => {
        if (!cancelled) {
          const loadedGoal = response.accepted ? response.goal : null
          const resolvedGoal = resolveHydratedRuntimeGoal(
            runtimeTaskLoadTarget.address,
            loadedGoal,
            seededGoal?.goal ?? null
          )
          if (import.meta.env.VITE_WEWORK_RUNTIME_DEBUG === '1') {
            console.info('[Wework] Runtime goal hydration resolved', {
              address: runtimeAddressDebug(runtimeTaskLoadTarget.address),
              accepted: response.accepted,
              goalStatus: loadedGoal?.status ?? null,
            })
          }
          setRuntimeConversationGoal(runtimeTaskLoadTarget.address, resolvedGoal)
          lifecycleStore.goalStatusReceived(
            runtimeTaskLoadTarget.address,
            resolvedGoal?.status ?? null
          )
          if (loadedGoal?.status === 'active') {
            void refreshWorkListsRef.current().catch(() => undefined)
          }
          if (loadedGoal) {
            clearRuntimePaneGoalSeed(runtimeTaskLoadTarget.address)
            setPendingGoalState(current =>
              current &&
              isPendingGoalVisibleForRuntimeTarget(current, runtimeTaskLoadTarget.address)
                ? null
                : current
            )
          }
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
      setTranscriptLoading(false)
      setTranscriptError(null)
      setTranscriptLoadingMoreBefore(false)
      return
    }

    const { key: loadKey, address } = runtimeTaskLoadTarget
    if (
      loadedRuntimeTranscriptKeyRef.current === loadKey &&
      displayedTranscriptIdentityRef.current === runtimeTaskLoadTarget.identityKey
    ) {
      return
    }

    let cancelled = false
    const hydrationToken = beginRuntimeConversationHydration(address)
    rebuildingTranscriptRef.current = true
    rebuildingTranscriptIdentityRef.current = runtimeTaskLoadTarget.identityKey
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
    dispatchMessages({ type: 'reset', messages: seededMessages })
    setTranscriptLoading(true)
    setTranscriptError(null)
    setTranscriptHasMoreBefore(false)
    setTranscriptBeforeCursor(null)
    setTranscriptLoadingMoreBefore(false)
    setTranscriptLoadingFullContent(false)
    setTranscriptFullContent(false)
    setLoadedTranscriptRanges([])
    setTurnNavigation([])
    void Promise.resolve()
      .then(() =>
        loadRuntimeTranscriptForPaneRef.current(address, {
          limit: runtimeTranscriptPageSize,
        })
      )
      .then(transcript => {
        if (!cancelled) {
          const preserveActiveTurn =
            (lifecycleStore.getTask(address)?.derived.isRunning ?? false) &&
            !runtimeConversationSnapshotSettlesLatestTurn(address, transcript.turns)
          lifecycleStore.syncTranscript(address, transcript, { preserveActiveTurn })
          const nextMessages = completeRuntimeConversationHydration(
            address,
            hydrationToken,
            transcript.turns
          )
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
          dispatchMessages({
            type: 'reset',
            messages: nextMessages,
          })
          rebuildingTranscriptRef.current = false
          rebuildingTranscriptIdentityRef.current = null
        }
      })
      .catch(error => {
        if (!cancelled) {
          abortRuntimeConversationHydration(address, hydrationToken)
          rebuildingTranscriptRef.current = false
          rebuildingTranscriptIdentityRef.current = null
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
        if (!cancelled) {
          setTranscriptLoading(false)
        }
      })

    return () => {
      cancelled = true
      abortRuntimeConversationHydration(address, hydrationToken)
      if (rebuildingTranscriptIdentityRef.current === runtimeTaskLoadTarget.identityKey) {
        rebuildingTranscriptRef.current = false
        rebuildingTranscriptIdentityRef.current = null
      }
    }
  }, [
    dispatchMessages,
    lifecycleStore,
    runtimeTaskLoadTarget,
    runtimeTranscriptPageSize,
    transcriptReloadVersion,
  ])
  /* eslint-enable react-hooks/set-state-in-effect */

  const reloadRuntimeTranscript = useCallback(() => {
    loadedRuntimeTranscriptKeyRef.current = null
    setTranscriptError(null)
    setTranscriptReloadVersion(version => version + 1)
  }, [])

  useEffect(() => {
    if (!runtimeTaskLoadTarget) return
    const target = runtimeTaskLoadTarget
    const { address, identityKey } = target
    return subscribeRuntimeTransportReplaced(replacement => {
      if (
        runtimeTaskLoadTargetRef.current?.identityKey !== identityKey ||
        rebuildingTranscriptRef.current ||
        !hasUnsettledRuntimePaneState(messagesRef.current)
      ) {
        return
      }

      const hydrationToken = beginRuntimeConversationHydration(address)
      rebuildingTranscriptRef.current = true
      rebuildingTranscriptIdentityRef.current = identityKey
      console.warn('[Wework] Runtime transport replaced during an active response', {
        address: runtimeAddressDebug(address),
        previousRuntimeInstanceId: replacement.previousRuntimeInstanceId,
        runtimeInstanceId: replacement.runtimeInstanceId,
        currentMessageCount: messagesRef.current.length,
      })

      void loadRuntimeTranscriptForPaneRef
        .current(address, {
          limit: runtimeTranscriptPageSize,
          refresh: true,
        })
        .then(transcript => {
          if (runtimeTaskLoadTargetRef.current?.identityKey !== identityKey) {
            abortRuntimeConversationHydration(address, hydrationToken)
            return
          }

          const nextMessages = completeRuntimeConversationHydration(
            address,
            hydrationToken,
            transcript.turns
          )
          loadedRuntimeTranscriptKeyRef.current = target.key
          setTranscriptFullContent(transcript.fullContent === true)
          setTranscriptHasMoreBefore(runtimeTranscriptHasMoreBefore(transcript))
          setTranscriptBeforeCursor(transcript.beforeCursor ?? null)
          setLoadedTranscriptRanges(transcriptRangeFromPage(transcript))
          setTurnNavigation(transcript.turnNavigation ?? [])
          dispatchMessages({ type: 'reset', messages: nextMessages })
          lifecycleStore.syncTranscript(address, transcript)
          console.info('[Wework] Runtime pane reconciled after transport replacement', {
            address: runtimeAddressDebug(address),
            running: lifecycleStore.getTask(address)?.derived.isRunning ?? false,
            transcriptMessageCount: transcript.messages.length,
            restoredMessageCount: nextMessages.length,
          })
        })
        .catch(error => {
          abortRuntimeConversationHydration(address, hydrationToken)
          if (runtimeTaskLoadTargetRef.current?.identityKey !== identityKey) return
          console.error('[Wework] Runtime replacement transcript recovery failed', {
            address: runtimeAddressDebug(address),
            error,
          })
        })
        .finally(() => {
          if (rebuildingTranscriptIdentityRef.current !== identityKey) return
          rebuildingTranscriptRef.current = false
          rebuildingTranscriptIdentityRef.current = null
        })
    })
  }, [dispatchMessages, lifecycleStore, runtimeTaskLoadTarget, runtimeTranscriptPageSize])

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
    setTranscriptLoadingMoreBefore(true)
    try {
      const transcript = await loadRuntimeTranscriptForPaneRef.current(address, {
        limit: runtimeTranscriptPageSize,
        beforeCursor,
      })
      const nextMessages = reconcileRuntimeConversationSnapshot(address, transcript.turns)
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
      dispatchMessages({ type: 'reset', messages: nextMessages })
    } catch (error) {
      console.error('[Wework] Runtime pane older transcript load failed', {
        key: loadKey,
        address,
        beforeCursor,
        error,
      })
    } finally {
      setTranscriptLoadingMoreBefore(false)
    }
  }, [
    dispatchMessages,
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

      const { address } = runtimeTaskLoadTarget
      const loadOptions = runtimeTurnNavigationLoadOptions(
        item,
        loadedTranscriptRangesRef.current,
        runtimeTranscriptPageSize
      )
      const transcript = await loadRuntimeTranscriptForPaneRef.current(address, loadOptions)
      const nextHasMoreBefore =
        loadOptions.beforeCursor === undefined
          ? transcriptHasMoreBefore
          : runtimeTranscriptHasMoreBefore(transcript)
      const nextBeforeCursor =
        loadOptions.beforeCursor === undefined
          ? transcriptBeforeCursor
          : (transcript.beforeCursor ?? null)
      const nextMessages = reconcileRuntimeConversationSnapshot(address, transcript.turns)
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
      dispatchMessages({ type: 'reset', messages: nextMessages })
    },
    [
      dispatchMessages,
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

      const { address } = runtimeTaskLoadTarget
      const limit = Math.min(runtimeTranscriptPageSize, gap.end - gap.start)
      const loadOptions = {
        limit,
        afterCursor: `offset:${gap.start}`,
      }
      const transcript = await loadRuntimeTranscriptForPaneRef.current(address, loadOptions)
      const nextMessages = reconcileRuntimeConversationSnapshot(address, transcript.turns)
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
      dispatchMessages({ type: 'reset', messages: nextMessages })
    },
    [dispatchMessages, runtimeTaskLoadTarget, runtimeTranscriptPageSize, transcriptFullContent]
  )

  const loadFullTranscript = useCallback(async () => {
    if (!runtimeTaskLoadTarget || transcriptLoadingFullContent || transcriptFullContent) return

    const { address } = runtimeTaskLoadTarget
    setTranscriptLoadingFullContent(true)
    try {
      const transcript = await loadRuntimeTranscriptForPaneRef.current(address, {
        includeFullContent: true,
        refresh: true,
      })
      const nextMessages = reconcileRuntimeConversationSnapshot(address, transcript.turns)
      setTranscriptFullContent(transcript.fullContent === true)
      setTranscriptHasMoreBefore(false)
      setTranscriptBeforeCursor(null)
      setLoadedTranscriptRanges(transcriptRangeFromPage(transcript))
      setTurnNavigation(current =>
        transcript.turnNavigation && transcript.turnNavigation.length > 0
          ? transcript.turnNavigation
          : current
      )
      dispatchMessages({ type: 'reset', messages: nextMessages })
    } catch (error) {
      console.error('[Wework] Runtime pane full transcript load failed', {
        address,
        error,
      })
      throw error
    } finally {
      setTranscriptLoadingFullContent(false)
    }
  }, [dispatchMessages, runtimeTaskLoadTarget, transcriptFullContent, transcriptLoadingFullContent])

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
      setMessages(nextMessages)
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
    ): Promise<boolean> => {
      if (!currentRuntimeTask) return false

      const userMessage = createRuntimeUserMessage(message.content, message.attachments, {
        id: message.id,
        createdAt: message.createdAt,
        runtimeGoalRequest: message.runtimeGoalRequest,
        codeComments: message.codeComments,
      })
      const appendedLocalMessage = options.appendLocalMessage !== false
      if (appendedLocalMessage) {
        const visibleMessage =
          message.displayContent === undefined
            ? userMessage
            : createRuntimeUserMessage(message.displayContent, message.attachments, {
                id: message.id,
                createdAt: message.createdAt,
                runtimeGoalRequest: message.runtimeGoalRequest,
                codeComments: message.codeComments,
              })
        setMessages(
          applyRuntimeConversationAction(currentRuntimeTask, {
            type: 'user_added',
            message: visibleMessage,
          })
        )
      }
      const messageAttachments = message.attachments ?? []
      const attachmentIds = remoteAttachmentIds(messageAttachments)
      const attachments = localRuntimeAttachments(messageAttachments)
      const terminalContext = readRuntimeTerminalAdditionalContext(currentRuntimeTask)
      const additionalContext = { ...message.additionalContext, ...terminalContext }
      const turnIdsBeforeSend = appendedLocalMessage
        ? new Set<string>()
        : getRuntimeConversationTurnIds(currentRuntimeTask)
      const sent = await sendRuntimePaneMessage(
        {
          address: currentRuntimeTask,
          message: message.content,
          clientUserMessageId: message.id,
          ...(message.modelId
            ? {
                modelId: message.modelId,
                modelType: message.modelType,
              }
            : {}),
          ...(message.modelOptions ? { modelOptions: message.modelOptions } : {}),
          ...(options.initialGoal ? { initialGoal: options.initialGoal } : {}),
          ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
          ...(attachments.length > 0 ? { attachments } : {}),
          ...(Object.keys(additionalContext).length > 0 ? { additionalContext } : {}),
        },
        {
          onError: options.onError ?? setError,
          silentBusyRetry: options.silentBusyRetry,
        }
      )
      if (sent) {
        if (!appendedLocalMessage) {
          const visibleMessage =
            message.displayContent === undefined
              ? userMessage
              : createRuntimeUserMessage(message.displayContent, message.attachments, {
                  id: message.id,
                  createdAt: message.createdAt,
                  runtimeGoalRequest: message.runtimeGoalRequest,
                  codeComments: message.codeComments,
                })
          const activeTurnId = lifecycleStore.getTask(currentRuntimeTask)?.turn.id ?? null
          setMessages(
            appendAcceptedRuntimeConversationMessage(
              currentRuntimeTask,
              visibleMessage,
              activeTurnId,
              turnIdsBeforeSend
            )
          )
        }
        markRuntimeTerminalAdditionalContextDelivered(terminalContext)
      } else if (appendedLocalMessage) {
        const rolledBackMessages = rollbackRejectedRuntimeConversationTurn(
          currentRuntimeTask,
          currentRuntimeTaskRef.current,
          message.id
        )
        if (rolledBackMessages) setMessages(rolledBackMessages)
      }
      return sent
    },
    [currentRuntimeTask, lifecycleStore, sendRuntimePaneMessage, setError]
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
        setMessages(
          removeRuntimeConversationTurn(currentRuntimeTask, {
            clientUserMessageId: message.id,
          })
        )
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

  const retryFailedMessageInPane = useCallback(
    async (message: WorkbenchMessage): Promise<boolean> => {
      if (retryInFlightRef.current) return false
      if (!currentRuntimeTask) return false

      retryInFlightRef.current = true
      setError(null)
      try {
        const currentMessages = messagesRef.current
        const failedMessage = currentMessages.find(
          currentMessage =>
            currentMessage.id === message.id &&
            currentMessage.role === 'assistant' &&
            currentMessage.status === 'failed'
        )
        if (!failedMessage) {
          setError('未找到可重试的失败消息')
          return false
        }

        const continuationMessage: RuntimePaneQueuedMessage = {
          id: `runtime-retry-continuation-${Date.now()}`,
          content: RUNTIME_RETRY_CONTINUATION_PROMPT,
          displayContent: i18n.t('workbench.retry_continue_message', '继续'),
          status: 'queued',
          createdAt: new Date().toISOString(),
          ...getRuntimeModelFields(),
        }
        debugRuntimePaneMessageFlow('retry-failed-message', {
          address: runtimeAddressDebug(currentRuntimeTask),
          failedMessageId: message.id,
          failedTurnId: failedMessage.turnId ?? failedMessage.subtaskId ?? null,
          continuationMessageId: continuationMessage.id,
        })
        return await sendRuntimeMessage(continuationMessage)
      } catch (error) {
        console.error('[Wework] Runtime failed message retry failed', {
          address: runtimeAddressDebug(currentRuntimeTask),
          messageId: message.id,
          error,
        })
        setError(error instanceof Error ? error.message : '重试失败')
        return false
      } finally {
        retryInFlightRef.current = false
      }
    },
    [currentRuntimeTask, getRuntimeModelFields, sendRuntimeMessage, setError]
  )

  const sendRequestUserInputResponse = useCallback(
    async (
      response: RequestUserInputResponse,
      options: SendRequestUserInputResponseOptions = {}
    ): Promise<boolean> => {
      if (!currentRuntimeTask) return false

      const message = requestUserInputResponseText(response)
      const requestUserInputKey = requestUserInputResponseKey(response)
      const runtimeModelOverride = options.forceDefaultCollaborationMode
        ? { collaborationMode: 'default' }
        : undefined
      if (options.forceDefaultCollaborationMode) {
        projectChat.setSelectedModelOption('collaborationMode', 'default')
      }
      const appendedUserMessage = options.appendUserMessage
        ? createRuntimeUserMessage(message)
        : null
      if (appendedUserMessage) {
        dispatchMessages({ type: 'user_added', message: appendedUserMessage })
      }
      if (requestUserInputKey) {
        setAnsweredRequestUserInputIds(current => {
          if (current.has(requestUserInputKey)) return current
          const next = new Set(current)
          next.add(requestUserInputKey)
          return next
        })
      }
      applyLocalRequestUserInputResponse(response)
      const runtimeModelFields = options.appendUserMessage
        ? getRuntimeModelFields(runtimeModelOverride)
        : {}
      const additionalContext = readRuntimeTerminalAdditionalContext(currentRuntimeTask)
      const sent = await sendRuntimePaneMessage({
        address: currentRuntimeTask,
        message,
        ...(appendedUserMessage ? { clientUserMessageId: appendedUserMessage.id } : {}),
        ...runtimeModelFields,
        ...(options.appendUserMessage ? {} : { requestUserInputResponse: response }),
        ...(additionalContext ? { additionalContext } : {}),
      })
      if (sent) {
        markRuntimeTerminalAdditionalContextDelivered(additionalContext)
      } else {
        if (requestUserInputKey) {
          setAnsweredRequestUserInputIds(current => {
            if (!current.has(requestUserInputKey)) return current
            const next = new Set(current)
            next.delete(requestUserInputKey)
            return next
          })
        }
      }
      return sent
    },
    [
      applyLocalRequestUserInputResponse,
      currentRuntimeTask,
      dispatchMessages,
      getRuntimeModelFields,
      projectChat,
      sendRuntimePaneMessage,
    ]
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

      const previousMessages = currentMessages
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

      const nextMessages = replaceRuntimeConversationFromUserMessage(
        currentRuntimeTask,
        message.id,
        { ...editedMessage, role: 'user' }
      )
      setMessages(nextMessages)
      try {
        const sent = await editLastUserMessage(request)
        if (sent) {
          markRuntimeTerminalAdditionalContextDelivered(additionalContext)
          return true
        }
        const transcript = await loadRuntimeTranscriptForPaneRef.current(currentRuntimeTask, {
          limit: runtimeTranscriptPageSize,
          refresh: true,
        })
        removeRuntimeConversationTurn(currentRuntimeTask, {
          clientUserMessageId: editedMessage.id,
        })
        const restoredMessages = reconcileRuntimeConversationSnapshot(
          currentRuntimeTask,
          transcript.turns
        )
        setMessages(restoredMessages)
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
        const restoredMessages = transcript
          ? reconcileRuntimeConversationSnapshot(currentRuntimeTask, transcript.turns)
          : previousMessages
        setMessages(restoredMessages)
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
    async (queuedMessage: RuntimePaneQueuedMessage) => {
      if (queuedMessageSendInFlightIdsRef.current.has(queuedMessage.id)) return
      queuedMessageSendInFlightIdsRef.current.add(queuedMessage.id)
      setQueuedMessages(messages =>
        messages.map(message =>
          message.id === queuedMessage.id
            ? {
                ...message,
                status: 'sending',
                deliveryMode: 'message',
                awaitingTurnStart: false,
              }
            : message
        )
      )

      try {
        const lifecycleBeforeSend = currentRuntimeTask
          ? lifecycleStore.getTask(currentRuntimeTask)
          : null
        let sendError: string | null = null
        const sent = await sendRuntimeMessage(queuedMessage, {
          appendLocalMessage: false,
          initialGoal: queuedMessage.initialGoal,
          onError: error => {
            sendError = error
          },
        })
        if (sent) {
          queuedMessageBusyBlockSnapshotsRef.current.delete(queuedMessage.id)
          if (!currentRuntimeTask) return
          if (runtimeConversationMessageHasStartedTurn(currentRuntimeTask, queuedMessage.id)) {
            settleRuntimeConversationAcceptedMessage(currentRuntimeTask, queuedMessage.id)
          } else {
            setQueuedMessages(messages =>
              messages.map(message =>
                message.id === queuedMessage.id ? { ...message, awaitingTurnStart: true } : message
              )
            )
          }
          return
        }
        if (isRuntimeTaskBusyError(sendError)) {
          const lifecycleAfterSend = currentRuntimeTask
            ? lifecycleStore.getTask(currentRuntimeTask)
            : null
          const lifecycleAlreadyChanged = runtimeTaskLifecycleTransitionChanged(
            lifecycleBeforeSend,
            lifecycleAfterSend
          )
          if (lifecycleAlreadyChanged) {
            queuedMessageBusyBlockSnapshotsRef.current.delete(queuedMessage.id)
          } else {
            queuedMessageBusyBlockSnapshotsRef.current.set(queuedMessage.id, lifecycleBeforeSend)
          }
          console.info('[Wework] Queued runtime message remains queued while executor is busy', {
            id: queuedMessage.id,
            deviceId: currentRuntimeTask?.deviceId ?? null,
            taskId: currentRuntimeTask?.taskId ?? null,
            executionPhase: lifecycleBeforeSend?.execution.phase ?? null,
            turnPhase: lifecycleBeforeSend?.turn.phase ?? null,
            executorSnapshotRunning: lifecycleBeforeSend?.task?.running ?? null,
            lifecycleAlreadyChanged,
          })
        } else {
          queuedMessageBusyBlockSnapshotsRef.current.delete(queuedMessage.id)
        }
        setQueuedMessages(messages =>
          messages.map(message =>
            message.id !== queuedMessage.id
              ? message
              : isRuntimeTaskBusyError(sendError)
                ? {
                    ...message,
                    status: 'queued',
                    awaitingTurnStart: undefined,
                    error: undefined,
                  }
                : {
                    ...message,
                    status: 'failed',
                    awaitingTurnStart: undefined,
                    error: '发送失败',
                  }
          )
        )
      } catch (error) {
        queuedMessageBusyBlockSnapshotsRef.current.delete(queuedMessage.id)
        console.error('[Wework] Queued runtime message send failed', {
          id: queuedMessage.id,
          error,
        })
        setQueuedMessages(messages =>
          messages.map(message =>
            message.id === queuedMessage.id
              ? {
                  ...message,
                  status: 'failed',
                  awaitingTurnStart: undefined,
                  error: '发送失败',
                }
              : message
          )
        )
      } finally {
        queuedMessageSendInFlightIdsRef.current.delete(queuedMessage.id)
      }
    },
    [currentRuntimeTask, lifecycleStore, sendRuntimeMessage, setQueuedMessages]
  )

  useEffect(() => {
    if (queuedMessagesPaused) return
    if (queuedMessages.some(message => message.status === 'sending')) return
    const queuedMessage = queuedMessages.find(message => message.status === 'queued')
    if (!queuedMessage) return
    if (
      !consumeRuntimeTaskLifecycleBlock(
        queuedMessageBusyBlockSnapshotsRef.current,
        queuedMessage.id,
        currentRuntimeTask ? lifecycleStore.getTask(currentRuntimeTask) : null
      )
    ) {
      return
    }
    const canStartQueuedGoal =
      Boolean(queuedMessage.initialGoal) &&
      Boolean(currentRuntimeTask) &&
      paneStatus.taskExecution.continuable &&
      !paneStatus.isResponseActive
    if (!paneStatus.canSendQueuedMessage && !canStartQueuedGoal) return

    // Goal activation intentionally keeps the task busy between turns. Its initial turn must
    // advance when the current response settles instead of waiting for the task to become idle.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Queue advancement is triggered by the idle-state transition.
    void sendQueuedMessage(queuedMessage)
  }, [
    currentRuntimeTask,
    lifecycleStore,
    paneStatus.canSendQueuedMessage,
    paneStatus.isResponseActive,
    paneStatus.taskExecution.continuable,
    queuedMessages,
    queuedMessagesPaused,
    sendQueuedMessage,
  ])

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
    async (queuedMessage: RuntimePaneQueuedMessage, forceActiveTurn = false) => {
      const id = queuedMessage.id
      queuedMessageBusyBlockSnapshotsRef.current.delete(id)
      if (!currentRuntimeTask) {
        setQueuedMessages(messages =>
          messages.map(message =>
            message.id === id
              ? { ...message, status: 'failed', error: '当前回复缺少引导上下文' }
              : message
          )
        )
        return
      }
      if (currentRuntimeTask.runtime && currentRuntimeTask.runtime !== 'codex') return

      if (queuedMessage.status === 'sending') return

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
          const sent = await sendRuntimeMessage(queuedMessage)
          setQueuedMessages(messages =>
            sent
              ? messages.filter(message => message.id !== id)
              : messages.map(message =>
                  message.id === id
                    ? { ...message, status: 'failed', notice: undefined, error: '发送失败' }
                    : message
                )
          )
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
        }
        return
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
        }
        if (!result.sent) {
          removeOptimisticRuntimeConversationGuidance(currentRuntimeTask, id)
          if (takeInterruptedRuntimeConversationGuidance(currentRuntimeTask, id)) {
            setQueuedMessages(messages => messages.filter(message => message.id !== id))
            return
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
        }
      } catch (error) {
        removeOptimisticRuntimeConversationGuidance(currentRuntimeTask, id)
        if (takeInterruptedRuntimeConversationGuidance(currentRuntimeTask, id)) {
          setQueuedMessages(messages => messages.filter(message => message.id !== id))
          return
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
      }
    },
    [
      currentRuntimeTask,
      readCurrentPaneBusy,
      sendRuntimeMessage,
      sendRuntimePaneGuidance,
      setError,
      setQueuedMessages,
    ]
  )

  const send: (inputOverride?: string, options?: RuntimePaneSendOptions) => Promise<boolean> =
    useCallback(
      async (inputOverride, options = {}) => {
        const submittedInput = (inputOverride ?? input).trim()
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
              setInput('')
              setRuntimeConversationGoal(currentRuntimeTask, response.goal)
              lifecycleStore.goalStatusReceived(currentRuntimeTask, response.goal.status)
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
              setInput('')
              setRuntimeConversationGoal(currentRuntimeTask, draftGoal)
              lifecycleStore.goalStatusReceived(currentRuntimeTask, draftGoal.status)
              setGoalDraftActive(false)
              setQueuedMessages(messages => [...messages, queuedMessage])
              return true
            }

            let sendError: string | null = null
            const sent = await sendRuntimeMessage(queuedMessage, {
              initialGoal,
              onError: nextError => {
                sendError = nextError
              },
            })
            if (sent) {
              setInput('')
              setRuntimeConversationGoal(currentRuntimeTask, draftGoal)
              lifecycleStore.goalStatusReceived(currentRuntimeTask, draftGoal.status)
              setGoalDraftActive(false)
              setCodeCommentContexts([])
            } else {
              currentAttachments.forEach(addExistingAttachment)
              setError(sendError ?? i18n.t('workbench.project_chat_send_failed'))
            }
            return sent
          }

          const draftGoal = createPendingRuntimeGoal(submittedInput)
          const initialGoal = runtimeGoalCreateInput(draftGoal)
          setInput('')
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
            initialSupervisor: options.initialSupervisor,
            ...(options.runtime ? { runtime: options.runtime } : {}),
            ...(options.runtimeExecutablePath
              ? { runtimeExecutablePath: options.runtimeExecutablePath }
              : {}),
            ...(options.runtimePermissionMode
              ? { runtimePermissionMode: options.runtimePermissionMode }
              : {}),
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
            setInput('')
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
            restoreInputAfterFailure(submittedInput)
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
            if (compacted) setInput('')
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
          setInput('')
          let errorScopeKey = inputScopeKey
          const optimisticMessage = createRuntimeUserMessage(
            visibleSubmittedInput,
            currentAttachments,
            {
              runtimeGoalRequest: Boolean(pendingInitialGoal),
              codeComments: codeCommentContexts,
            }
          )
          const sent = await sendCurrentInput(visibleSubmittedInput, {
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
            ...(Object.prototype.hasOwnProperty.call(options, 'modelSelection')
              ? { modelSelection: options.modelSelection }
              : {}),
            onError: nextError => setErrorForScope(errorScopeKey, nextError),
            onRuntimeTaskOptimisticOpen: (address, context) => {
              errorScopeKey = getRuntimeTaskChatScopeKey(address)
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
          })
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
              dispatchMessages({ type: 'reset', messages: [] })
            }
            resetAttachments()
            clearCodeCommentsAfterCommit('send_success', codeCommentContexts)
          } else {
            restoreInputAfterFailure(visibleSubmittedInput)
          }
          return Boolean(sent)
        }

        if (hasCodeComments) {
          const queuedMessage: RuntimePaneQueuedMessage = {
            id: `queued-runtime-pane-${Date.now()}-${queuedMessages.length}`,
            content: appendCodeCommentContexts(visibleSubmittedInput, codeCommentContexts),
            displayContent: visibleSubmittedInput,
            codeComments: codeCommentContexts,
            status: 'queued',
            createdAt: new Date().toISOString(),
            attachments: persistAttachmentReferences(currentAttachments),
            additionalContext: resolvedAdditionalContext,
            ...getRuntimeModelFields(),
          }

          if (paneIsBusy) {
            resetAttachments()
            setCodeCommentContexts([])
            if (options.interruptWhenBusy) {
              const sent = await interruptAndSendQueuedMessage(queuedMessage)
              if (!sent) {
                currentAttachments.forEach(addExistingAttachment)
                setCodeCommentContexts(codeCommentContexts)
              } else {
                setInput('')
              }
              return sent
            }
            setQueuedMessages(messages => [...messages, queuedMessage])
            setInput('')
            return true
          }

          let sendError: string | null = null
          const lifecycleBeforeSend = currentRuntimeTask
            ? lifecycleStore.getTask(currentRuntimeTask)
            : null
          const sent = await sendRuntimeMessage(queuedMessage, {
            onError: nextError => {
              sendError = nextError
            },
          })
          if (sent) {
            setInput('')
            resetAttachments()
            clearCodeCommentsAfterCommit('send_success', codeCommentContexts)
          } else if (isRuntimeTaskBusyError(sendError)) {
            const lifecycleAfterSend = currentRuntimeTask
              ? lifecycleStore.getTask(currentRuntimeTask)
              : null
            if (runtimeTaskLifecycleTransitionChanged(lifecycleBeforeSend, lifecycleAfterSend)) {
              queuedMessageBusyBlockSnapshotsRef.current.delete(queuedMessage.id)
            } else {
              queuedMessageBusyBlockSnapshotsRef.current.set(queuedMessage.id, lifecycleBeforeSend)
            }
            setQueuedMessages(messages => [...messages, queuedMessage])
            setInput('')
            resetAttachments()
            setCodeCommentContexts([])
          } else {
            setError(sendError ?? i18n.t('workbench.project_chat_send_failed'))
          }
          return sent || isRuntimeTaskBusyError(sendError)
        }

        const queuedMessage: RuntimePaneQueuedMessage = {
          id: `queued-runtime-pane-${Date.now()}-${queuedMessages.length}`,
          content: submittedInput,
          status: 'queued',
          createdAt: new Date().toISOString(),
          attachments: persistAttachmentReferences(currentAttachments),
          additionalContext: resolvedAdditionalContext,
          ...getRuntimeModelFields(),
        }

        resetAttachments()
        if (paneIsBusy) {
          if (options.interruptWhenBusy) {
            const sent = await interruptAndSendQueuedMessage(queuedMessage)
            if (!sent) {
              currentAttachments.forEach(addExistingAttachment)
            } else {
              setInput('')
            }
            return sent
          }
          setQueuedMessages(messages => [...messages, queuedMessage])
          setInput('')
          if (options.guideWhenBusy) {
            await sendQueuedMessageAsGuidance(queuedMessage, true)
          }
          return true
        }

        let sendError: string | null = null
        const lifecycleBeforeSend = currentRuntimeTask
          ? lifecycleStore.getTask(currentRuntimeTask)
          : null
        const sent = await sendRuntimeMessage(queuedMessage, {
          onError: nextError => {
            sendError = nextError
          },
        })
        if (sent) {
          setInput('')
          setCodeCommentContexts([])
        } else if (isRuntimeTaskBusyError(sendError)) {
          const lifecycleAfterSend = currentRuntimeTask
            ? lifecycleStore.getTask(currentRuntimeTask)
            : null
          if (runtimeTaskLifecycleTransitionChanged(lifecycleBeforeSend, lifecycleAfterSend)) {
            queuedMessageBusyBlockSnapshotsRef.current.delete(queuedMessage.id)
          } else {
            queuedMessageBusyBlockSnapshotsRef.current.set(queuedMessage.id, lifecycleBeforeSend)
          }
          setQueuedMessages(messages => [...messages, queuedMessage])
          setInput('')
        } else {
          currentAttachments.forEach(addExistingAttachment)
          setError(sendError ?? i18n.t('workbench.project_chat_send_failed'))
        }
        return sent || isRuntimeTaskBusyError(sendError)
      },
      [
        addExistingAttachment,
        appendLocalUserMessage,
        attachmentState.attachments,
        clearCodeCommentsAfterCommit,
        codeCommentContexts,
        compactRuntimePaneTask,
        currentRuntimeTask,
        dispatchMessages,
        goalDraftActive,
        getRuntimeModelFields,
        input,
        inputScopeKey,
        interruptAndSendQueuedMessage,
        lifecycleStore,
        loadRuntimeTranscriptForPane,
        pendingGoalState,
        queuedMessages.length,
        readCurrentPaneBusy,
        resetAttachments,
        restoreInputAfterFailure,
        sendCurrentInput,
        sendQueuedMessageAsGuidance,
        sendRuntimeMessage,
        setErrorForScope,
        setError,
        setInput,
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
    (id: string) => {
      queuedMessageBusyBlockSnapshotsRef.current.delete(id)
      setQueuedMessages(messages => messages.filter(message => message.id !== id))
    },
    [setQueuedMessages]
  )

  const resumeQueuedMessages = useCallback(() => {
    setQueuedMessagesPaused(false)
    const interruptedGuidance = queuedMessages.find(isInterruptedGuidance)
    const queuedMessage =
      interruptedGuidance ?? queuedMessages.find(message => message.status === 'queued')
    if (queuedMessage) {
      queuedMessageBusyBlockSnapshotsRef.current.delete(queuedMessage.id)
      void sendQueuedMessage(queuedMessage)
    }
  }, [queuedMessages, sendQueuedMessage, setQueuedMessagesPaused])

  const resumeQueuedMessagesWithInput = useCallback(
    async (inputOverride?: string, options?: RuntimePaneSendOptions) => {
      const interruptedGuidance = queuedMessages.find(isInterruptedGuidance)
      if (!interruptedGuidance) {
        const queuedMessage = queuedMessages.find(message => message.status === 'queued')
        const lifecycle = currentRuntimeTask ? lifecycleStore.getTask(currentRuntimeTask) : null
        if (queuedMessage && queuedMessageScopeKey) {
          resumePausedQueueAfterTurnRef.current = {
            scopeKey: queuedMessageScopeKey,
            previousLifecycle: lifecycle,
            observedManualTurn: false,
          }
        }
        const sent = await send(inputOverride, options)
        if (!sent) {
          resumePausedQueueAfterTurnRef.current = null
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
      queuedMessageScopeKey,
      queuedMessages,
      send,
      sendQueuedMessage,
      setQueuedMessagesPaused,
    ]
  )

  const clearQueuedMessages = useCallback(() => {
    queuedMessageBusyBlockSnapshotsRef.current.clear()
    setQueuedMessages([])
    setQueuedMessagesPaused(false)
  }, [setQueuedMessages, setQueuedMessagesPaused])

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
      if (!queuedMessage || queuedMessage.status === 'sending') return

      queuedMessageBusyBlockSnapshotsRef.current.delete(id)
      setInput(queuedMessage.content)
      queuedMessage.attachments?.forEach(attachment => {
        addExistingAttachment(attachment)
      })
      setQueuedMessages(messages => messages.filter(message => message.id !== id))
    },
    [addExistingAttachment, queuedMessages, setInput, setQueuedMessages]
  )

  const sendQueuedAsGuidance = useCallback(
    async (id: string) => {
      const queuedMessage = queuedMessages.find(message => message.id === id)
      if (!queuedMessage) return
      await sendQueuedMessageAsGuidance(queuedMessage)
    },
    [queuedMessages, sendQueuedMessageAsGuidance]
  )

  const interruptAndSendQueued = useCallback(
    async (id: string) => {
      const queuedMessage = queuedMessages.find(message => message.id === id)
      if (!queuedMessage) return
      queuedMessageBusyBlockSnapshotsRef.current.delete(id)
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

        setRuntimeConversationGoal(currentRuntimeTask, response.goal)
        lifecycleStore.goalStatusReceived(currentRuntimeTask, response.goal.status)
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
    const sent = await sendRuntimeMessage(message, {
      initialGoal,
      onError: error => {
        sendError = error
      },
    })
    if (sent) return true

    await updateCurrentGoalStatus('paused')
    setError(sendError ?? i18n.t('workbench.project_chat_send_failed'))
    return false
  }, [
    currentRuntime,
    getRuntimeModelFields,
    goal,
    paneStatus.isBusy,
    sendRuntimeMessage,
    setError,
    updateCurrentGoalStatus,
  ])

  const pauseCurrentResponse = useCallback(async () => {
    if (!currentRuntimeTask) return

    if (goal?.status === 'active' || taskGoalStatus === 'active') {
      const paused = await updateCurrentGoalStatus('paused')
      if (!paused) return
    }

    const shouldPauseQueue = queuedMessages.some(message => message.status === 'queued')
    if (shouldPauseQueue) {
      setQueuedMessagesPaused(true)
    }
    const cancelled = await cancelRuntimePaneTask(currentRuntimeTask)
    if (!cancelled) {
      if (shouldPauseQueue) {
        setQueuedMessagesPaused(false)
      }
      return
    }

    optimisticallyInterruptRuntimeConversation(currentRuntimeTask)
    void refreshWorkLists()
  }, [
    cancelRuntimePaneTask,
    currentRuntimeTask,
    goal?.status,
    queuedMessages,
    refreshWorkLists,
    setQueuedMessagesPaused,
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

      setRuntimeConversationGoal(currentRuntimeTask, null)
      lifecycleStore.goalStatusReceived(currentRuntimeTask, null)
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
  const goalContinuing = projectRuntimeGoalContinuing({
    goal,
    continuation: goalContinuation,
    taskRunning: paneStatus.taskExecution.running,
    messages,
    activeAssistantMessage,
  })

  useEffect(() => {
    const shouldReconcile = shouldReconcileActiveRuntimeGoalTranscript({
      goalContinuing,
      messages,
      activeAssistantMessage,
    })
    if (!runtimeTaskLoadTarget || transcriptLoading || !shouldReconcile) {
      if (!shouldReconcile) {
        goalTranscriptReconciliationRef.current = null
      }
      return
    }

    const { address, identityKey } = runtimeTaskLoadTarget
    const activeTurnId =
      activeAssistantMessage?.turnId?.trim() ||
      activeAssistantMessage?.subtaskId?.trim() ||
      activeAssistantMessage?.id
    const reconciliationKey = `${identityKey}:${activeTurnId}`
    if (goalTranscriptReconciliationRef.current?.key !== reconciliationKey) {
      goalTranscriptReconciliationRef.current = {
        key: reconciliationKey,
        attempts: 0,
      }
    }
    if ((goalTranscriptReconciliationRef.current?.attempts ?? 0) >= 30) {
      return
    }

    let cancelled = false
    let retryTimeout: number | null = null
    const reconcile = async () => {
      if (cancelled) return
      if (rebuildingTranscriptRef.current) {
        retryTimeout = window.setTimeout(() => void reconcile(), 1_000)
        return
      }

      const reconciliation = goalTranscriptReconciliationRef.current
      if (!reconciliation || reconciliation.key !== reconciliationKey) return
      if (reconciliation.attempts >= 30) return
      reconciliation.attempts += 1
      const attempt = reconciliation.attempts
      const hydrationToken = beginRuntimeConversationHydration(address)
      rebuildingTranscriptRef.current = true
      rebuildingTranscriptIdentityRef.current = identityKey
      try {
        const transcript = await loadRuntimeTranscriptForPaneRef.current(address, {
          limit: runtimeTranscriptPageSize,
          refresh: true,
        })
        if (cancelled || runtimeTaskLoadTargetRef.current?.identityKey !== identityKey) {
          abortRuntimeConversationHydration(address, hydrationToken)
          return
        }

        const nextMessages = completeRuntimeConversationHydration(
          address,
          hydrationToken,
          transcript.turns
        )
        dispatchMessages({ type: 'reset', messages: nextMessages })
        lifecycleStore.syncTranscript(address, transcript, { preserveActiveTurn: true })
        console.info('[Wework] Active Goal transcript projection reconciled', {
          address: runtimeAddressDebug(address),
          attempt,
          transcriptMessageCount: transcript.messages.length,
          restoredMessageCount: nextMessages.length,
        })

        if (
          attempt < 30 &&
          shouldReconcileActiveRuntimeGoalTranscript({
            goalContinuing: true,
            messages: nextMessages,
            activeAssistantMessage,
          })
        ) {
          retryTimeout = window.setTimeout(() => void reconcile(), 1_000)
        }
      } catch (error) {
        abortRuntimeConversationHydration(address, hydrationToken)
        if (!cancelled && attempt < 30) {
          retryTimeout = window.setTimeout(() => void reconcile(), 1_000)
        }
        console.error('[Wework] Active Goal transcript projection reconciliation failed', {
          address: runtimeAddressDebug(address),
          attempt,
          error,
        })
      } finally {
        if (rebuildingTranscriptIdentityRef.current === identityKey) {
          rebuildingTranscriptRef.current = false
          rebuildingTranscriptIdentityRef.current = null
        }
      }
    }

    void reconcile()
    return () => {
      cancelled = true
      if (retryTimeout !== null) {
        window.clearTimeout(retryTimeout)
      }
    }
  }, [
    activeAssistantMessage,
    dispatchMessages,
    goalContinuing,
    lifecycleStore,
    messages,
    runtimeTaskLoadTarget,
    runtimeTranscriptPageSize,
    transcriptLoading,
  ])

  useEffect(() => {
    if (!debugSnapshotEnabled) return

    let timeout: number | null = null
    const schedule = () => {
      if (timeout !== null) return
      timeout = window.setTimeout(() => {
        timeout = null
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
      }, DEBUG_SNAPSHOT_DEBOUNCE_MS)
    }
    schedule()
    return () => {
      if (timeout !== null) {
        clearTimeout(timeout)
      }
    }
  }, [
    codeCommentContexts.length,
    currentRuntimeTask,
    debugSnapshotEnabled,
    goal,
    taskPlan,
    goalDraftActive,
    guidanceMessages,
    input.length,
    loadedTranscriptRanges,
    messages,
    paneStatus,
    queuedMessages,
    queuedMessagesPaused,
    subagentStatuses,
    transcriptHasMoreBefore,
    transcriptFullContent,
    transcriptLoading,
    transcriptError,
    reloadRuntimeTranscript,
    transcriptLoadingFullContent,
    transcriptLoadingMoreBefore,
    turnNavigation.length,
  ])

  return {
    scopeKey: inputScopeKey,
    attachments: attachmentState.attachments,
    uploadingFiles: attachmentState.uploadingFiles,
    attachmentErrors: attachmentState.errors,
    handleFileSelect,
    removeAttachment,
    messages,
    queuedMessages,
    queuedMessagesPaused,
    guidanceMessages,
    codeCommentContexts,
    browserAnnotationCommand,
    input,
    setInput,
    error,
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
    transcriptLoadingFullContent,
    transcriptFullContent,
    loadedTranscriptRanges,
    turnNavigation,
    subagentStatuses,
    goal,
    goalContinuing,
    taskPlan,
    goalDraftActive,
    loadMoreTranscriptBefore,
    loadFullTranscript,
    loadFullTranscriptForExport,
    loadTranscriptTurnNavigationItem,
    loadTranscriptGap,
    send,
    retryFailedMessage: retryFailedMessageInPane,
    editLastUserMessage: editLastUserMessageInPane,
    sendRequestUserInputResponse,
    ignoreRequestUserInput,
    addCodeComment,
    replaceBrowserCodeComments,
    removeBrowserCodeComments,
    clearCodeComments,
    cancelQueuedMessage,
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
  seededGoal: RuntimeGoal | null
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

  return seededGoal
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
    contentLength: message.content.length,
    subtaskId: message.subtaskId ?? null,
    turnId: message.turnId ?? null,
  }))
}

function debugRuntimePaneMessageFlow(event: string, details: Record<string, unknown>) {
  if (!isRuntimeDebugEnabled()) return
  console.debug('[Wework] Runtime pane message flow', {
    event,
    ...details,
  })
}

function isBatchableRuntimePaneMessageAction(action: RuntimePaneMessageAction): boolean {
  return action.type === 'assistant_chunk' || action.type === 'block_updated'
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

function isUnsettledRuntimeMessage(message: WorkbenchMessage): boolean {
  return (
    message.status === 'streaming' ||
    message.status === 'pending' ||
    Boolean(
      message.blocks?.some(block =>
        ['generating_arguments', 'pending', 'streaming'].includes(block.status)
      )
    )
  )
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

function transcriptRangeFromPage(transcript: RuntimePaneTranscript): LoadedTranscriptRange[] {
  const indexedRange = transcriptRangeFromMessageIndexes(transcript.messages)
  const rangeStart =
    numericValue(transcript.rangeStart) ??
    cursorOffset(transcript.beforeCursor) ??
    indexedRange?.start ??
    (transcript.hasMoreBefore ? null : 0)
  const rangeEnd =
    numericValue(transcript.rangeEnd) ??
    cursorOffset(transcript.afterCursor) ??
    indexedRange?.end ??
    (rangeStart === null ? null : rangeStart + transcript.messages.length)

  if (rangeStart === null || rangeEnd === null || rangeEnd < rangeStart) return []
  return [{ start: rangeStart, end: rangeEnd }]
}

function transcriptRangeFromMessageIndexes(
  messages: WorkbenchMessage[]
): LoadedTranscriptRange | null {
  const indexes = messages
    .map(message =>
      typeof message.runtimeMessageIndex === 'number' &&
      Number.isFinite(message.runtimeMessageIndex)
        ? message.runtimeMessageIndex
        : null
    )
    .filter((index): index is number => index !== null)
  if (indexes.length === 0) return null
  return {
    start: Math.min(...indexes),
    end: Math.max(...indexes) + 1,
  }
}

function mergeTranscriptRanges(
  currentRanges: LoadedTranscriptRange[],
  incomingRanges: LoadedTranscriptRange[]
): LoadedTranscriptRange[] {
  const ranges = [...currentRanges, ...incomingRanges]
    .filter(range => range.end > range.start)
    .sort((left, right) => left.start - right.start)

  const merged: LoadedTranscriptRange[] = []
  for (const range of ranges) {
    const previous = merged[merged.length - 1]
    if (!previous || range.start > previous.end) {
      merged.push({ ...range })
      continue
    }
    previous.end = Math.max(previous.end, range.end)
  }
  return merged
}

function numericValue(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function cursorOffset(cursor: string | null | undefined): number | null {
  if (!cursor) return null
  const match = /^offset:(\d+)$/.exec(cursor.trim())
  if (!match) return null
  return Number.parseInt(match[1], 10)
}

function runtimeTurnNavigationLoadOptions(
  item: RuntimeTurnNavigationItem,
  loadedRanges: LoadedTranscriptRange[],
  pageSize: number
) {
  const messageIndex = Number.isFinite(item.messageIndex) ? Math.max(0, item.messageIndex) : 0
  const sortedRanges = mergeTranscriptRanges(loadedRanges, [])
  const nextLoadedRange = sortedRanges.find(range => range.start > messageIndex)
  const pageEnd = Math.max(
    messageIndex + 1,
    Math.min(nextLoadedRange?.start ?? messageIndex + pageSize, messageIndex + pageSize)
  )

  return {
    limit: pageSize,
    beforeCursor: `offset:${pageEnd}`,
  }
}

function hasUnsettledRuntimePaneState(messages: WorkbenchMessage[]): boolean {
  return messages.some(isUnsettledRuntimeMessage)
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

function requestUserInputResponseText(response: RequestUserInputResponse): string {
  const answers = Object.values(response.answers)
    .flatMap(answer => answer.answers)
    .map(answer => answer.trim())
    .filter(Boolean)
  return answers.length > 0 ? answers.join('\n') : '继续'
}
