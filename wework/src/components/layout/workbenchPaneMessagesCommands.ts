import {
  logRuntimeQueueStage,
  runtimeMessagePresentationDiagnostic,
} from '@/features/workbench/runtimeQueueDiagnostics'
import { pendingRequestUserInputPayload } from './requestUserInputOverlay'

import i18n from '@/i18n'

import { isRuntimeTaskBusyError } from '@/features/workbench/runtimePaneStatus'
import { runtimeTaskLifecycleTransitionChanged } from '@/features/workbench/runtimeTaskLifecycle'
import {
  resolveAutomaticModel,
  selectedModelExecutionFields,
} from '@/features/workbench/runtimeModelSelection'

import { normalizeGuidanceError } from '@/features/workbench/workbenchProviderHelpers'

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

import {
  markRuntimeTerminalAdditionalContextDelivered,
  readRuntimeTerminalAdditionalContext,
} from '@/lib/runtime-terminal-context'
import type {
  Attachment,
  ModelOptions,
  RequestUserInputResponse,
  RuntimeRollbackRequest,
} from '@/types/api'

import type { RuntimePaneQueuedMessage, WorkbenchMessage } from '@/types/workbench'

import {
  applyRuntimeConversationAction,
  appendAcceptedRuntimeConversationMessage,
  appendOptimisticRuntimeConversationGuidance,
  beginRuntimeConversationOperation,
  clearInterruptedRuntimeConversationGuidanceExcept,
  getRuntimeConversationMessages,
  getRuntimeConversationTurns,
  getRuntimeConversationTurnIds,
  markRuntimeConversationGuidanceInterrupted,
  optimisticallyInterruptRuntimeConversation,
  removeOptimisticRuntimeConversationGuidance,
  removeRuntimeConversationTurn,
  replaceRuntimeConversationFromUserMessage,
  settleOptimisticallyInterruptedRuntimeConversation,
  restoreOptimisticallyInterruptedRuntimeConversation,
  takeInterruptedRuntimeConversationGuidance,
  updateRuntimeConversationBlocks,
  replaceRuntimeConversationSnapshot,
} from '@/features/workbench/runtimeConversationCache'
import {
  createRuntimeUserMessage,
  type RuntimeUserMessageOptions,
} from '@/features/workbench/runtimeUserMessage'

import {
  createRuntimeQueuedUserMessage,
  retainRuntimeQueuedMessage as retainQueuedMessage,
  sendRuntimeQueuedMessage,
} from '@/features/workbench/runtimeQueuedMessageSender'
import { RUNTIME_RETRY_CONTINUATION_PROMPT } from './runtimeRetry'

import {
  rollbackRejectedRuntimeConversationTurn,
  isInterruptedGuidance,
  runtimeAddressDebug,
  summarizeWorkbenchMessages,
  debugRuntimePaneMessageFlow,
  isEditableLastUserMessage,
} from './workbenchPaneSessionHelpers'
import type {
  SendRequestUserInputResponseOptions,
  SendRuntimeMessageOptions,
  RuntimeMessageSendResult,
} from './workbenchPaneSessionTypes'
import type { PaneCommandContext } from './workbenchPaneCommandContext'

