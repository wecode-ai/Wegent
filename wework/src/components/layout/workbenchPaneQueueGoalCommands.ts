import { syncRuntimeGoal } from '@/features/workbench/runtimeTaskLifecycle/goalSynchronization'

import i18n from '@/i18n'
import {
  composeImageMarkupMessage,
  hasImageMarkupComments,
} from '@/components/chat/image-preview/imageEdit'

import { runtimeGoalCreateInput } from '@/lib/runtime-goal'

import type { RuntimeGoal } from '@/types/api'

import type { RuntimePaneQueuedMessage } from '@/types/workbench'

import {
  getRuntimeConversationQueuePausedByKey,
  optimisticallyInterruptRuntimeConversation,
  runtimeConversationKey,
  settleOptimisticallyInterruptedRuntimeConversation,
  restoreOptimisticallyInterruptedRuntimeConversation,
} from '@/features/workbench/runtimeConversationCache'

import { logRuntimeQueueStage } from '@/features/workbench/runtimeQueueDiagnostics'

import {
  clearRuntimePaneGoalSeed,
  isInterruptedGuidance,
  runtimeAddressDebug,
} from './workbenchPaneSessionHelpers'
import type { RuntimePaneSendOptions } from './workbenchPaneSessionTypes'
import type { PaneCommandContext } from './workbenchPaneCommandContext'

