import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import i18n from '@/i18n'
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
  getRuntimePaneTaskExecution,
  hasSettledAssistantMessage,
  type RuntimePaneSendPhase,
} from '@/features/workbench/runtimePaneStatus'
import {
  resolveAutomaticModel,
  selectedModelExecutionFields,
} from '@/features/workbench/runtimeModelSelection'
import { persistAttachmentReferences } from '@/lib/attachments'
import { localRuntimeAttachments, remoteAttachmentIds } from '@/lib/runtime-attachments'
import {
  applyRequestUserInputResponseToMessages,
  requestUserInputPayloadKey,
  requestUserInputResponseKey,
} from '@/components/chat/requestUserInputMessages'
import type { RequestUserInputPayload } from '@/components/chat/RequestUserInputCard'
import { debugComposerEvent, textMetrics } from '@/components/chat/composer/composerDebug'
import { visibleRuntimeGoal } from '@/lib/runtime-goal'
import { appendCodeCommentContexts } from '@/lib/code-comment-context'
import {
  markRuntimeTerminalAdditionalContextDelivered,
  readRuntimeTerminalAdditionalContext,
} from '@/lib/runtime-terminal-context'
import type {
  Attachment,
  ModelOptions,
  RequestUserInputResponse,
  RuntimeGoal,
  RuntimeGoalCreateInput,
  RuntimePlanEventPayload,
  RuntimeGoalContinuationPayload,
  RuntimeRollbackRequest,
  RuntimeSubagentActivityPayload,
  RuntimeSendRequest,
  RuntimeTaskAddress,
  RuntimeTurnNavigationItem,
  TurnFileChangesSummary,
} from '@/types/api'
import type {
  GuidanceWorkbenchMessage,
  QueuedWorkbenchMessage,
  RuntimePaneTranscript,
  RuntimeSubagentStatus,
  WorkbenchMessage,
} from '@/types/workbench'
import type { CodeCommentContext } from '@/types/workspace-files'
import { reduceWorkbenchMessages } from '@wegent/chat-core'
import { getCachedRuntimeTaskPlan } from '@/stream/responseApiStream'
import { useWorkbenchPaneActive } from './workbenchPaneStack'

interface WorkbenchPaneSessionOptions {
  currentRuntimeTask: RuntimeTaskAddress | null
}

interface RuntimePaneQueuedMessage extends QueuedWorkbenchMessage {
  attachments?: Attachment[]
  displayContent?: string
  codeComments?: CodeCommentContext[]
  modelId?: string
  modelType?: RuntimeSendRequest['modelType']
  modelOptions?: ModelOptions
  runtimeGoalRequest?: boolean
}

interface SendRequestUserInputResponseOptions {
  appendUserMessage?: boolean
  forceDefaultCollaborationMode?: boolean
}

interface RuntimePaneSendOptions {
  guideWhenBusy?: boolean
}