export function createPaneMessagesCommands(sessionOwner: PaneCommandContext) {
  const getRuntimeModelFields = (modelOptionsOverride?: ModelOptions) => {
    const { currentRuntimeTask, projectChat } = sessionOwner.frame

    // A pane renders one conversation, which may differ from the provider's
    // active pane in a split layout. Resolve against this pane's address.
    const taskModelSelection = currentRuntimeTask
      ? projectChat.resolveRuntimeTaskModelSelection?.(currentRuntimeTask)
      : null
    const selectedModel = currentRuntimeTask
      ? (taskModelSelection?.selectedModel ?? null)
      : (projectChat.getSelectedModel?.() ??
        projectChat.selectedModel ??
        resolveAutomaticModel(projectChat.models))
    const selectedModelOptions = currentRuntimeTask
      ? (taskModelSelection?.selectedModelOptions ?? {})
      : (projectChat.getSelectedModelOptions?.() ?? projectChat.selectedModelOptions)
    return selectedModelExecutionFields(selectedModel, {
      ...selectedModelOptions,
      ...modelOptionsOverride,
    })
  }

  const appendLocalUserMessage = (
    content: string,
    attachments?: Attachment[],
    options?: RuntimeUserMessageOptions
  ) => {
    const { dispatchMessages } = sessionOwner.commands

    dispatchMessages({
      type: 'user_added',
      message: createRuntimeUserMessage(content, attachments, options),
    })
  }

  const applyLocalRequestUserInputResponses = (responses: readonly RequestUserInputResponse[]) => {
    const { currentRuntimeTask } = sessionOwner.frame

    if (!currentRuntimeTask) return
    const previousCount = getRuntimeConversationMessages(currentRuntimeTask).length
    const nextMessages = updateRuntimeConversationBlocks(currentRuntimeTask, block =>
      responses.reduce(
        (current, response) => applyRequestUserInputResponseToBlock(current, response),
        block
      )
    )
    debugRuntimePaneMessageFlow('request-user-input-response-applied', {
      address: runtimeAddressDebug(currentRuntimeTask),
      requestUserInputKeys: responses.map(requestUserInputResponseKey),
      previousCount,
      nextCount: nextMessages.length,
      nextMessages: summarizeWorkbenchMessages(nextMessages),
    })
  }

  const sendRuntimeMessage = async (
    message: RuntimePaneQueuedMessage,
    options: SendRuntimeMessageOptions = {}
  ): Promise<RuntimeMessageSendResult> => {
    const {
      currentRuntimeTask,
      lifecycleStore,
      sendRuntimePaneMessage,
      answeredRequestUserInputIds,
    } = sessionOwner.frame
    const { setError, setQueuedMessages } = sessionOwner.commands

    if (!currentRuntimeTask) return { accepted: false, queued: false }
    const operation = beginRuntimeConversationOperation(currentRuntimeTask)
    let pendingAdmission = false
    try {
      const appendedLocalMessage =
        options.appendLocalMessage !== false &&
        !pendingRequestUserInputPayload(
          getRuntimeConversationMessages(currentRuntimeTask),
          answeredRequestUserInputIds
        )
      if (appendedLocalMessage) {
        applyRuntimeConversationAction(currentRuntimeTask, {
          type: 'user_added',
          message: createRuntimeQueuedUserMessage(message),
        })
      }
      if (options.appendLocalMessage !== false && !appendedLocalMessage) {
        setQueuedMessages(messages => {
          if (messages.some(item => item.id === message.id)) return messages
          pendingAdmission = true
          return [...messages, { ...message, status: 'sending' }]
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
          sessionOwner.live.currentRuntimeTask,
          message.id
        )
      }
      return result
    } finally {
      if (pendingAdmission)
        setQueuedMessages(messages => messages.filter(item => item.id !== message.id))
      operation.dispose()
    }
  }

  const retainRuntimeQueuedMessage = (
    message: RuntimePaneQueuedMessage,
    queuePosition?: number | null
  ) => {
    const { currentRuntimeTask } = sessionOwner.frame

    if (currentRuntimeTask) retainQueuedMessage(currentRuntimeTask, message, queuePosition)
  }

  const interruptAndSendQueuedMessage = async (
    message: RuntimePaneQueuedMessage
  ): Promise<boolean> => {
    const {
      answeredRequestUserInputIds,
      currentRuntimeTask,
      interruptAndSendRuntimePaneMessage,
      lifecycleStore,
      queuedMessages,
    } = sessionOwner.frame
    const { appendLocalUserMessage, setError, setQueuedMessages } = sessionOwner.commands

    if (!currentRuntimeTask) return false
    if (sessionOwner.live.interruptAndSendInFlight) return false
    sessionOwner.live.interruptAndSendInFlight = true
    const deferLocalMessage = Boolean(
      pendingRequestUserInputPayload(
        getRuntimeConversationMessages(currentRuntimeTask),
        answeredRequestUserInputIds
      )
    )
    const turnIdsBeforeSend = getRuntimeConversationTurnIds(currentRuntimeTask)
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
    if (!deferLocalMessage) {
      appendLocalUserMessage(message.displayContent ?? message.content, message.attachments, {
        id: message.id,
        createdAt: message.createdAt,
        runtimeGoalRequest: message.runtimeGoalRequest,
        codeComments: message.codeComments,
      })
    }
    let queued = false
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
      {
        onError: setError,
        onQueued: () => {
          queued = true
        },
      }
    )
    sessionOwner.live.interruptAndSendInFlight = false
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
      if (!deferLocalMessage) {
        removeRuntimeConversationTurn(currentRuntimeTask, {
          clientUserMessageId: message.id,
        })
      }
      return false
    }
    if (interruptedTurn) {
      settleOptimisticallyInterruptedRuntimeConversation(currentRuntimeTask, interruptedTurn)
    }

    if (deferLocalMessage && !queued) {
      appendAcceptedRuntimeConversationMessage(
        currentRuntimeTask,
        createRuntimeQueuedUserMessage(message),
        lifecycleStore.getTask(currentRuntimeTask)?.turn.id ?? null,
        turnIdsBeforeSend
      )
    }
    markRuntimeTerminalAdditionalContextDelivered(terminalContext)
    setQueuedMessages(messages =>
      messages.filter(item => item.id !== message.id && !interruptedGuidanceIds.has(item.id))
    )
    return true
  }

  const dispatchContinuation = async (input: string, displayContent?: string): Promise<boolean> => {
    const { currentRuntimeTask, lifecycleStore, queuedMessageBusyBlocks } = sessionOwner.frame
    const {
      getRuntimeModelFields,
      retainRuntimeQueuedMessage,
      sendRuntimeMessage,
      setError,
      setQueuedMessages,
    } = sessionOwner.commands

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
  }

  const sendContinuation = async (input: string, displayContent?: string): Promise<boolean> => {
    const { currentRuntimeTask } = sessionOwner.frame
    const { dispatchContinuation, setError } = sessionOwner.commands

    if (!currentRuntimeTask || !input.trim() || sessionOwner.live.continuationInFlight) return false
    sessionOwner.live.continuationInFlight = true
    setError(null)
    try {
      return await dispatchContinuation(input.trim(), displayContent)
    } catch (error) {
      setError(
        error instanceof Error ? error.message : i18n.t('workbench.project_chat_send_failed')
      )
      return false
    } finally {
      sessionOwner.live.continuationInFlight = false
    }
  }

  const retryFailedMessageInPane = async (message: WorkbenchMessage): Promise<boolean> => {
    const { currentRuntimeTask } = sessionOwner.frame
    const { sendContinuation, setError } = sessionOwner.commands

    if (!currentRuntimeTask || sessionOwner.live.continuationInFlight) return false
    const failedMessage = getRuntimeConversationMessages(currentRuntimeTask).find(
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
  }

  const editLastUserMessageInPane = async (
    message: WorkbenchMessage,
    content: string
  ): Promise<boolean> => {
    const {
      currentRuntimeTask,
      editLastUserMessage,
      isTranscriptScopeCurrent,
      loadRuntimeTranscriptForPane,
      paneStatus,
      runtimeTranscriptPageSize,
    } = sessionOwner.frame
    const { getRuntimeModelFields, setError } = sessionOwner.commands

    const submittedContent = content.trim()
    if (!submittedContent) return false
    if (!currentRuntimeTask) return false
    if (paneStatus.isBusy) {
      setError('当前回复仍在进行中，完成后再编辑')
      return false
    }

    const currentMessages = getRuntimeConversationMessages(currentRuntimeTask)
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
      await loadRuntimeTranscriptForPane(currentRuntimeTask, {
        limit: runtimeTranscriptPageSize,
        refresh: true,
      })
      removeRuntimeConversationTurn(currentRuntimeTask, {
        clientUserMessageId: editedMessage.id,
      })
      return false
    } catch (error) {
      const transcript = await loadRuntimeTranscriptForPane(currentRuntimeTask, {
        limit: runtimeTranscriptPageSize,
        refresh: true,
      }).catch(() => null)
      removeRuntimeConversationTurn(currentRuntimeTask, {
        clientUserMessageId: editedMessage.id,
      })
      if (!transcript) {
        replaceRuntimeConversationSnapshot(currentRuntimeTask, previousTurns)
      }
      if (isTranscriptScopeCurrent()) {
        console.error('[Wework] Runtime last user message edit failed', {
          address: runtimeAddressDebug(currentRuntimeTask),
          messageId: message.id,
          error,
        })
        setError('编辑失败')
      }
      return false
    }
  }

  const ignoreRequestUserInput = async (
    payload: RequestUserInputPayload | RequestUserInputPayload[]
  ) => {
    const { activeAssistantMessage, cancelRuntimePaneTask, currentRuntimeTask } = sessionOwner.frame
    const { setAnsweredRequestUserInputIds } = sessionOwner.actions
    const { dispatchMessages } = sessionOwner.commands

    const requestUserInputKeys = (Array.isArray(payload) ? payload : [payload])
      .map(requestUserInputPayloadKey)
      .filter((key): key is string => Boolean(key))
    setAnsweredRequestUserInputIds(current => new Set([...current, ...requestUserInputKeys]))

    if (!currentRuntimeTask) return

    const cancelled = await cancelRuntimePaneTask(currentRuntimeTask)
    if (!cancelled) {
      setAnsweredRequestUserInputIds(current => {
        const next = new Set(current)
        for (const key of requestUserInputKeys) next.delete(key)
        return next
      })
      return
    }

    if (!activeAssistantMessage) return
    const activeTurnId = activeAssistantMessage.turnId ?? activeAssistantMessage.subtaskId
    if (!activeTurnId) return

    dispatchMessages({
      type: 'assistant_cancelled',
      subtaskId: activeTurnId,
    })
  }

  const sendQueuedMessage = async (message: RuntimePaneQueuedMessage) => {
    const { queueController } = sessionOwner.frame

    await queueController?.send(message)
  }

  const loadFullTranscriptForExport = async () => {
    const { loadRuntimeTranscriptForPane, runtimeTaskLoadTarget } = sessionOwner.frame

    if (!runtimeTaskLoadTarget) return sessionOwner.live.messages

    const transcript = await loadRuntimeTranscriptForPane(runtimeTaskLoadTarget.address, {
      includeFullContent: true,
      refresh: true,
    })
    if (transcript.fullContent !== true) {
      throw new Error('The complete task transcript is unavailable')
    }
    return transcript.messages.length > 0 ? transcript.messages : sessionOwner.live.messages
  }

  const sendQueuedMessageAsGuidance = async (
    queuedMessage: RuntimePaneQueuedMessage,
    forceActiveTurn = false
  ): Promise<boolean> => {
    const { currentRuntime, currentRuntimeTask, queuedMessageBusyBlocks, sendRuntimePaneGuidance } =
      sessionOwner.frame
    const {
      readCurrentPaneBusy,
      retainRuntimeQueuedMessage,
      sendRuntimeMessage,
      setError,
      setQueuedMessages,
    } = sessionOwner.commands

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
    if (currentRuntime && currentRuntime !== 'codex') return false

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
      logRuntimeQueueStage(currentRuntimeTask, 'guidance-request-presentation', {
        messageId: id,
        content: runtimeMessagePresentationDiagnostic(queuedMessage.content),
        displayContent: runtimeMessagePresentationDiagnostic(queuedMessage.displayContent),
        attachmentCount: messageAttachments.length,
      })
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
                error: normalizeGuidanceError(result.error),
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
                error: normalizeGuidanceError(error instanceof Error ? error.message : undefined),
              }
            : message
        )
      )
      return false
    }
  }

  const setDefaultCollaborationMode = () => {
    const { currentRuntimeTask, projectChat } = sessionOwner.frame

    if (currentRuntimeTask) {
      projectChat.setRuntimeTaskSelectedModelOption(
        currentRuntimeTask,
        'collaborationMode',
        'default'
      )
      return
    }
    projectChat.setSelectedModelOption('collaborationMode', 'default')
  }

  const sendRequestUserInputResponse = async (
    response: RequestUserInputResponse,
    options: SendRequestUserInputResponseOptions = {}
  ): Promise<boolean> => {
    const { currentRuntimeTask, lifecycleStore, sendRuntimePaneMessage } = sessionOwner.frame
    const { setAnsweredRequestUserInputIds } = sessionOwner.actions
    const {
      applyLocalRequestUserInputResponses,
      getRuntimeModelFields,
      sendQueuedMessageAsGuidance,
      setDefaultCollaborationMode,
      setQueuedMessages,
    } = sessionOwner.commands

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
        setDefaultCollaborationMode()
      }
      // A question that is answered by the next user message - a non-blocking
      // Codex question or an implementation-plan confirmation - is delivered like
      // any other user message. Codex then steers the running turn while the model
      // is still working and starts a new turn once it has stopped, instead of
      // rejecting the answer for arriving mid-turn.
      const answerIsUserMessage =
        options.appendUserMessage ||
        isAsyncRequestUserInputPayload(
          findRequestUserInputPayload(
            getRuntimeConversationMessages(currentRuntimeTask),
            requestUserInputKey
          )
        )
      if (answerIsUserMessage) {
        const answerMessage: RuntimePaneQueuedMessage = {
          id: `queued-runtime-pane-${crypto.randomUUID()}`,
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
      const responses = options.requestUserInputResponses ?? [response]
      const answeredKeys = responses
        .map(requestUserInputResponseKey)
        .filter((key): key is string => Boolean(key))
      if (answeredKeys.length > 0) {
        setAnsweredRequestUserInputIds(current => new Set([...current, ...answeredKeys]))
      }
      applyLocalRequestUserInputResponses(responses)
      return true
    } finally {
      operation.dispose()
    }
  }
  return {
    getRuntimeModelFields,
    appendLocalUserMessage,
    applyLocalRequestUserInputResponses,
    sendRuntimeMessage,
    retainRuntimeQueuedMessage,
    interruptAndSendQueuedMessage,
    dispatchContinuation,
    sendContinuation,
    retryFailedMessageInPane,
    editLastUserMessageInPane,
    ignoreRequestUserInput,
    sendQueuedMessage,
    loadFullTranscriptForExport,
    sendQueuedMessageAsGuidance,
    setDefaultCollaborationMode,
    sendRequestUserInputResponse,
  }
}
export type PaneMessagesCommands = ReturnType<typeof createPaneMessagesCommands>
