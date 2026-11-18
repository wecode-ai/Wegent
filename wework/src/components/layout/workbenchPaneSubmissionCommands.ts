import { syncRuntimeGoal } from '@/features/workbench/runtimeTaskLifecycle/goalSynchronization'

import i18n from '@/i18n'

import { isRuntimeTaskBusyError } from '@/features/workbench/runtimePaneStatus'
import { runtimeTaskLifecycleTransitionChanged } from '@/features/workbench/runtimeTaskLifecycle'

import { getRuntimeTaskChatScopeKey } from '@/features/workbench/workbenchProviderHelpers'
import { persistAttachmentReferences } from '@/lib/attachments'

import { debugComposerEvent, textMetrics } from '@/components/chat/composer/composerDebug'
import { runtimeGoalCreateInput } from '@/lib/runtime-goal'
import { appendCodeCommentContexts } from '@/lib/code-comment-context'
import { appendConversationMentionContext } from '@/lib/conversation-mentions'

import type { RuntimeAdditionalContext, RuntimeTaskAddress } from '@/types/api'

import type { RuntimePaneQueuedMessage } from '@/types/workbench'

import { createRuntimeUserMessage } from '@/features/workbench/runtimeUserMessage'

import {
  runtimeTranscriptPaneKey,
  runtimeTranscriptPaneIdentityKey,
  isUnboundPendingGoalState,
  seedRuntimePaneGoal,
  clearRuntimePaneGoalSeed,
  runtimeAddressDebug,
  summarizeWorkbenchMessages,
  debugRuntimePaneMessageFlow,
  isRuntimeTaskAddress,
  createPendingRuntimeGoal,
} from './workbenchPaneSessionHelpers'
import type { RuntimePaneSendOptions } from './workbenchPaneSessionTypes'
import type { PaneCommandContext } from './workbenchPaneCommandContext'

export function createPaneSubmissionCommands(sessionOwner: PaneCommandContext) {
  const send: (
    inputOverride?: string,
    options?: RuntimePaneSendOptions
  ) => Promise<boolean> = async (inputOverride, options = {}) => {
    const {
      addExistingAttachment,
      attachmentState,
      codeCommentContexts,
      compactRuntimePaneTask,
      currentRuntimeTask,
      goalDraftActive,
      input,
      inputRevision,
      sharedInputRevision,
      getInputRevisionForScope,
      inputScopeKey,
      isTranscriptScopeCurrent,
      lifecycleStore,
      loadRuntimeTranscriptForPane,
      pendingGoalState,
      addExistingAttachmentForScope,
      queuedMessages,
      queuedMessageBusyBlocks,
      resetAttachments,
      sendCurrentInput,
      setRuntimeGoal,
    } = sessionOwner.frame
    const { setPendingGoalState, setDraftMessages } = sessionOwner.actions
    const {
      appendLocalUserMessage,
      clearCodeCommentsAfterCommit,
      getRuntimeModelFields,
      setGoalDraftActive,
      interruptAndSendQueuedMessage,
      readCurrentPaneBusy,
      retainRuntimeQueuedMessage,
      sendQueuedMessageAsGuidance,
      sendRuntimeMessage,
      setErrorForScope,
      setError,
      setInput,
      replaceInputForScope,
      setQueuedMessages,
    } = sessionOwner.commands

    const submittedInput = (inputOverride ?? input).trim()
    const submittedDraftEditVersion = options.draftEditVersion ?? sessionOwner.live.draftEditVersion
    // Capture the rendered revision, before asynchronous submission preparation.
    let submittedInputRevision = inputRevision
    let submittedSharedInputRevision = sharedInputRevision
    const ownsSubmittedInput = () =>
      getInputRevisionForScope(inputScopeKey) === submittedSharedInputRevision &&
      sessionOwner.live.inputRevision === submittedInputRevision &&
      sessionOwner.live.activeInputScope === inputScopeKey
    const clearSubmittedInput = () => {
      if (!sessionOwner.live.mounted || !ownsSubmittedInput()) return
      setInput('')
      submittedInputRevision = sessionOwner.live.inputRevision
      submittedSharedInputRevision = getInputRevisionForScope(inputScopeKey)
    }
    const restoreSubmittedInput = (scopeKey: string, value: string) => {
      if (
        ownsSubmittedInput() &&
        sessionOwner.live.draftEditVersion === submittedDraftEditVersion
      ) {
        replaceInputForScope(scopeKey, value)
      }
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
          seedRuntimePaneGoal(address, draftGoal, sessionOwner.ownerKey)
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
          clearRuntimePaneGoalSeed(seededGoalAddress, sessionOwner.ownerKey)
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
      if (!isTranscriptScopeCurrent()) return false
      console.warn('[Wework composer] failed to load referenced conversation', cause)
      setError(i18n.t('workbench.mention_conversation_load_failed'))
      return false
    }
    // Do not keep an earlier action error visible once the user sends a new message.
    setError(null)
    const visibleSubmittedInput =
      effectiveSubmittedInput || (hasCodeComments ? i18n.t('workbench.code_comment_fallback') : '')
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
              seedRuntimePaneGoal(address, pendingGoalState.goal, sessionOwner.ownerKey)
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
  }
  return { send }
}
export type PaneSubmissionCommands = ReturnType<typeof createPaneSubmissionCommands>