interface SendRuntimeMessageOptions {
  appendLocalMessage?: boolean
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

interface GuidanceSplitBoundary {
  prefix: string
}

const runtimePaneMessageSeeds = new Map<string, WorkbenchMessage[]>()
const runtimePaneMessageSnapshots = new Map<string, WorkbenchMessage[]>()
const runtimePaneGoalSeeds = new Map<string, PendingRuntimeGoalState>()
const RUNTIME_TRANSCRIPT_PAGE_SIZE = 50
const MAX_CACHED_RUNTIME_PANE_MESSAGES = 3
const MAX_CACHED_RUNTIME_PANE_GOALS = 3
const noopSetInput = () => undefined

export function useWorkbenchPaneSession({ currentRuntimeTask }: WorkbenchPaneSessionOptions) {
  const {
    state: workbenchState,
    projectChat,
    loadRuntimeTranscriptForPane,
    subscribeRuntimeTaskStream,
    getRuntimeGoal,
    setRuntimeGoal,
    clearRuntimeGoal,
    markRuntimeTaskStarted,
    sendRuntimePaneMessage,
    sendRuntimePaneGuidance,
    compactRuntimePaneTask,
    editLastUserMessage,
    cancelRuntimePaneTask,
    sendCurrentInput,
    refreshWorkLists,
  } = useWorkbenchPaneContext()
  const paneActive = useWorkbenchPaneActive()
  const [queuedMessages, setQueuedMessages] = useState<RuntimePaneQueuedMessage[]>([])
  const [queuedMessagesPaused, setQueuedMessagesPaused] = useState(false)
  const [guidanceMessages] = useState<GuidanceWorkbenchMessage[]>([])
  const [codeCommentContexts, setCodeCommentContexts] = useState<CodeCommentContext[]>([])
  const input = projectChat.input ?? ''
  const scopedSetInput = projectChat.setInput ?? noopSetInput
  const [error, setError] = useState<string | null>(null)
  const setInput = useCallback(
    (value: string) => {
      scopedSetInput(value)
      setError(null)
    },
    [scopedSetInput]
  )
  const [sendPhase, setSendPhase] = useState<RuntimePaneSendPhase>('idle')
  const [answeredRequestUserInputIds, setAnsweredRequestUserInputIds] = useState<
    ReadonlySet<string>
  >(() => new Set())
  const [transcriptLoading, setTranscriptLoading] = useState(() => Boolean(currentRuntimeTask))
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
  const subscribeRuntimeTaskStreamRef = useRef(subscribeRuntimeTaskStream)
  const getRuntimeGoalRef = useRef(getRuntimeGoal)
  const goalRevisionRef = useRef(0)
  const commitThreadGoal = useCallback((nextGoal: RuntimeGoal | null) => {
    goalRevisionRef.current += 1
    setThreadGoal(nextGoal)
  }, [])
  const refreshWorkListsRef = useRef(refreshWorkLists)
  const currentRuntimeTaskRef = useRef(currentRuntimeTask)
  const runtimeTaskLoadTargetRef = useRef<RuntimeTaskLoadTarget | null>(null)
  const messagesRef = useRef<WorkbenchMessage[]>([])
  const loadedTranscriptRangesRef = useRef<LoadedTranscriptRange[]>([])
  const guidanceSplitBoundariesRef = useRef(new Map<string, GuidanceSplitBoundary>())
  const pendingAppliedGuidancesRef = useRef(new Map<string, RuntimePaneQueuedMessage>())
  const pendingMessageActionsRef = useRef<RuntimePaneMessageAction[]>([])
  const messageActionFrameRef = useRef<number | null>(null)
  const currentRuntimeTaskLoadTarget = useMemo(
    () => (currentRuntimeTask ? runtimeTaskLoadTargetFromAddress(currentRuntimeTask) : null),
    [currentRuntimeTask]
  )
  const [retainedRuntimeTaskLoadTarget, setRetainedRuntimeTaskLoadTarget] =
    useState<RuntimeTaskLoadTarget | null>(() =>
      currentRuntimeTask ? runtimeTaskLoadTargetFromAddress(currentRuntimeTask) : null
    )
  const runtimeTaskLoadTarget = retainedRuntimeTaskLoadTarget
  const runtimeTaskStreamTargetKey = runtimeTaskLoadTarget?.identityKey ?? null
  const [messages, setMessages] = useState<WorkbenchMessage[]>([])
  const applyMessageActions = useCallback((actions: RuntimePaneMessageAction[]) => {
    if (actions.length === 0) return
    setMessages(currentMessages => {
      let nextMessages = currentMessages
      for (const action of actions) {
        const actionForReduction = transformRuntimePaneActionForGuidanceSplits(
          action,
          guidanceSplitBoundariesRef.current
        )
        nextMessages = reduceWorkbenchMessages<Attachment, TurnFileChangesSummary>(
          nextMessages,
          actionForReduction
        )
      }
      const activeRuntimeTask =
        runtimeTaskLoadTargetRef.current?.address ?? currentRuntimeTaskRef.current
      if (activeRuntimeTask) {
        snapshotRuntimePaneMessages(activeRuntimeTask, nextMessages)
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

      pendingMessageActionsRef.current.push(action)
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
  const appendGuidanceLocalUserMessage = useCallback(
    (content: string, attachments?: Attachment[], options?: CreateLocalUserMessageOptions) => {
      const guidanceMessage = createLocalUserMessage(content, attachments, options)
      setMessages(currentMessages => {
        const nextMessages = splitActiveAssistantForGuidance(
          currentMessages,
          guidanceMessage,
          guidanceSplitBoundariesRef.current
        )
        const activeRuntimeTask = currentRuntimeTaskRef.current
        if (activeRuntimeTask) {
          snapshotRuntimePaneMessages(activeRuntimeTask, nextMessages)
          debugRuntimePaneMessageFlow('guidance-message-inserted', {
            address: runtimeAddressDebug(activeRuntimeTask),
            previousCount: currentMessages.length,
            nextCount: nextMessages.length,
            nextMessages: summarizeWorkbenchMessages(nextMessages),
          })
        }
        return nextMessages
      })
    },
    []
  )
  const runtimeTaskStatusAddress = runtimeTaskLoadTarget?.address ?? currentRuntimeTask
  const taskExecution = useMemo(
    () => getRuntimePaneTaskExecution(workbenchState.runtimeWork, runtimeTaskStatusAddress),
    [runtimeTaskStatusAddress, workbenchState.runtimeWork]
  )
  const paneStatus = useMemo(
    () =>
      deriveRuntimePaneStatus({
        messages,
        sendPhase,
        currentRuntimeTask,
        taskExecution,
      }),
    [currentRuntimeTask, messages, sendPhase, taskExecution]
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
    if (currentRuntimeTaskLoadTarget) {
      setRetainedRuntimeTaskLoadTarget(current =>
        current?.key === currentRuntimeTaskLoadTarget.key ? current : currentRuntimeTaskLoadTarget
      )
    }
  }, [currentRuntimeTaskLoadTarget])

  useEffect(() => {
    const syncCachedPlan = () => {
      const cachedPlan = currentRuntimeTaskLoadTarget
        ? getCachedRuntimeTaskPlan(currentRuntimeTaskLoadTarget.address)
        : null
      if (import.meta.env.DEV) {
        console.warn('[Wework] Runtime task plan cache sync', {
          currentRuntimeTaskId: currentRuntimeTaskLoadTarget?.address ?? null,
          found: Boolean(cachedPlan),
          stepCount: cachedPlan?.plan.length ?? 0,
        })
      }
      setTaskPlan(cachedPlan?.plan.length ? cachedPlan : null)
    }

    syncCachedPlan()
    globalThis.addEventListener('wework-runtime-plan-updated', syncCachedPlan)
    return () => globalThis.removeEventListener('wework-runtime-plan-updated', syncCachedPlan)
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
    subscribeRuntimeTaskStreamRef.current = subscribeRuntimeTaskStream
  }, [subscribeRuntimeTaskStream])

  useEffect(() => {
    getRuntimeGoalRef.current = getRuntimeGoal
  }, [getRuntimeGoal])

  useEffect(() => {
    refreshWorkListsRef.current = refreshWorkLists
  }, [refreshWorkLists])

  useEffect(() => {
    if (!runtimeTaskLoadTarget) {
      commitThreadGoal(null)
      setGoalContinuation(null)
      return
    }

    const seededGoal = getRuntimePaneGoalSeed(runtimeTaskLoadTarget.address)
    if (seededGoal) {
      setPendingGoalState(current =>
        current && isPendingGoalVisibleForRuntimeTarget(current, runtimeTaskLoadTarget.address)
          ? current
          : seededGoal
      )
    }

    let cancelled = false
    commitThreadGoal(null)
    setGoalContinuation(null)
    const requestedGoalRevision = goalRevisionRef.current
    void getRuntimeGoal(runtimeTaskLoadTarget.address)
      .then(response => {
        if (!cancelled && requestedGoalRevision === goalRevisionRef.current) {
          const loadedGoal = response.accepted ? response.goal : null
          commitThreadGoal(loadedGoal)
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
          commitThreadGoal(null)
          console.error('[Wework] Runtime goal load failed', {
            address: runtimeAddressDebug(runtimeTaskLoadTarget.address),
            error,
          })
        }
      })

    return () => {
      cancelled = true
    }
  }, [commitThreadGoal, getRuntimeGoal, runtimeTaskLoadTarget])

  useEffect(() => {
    if (!runtimeTaskLoadTarget) {
      // Keep the loaded transcript key and range metadata while the pane is on a blank
      // chat. The pane intentionally keeps the previous runtime DOM alive, so returning
      // to the same task should not reload and reset the transcript tree.
      setTranscriptLoading(false)
      setTranscriptLoadingMoreBefore(false)
      return
    }

    const { key: loadKey, address } = runtimeTaskLoadTarget
    if (loadedRuntimeTranscriptKeyRef.current === loadKey) {
      return
    }

    let cancelled = false
    const seededMessages = getRuntimePaneMessageSeed(address)
    debugRuntimePaneMessageFlow('transcript-load-start', {
      address: runtimeAddressDebug(address),
      key: loadKey,
      seededCount: seededMessages.length,
      seededMessages: summarizeWorkbenchMessages(seededMessages),
    })
    dispatchMessages({ type: 'reset', messages: seededMessages })
    setTranscriptLoading(true)
    setTranscriptHasMoreBefore(false)
    setTranscriptBeforeCursor(null)
    setTranscriptLoadingMoreBefore(false)
    setTranscriptLoadingFullContent(false)
    setTranscriptFullContent(false)
    setLoadedTranscriptRanges([])
    setTurnNavigation([])
    setSubagentStatuses([])
    setTaskPlan(null)
    void loadRuntimeTranscriptForPaneRef
      .current(address, { limit: RUNTIME_TRANSCRIPT_PAGE_SIZE })
      .then(transcript => {
        if (!cancelled) {
          if (transcript.running) {
            markRuntimeTaskStarted(address)
          }
          const nextMessages = transcript.messages.length > 0 ? transcript.messages : seededMessages
          loadedRuntimeTranscriptKeyRef.current = loadKey
          setTranscriptFullContent(transcript.fullContent === true)
          setTranscriptHasMoreBefore(Boolean(transcript.hasMoreBefore))
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
          if (hasSettledAssistantMessage(nextMessages)) {
            setSendPhase('idle')
          }
          clearRuntimePaneMessageSeed(address)
        }
      })
      .catch(error => {
        if (!cancelled) {
          loadedRuntimeTranscriptKeyRef.current = null
          setTranscriptFullContent(false)
          setTranscriptHasMoreBefore(false)
          setTranscriptBeforeCursor(null)
          setLoadedTranscriptRanges([])
          setTurnNavigation([])
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
    }
  }, [dispatchMessages, markRuntimeTaskStarted, runtimeTaskLoadTarget])
  /* eslint-enable react-hooks/set-state-in-effect */

  /* eslint-disable react-hooks/set-state-in-effect -- Queued runtime messages are advanced when the active runtime response becomes idle. */
  useEffect(() => {
    const target = runtimeTaskLoadTargetRef.current
    if (!target) {
      return
    }

    const { address } = target
    const unsubscribe = subscribeRuntimeTaskStreamRef.current(address, {
      onMessageAction: dispatchMessages,
      onAssistantStart: () => {
        setSendPhase('idle')
        setGoalContinuation(null)
      },
      onAssistantSettled: () => {
        setSendPhase('idle')
        setSubagentStatuses(markRuntimeSubagentsSettled)
        const requestedGoalRevision = goalRevisionRef.current
        void getRuntimeGoalRef
          .current(address)
          .then(response => {
            if (requestedGoalRevision !== goalRevisionRef.current) return
            const loadedGoal = response.accepted ? response.goal : null
            commitThreadGoal(loadedGoal)
            if (loadedGoal?.status === 'active') {
              void refreshWorkListsRef.current().catch(() => undefined)
            }
            if (loadedGoal) {
              clearRuntimePaneGoalSeed(address)
              const latestAddress = runtimeTaskLoadTargetRef.current?.address ?? address
              setPendingGoalState(current =>
                current && isPendingGoalVisibleForRuntimeTarget(current, latestAddress)
                  ? null
                  : current
              )
            }
          })
          .catch(error => {
            console.error('[Wework] Runtime goal refresh failed', {
              address: runtimeAddressDebug(address),
              error,
            })
          })
      },
      onRefreshWorkLists: () => {
        void refreshWorkListsRef.current().catch(() => undefined)
      },
      onSubagentActivity: activity => {
        setSubagentStatuses(current => updateRuntimeSubagentStatuses(current, activity))
      },
      onRuntimeGoalUpdated: payload => {
        const loadedGoal = payload.goal ?? null
        commitThreadGoal(loadedGoal)
        void refreshWorkListsRef.current().catch(() => undefined)
        if (loadedGoal?.status !== 'active') setGoalContinuation(null)
        clearRuntimePaneGoalSeed(address)
        const latestAddress = runtimeTaskLoadTargetRef.current?.address ?? address
        setPendingGoalState(current =>
          current && isPendingGoalVisibleForRuntimeTarget(current, latestAddress) ? null : current
        )
      },
      onRuntimeGoalCleared: () => {
        commitThreadGoal(null)
        void refreshWorkListsRef.current().catch(() => undefined)
        setGoalContinuation(null)
        clearRuntimePaneGoalSeed(address)
        const latestAddress = runtimeTaskLoadTargetRef.current?.address ?? address
        setPendingGoalState(current =>
          current && isPendingGoalVisibleForRuntimeTarget(current, latestAddress) ? null : current
        )
      },
      onRuntimeGoalContinuation: payload => {
        setGoalContinuation(payload.status === 'started' ? payload : null)
        void refreshWorkListsRef.current().catch(() => undefined)
      },
      onRuntimePlanUpdated: payload => {
        if (import.meta.env.DEV) {
          console.info('[Wework] Runtime task plan state updated', {
            taskId: payload.taskId ?? null,
            threadId: payload.threadId ?? null,
            stepCount: payload.plan.length,
          })
        }
        setTaskPlan(payload.plan.length > 0 ? payload : null)
      },
      onGuidanceApplied: payload => {
        const pendingEntry = [...pendingAppliedGuidancesRef.current.entries()].find(
          ([, message]) => !payload.message || message.content === payload.message
        )
        if (!pendingEntry) return
        const [guidanceId, guidanceMessage] = pendingEntry
        pendingAppliedGuidancesRef.current.delete(guidanceId)
        appendGuidanceLocalUserMessage(guidanceMessage.content, guidanceMessage.attachments, {
          id: guidanceMessage.id,
          createdAt: new Date(payload.appliedAtMs).toISOString(),
          runtimeGoalRequest: guidanceMessage.runtimeGoalRequest,
          runtimeGuidance: true,
        })
        setQueuedMessages(messages => messages.filter(message => message.id !== guidanceId))
      },
    })
    return unsubscribe
  }, [
    appendGuidanceLocalUserMessage,
    commitThreadGoal,
    dispatchMessages,
    runtimeTaskStreamTargetKey,
  ])

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
        limit: RUNTIME_TRANSCRIPT_PAGE_SIZE,
        beforeCursor,
      })
      const nextMessages = mergeRuntimeTranscriptMessages(transcript.messages, messagesRef.current)
      const nextRanges = mergeTranscriptRanges(
        loadedTranscriptRangesRef.current,
        transcriptRangeFromPage(transcript)
      )
      setTranscriptHasMoreBefore(Boolean(transcript.hasMoreBefore))
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
      const loadOptions = runtimeTurnNavigationLoadOptions(item, loadedTranscriptRangesRef.current)
      const transcript = await loadRuntimeTranscriptForPaneRef.current(address, loadOptions)
      const nextHasMoreBefore =
        loadOptions.beforeCursor === undefined
          ? transcriptHasMoreBefore
          : Boolean(transcript.hasMoreBefore)
      const nextBeforeCursor =
        loadOptions.beforeCursor === undefined
          ? transcriptBeforeCursor
          : (transcript.beforeCursor ?? null)
      const nextMessages = mergeRuntimeTranscriptMessages(transcript.messages, messagesRef.current)
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
      transcriptBeforeCursor,
      transcriptFullContent,
      transcriptHasMoreBefore,
    ]
  )

  const loadTranscriptGap = useCallback(
    async (gap: LoadedTranscriptRange) => {
      if (!runtimeTaskLoadTarget || transcriptFullContent || gap.end <= gap.start) return

      const { address } = runtimeTaskLoadTarget
      const limit = Math.min(RUNTIME_TRANSCRIPT_PAGE_SIZE, gap.end - gap.start)
      const loadOptions = {
        limit,
        afterCursor: `offset:${gap.start}`,
      }
      const transcript = await loadRuntimeTranscriptForPaneRef.current(address, loadOptions)
      const nextMessages = mergeRuntimeTranscriptMessages(transcript.messages, messagesRef.current)
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
    [dispatchMessages, runtimeTaskLoadTarget, transcriptFullContent]
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
      const nextMessages =
        transcript.messages.length > 0 ? transcript.messages : messagesRef.current
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
    (content: string, attachments?: Attachment[], options?: CreateLocalUserMessageOptions) => {
      dispatchMessages({
        type: 'user_added',
        message: createLocalUserMessage(content, attachments, options),
      })
    },
    [dispatchMessages]
  )

  const applyLocalRequestUserInputResponse = useCallback(
    (response: RequestUserInputResponse) => {
      setMessages(currentMessages => {
        const nextMessages = applyRequestUserInputResponseToMessages(currentMessages, response)
        if (currentRuntimeTask) {
          snapshotRuntimePaneMessages(currentRuntimeTask, nextMessages)
          debugRuntimePaneMessageFlow('request-user-input-response-applied', {
            address: runtimeAddressDebug(currentRuntimeTask),
            requestUserInputKey: requestUserInputResponseKey(response),
            previousCount: currentMessages.length,
            nextCount: nextMessages.length,
            nextMessages: summarizeWorkbenchMessages(nextMessages),
          })
        }
        return nextMessages
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

      setSendPhase('submitting')
      if (options.appendLocalMessage !== false) {
        appendLocalUserMessage(message.displayContent ?? message.content, message.attachments, {
          id: message.id,
          createdAt: message.createdAt,
          runtimeGoalRequest: message.runtimeGoalRequest,
          codeComments: message.codeComments,
        })
      }
      const messageAttachments = message.attachments ?? []
      const attachmentIds = remoteAttachmentIds(messageAttachments)
      const attachments = localRuntimeAttachments(messageAttachments)
      const additionalContext = readRuntimeTerminalAdditionalContext(currentRuntimeTask)
      const sent = await sendRuntimePaneMessage({
        address: currentRuntimeTask,
        message: message.content,
        ...(message.modelId
          ? {
              modelId: message.modelId,
              modelType: message.modelType,
            }
          : {}),
        ...(message.modelOptions ? { modelOptions: message.modelOptions } : {}),
        ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
        ...(attachments.length > 0 ? { attachments } : {}),
        ...(additionalContext ? { additionalContext } : {}),
      })
      if (sent) {
        markRuntimeTerminalAdditionalContextDelivered(additionalContext)
        setSendPhase(current => (current === 'submitting' ? 'awaiting_assistant' : current))
      } else {
        setSendPhase('idle')
      }
      return sent
    },
    [appendLocalUserMessage, currentRuntimeTask, sendRuntimePaneMessage]
  )

  const sendRequestUserInputResponse = useCallback(
    async (
      response: RequestUserInputResponse,
      options: SendRequestUserInputResponseOptions = {}
    ): Promise<boolean> => {
      if (!currentRuntimeTask) return false

      const message = requestUserInputResponseText(response)
      const requestUserInputKey = requestUserInputResponseKey(response)
      setSendPhase('submitting')
      const runtimeModelOverride = options.forceDefaultCollaborationMode
        ? { collaborationMode: 'default' }
        : undefined
      if (options.forceDefaultCollaborationMode) {
        projectChat.setSelectedModelOption('collaborationMode', 'default')
      }
      if (options.appendUserMessage) {
        appendLocalUserMessage(message)
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
        ...runtimeModelFields,
        ...(options.appendUserMessage ? {} : { requestUserInputResponse: response }),
        ...(additionalContext ? { additionalContext } : {}),
      })
      if (sent) {
        markRuntimeTerminalAdditionalContextDelivered(additionalContext)
        setSendPhase(current => (current === 'submitting' ? 'awaiting_assistant' : current))
      } else {
        setSendPhase('idle')
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
      appendLocalUserMessage,
      applyLocalRequestUserInputResponse,
      currentRuntimeTask,
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
      const editedMessage = createLocalUserMessage(submittedContent, messageAttachments, {
        runtimeGoalRequest: message.runtimeGoalRequest === true,
      })
      const nextMessages = [...currentMessages.slice(0, messageIndex), editedMessage]
      const request: RuntimeRollbackRequest = {
        address: currentRuntimeTask,
        message: submittedContent,
        messageId: message.id,
        ...getRuntimeModelFields(),
        ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
        ...(attachments.length > 0 ? { attachments } : {}),
        ...(additionalContext ? { additionalContext } : {}),
      }

      setSendPhase('submitting')
      dispatchMessages({ type: 'reset', messages: nextMessages })
      try {
        const sent = await editLastUserMessage(request)
        if (sent) {
          markRuntimeTerminalAdditionalContextDelivered(additionalContext)
          setSendPhase(current => (current === 'submitting' ? 'awaiting_assistant' : current))
          return true
        }
        dispatchMessages({ type: 'reset', messages: previousMessages })
        setSendPhase('idle')
        return false
      } catch (error) {
        dispatchMessages({ type: 'reset', messages: previousMessages })
        setSendPhase('idle')
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
      dispatchMessages,
      editLastUserMessage,
      getRuntimeModelFields,
      paneStatus.isBusy,
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
        setSendPhase('idle')
        return
      }

      const cancelled = await cancelRuntimePaneTask(currentRuntimeTask)
      setSendPhase('idle')
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

      dispatchMessages({
        type: 'assistant_cancelled',
      })
    },
    [activeAssistantMessage, cancelRuntimePaneTask, currentRuntimeTask, dispatchMessages]
  )

  const sendQueuedMessage = useCallback(
    async (queuedMessage: RuntimePaneQueuedMessage) => {
      setQueuedMessages(messages =>
        messages.map(message =>
          message.id === queuedMessage.id ? { ...message, status: 'sending' } : message
        )
      )

      try {
        const sent = await sendRuntimeMessage(queuedMessage)
        setQueuedMessages(messages =>
          sent
            ? messages.filter(message => message.id !== queuedMessage.id)
            : messages.map(message =>
                message.id === queuedMessage.id
                  ? { ...message, status: 'failed', error: '发送失败' }
                  : message
              )
        )
      } catch (error) {
        console.error('[Wework] Queued runtime message send failed', {
          id: queuedMessage.id,
          error,
        })
        setQueuedMessages(messages =>
          messages.map(message =>
            message.id === queuedMessage.id
              ? { ...message, status: 'failed', error: '发送失败' }
              : message
          )
        )
        setSendPhase('idle')
      }
    },
    [sendRuntimeMessage]
  )

  useEffect(() => {
    if (queuedMessagesPaused) return
    if (!paneStatus.canSendQueuedMessage) return
    if (queuedMessages.some(message => message.status === 'sending')) return
    const queuedMessage = queuedMessages.find(message => message.status === 'queued')
    if (!queuedMessage) return

    // This advances the next queued message once the pane becomes idle.
    void sendQueuedMessage(queuedMessage)
  }, [paneStatus.canSendQueuedMessage, queuedMessages, queuedMessagesPaused, sendQueuedMessage])
  /* eslint-enable react-hooks/set-state-in-effect */

  const sendQueuedMessageAsGuidance = useCallback(
    async (queuedMessage: RuntimePaneQueuedMessage) => {
      const id = queuedMessage.id
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

      if (queuedMessage.status === 'sending') return

      setError(null)
      if (!paneStatus.isBusy) {
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

      setQueuedMessages(messages =>
        messages.map(message =>
          message.id === id
            ? {
                ...message,
                status: 'sending',
                error: undefined,
                notice: '正在引导当前对话',
              }
            : message
        )
      )

      pendingAppliedGuidancesRef.current.set(id, queuedMessage)

      try {
        const additionalContext = readRuntimeTerminalAdditionalContext(currentRuntimeTask)
        const messageAttachments = queuedMessage.attachments ?? []
        const attachmentIds = remoteAttachmentIds(messageAttachments)
        const attachments = localRuntimeAttachments(messageAttachments)
        const result = await sendRuntimePaneGuidance({
          address: currentRuntimeTask,
          message: queuedMessage.content,
          clientGuidanceId: id,
          ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
          ...(attachments.length > 0 ? { attachments } : {}),
          ...(additionalContext ? { additionalContext } : {}),
        })
        if (!result.sent && result.code === 'no_active_turn') {
          pendingAppliedGuidancesRef.current.delete(id)
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
          return
        }
        if (result.sent) {
          markRuntimeTerminalAdditionalContextDelivered(additionalContext)
        }
        if (!result.sent) {
          pendingAppliedGuidancesRef.current.delete(id)
          setQueuedMessages(messages =>
            messages.map(message =>
              message.id === id
                ? { ...message, status: 'failed', notice: undefined, error: '引导发送失败' }
                : message
            )
          )
        }
      } catch (error) {
        pendingAppliedGuidancesRef.current.delete(id)
        console.error('[Wework] Queued guidance send failed', {
          id,
          error,
        })
        setQueuedMessages(messages =>
          messages.map(message =>
            message.id === id
              ? { ...message, status: 'failed', notice: undefined, error: '引导发送失败' }
              : message
          )
        )
      }
    },
    [currentRuntimeTask, paneStatus.isBusy, sendRuntimeMessage, sendRuntimePaneGuidance]
  )

  const send: (inputOverride?: string, options?: RuntimePaneSendOptions) => Promise<void> =
    useCallback(
      async (inputOverride, options = {}) => {
        const submittedInput = (inputOverride ?? input).trim()
        const currentAttachments = projectChat.attachments
        const hasCodeComments = codeCommentContexts.length > 0
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
          hasCurrentRuntimeTask: Boolean(currentRuntimeTask),
          paneBusy: paneStatus.isBusy,
        })

        if (goalDraftActive) {
          if (!submittedInput) {
            setError(i18n.t('workbench.goal_objective_required'))
            return
          }
          if (hasCodeComments) {
            setError(i18n.t('workbench.runtime_task_code_comments_not_supported'))
            return
          }

          // Errors belong to the previous action; a new goal submission starts fresh.
          setError(null)
          setInput('')
          setSendPhase('submitting')
          try {
            if (currentRuntimeTask) {
              const response = await setRuntimeGoal({
                address: currentRuntimeTask,
                objective: submittedInput,
                status: 'active',
              })
              if (!response.accepted) {
                setError(response.error || i18n.t('workbench.goal_set_failed'))
                return
              }
              commitThreadGoal(response.goal)
              setGoalDraftActive(false)
              const queuedMessage: RuntimePaneQueuedMessage = {
                id: `queued-runtime-pane-${Date.now()}-${queuedMessages.length}`,
                content: submittedInput,
                status: 'queued',
                createdAt: new Date().toISOString(),
                attachments: persistAttachmentReferences(currentAttachments),
                runtimeGoalRequest: true,
                ...getRuntimeModelFields(),
              }

              projectChat.resetAttachments()
              if (paneStatus.isBusy) {
                setQueuedMessages(messages => [...messages, queuedMessage])
                if (options.guideWhenBusy) {
                  await sendQueuedMessageAsGuidance(queuedMessage)
                }
                return
              }

              const sent = await sendRuntimeMessage(queuedMessage)
              if (sent) {
                setCodeCommentContexts([])
              } else {
                setError('目标已更新，但指令发送失败')
                setInput(submittedInput)
              }
              return
            }

            const draftGoal = createPendingRuntimeGoal(submittedInput)
            const initialGoal = runtimeGoalCreateInput(draftGoal)
            setPendingGoalState({ goal: draftGoal, targetKey: null, targetIdentityKey: null })
            setGoalDraftActive(false)
            const optimisticMessage = createLocalUserMessage(submittedInput, currentAttachments, {
              runtimeGoalRequest: true,
            })
            let seededGoalAddress: RuntimeTaskAddress | null = null
            const sent = await sendCurrentInput(submittedInput, {
              initialGoal,
              onRuntimeTaskOptimisticOpen: (address, context) => {
                setPendingGoalState(current =>
                  current
                    ? {
                        ...current,
                        targetKey: runtimeTranscriptPaneKey(address),
                        targetIdentityKey: runtimeTranscriptPaneIdentityKey(address),
                      }
                    : current
                )
                const previousMessages = context?.previousAddress
                  ? getRuntimePaneMessageSnapshot(context.previousAddress)
                  : []
                seedRuntimePaneGoal(address, draftGoal)
                seededGoalAddress = address
                const seededMessages =
                  previousMessages.length > 0 ? previousMessages : [optimisticMessage]
                debugRuntimePaneMessageFlow('seed-goal-first-open', {
                  address: runtimeAddressDebug(address),
                  previousAddress: context?.previousAddress
                    ? runtimeAddressDebug(context.previousAddress)
                    : null,
                  previousCount: previousMessages.length,
                  seededCount: seededMessages.length,
                  seededMessages: summarizeWorkbenchMessages(seededMessages),
                })
                seedRuntimePaneMessages(address, seededMessages)
              },
            })
            if (sent) {
              if (!isRuntimeTaskAddress(sent)) {
                setSendPhase(current => (current === 'submitting' ? 'awaiting_assistant' : current))
                appendLocalUserMessage(submittedInput, currentAttachments, {
                  runtimeGoalRequest: true,
                })
              } else {
                setSendPhase('idle')
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
              setGoalDraftActive(true)
              setPendingGoalState(null)
              setSendPhase('idle')
            }
            return
          } finally {
            setSendPhase(current => (current === 'submitting' ? 'idle' : current))
          }
        }

        if (submittedInput === '/compact') {
          if (!currentRuntimeTask) {
            setError('当前对话还没有可压缩的 Codex 线程')
            return
          }
          if (paneStatus.isBusy) {
            setError('当前回复进行中，完成后再压缩上下文')
            return
          }
          if (currentAttachments.length > 0 || hasCodeComments) {
            setError('/compact 不能和附件或代码评论一起发送')
            return
          }
          setInput('')
          setSendPhase('submitting')
          try {
            await compactRuntimePaneTask(currentRuntimeTask, { onError: setError })
          } finally {
            setSendPhase(current => (current === 'submitting' ? 'idle' : current))
          }
          return
        }

        const pendingInitialGoal =
          !currentRuntimeTask && pendingGoalState && isUnboundPendingGoalState(pendingGoalState)
            ? runtimeGoalCreateInput(pendingGoalState.goal)
            : null
        const effectiveSubmittedInput = submittedInput || pendingInitialGoal?.objective.trim() || ''
        if (!effectiveSubmittedInput && currentAttachments.length === 0 && !hasCodeComments) {
          void sendCurrentInput('', { codeCommentContexts })
          return
        }

        // Do not keep an earlier action error visible once the user sends a new message.
        setError(null)
        setInput('')
        setSendPhase('submitting')
        try {
          const visibleSubmittedInput =
            effectiveSubmittedInput ||
            (hasCodeComments ? i18n.t('workbench.code_comment_fallback') : '')
          if (!currentRuntimeTask) {
            const optimisticMessage = createLocalUserMessage(
              visibleSubmittedInput,
              currentAttachments,
              {
                runtimeGoalRequest: Boolean(pendingInitialGoal),
                codeComments: codeCommentContexts,
              }
            )
            const sent = await sendCurrentInput(visibleSubmittedInput, {
              codeCommentContexts,
              initialGoal: pendingInitialGoal,
              onError: setError,
              onRuntimeTaskOptimisticOpen: (address, context) => {
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
                const previousMessages = context?.previousAddress
                  ? getRuntimePaneMessageSnapshot(context.previousAddress)
                  : []
                if (pendingInitialGoal && pendingGoalState) {
                  seedRuntimePaneGoal(address, pendingGoalState.goal)
                }
                const seededMessages =
                  previousMessages.length > 0 ? previousMessages : [optimisticMessage]
                debugRuntimePaneMessageFlow('seed-optimistic-open', {
                  address: runtimeAddressDebug(address),
                  previousAddress: context?.previousAddress
                    ? runtimeAddressDebug(context.previousAddress)
                    : null,
                  previousCount: previousMessages.length,
                  seededCount: seededMessages.length,
                  seededMessages: summarizeWorkbenchMessages(seededMessages),
                })
                seedRuntimePaneMessages(address, seededMessages)
              },
            })
            if (sent) {
              if (!isRuntimeTaskAddress(sent)) {
                setSendPhase(current => (current === 'submitting' ? 'awaiting_assistant' : current))
                appendLocalUserMessage(visibleSubmittedInput, currentAttachments, {
                  runtimeGoalRequest: Boolean(pendingInitialGoal),
                  codeComments: codeCommentContexts,
                })
              } else {
                setSendPhase('idle')
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
              projectChat.resetAttachments()
              setCodeCommentContexts([])
            } else {
              // Restore the draft when send is blocked so the user can retry.
              // Use scoped setter so we do not clear the pane error reported via onError.
              scopedSetInput(visibleSubmittedInput)
              setSendPhase('idle')
            }
            return
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
              ...getRuntimeModelFields(),
            }

            if (paneStatus.isBusy) {
              projectChat.resetAttachments()
              setCodeCommentContexts([])
              setQueuedMessages(messages => [...messages, queuedMessage])
              return
            }

            const sent = await sendRuntimeMessage(queuedMessage)
            if (sent) {
              projectChat.resetAttachments()
              setCodeCommentContexts([])
            }
            return
          }

          const queuedMessage: RuntimePaneQueuedMessage = {
            id: `queued-runtime-pane-${Date.now()}-${queuedMessages.length}`,
            content: submittedInput,
            status: 'queued',
            createdAt: new Date().toISOString(),
            attachments: persistAttachmentReferences(currentAttachments),
            ...getRuntimeModelFields(),
          }

          projectChat.resetAttachments()
          if (paneStatus.isBusy) {
            setQueuedMessages(messages => [...messages, queuedMessage])
            if (options.guideWhenBusy) {
              await sendQueuedMessageAsGuidance(queuedMessage)
            }
            return
          }

          const sent = await sendRuntimeMessage(queuedMessage)
          if (sent) {
            setCodeCommentContexts([])
          }
        } finally {
          setSendPhase(current => (current === 'submitting' ? 'idle' : current))
        }
      },
      [
        appendLocalUserMessage,
        codeCommentContexts,
        commitThreadGoal,
        compactRuntimePaneTask,
        currentRuntimeTask,
        dispatchMessages,
        goalDraftActive,
        getRuntimeModelFields,
        input,
        pendingGoalState,
        paneStatus.isBusy,
        projectChat,
        queuedMessages.length,
        sendCurrentInput,
        sendQueuedMessageAsGuidance,
        sendRuntimeMessage,
        scopedSetInput,
        setInput,
        setRuntimeGoal,
      ]
    )

  const addCodeComment = useCallback((context: CodeCommentContext) => {
    setCodeCommentContexts(current => [...current.filter(item => item.id !== context.id), context])
  }, [])

  const clearCodeComments = useCallback(() => {
    setCodeCommentContexts([])
  }, [])

  const cancelQueuedMessage = useCallback((id: string) => {
    setQueuedMessages(messages => messages.filter(message => message.id !== id))
  }, [])

  const resumeQueuedMessages = useCallback(() => {
    setQueuedMessagesPaused(false)
    const interruptedGuidance = queuedMessages.find(isInterruptedGuidance)
    const queuedMessage =
      interruptedGuidance ?? queuedMessages.find(message => message.status === 'queued')
    if (queuedMessage) void sendQueuedMessage(queuedMessage)
  }, [queuedMessages, sendQueuedMessage])

  const resumeQueuedMessagesWithInput = useCallback(
    async (inputOverride?: string, options?: RuntimePaneSendOptions) => {
      const interruptedGuidance = queuedMessages.find(isInterruptedGuidance)
      if (!interruptedGuidance) {
        await send(inputOverride, options)
        setQueuedMessagesPaused(false)
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
    [input, queuedMessages, send, sendQueuedMessage]
  )

  const clearQueuedMessages = useCallback(() => {
    setQueuedMessages([])
    setQueuedMessagesPaused(false)
  }, [])

  const reorderQueuedMessages = useCallback((sourceId: string, targetId: string) => {
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
  }, [])

  const editQueuedMessage = useCallback(
    (id: string) => {
      const queuedMessage = queuedMessages.find(message => message.id === id)
      if (!queuedMessage || queuedMessage.status === 'sending') return

      setInput(queuedMessage.content)
      queuedMessage.attachments?.forEach(attachment => {
        projectChat.addExistingAttachment(attachment)
      })
      setQueuedMessages(messages => messages.filter(message => message.id !== id))
    },
    [projectChat, queuedMessages, setInput]
  )

  const sendQueuedAsGuidance = useCallback(
    async (id: string) => {
      const queuedMessage = queuedMessages.find(message => message.id === id)
      if (!queuedMessage) return
      await sendQueuedMessageAsGuidance(queuedMessage)
    },
    [queuedMessages, sendQueuedMessageAsGuidance]
  )

  const compactContext = useCallback(async () => {
    if (!currentRuntimeTask) {
      setError('当前对话还没有可压缩的 Codex 线程')
      return false
    }
    if (paneStatus.isBusy) {
      setError('当前回复进行中，完成后再压缩上下文')
      return false
    }
    setSendPhase('submitting')
    try {
      return await compactRuntimePaneTask(currentRuntimeTask, { onError: setError })
    } finally {
      setSendPhase(current => (current === 'submitting' ? 'idle' : current))
    }
  }, [compactRuntimePaneTask, currentRuntimeTask, paneStatus.isBusy])

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
      if (!goal) return false
      if (!currentRuntimeTask) {
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

        commitThreadGoal(response.goal)
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
    [commitThreadGoal, currentRuntimeTask, goal, refreshWorkLists, setRuntimeGoal]
  )

  const pauseCurrentGoal = useCallback(
    () => updateCurrentGoalStatus('paused'),
    [updateCurrentGoalStatus]
  )

  const resumeCurrentGoal = useCallback(
    () => updateCurrentGoalStatus('active'),
    [updateCurrentGoalStatus]
  )

  const pauseCurrentResponse = useCallback(async () => {
    if (!currentRuntimeTask) return

    const cancelled = await cancelRuntimePaneTask(currentRuntimeTask)
    if (!cancelled) return

    setQueuedMessagesPaused(queuedMessages.some(message => message.status === 'queued'))
    setSendPhase('idle')
    void refreshWorkLists()

    if (goal?.status === 'active') {
      await updateCurrentGoalStatus('paused')
    }

    if (!activeAssistantMessage) return

    dispatchMessages({
      type: 'assistant_cancelled',
    })
  }, [
    activeAssistantMessage,
    cancelRuntimePaneTask,
    currentRuntimeTask,
    dispatchMessages,
    goal?.status,
    queuedMessages,
    refreshWorkLists,
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

      commitThreadGoal(null)
      await refreshWorkLists()
      return true
    } catch (error) {
      console.error('[Wework] Runtime goal clear failed', {
        address: runtimeAddressDebug(currentRuntimeTask),
        error,
      })
      return false
    }
  }, [clearRuntimeGoal, commitThreadGoal, currentRuntimeTask, goal, refreshWorkLists])

  const cancelGuidanceMessage = useCallback(() => undefined, [])
  const goalContinuing = goal?.status === 'active' && goalContinuation?.status === 'started'

  useEffect(() => {
    if (!paneActive) return

    updateRuntimePaneDebugSnapshot({
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
    })
  }, [
    codeCommentContexts.length,
    currentRuntimeTask,
    goal,
    taskPlan,
    goalDraftActive,
    guidanceMessages,
    input.length,
    loadedTranscriptRanges,
    messages,
    paneActive,
    paneStatus,
    queuedMessages,
    queuedMessagesPaused,
    subagentStatuses,
    transcriptHasMoreBefore,
    transcriptFullContent,
    transcriptLoading,
    transcriptLoadingFullContent,
    transcriptLoadingMoreBefore,
    turnNavigation.length,
  ])

  return {
    messages,
    queuedMessages,
    queuedMessagesPaused,
    guidanceMessages,
    codeCommentContexts,
    input,
    setInput,
    error,
    status: paneStatus,
    sending: paneStatus.isSubmitting,
    waitingForAssistant: paneStatus.isWaitingForAssistantIndicator,
    answeredRequestUserInputIds,
    transcriptLoading,
    transcriptHasMoreBefore,
    transcriptLoadingMoreBefore,
    transcriptLoadingFullContent,
    transcriptFullContent,
    turnNavigation,
    subagentStatuses,
    goal,
    goalContinuing,
    taskPlan,
    goalDraftActive,
    loadMoreTranscriptBefore,
    loadFullTranscript,
    loadTranscriptTurnNavigationItem,
    loadTranscriptGap,
    send,
    editLastUserMessage: editLastUserMessageInPane,
    sendRequestUserInputResponse,
    ignoreRequestUserInput,
    addCodeComment,
    clearCodeComments,
    cancelQueuedMessage,
    resumeQueuedMessages,
    resumeQueuedMessagesWithInput,
    clearQueuedMessages,
    reorderQueuedMessages,
    sendQueuedAsGuidance,
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

export type WorkbenchPaneSession = ReturnType<typeof useWorkbenchPaneSession>

function isInterruptedGuidance(message: RuntimePaneQueuedMessage): boolean {
  return message.status === 'sending' && message.notice === '正在引导当前对话'
}

function runtimeTaskLoadTargetFromAddress(address: RuntimeTaskAddress): RuntimeTaskLoadTarget {
  return {
    key: runtimeTranscriptPaneKey(address),
    identityKey: runtimeTranscriptPaneIdentityKey(address),
    address,
  }
}

function runtimeTranscriptPaneKey(address: RuntimeTaskAddress): string {
  return `${address.deviceId}:${address.taskId}:${address.workspacePath ?? ''}`
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

interface CreateLocalUserMessageOptions {
  id?: string
  createdAt?: string
  runtimeGoalRequest?: boolean
  runtimeGuidance?: boolean
  codeComments?: CodeCommentContext[]
}

function createLocalUserMessage(
  content: string,
  attachments?: Attachment[],
  options: CreateLocalUserMessageOptions = {}
): WorkbenchMessage {
  return {
    id: options.id ?? `runtime-local-pane-${Date.now()}`,
    role: 'user',
    content,
    attachments: attachments ? persistAttachmentReferences(attachments) : undefined,
    status: 'done',
    createdAt: options.createdAt ?? new Date().toISOString(),
    runtimeGoalRequest: options.runtimeGoalRequest ? true : undefined,
    runtimeGuidance: options.runtimeGuidance ? true : undefined,
    codeComments: options.codeComments?.length ? options.codeComments : undefined,
  }
}

function splitActiveAssistantForGuidance(
  messages: WorkbenchMessage[],
  guidanceMessage: WorkbenchMessage,
  splitBoundaries: Map<string, GuidanceSplitBoundary>
): WorkbenchMessage[] {
  const assistantIndex = findLastIndex(
    messages,
    message => message.role === 'assistant' && message.status === 'streaming'
  )
  if (assistantIndex < 0) {
    return [...messages, guidanceMessage]
  }

  const assistantMessage = messages[assistantIndex]
  if (assistantMessage?.subtaskId) {
    splitBoundaries.set(assistantMessage.subtaskId, {
      prefix: assistantMessage.content,
    })
  }

  const frozenAssistantMessage: WorkbenchMessage = {
    ...assistantMessage,
    id: `${assistantMessage.id}-before-guidance-${guidanceMessage.id}`,
    subtaskId: undefined,
    status: 'done',
    runtimeStatus: 'done',
    streamTextOffset: undefined,
    completedAt: guidanceMessage.createdAt,
    runtimeGuidanceSplitBefore: true,
    blocks: freezeGuidanceAssistantBlocks(assistantMessage.blocks),
  }

  const continuationMessage = assistantMessage.subtaskId
    ? createGuidanceContinuationAssistantMessage(
        { ...assistantMessage, subtaskId: assistantMessage.subtaskId },
        guidanceMessage
      )
    : null

  return [
    ...messages.slice(0, assistantIndex),
    frozenAssistantMessage,
    guidanceMessage,
    ...(continuationMessage ? [continuationMessage] : []),
    ...messages.slice(assistantIndex + 1),
  ]
}

function createGuidanceContinuationAssistantMessage(
  assistantMessage: WorkbenchMessage & { subtaskId: string },
  guidanceMessage: WorkbenchMessage
): WorkbenchMessage {
  return {
    ...assistantMessage,
    id: `${assistantMessage.id}-after-guidance-${guidanceMessage.id}`,
    content: '',
    status: 'streaming',
    runtimeStatus: 'streaming',
    streamTextOffset: undefined,
    blocks: [
      {
        id: `${guidanceMessage.id}-guidance`,
        subtaskId: assistantMessage.subtaskId,
        type: 'tool',
        toolName: 'conversation_guidance',
        toolInput: { message: guidanceMessage.content },
        status: 'done',
        createdAt: getMessageCreatedAtMs(guidanceMessage.createdAt),
      },
    ],
    runtimeGuidanceContinuation: true,
    contentTruncated: undefined,
    contentOriginalChars: undefined,
    completedAt: undefined,
    stoppedNotice: false,
  }
}

function transformRuntimePaneActionForGuidanceSplits(
  action: RuntimePaneMessageAction,
  splitBoundaries: Map<string, GuidanceSplitBoundary>
): RuntimePaneMessageAction {
  if (!('subtaskId' in action) || typeof action.subtaskId !== 'string') return action

  const boundary = splitBoundaries.get(action.subtaskId)
  if (!boundary) return action

  switch (action.type) {
    case 'assistant_chunk':
      return action
    case 'assistant_done': {
      splitBoundaries.delete(action.subtaskId)
      return {
        ...action,
        content:
          action.content === undefined
            ? undefined
            : trimGuidanceSplitPrefix(boundary.prefix, action.content),
      }
    }
    case 'assistant_error':
    case 'assistant_cancelled':
      splitBoundaries.delete(action.subtaskId)
      return action
    default:
      return action
  }
}

function trimGuidanceSplitPrefix(prefix: string, content: string, offset?: number): string {
  if (!prefix || !content) return content

  const prefixLength = textCodePointLength(prefix)
  if (typeof offset === 'number' && Number.isFinite(offset)) {
    const contentLength = textCodePointLength(content)
    if (offset >= prefixLength) return content
    const coveredLength = prefixLength - offset
    if (coveredLength >= contentLength) return ''
    return sliceTextCodePoints(content, coveredLength)
  }

  if (content.startsWith(prefix)) {
    return content.slice(prefix.length)
  }
  return content
}

function freezeGuidanceAssistantBlocks(
  blocks: WorkbenchMessage['blocks']
): WorkbenchMessage['blocks'] {
  return blocks?.map(block => {
    if (block.status !== 'streaming' && block.status !== 'pending') return block
    return {
      ...block,
      status: block.type === 'tool' ? 'done' : 'done',
    }
  })
}

function textCodePointLength(value: string): number {
  return isAsciiText(value) ? value.length : Array.from(value).length
}

function sliceTextCodePoints(value: string, start: number): string {
  if (start <= 0) return value
  if (isAsciiText(value)) return value.slice(start)
  return Array.from(value).slice(start).join('')
}

function getMessageCreatedAtMs(createdAt: string): number {
  const timestamp = new Date(createdAt).getTime()
  return Number.isFinite(timestamp) ? timestamp : Date.now()
}

function isAsciiText(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code > 0x7f) return false
  }
  return true
}

function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (item !== undefined && predicate(item)) return index
  }
  return -1
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

function seedRuntimePaneMessages(address: RuntimeTaskAddress, messages: WorkbenchMessage[]) {
  const key = runtimeTranscriptPaneKey(address)
  setLruMapValue(runtimePaneMessageSeeds, key, [...messages], MAX_CACHED_RUNTIME_PANE_MESSAGES)
}

function snapshotRuntimePaneMessages(address: RuntimeTaskAddress, messages: WorkbenchMessage[]) {
  const key = runtimeTranscriptPaneKey(address)
  if (messages.length === 0) {
    runtimePaneMessageSnapshots.delete(key)
    return
  }
  setLruMapValue(runtimePaneMessageSnapshots, key, [...messages], MAX_CACHED_RUNTIME_PANE_MESSAGES)
}

function getRuntimePaneMessageSnapshot(address: RuntimeTaskAddress): WorkbenchMessage[] {
  const key = runtimeTranscriptPaneKey(address)
  const snapshot = getLruMapValue(runtimePaneMessageSnapshots, key)
  return [...(snapshot ?? [])]
}

function getRuntimePaneMessageSeed(address: RuntimeTaskAddress): WorkbenchMessage[] {
  const key = runtimeTranscriptPaneKey(address)
  const seed = getLruMapValue(runtimePaneMessageSeeds, key)
  return [...(seed ?? [])]
}

function clearRuntimePaneMessageSeed(address: RuntimeTaskAddress) {
  runtimePaneMessageSeeds.delete(runtimeTranscriptPaneKey(address))
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

function mergeRuntimeTranscriptMessages(
  leadingMessages: WorkbenchMessage[],
  trailingMessages: WorkbenchMessage[]
): WorkbenchMessage[] {
  const merged: WorkbenchMessage[] = []
  const seenIds = new Set<string>()
  for (const message of [...leadingMessages, ...trailingMessages]) {
    if (seenIds.has(message.id)) continue
    seenIds.add(message.id)
    merged.push(message)
  }

  if (!merged.some(message => getRuntimeMessageIndex(message) !== null)) {
    return merged
  }

  return merged
    .map((message, order) => ({ message, order }))
    .sort((left, right) => {
      const leftIndex = getRuntimeMessageIndex(left.message)
      const rightIndex = getRuntimeMessageIndex(right.message)
      if (leftIndex !== null && rightIndex !== null && leftIndex !== rightIndex) {
        return leftIndex - rightIndex
      }
      if (leftIndex !== null && rightIndex === null) return -1
      if (leftIndex === null && rightIndex !== null) return 1
      return left.order - right.order
    })
    .map(item => item.message)
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
    .map(getRuntimeMessageIndex)
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

function getRuntimeMessageIndex(message: WorkbenchMessage): number | null {
  return typeof message.runtimeMessageIndex === 'number' &&
    Number.isFinite(message.runtimeMessageIndex)
    ? message.runtimeMessageIndex
    : null
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
  loadedRanges: LoadedTranscriptRange[]
) {
  const messageIndex = Number.isFinite(item.messageIndex) ? Math.max(0, item.messageIndex) : 0
  const sortedRanges = mergeTranscriptRanges(loadedRanges, [])
  const nextLoadedRange = sortedRanges.find(range => range.start > messageIndex)
  const pageEnd = Math.max(
    messageIndex + 1,
    Math.min(
      nextLoadedRange?.start ?? messageIndex + RUNTIME_TRANSCRIPT_PAGE_SIZE,
      messageIndex + RUNTIME_TRANSCRIPT_PAGE_SIZE
    )
  )

  return {
    limit: RUNTIME_TRANSCRIPT_PAGE_SIZE,
    beforeCursor: `offset:${pageEnd}`,
  }
}

function updateRuntimeSubagentStatuses(
  current: RuntimeSubagentStatus[],
  activity: RuntimeSubagentActivityPayload
): RuntimeSubagentStatus[] {
  const agentPath = activity.agentPath.trim()
  if (!agentPath) return current

  const agentId = runtimeSubagentId(activity)
  const status = normalizeRuntimeSubagentStatus(activity.status ?? activity.kind)
  const previousStatus = current.find(item => item.id === agentId)
  const nextStatus: RuntimeSubagentStatus = {
    id: agentId,
    agentId,
    agentPath,
    agentName:
      activity.agentName?.trim() || previousStatus?.agentName || runtimeSubagentName(agentId),
    status,
    kind: activity.kind,
    updatedAtMs: activity.occurredAtMs ?? Date.now(),
  }

  const withoutCurrent = current.filter(item => item.id !== agentId)
  return [...withoutCurrent, nextStatus].sort((left, right) => {
    const leftTime = left.updatedAtMs ?? 0
    const rightTime = right.updatedAtMs ?? 0
    return rightTime - leftTime
  })
}

function markRuntimeSubagentsSettled(current: RuntimeSubagentStatus[]): RuntimeSubagentStatus[] {
  let changed = false
  const settled = current.map(status => {
    if (status.status !== 'running') return status
    changed = true
    return {
      ...status,
      status: 'done' as const,
      updatedAtMs: Date.now(),
    }
  })
  return changed ? settled : current
}

function normalizeRuntimeSubagentStatus(
  value: string | undefined
): RuntimeSubagentStatus['status'] {
  const normalized = value?.replace(/_/g, '').toLowerCase()
  if (normalized === 'done' || normalized === 'completed' || normalized === 'taskcomplete') {
    return 'done'
  }
  if (normalized === 'interrupted' || normalized === 'cancelled' || normalized === 'canceled') {
    return 'interrupted'
  }
  return 'running'
}

function runtimeSubagentId(activity: RuntimeSubagentActivityPayload): string {
  const agentId = activity.agentId?.trim()
  if (agentId) return agentId

  const threadId = activity.agentThreadId?.trim()
  if (threadId) return threadId

  const agentPath = activity.agentPath.trim()
  if (agentPath.startsWith('thread:')) {
    return agentPath.slice('thread:'.length).trim() || agentPath
  }
  return agentPath
}

function runtimeSubagentName(agentId: string): string {
  const parts = agentId.split('/').filter(Boolean)
  const lastPart = parts[parts.length - 1] ?? agentId
  if (!lastPart || lastPart.startsWith('019') || lastPart.length > 16) {
    return `Agent ${shortRuntimeAgentId(agentId)}`
  }
  return lastPart
}

function shortRuntimeAgentId(agentId: string): string {
  const normalized = agentId.replace(/^thread:/, '').trim()
  return normalized.length > 8 ? normalized.slice(-8) : normalized || 'subagent'
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

function runtimeGoalCreateInput(goal: RuntimeGoal): RuntimeGoalCreateInput {
  return {
    objective: goal.objective,
    status: goal.status,
    tokenBudget: goal.tokenBudget,
  }
}

function requestUserInputResponseText(response: RequestUserInputResponse): string {
  const answers = Object.values(response.answers)
    .flatMap(answer => answer.answers)
    .map(answer => answer.trim())
    .filter(Boolean)
  return answers.length > 0 ? answers.join('\n') : '继续'
}