export function createPaneQueueGoalCommands(sessionOwner: PaneCommandContext) {
  const cancelQueuedMessage = async (id: string) => {
    const { cancelRuntimeTask, currentRuntimeTask, queuedMessageBusyBlocks, queuedMessages } =
      sessionOwner.frame
    const { setQueuedMessages } = sessionOwner.commands

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
  }

  const forceStartQueuedMessage = async (id: string) => {
    const { currentRuntimeTask, forceStartRuntimeTask, queuedMessages } = sessionOwner.frame
    const { setQueuedMessages } = sessionOwner.commands

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
  }

  const resumeQueuedMessages = () => {
    const { currentRuntimeTask, queuedMessageBusyBlocks, queuedMessages } = sessionOwner.frame
    const { sendQueuedMessage, setQueuedMessagesPaused } = sessionOwner.commands

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
  }

  const resumeQueuedMessagesWithInput = async (
    inputOverride?: string,
    options?: RuntimePaneSendOptions
  ) => {
    const {
      currentRuntimeTask,
      getInput,
      lifecycleStore,
      queueController,
      queuedMessageScopeKey,
      queuedMessages,
    } = sessionOwner.frame
    const { send, sendQueuedMessage, setQueuedMessagesPaused } = sessionOwner.commands

    const interruptedGuidance = queuedMessages.find(isInterruptedGuidance)
    if (currentRuntimeTask) {
      logRuntimeQueueStage(currentRuntimeTask, 'queue-resume-requested', {
        source: 'resume-with-input',
        hasInput: Boolean((inputOverride ?? getInput()).trim()),
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

    const submittedInput = (inputOverride ?? getInput()).trim()
    const combinedMessage = {
      ...interruptedGuidance,
      content: [interruptedGuidance.content, submittedInput].filter(Boolean).join('\n\n'),
      ...(interruptedGuidance.imageMarkupDraftText !== undefined
        ? {
            imageMarkupDraftText: [interruptedGuidance.imageMarkupDraftText, submittedInput]
              .filter(Boolean)
              .join('\n\n'),
          }
        : {}),
      notice: undefined,
    }
    setQueuedMessagesPaused(false)
    await sendQueuedMessage(combinedMessage)
  }

  const clearQueuedMessages = () => {
    const { queuedMessageBusyBlocks, queuedMessages } = sessionOwner.frame
    const { cancelQueuedMessage, setQueuedMessages, setQueuedMessagesPaused } =
      sessionOwner.commands

    queuedMessageBusyBlocks.clear()
    const runtimeQueuedMessage = queuedMessages.find(message => message.runtimeQueued)
    setQueuedMessages(messages => messages.filter(message => message.runtimeQueued))
    setQueuedMessagesPaused(false)
    if (runtimeQueuedMessage) {
      void cancelQueuedMessage(runtimeQueuedMessage.id)
    }
  }

  const reorderQueuedMessages = (sourceId: string, targetId: string) => {
    const { setQueuedMessages } = sessionOwner.commands

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
  }

  const editQueuedMessage = (id: string) => {
    const { addExistingAttachment, queuedMessageBusyBlocks, queuedMessages } = sessionOwner.frame
    const { replaceInput, setQueuedMessages } = sessionOwner.commands

    const queuedMessage = queuedMessages.find(message => message.id === id)
    if (!queuedMessage || queuedMessage.status === 'sending' || queuedMessage.runtimeQueued) return

    queuedMessageBusyBlocks.delete(id)
    replaceInput(queuedMessage.imageMarkupDraftText ?? queuedMessage.content)
    if (queuedMessage.imageMarkupDraftText !== undefined && queuedMessage.codeComments?.length) {
      sessionOwner.actions.setCodeCommentContexts(queuedMessage.codeComments)
    }
    queuedMessage.attachments?.forEach(attachment => {
      addExistingAttachment(attachment)
    })
    setQueuedMessages(messages => messages.filter(message => message.id !== id))
  }

  const sendQueuedAsGuidance = async (id: string) => {
    const { queuedMessages } = sessionOwner.frame
    const { sendQueuedMessageAsGuidance } = sessionOwner.commands

    const queuedMessage = queuedMessages.find(message => message.id === id)
    if (!queuedMessage || queuedMessage.runtimeQueued) return
    await sendQueuedMessageAsGuidance(queuedMessage)
  }

  const interruptAndSendQueued = async (id: string) => {
    const {
      addExistingAttachment,
      attachmentState,
      getInput,
      inputScopeKey,
      getInputRevisionForScope,
      queuedMessageBusyBlocks,
      queuedMessages,
      resetAttachments,
    } = sessionOwner.frame
    const { setCodeCommentContexts } = sessionOwner.actions
    const { interruptAndSendQueuedMessage, replaceInput, setInput } = sessionOwner.commands

    const queuedMessage = queuedMessages.find(message => message.id === id)
    if (!queuedMessage || queuedMessage.runtimeQueued) return
    queuedMessageBusyBlocks.delete(id)
    const submittedInput = getInput().trim()
    const currentAttachments = attachmentState.attachments
    const markupMessage = composeImageMarkupMessage(
      submittedInput,
      currentAttachments,
      queuedMessage.attachments
    )
    const queuedDisplayContent = queuedMessage.displayContent ?? queuedMessage.content
    const draftText = [queuedMessage.imageMarkupDraftText ?? queuedDisplayContent, submittedInput]
      .filter(Boolean)
      .join('\n\n')
    const combinedMessage: RuntimePaneQueuedMessage = {
      ...queuedMessage,
      content: [queuedMessage.content, markupMessage.content].filter(Boolean).join('\n\n'),
      displayContent: [queuedDisplayContent, markupMessage.content].filter(Boolean).join('\n\n'),
      attachments: [...(queuedMessage.attachments ?? []), ...currentAttachments],
      ...(queuedMessage.imageMarkupDraftText !== undefined ||
      hasImageMarkupComments(currentAttachments)
        ? { imageMarkupDraftText: draftText }
        : {}),
      notice: undefined,
    }
    setInput('')
    const submittedInputRevision = sessionOwner.live.inputRevision
    const submittedSharedInputRevision = getInputRevisionForScope(inputScopeKey)
    const submittedDraftEditVersion =
      sessionOwner.live.draftEditVersions.get(sessionOwner.frame.inputScopeKey) ?? 0
    resetAttachments()
    const sent = await interruptAndSendQueuedMessage(combinedMessage)
    if (sent) return
    if (
      sessionOwner.live.activeInputScope === inputScopeKey &&
      sessionOwner.live.inputRevision === submittedInputRevision &&
      getInputRevisionForScope(inputScopeKey) === submittedSharedInputRevision &&
      (sessionOwner.live.draftEditVersions.get(sessionOwner.frame.inputScopeKey) ?? 0) ===
        submittedDraftEditVersion
    ) {
      replaceInput(draftText)
    }
    queuedMessage.attachments?.forEach(addExistingAttachment)
    currentAttachments.forEach(addExistingAttachment)
    if (combinedMessage.codeComments && combinedMessage.codeComments.length > 0) {
      setCodeCommentContexts(combinedMessage.codeComments)
    }
  }

  const compactContext = async () => {
    const { compactRuntimePaneTask, currentRuntimeTask, lifecycleStore, paneStatus } =
      sessionOwner.frame
    const { send, setError } = sessionOwner.commands

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
  }

  const setCurrentGoal = async () => {
    const { setDefaultCollaborationMode, setGoalDraftActive } = sessionOwner.commands

    setDefaultCollaborationMode()
    setGoalDraftActive(true)
    return true
  }

  const cancelGoalDraft = () => {
    const { setGoalDraftActive } = sessionOwner.commands

    setGoalDraftActive(false)
  }

  const editCurrentGoal = () => {
    const { goal } = sessionOwner.frame
    const { replaceInput, setGoalDraftActive } = sessionOwner.commands

    if (!goal) return
    replaceInput(goal.objective)
    setGoalDraftActive(true)
  }

  const updateCurrentGoalStatus = async (status: RuntimeGoal['status']) => {
    const { currentRuntimeTask, goal, lifecycleStore, refreshWorkLists, setRuntimeGoal } =
      sessionOwner.frame
    const { setPendingGoalState } = sessionOwner.actions

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
  }

  const pauseCurrentGoal = () => {
    const { updateCurrentGoalStatus } = sessionOwner.commands
    return updateCurrentGoalStatus('paused')
  }

  const resumeCurrentGoal = async () => {
    const { currentRuntime, goal, paneStatus } = sessionOwner.frame
    const {
      getRuntimeModelFields,
      retainRuntimeQueuedMessage,
      sendRuntimeMessage,
      setError,
      updateCurrentGoalStatus,
    } = sessionOwner.commands

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
  }

  const pauseCurrentResponse = async () => {
    const {
      cancelRuntimePaneTask,
      currentRuntimeTask,
      goal,
      queueController,
      quotaWaitPending,
      taskGoalStatus,
    } = sessionOwner.frame
    const { updateCurrentGoalStatus } = sessionOwner.commands

    if (!currentRuntimeTask) return
    const goalPauseRequired =
      goal?.status === 'active' ||
      taskGoalStatus === 'active' ||
      (quotaWaitPending &&
        [goal?.status, taskGoalStatus].some(
          status => status === 'usageLimited' || status === 'blocked'
        ))
    logRuntimeQueueStage(currentRuntimeTask, 'queue-stop-requested', {
      source: 'composer',
      goalPauseRequired,
    })
    let accepted: boolean | null = null
    let queuePauseRequested = false
    let restoreQueue: (() => void) | undefined
    let interruptedTurn: ReturnType<typeof optimisticallyInterruptRuntimeConversation> = null
    let abortReason: 'goal-pause-rejected' | null = null
    try {
      if (goalPauseRequired) {
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
      interruptedTurn = optimisticallyInterruptRuntimeConversation(currentRuntimeTask)
      const cancelled =
        interruptedTurn?.turnId === null && interruptedTurn.clientUserMessageId
          ? await cancelRuntimePaneTask(currentRuntimeTask, {
              pendingClientUserMessageId: interruptedTurn.clientUserMessageId,
            })
          : await cancelRuntimePaneTask(currentRuntimeTask)
      accepted = cancelled
      if (!cancelled) return
    } finally {
      if (accepted !== true) {
        restoreQueue?.()
        if (interruptedTurn) {
          restoreOptimisticallyInterruptedRuntimeConversation(currentRuntimeTask, interruptedTurn)
        }
      } else if (interruptedTurn) {
        settleOptimisticallyInterruptedRuntimeConversation(currentRuntimeTask, interruptedTurn)
      }
      logRuntimeQueueStage(currentRuntimeTask, 'queue-stop-result', {
        source: 'composer',
        accepted,
        queuePauseRequested,
        abortReason,
      })
    }
  }

  const clearCurrentGoal = async () => {
    const { clearRuntimeGoal, currentRuntimeTask, goal, lifecycleStore, refreshWorkLists } =
      sessionOwner.frame
    const { setPendingGoalState } = sessionOwner.actions

    if (!goal) return false
    if (!currentRuntimeTask) {
      setPendingGoalState(null)
      return true
    }

    try {
      const response = await clearRuntimeGoal(currentRuntimeTask)
      if (!response.accepted) return false

      clearRuntimePaneGoalSeed(currentRuntimeTask, sessionOwner.ownerKey)
      setPendingGoalState(null)
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
  }

  const cancelGuidanceMessage = () => {
    return undefined
  }
  return {
    cancelQueuedMessage,
    forceStartQueuedMessage,
    resumeQueuedMessages,
    resumeQueuedMessagesWithInput,
    clearQueuedMessages,
    reorderQueuedMessages,
    editQueuedMessage,
    sendQueuedAsGuidance,
    interruptAndSendQueued,
    compactContext,
    setCurrentGoal,
    cancelGoalDraft,
    editCurrentGoal,
    updateCurrentGoalStatus,
    pauseCurrentGoal,
    resumeCurrentGoal,
    pauseCurrentResponse,
    clearCurrentGoal,
    cancelGuidanceMessage,
  }
}
export type PaneQueueGoalCommands = ReturnType<typeof createPaneQueueGoalCommands>
