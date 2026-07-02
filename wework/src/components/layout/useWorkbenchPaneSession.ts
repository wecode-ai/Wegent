import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import i18n from '@/i18n'
import { useWorkbenchPaneContext } from '@/features/workbench/useWorkbench'
import {
  findActiveAssistantMessage,
  type RuntimePaneMessageAction,
} from '@/features/workbench/runtimePaneMessages'
import {
  resolveAutomaticModel,
  selectedModelExecutionFields,
} from '@/features/workbench/runtimeModelSelection'
import { localRuntimeAttachments, remoteAttachmentIds } from '@/lib/runtime-attachments'
import {
  applyRequestUserInputResponseToMessages,
  requestUserInputPayloadKey,
  requestUserInputResponseKey,
} from '@/components/chat/requestUserInputMessages'
import type { RequestUserInputPayload } from '@/components/chat/RequestUserInputCard'
import { visibleRuntimeGoal } from '@/lib/runtime-goal'
import type {
  Attachment,
  ModelOptions,
  RequestUserInputResponse,
  RuntimeGoal,
  RuntimeGoalCreateInput,
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

interface WorkbenchPaneSessionOptions {
  currentRuntimeTask: RuntimeTaskAddress | null
}

interface RuntimePaneQueuedMessage extends QueuedWorkbenchMessage {
  attachments?: Attachment[]
  modelId?: string
  modelType?: RuntimeSendRequest['modelType']
  modelOptions?: ModelOptions
  runtimeGoalRequest?: boolean
}

interface SendRequestUserInputResponseOptions {
  appendUserMessage?: boolean
  forceDefaultCollaborationMode?: boolean
}

interface LoadedTranscriptRange {
  start: number
  end: number
}

interface PendingRuntimeGoalState {
  goal: RuntimeGoal
  targetKey: string | null
  targetIdentityKey: string | null
}

const runtimePaneMessageSeeds = new Map<string, WorkbenchMessage[]>()
const runtimePaneMessageSnapshots = new Map<string, WorkbenchMessage[]>()
const runtimePaneGoalSeeds = new Map<string, PendingRuntimeGoalState>()
const RUNTIME_TRANSCRIPT_PAGE_SIZE = 50

export function useWorkbenchPaneSession({ currentRuntimeTask }: WorkbenchPaneSessionOptions) {
  const {
    projectChat,
    loadRuntimeTranscriptForPane,
    subscribeRuntimeTaskStream,
    getRuntimeGoal,
    setRuntimeGoal,
    clearRuntimeGoal,
    setWorkbenchError,
    sendRuntimePaneMessage,
    cancelRuntimePaneTask,
    sendCurrentInput,
    refreshWorkLists,
  } = useWorkbenchPaneContext()
  const [queuedMessages, setQueuedMessages] = useState<RuntimePaneQueuedMessage[]>([])
  const [guidanceMessages] = useState<GuidanceWorkbenchMessage[]>([])
  const [codeCommentContexts, setCodeCommentContexts] = useState<CodeCommentContext[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [waitingForAssistant, setWaitingForAssistant] = useState(false)
  const [answeredRequestUserInputIds, setAnsweredRequestUserInputIds] = useState<
    ReadonlySet<string>
  >(() => new Set())
  const [transcriptLoading, setTranscriptLoading] = useState(() => Boolean(currentRuntimeTask))
  const [transcriptHasMoreBefore, setTranscriptHasMoreBefore] = useState(false)
  const [transcriptBeforeCursor, setTranscriptBeforeCursor] = useState<string | null>(null)
  const [transcriptLoadingMoreBefore, setTranscriptLoadingMoreBefore] = useState(false)
  const [loadedTranscriptRanges, setLoadedTranscriptRanges] = useState<LoadedTranscriptRange[]>([])
  const [turnNavigation, setTurnNavigation] = useState<RuntimeTurnNavigationItem[]>([])
  const [subagentStatuses, setSubagentStatuses] = useState<RuntimeSubagentStatus[]>([])
  const [threadGoal, setThreadGoal] = useState<RuntimeGoal | null>(null)
  const [pendingGoalState, setPendingGoalState] = useState<PendingRuntimeGoalState | null>(null)
  const [goalDraftActive, setGoalDraftActive] = useState(false)
  const loadedRuntimeTranscriptKeyRef = useRef<string | null>(null)
  const loadRuntimeTranscriptForPaneRef = useRef(loadRuntimeTranscriptForPane)
  const subscribeRuntimeTaskStreamRef = useRef(subscribeRuntimeTaskStream)
  const refreshWorkListsRef = useRef(refreshWorkLists)
  const messagesRef = useRef<WorkbenchMessage[]>([])
  const loadedTranscriptRangesRef = useRef<LoadedTranscriptRange[]>([])
  const runtimeTaskLoadTarget = useMemo(() => {
    if (!currentRuntimeTask) return null
    return {
      key: runtimeTranscriptPaneKey(currentRuntimeTask),
      address: currentRuntimeTask,
    }
  }, [currentRuntimeTask])
  const [messages, setMessages] = useState<WorkbenchMessage[]>([])
  const dispatchMessages = useCallback(
    (action: RuntimePaneMessageAction) => {
      setMessages(currentMessages => {
        const nextMessages = reduceWorkbenchMessages<Attachment, TurnFileChangesSummary>(
          currentMessages,
          action
        )
        if (currentRuntimeTask) {
          snapshotRuntimePaneMessages(currentRuntimeTask, nextMessages)
          debugRuntimePaneMessageFlow('message-action', {
            address: runtimeAddressDebug(currentRuntimeTask),
            actionType: action.type,
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
  const activeAssistantMessage = useMemo(() => findActiveAssistantMessage(messages), [messages])
  const hasActiveAssistant = Boolean(activeAssistantMessage)
  const busy = sending || waitingForAssistant || hasActiveAssistant
  const goal = useMemo(() => {
    const visibleThreadGoal = visibleRuntimeGoal(threadGoal)
    if (visibleThreadGoal) return visibleThreadGoal
    if (!pendingGoalState) return null
    if (!runtimeTaskLoadTarget && isUnboundPendingGoalState(pendingGoalState)) {
      return visibleRuntimeGoal(pendingGoalState.goal)
    }
    if (
      runtimeTaskLoadTarget &&
      isPendingGoalVisibleForRuntimeTarget(pendingGoalState, runtimeTaskLoadTarget.address)
    ) {
      return visibleRuntimeGoal(pendingGoalState.goal)
    }
    return null
  }, [pendingGoalState, runtimeTaskLoadTarget, threadGoal])

  /* eslint-disable react-hooks/set-state-in-effect -- Runtime task changes reset pane transcript state before the async transcript load completes. */
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
    refreshWorkListsRef.current = refreshWorkLists
  }, [refreshWorkLists])

  useEffect(() => {
    if (!runtimeTaskLoadTarget) {
      setThreadGoal(null)
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
    setThreadGoal(null)
    void getRuntimeGoal(runtimeTaskLoadTarget.address)
      .then(response => {
        if (!cancelled) {
          const loadedGoal = response.accepted ? response.goal : null
          setThreadGoal(loadedGoal)
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
          setThreadGoal(null)
          console.error('[Wework] Runtime goal load failed', {
            address: runtimeAddressDebug(runtimeTaskLoadTarget.address),
            error,
          })
        }
      })

    return () => {
      cancelled = true
    }
  }, [getRuntimeGoal, runtimeTaskLoadTarget])

  useEffect(() => {
    if (!runtimeTaskLoadTarget) {
      loadedRuntimeTranscriptKeyRef.current = null
      // This clears pane-local transcript state when there is no runtime target.
      setTranscriptLoading(false)
      setTranscriptHasMoreBefore(false)
      setTranscriptBeforeCursor(null)
      setTranscriptLoadingMoreBefore(false)
      setLoadedTranscriptRanges([])
      setTurnNavigation([])
      setSubagentStatuses([])
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
    setLoadedTranscriptRanges([])
    setTurnNavigation([])
    setSubagentStatuses([])
    void loadRuntimeTranscriptForPaneRef
      .current(address, { limit: RUNTIME_TRANSCRIPT_PAGE_SIZE })
      .then(transcript => {
        if (!cancelled) {
          const nextMessages = transcript.messages.length > 0 ? transcript.messages : seededMessages
          loadedRuntimeTranscriptKeyRef.current = loadKey
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
            setWaitingForAssistant(false)
          }
          clearRuntimePaneMessageSeed(address)
        }
      })
      .catch(error => {
        if (!cancelled) {
          loadedRuntimeTranscriptKeyRef.current = null
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
  }, [dispatchMessages, runtimeTaskLoadTarget])
  /* eslint-enable react-hooks/set-state-in-effect */

  /* eslint-disable react-hooks/set-state-in-effect -- Queued runtime messages are advanced when the active runtime response becomes idle. */
  useEffect(() => {
    if (!runtimeTaskLoadTarget) {
      return
    }

    const { address } = runtimeTaskLoadTarget
    const unsubscribe = subscribeRuntimeTaskStreamRef.current(address, {
      onMessageAction: dispatchMessages,
      onAssistantStart: () => setWaitingForAssistant(false),
      onAssistantSettled: () => {
        setWaitingForAssistant(false)
        setSubagentStatuses(markRuntimeSubagentsSettled)
        void getRuntimeGoal(address)
          .then(response => {
            const loadedGoal = response.accepted ? response.goal : null
            setThreadGoal(loadedGoal)
            if (loadedGoal) {
              clearRuntimePaneGoalSeed(address)
              setPendingGoalState(current =>
                current &&
                isPendingGoalVisibleForRuntimeTarget(current, runtimeTaskLoadTarget.address)
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
        setThreadGoal(loadedGoal)
        clearRuntimePaneGoalSeed(address)
        setPendingGoalState(current =>
          current && isPendingGoalVisibleForRuntimeTarget(current, runtimeTaskLoadTarget.address)
            ? null
            : current
        )
      },
      onRuntimeGoalCleared: () => {
        setThreadGoal(null)
        clearRuntimePaneGoalSeed(address)
        setPendingGoalState(current =>
          current && isPendingGoalVisibleForRuntimeTarget(current, runtimeTaskLoadTarget.address)
            ? null
            : current
        )
      },
    })
    return unsubscribe
  }, [dispatchMessages, getRuntimeGoal, runtimeTaskLoadTarget])

  const loadMoreTranscriptBefore = useCallback(async () => {
    if (!runtimeTaskLoadTarget || !transcriptBeforeCursor || transcriptLoadingMoreBefore) return

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
  }, [dispatchMessages, runtimeTaskLoadTarget, transcriptBeforeCursor, transcriptLoadingMoreBefore])

  const loadTranscriptTurnNavigationItem = useCallback(
    async (item: RuntimeTurnNavigationItem) => {
      if (!runtimeTaskLoadTarget || !item.cursor) {
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
    [dispatchMessages, runtimeTaskLoadTarget, transcriptBeforeCursor, transcriptHasMoreBefore]
  )

  const loadTranscriptGap = useCallback(
    async (gap: LoadedTranscriptRange) => {
      if (!runtimeTaskLoadTarget || gap.end <= gap.start) return

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
    [dispatchMessages, runtimeTaskLoadTarget]
  )

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
    async (message: RuntimePaneQueuedMessage): Promise<boolean> => {
      if (!currentRuntimeTask) return false

      setWaitingForAssistant(true)
      appendLocalUserMessage(message.content, message.attachments, {
        runtimeGoalRequest: message.runtimeGoalRequest,
      })
      const messageAttachments = message.attachments ?? []
      const attachmentIds = remoteAttachmentIds(messageAttachments)
      const attachments = localRuntimeAttachments(messageAttachments)
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
      })
      if (!sent) {
        setWaitingForAssistant(false)
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
      setWaitingForAssistant(true)
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
      const sent = await sendRuntimePaneMessage({
        address: currentRuntimeTask,
        message,
        ...runtimeModelFields,
        ...(options.appendUserMessage ? {} : { requestUserInputResponse: response }),
      })
      if (!sent) {
        setWaitingForAssistant(false)
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
        setWaitingForAssistant(false)
        return
      }

      const cancelled = await cancelRuntimePaneTask(currentRuntimeTask)
      setWaitingForAssistant(false)
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

  useEffect(() => {
    if (!currentRuntimeTask || busy) return
    if (queuedMessages.some(message => message.status === 'sending')) return
    const queuedMessage = queuedMessages.find(message => message.status === 'queued')
    if (!queuedMessage) return

    // This advances the next queued message once the pane becomes idle.
    setQueuedMessages(messages =>
      messages.map(message =>
        message.id === queuedMessage.id ? { ...message, status: 'sending' } : message
      )
    )

    void sendRuntimeMessage(queuedMessage).then(sent => {
      setQueuedMessages(messages =>
        sent
          ? messages.filter(message => message.id !== queuedMessage.id)
          : messages.map(message =>
              message.id === queuedMessage.id
                ? { ...message, status: 'failed', error: '发送失败' }
                : message
            )
      )
    })
  }, [busy, currentRuntimeTask, queuedMessages, sendRuntimeMessage])
  /* eslint-enable react-hooks/set-state-in-effect */

  const send = useCallback(async () => {
    const submittedInput = input.trim()
    const currentAttachments = projectChat.attachments
    const hasCodeComments = codeCommentContexts.length > 0

    if (goalDraftActive) {
      if (!submittedInput) {
        setWorkbenchError(i18n.t('workbench.goal_objective_required'))
        return
      }
      if (hasCodeComments) {
        setWorkbenchError(i18n.t('workbench.runtime_task_code_comments_not_supported'))
        return
      }

      setInput('')
      setSending(true)
      try {
        if (currentRuntimeTask) {
          const response = await setRuntimeGoal({
            address: currentRuntimeTask,
            objective: submittedInput,
            status: 'active',
          })
          if (!response.accepted) {
            setWorkbenchError(response.error || i18n.t('workbench.goal_set_failed'))
            return
          }
          setThreadGoal(response.goal)
          setGoalDraftActive(false)
          const queuedMessage: RuntimePaneQueuedMessage = {
            id: `queued-runtime-pane-${Date.now()}-${queuedMessages.length}`,
            content: submittedInput,
            status: 'queued',
            createdAt: new Date().toISOString(),
            attachments: currentAttachments,
            runtimeGoalRequest: true,
            ...getRuntimeModelFields(),
          }

          projectChat.resetAttachments()
          if (busy) {
            setQueuedMessages(messages => [...messages, queuedMessage])
            return
          }

          const sent = await sendRuntimeMessage(queuedMessage)
          if (sent) {
            setCodeCommentContexts([])
          }
          return
        }

        const draftGoal = createPendingRuntimeGoal(submittedInput)
        const initialGoal = runtimeGoalCreateInput(draftGoal)
        setPendingGoalState({ goal: draftGoal, targetKey: null, targetIdentityKey: null })
        setGoalDraftActive(false)
        setWaitingForAssistant(true)
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
            appendLocalUserMessage(submittedInput, currentAttachments, {
              runtimeGoalRequest: true,
            })
          } else {
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
          setWaitingForAssistant(false)
        }
        return
      } finally {
        setSending(false)
      }
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

    setInput('')
    setSending(true)
    try {
      if (!currentRuntimeTask) {
        setWaitingForAssistant(true)
        const optimisticMessage = createLocalUserMessage(
          effectiveSubmittedInput,
          currentAttachments,
          { runtimeGoalRequest: Boolean(pendingInitialGoal) }
        )
        const sent = await sendCurrentInput(effectiveSubmittedInput, {
          codeCommentContexts,
          initialGoal: pendingInitialGoal,
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
            appendLocalUserMessage(effectiveSubmittedInput, currentAttachments, {
              runtimeGoalRequest: Boolean(pendingInitialGoal),
            })
          } else if (pendingInitialGoal) {
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
          setCodeCommentContexts([])
        } else {
          setWaitingForAssistant(false)
        }
        return
      }

      if (hasCodeComments) {
        void sendCurrentInput(submittedInput, { codeCommentContexts })
        return
      }

      const queuedMessage: RuntimePaneQueuedMessage = {
        id: `queued-runtime-pane-${Date.now()}-${queuedMessages.length}`,
        content: submittedInput,
        status: 'queued',
        createdAt: new Date().toISOString(),
        attachments: currentAttachments,
        ...getRuntimeModelFields(),
      }

      projectChat.resetAttachments()
      if (busy) {
        setQueuedMessages(messages => [...messages, queuedMessage])
        return
      }

      const sent = await sendRuntimeMessage(queuedMessage)
      if (sent) {
        setCodeCommentContexts([])
      }
    } finally {
      setSending(false)
    }
  }, [
    appendLocalUserMessage,
    busy,
    codeCommentContexts,
    currentRuntimeTask,
    goalDraftActive,
    getRuntimeModelFields,
    input,
    pendingGoalState,
    projectChat,
    queuedMessages.length,
    sendCurrentInput,
    sendRuntimeMessage,
    setRuntimeGoal,
    setWorkbenchError,
  ])

  const addCodeComment = useCallback((context: CodeCommentContext) => {
    setCodeCommentContexts(current => [...current.filter(item => item.id !== context.id), context])
  }, [])

  const clearCodeComments = useCallback(() => {
    setCodeCommentContexts([])
  }, [])

  const cancelQueuedMessage = useCallback((id: string) => {
    setQueuedMessages(messages => messages.filter(message => message.id !== id))
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
    [projectChat, queuedMessages]
  )

  const sendQueuedAsGuidance = useCallback(
    async (id: string) => {
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

      const queuedMessage = queuedMessages.find(message => message.id === id)
      if (!queuedMessage || queuedMessage.status === 'sending') return

      setQueuedMessages(messages =>
        messages.map(message =>
          message.id === id
            ? {
                ...message,
                status: 'sending',
                error: undefined,
                notice: '正在暂停当前回复并发送',
              }
            : message
        )
      )

      const cancelled = await cancelRuntimePaneTask(currentRuntimeTask)
      if (!cancelled) {
        setQueuedMessages(messages =>
          messages.map(message =>
            message.id === id
              ? { ...message, status: 'failed', notice: undefined, error: '暂停当前回复失败' }
              : message
          )
        )
        return
      }

      if (activeAssistantMessage) {
        const action: RuntimePaneMessageAction = {
          type: 'assistant_cancelled',
        }
        dispatchMessages(action)
      }

      const sent = await sendRuntimeMessage(queuedMessage)
      setQueuedMessages(messages =>
        sent
          ? messages.filter(message => message.id !== id)
          : messages.map(message =>
              message.id === id
                ? { ...message, status: 'failed', notice: undefined, error: '引导发送失败' }
                : message
            )
      )
    },
    [
      activeAssistantMessage,
      cancelRuntimePaneTask,
      currentRuntimeTask,
      dispatchMessages,
      queuedMessages,
      sendRuntimeMessage,
    ]
  )

  const pauseCurrentResponse = useCallback(async () => {
    if (!currentRuntimeTask || !activeAssistantMessage) return

    const cancelled = await cancelRuntimePaneTask(currentRuntimeTask)
    if (!cancelled) return

    dispatchMessages({
      type: 'assistant_cancelled',
    })
  }, [activeAssistantMessage, cancelRuntimePaneTask, currentRuntimeTask, dispatchMessages])

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
  }, [goal])

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

        setThreadGoal(response.goal)
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
    [currentRuntimeTask, goal, setRuntimeGoal]
  )

  const pauseCurrentGoal = useCallback(
    () => updateCurrentGoalStatus('paused'),
    [updateCurrentGoalStatus]
  )

  const resumeCurrentGoal = useCallback(
    () => updateCurrentGoalStatus('active'),
    [updateCurrentGoalStatus]
  )

  const clearCurrentGoal = useCallback(async () => {
    if (!goal) return false
    if (!currentRuntimeTask) {
      setPendingGoalState(null)
      return true
    }

    try {
      const response = await clearRuntimeGoal(currentRuntimeTask)
      if (!response.accepted) return false

      setThreadGoal(null)
      return true
    } catch (error) {
      console.error('[Wework] Runtime goal clear failed', {
        address: runtimeAddressDebug(currentRuntimeTask),
        error,
      })
      return false
    }
  }, [clearRuntimeGoal, currentRuntimeTask, goal])

  const cancelGuidanceMessage = useCallback(() => undefined, [])

  return {
    messages,
    queuedMessages,
    guidanceMessages,
    codeCommentContexts,
    input,
    setInput,
    sending,
    waitingForAssistant,
    answeredRequestUserInputIds,
    transcriptLoading,
    transcriptHasMoreBefore,
    transcriptLoadingMoreBefore,
    turnNavigation,
    subagentStatuses,
    goal,
    goalDraftActive,
    loadMoreTranscriptBefore,
    loadTranscriptTurnNavigationItem,
    loadTranscriptGap,
    send,
    sendRequestUserInputResponse,
    ignoreRequestUserInput,
    addCodeComment,
    clearCodeComments,
    cancelQueuedMessage,
    sendQueuedAsGuidance,
    editQueuedMessage,
    cancelGuidanceMessage,
    pauseCurrentResponse,
    setCurrentGoal,
    cancelGoalDraft,
    editCurrentGoal,
    pauseCurrentGoal,
    resumeCurrentGoal,
    clearCurrentGoal,
  }
}

export type WorkbenchPaneSession = ReturnType<typeof useWorkbenchPaneSession>

function runtimeTranscriptPaneKey(address: RuntimeTaskAddress): string {
  return `${address.deviceId}:${address.localTaskId}:${address.workspacePath ?? ''}`
}

function runtimeTranscriptPaneIdentityKey(address: RuntimeTaskAddress): string {
  return `${address.deviceId}:${address.localTaskId}`
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
  runtimePaneGoalSeeds.set(
    runtimeTranscriptPaneIdentityKey(address),
    pendingRuntimeGoalState(goal, address)
  )
}

function getRuntimePaneGoalSeed(address: RuntimeTaskAddress): PendingRuntimeGoalState | null {
  return runtimePaneGoalSeeds.get(runtimeTranscriptPaneIdentityKey(address)) ?? null
}

function clearRuntimePaneGoalSeed(address: RuntimeTaskAddress) {
  runtimePaneGoalSeeds.delete(runtimeTranscriptPaneIdentityKey(address))
}

function runtimeAddressDebug(address: RuntimeTaskAddress): Record<string, unknown> {
  return {
    deviceId: address.deviceId,
    localTaskId: address.localTaskId,
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

function isRuntimeDebugEnabled(): boolean {
  return globalThis.localStorage?.getItem('wework:debug-runtime') === '1'
}

interface CreateLocalUserMessageOptions {
  runtimeGoalRequest?: boolean
}

function createLocalUserMessage(
  content: string,
  attachments?: Attachment[],
  options: CreateLocalUserMessageOptions = {}
): WorkbenchMessage {
  return {
    id: `runtime-local-pane-${Date.now()}`,
    role: 'user',
    content,
    attachments,
    status: 'done',
    createdAt: new Date().toISOString(),
    runtimeGoalRequest: options.runtimeGoalRequest ? true : undefined,
  }
}

function seedRuntimePaneMessages(address: RuntimeTaskAddress, messages: WorkbenchMessage[]) {
  const key = runtimeTranscriptPaneKey(address)
  runtimePaneMessageSeeds.set(key, [...messages])
}

function snapshotRuntimePaneMessages(address: RuntimeTaskAddress, messages: WorkbenchMessage[]) {
  const key = runtimeTranscriptPaneKey(address)
  if (messages.length === 0) {
    runtimePaneMessageSnapshots.delete(key)
    return
  }
  runtimePaneMessageSnapshots.set(key, [...messages])
}

function getRuntimePaneMessageSnapshot(address: RuntimeTaskAddress): WorkbenchMessage[] {
  const key = runtimeTranscriptPaneKey(address)
  return [...(runtimePaneMessageSnapshots.get(key) ?? [])]
}

function getRuntimePaneMessageSeed(address: RuntimeTaskAddress): WorkbenchMessage[] {
  const key = runtimeTranscriptPaneKey(address)
  return [...(runtimePaneMessageSeeds.get(key) ?? [])]
}

function clearRuntimePaneMessageSeed(address: RuntimeTaskAddress) {
  runtimePaneMessageSeeds.delete(runtimeTranscriptPaneKey(address))
}

function hasSettledAssistantMessage(messages: WorkbenchMessage[]): boolean {
  return (
    messages.some(message => message.role === 'assistant') && !findActiveAssistantMessage(messages)
  )
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
  const agentPath = activity.agent_path.trim()
  if (!agentPath) return current

  const agentId = runtimeSubagentId(activity)
  const status = normalizeRuntimeSubagentStatus(activity.status ?? activity.kind)
  const previousStatus = current.find(item => item.id === agentId)
  const nextStatus: RuntimeSubagentStatus = {
    id: agentId,
    agentId,
    agentPath,
    agentName:
      activity.agent_name?.trim() || previousStatus?.agentName || runtimeSubagentName(agentId),
    status,
    kind: activity.kind,
    updatedAtMs: activity.occurred_at_ms ?? Date.now(),
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
  const agentId = activity.agent_id?.trim()
  if (agentId) return agentId

  const threadId = activity.agent_thread_id?.trim()
  if (threadId) return threadId

  const agentPath = activity.agent_path.trim()
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
  return typeof candidate.deviceId === 'string' && typeof candidate.localTaskId === 'string'
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
