import { syncRuntimeGoal } from '@/features/workbench/runtimeTaskLifecycle/goalSynchronization'
import { includeDraftAttachmentGroup } from '@wegent/collaboration/composer'

import i18n from '@/i18n'

import { isRuntimeTaskBusyError } from '@/features/workbench/runtimePaneStatus'
import { runtimeTaskLifecycleTransitionChanged } from '@/features/workbench/runtimeTaskLifecycle'

import { getRuntimeTaskChatScopeKey } from '@/features/workbench/workbenchProviderHelpers'
import { persistAttachmentReferences } from '@/lib/attachments'

import { debugComposerEvent, textMetrics } from '@/components/chat/composer/composerDebug'
import {
  composeImageMarkupMessage,
  hasImageMarkupComments,
} from '@/components/chat/image-preview/imageEdit'
import { runtimeGoalCreateInput } from '@/lib/runtime-goal'
import { appendCodeCommentContexts } from '@/lib/code-comment-context'
import { appendConversationMentionContext } from '@/lib/conversation-mentions'

import type { RuntimeTaskAddress } from '@/types/api'

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
      attachmentState,
      codeCommentContexts: draftCodeComments,
      compactRuntimePaneTask,
      currentRuntimeTask,
      goalDraftActive,
      input,
      inputRevision,
      sharedInputRevision,
      getInputRevisionForScope,
      inputScopeKey,
      lifecycleStore,
      pendingGoalState,
      addExistingAttachmentForScope,
      queuedMessageBusyBlocks,
      resetAttachments: resetDraftAttachments,
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

    const { attachments: draftAttachments, captureAttachments, removeAttachment } = attachmentState
    const { getDraftEditVersion } = sessionOwner.commands

    const standalone = options.standaloneAttachments !== undefined
    const codeCommentContexts = standalone ? [] : draftCodeComments
    const resetAttachments = () => {
      if (!standalone) resetDraftAttachments()
    }
    const submittedAttachmentSourceId = standalone ? options.draftAttachmentSourceId : undefined
    const cleanupSubmittedAttachmentSource = () => {
      if (submittedAttachmentSourceId === undefined) return
      void removeAttachment(submittedAttachmentSourceId).catch(() => {})
    }
    const restoreAttachments = (
      scope: string,
      attachments: ReturnType<typeof captureAttachments>
    ) => {
      if (standalone) return
      attachments.forEach(attachment => addExistingAttachmentForScope(scope, attachment))
    }
    const submittedInput = (inputOverride ?? input).trim()
    const submittedDraftEditVersion = options.draftEditVersion ?? getDraftEditVersion()
    const restoreRevisions = new Map([
      [
        inputScopeKey,
        {
          shared: sharedInputRevision,
          edits: submittedDraftEditVersion,
        },
      ],
    ])
    // Capture the rendered revision, before asynchronous submission preparation.
    let submittedInputRevision = inputRevision
    let submittedSharedInputRevision = sharedInputRevision
    const ownsSubmittedInput = () =>
      getInputRevisionForScope(inputScopeKey) === submittedSharedInputRevision &&
      sessionOwner.live.inputRevision === submittedInputRevision &&
      sessionOwner.live.activeInputScope === inputScopeKey
    const clearSubmittedInput = () => {
      if (standalone || !sessionOwner.live.mounted || !ownsSubmittedInput()) return
      setInput('')
      submittedInputRevision = sessionOwner.live.inputRevision
      submittedSharedInputRevision = getInputRevisionForScope(inputScopeKey)
      restoreRevisions.set(inputScopeKey, {
        shared: submittedSharedInputRevision,
        edits: submittedDraftEditVersion,
      })
    }
    const restoreSubmittedInput = (scopeKey: string, value: string) => {
      if (standalone) return
      const revision = restoreRevisions.get(scopeKey)
      if (
        revision &&
        getInputRevisionForScope(scopeKey) === revision.shared &&
        (sessionOwner.live.draftEditVersions.get(scopeKey) ?? 0) === revision.edits
      ) {
        replaceInputForScope(scopeKey, value)
      }
    }
    const currentAttachments = options.standaloneAttachments
      ? includeDraftAttachmentGroup({
          submittedAttachments: options.standaloneAttachments,
          draftAttachments,
          sourceAttachmentId: submittedAttachmentSourceId,
        })
      : captureAttachments()
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

    if (goalDraftActive && !standalone) {
      if (!submittedInput) {
        setError(i18n.t('workbench.goal_objective_required'))
        return false
      }
      if (hasCodeComments) {
        setError(i18n.t('workbench.runtime_task_code_comments_not_supported'))
        return false
      }

      const goalMessage = composeImageMarkupMessage(submittedInput, currentAttachments)
      const goalContext = appendConversationMentionContext(
        submittedInput,
        options.additionalContext
      )
      // Errors belong to the previous action; a new goal submission starts fresh.
      setError(null)
      if (currentRuntimeTask) {
        const draftGoal = createPendingRuntimeGoal(submittedInput)
        const initialGoal = runtimeGoalCreateInput(draftGoal)
        const baseMessage: RuntimePaneQueuedMessage = {
          id: `queued-runtime-pane-${crypto.randomUUID()}`,
          content: goalMessage.content,
          status: 'queued',
          createdAt: new Date().toISOString(),
          attachments: persistAttachmentReferences(currentAttachments),
          ...(hasImageMarkupComments(currentAttachments)
            ? { imageMarkupDraftText: submittedInput }
            : {}),
          runtimeGoalRequest: true,
          additionalContext: goalContext,
          cloudProjectId: options.cloudProjectId,
          origin: options.origin,
          ...getRuntimeModelFields(),
        }

        resetAttachments()
        clearSubmittedInput()
        if (paneIsBusy && options.guideWhenBusy) {
          setQueuedMessages(messages => [...messages, { ...baseMessage, status: 'sending' }])
          const response = await setRuntimeGoal({
            address: currentRuntimeTask,
            objective: submittedInput,
            status: 'active',
          }).catch((cause: unknown) => ({
            accepted: false,
            error: cause instanceof Error ? cause.message : String(cause),
            goal: null,
          }))
          setQueuedMessages(messages => messages.filter(message => message.id !== baseMessage.id))
          if (!response.accepted) {
            restoreSubmittedInput(inputScopeKey, submittedInput)
            currentAttachments.forEach(attachment =>
              addExistingAttachmentForScope(inputScopeKey, attachment)
            )
            setError(response.error || i18n.t('workbench.goal_set_failed'))
            return false
          }
          syncRuntimeGoal(lifecycleStore, currentRuntimeTask, response.goal)
          setGoalDraftActive(false)
          setQueuedMessages(messages => [...messages, baseMessage])
          await sendQueuedMessageAsGuidance(baseMessage, true)
          cleanupSubmittedAttachmentSource()
          return true
        }

        const queuedMessage: RuntimePaneQueuedMessage = {
          ...baseMessage,
          initialGoal,
        }
        if (paneIsBusy) {
          syncRuntimeGoal(lifecycleStore, currentRuntimeTask, draftGoal)
          setGoalDraftActive(false)
          setQueuedMessages(messages => [...messages, queuedMessage])
          cleanupSubmittedAttachmentSource()
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
          syncRuntimeGoal(lifecycleStore, currentRuntimeTask, draftGoal)
          setGoalDraftActive(false)
          clearCodeCommentsAfterCommit('send_success', codeCommentContexts)
          cleanupSubmittedAttachmentSource()
        } else {
          restoreSubmittedInput(inputScopeKey, submittedInput)
          currentAttachments.forEach(attachment =>
            addExistingAttachmentForScope(inputScopeKey, attachment)
          )
          setErrorForScope(inputScopeKey, sendError ?? i18n.t('workbench.project_chat_send_failed'))
        }
        return result.accepted
      }

      const draftGoal = createPendingRuntimeGoal(submittedInput)
      const initialGoal = runtimeGoalCreateInput(draftGoal)
      clearSubmittedInput()
      setPendingGoalState({ goal: draftGoal, targetKey: null, targetIdentityKey: null })
      setGoalDraftActive(false)
      const optimisticMessage = createRuntimeUserMessage(
        goalMessage.content,
        goalMessage.attachments,
        {
          runtimeGoalRequest: true,
        }
      )
      let seededGoalAddress: RuntimeTaskAddress | null = null
      let errorScopeKey = inputScopeKey
      const sent = await sendCurrentInput(goalMessage.content, {
        attachments: goalMessage.attachments,
        optimisticUserMessage: optimisticMessage,
        initialGoal,
        additionalContext: goalContext,
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
        cleanupSubmittedAttachmentSource()
        clearSubmittedInput()
        if (!isRuntimeTaskAddress(sent)) {
          appendLocalUserMessage(goalMessage.content, goalMessage.attachments, {
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
      !standalone &&
      !currentRuntimeTask &&
      pendingGoalState &&
      isUnboundPendingGoalState(pendingGoalState)
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

    const resolvedAdditionalContext = appendConversationMentionContext(
      effectiveSubmittedInput,
      options.additionalContext
    )
    // Do not keep an earlier action error visible once the user sends a new message.
    setError(null)
    const visibleSubmittedInput =
      effectiveSubmittedInput || (hasCodeComments ? i18n.t('workbench.code_comment_fallback') : '')
    const { content: messageInput, attachments: messageAttachments } = composeImageMarkupMessage(
      visibleSubmittedInput,
      currentAttachments
    )
    if (!currentRuntimeTask) {
      clearSubmittedInput()
      resetAttachments()
      let errorScopeKey = inputScopeKey
      let submissionScopeKey = inputScopeKey
      const optimisticMessage = createRuntimeUserMessage(messageInput, messageAttachments, {
        runtimeGoalRequest: Boolean(pendingInitialGoal),
        codeComments: codeCommentContexts,
      })
      let sent: boolean | RuntimeTaskAddress
      try {
        sent = await sendCurrentInput(messageInput, {
          attachments: messageAttachments,
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
            restoreRevisions.set(submissionScopeKey, {
              shared: getInputRevisionForScope(submissionScopeKey),
              edits: sessionOwner.live.draftEditVersions.get(submissionScopeKey) ?? 0,
            })
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
        restoreAttachments(submissionScopeKey, currentAttachments)
        throw error
      }
      if (sent) {
        if (!isRuntimeTaskAddress(sent)) {
          appendLocalUserMessage(messageInput, messageAttachments, {
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
        cleanupSubmittedAttachmentSource()
      } else {
        restoreSubmittedInput(submissionScopeKey, visibleSubmittedInput)
        restoreAttachments(submissionScopeKey, currentAttachments)
      }
      return Boolean(sent)
    }

    const queuedMessage: RuntimePaneQueuedMessage = {
      id: `queued-runtime-pane-${crypto.randomUUID()}`,
      content: hasCodeComments
        ? appendCodeCommentContexts(messageInput, codeCommentContexts)
        : messageInput,
      ...(hasCodeComments
        ? { displayContent: messageInput, codeComments: codeCommentContexts }
        : {}),
      status: 'queued',
      createdAt: new Date().toISOString(),
      attachments: persistAttachmentReferences(currentAttachments),
      ...(hasImageMarkupComments(currentAttachments)
        ? { imageMarkupDraftText: visibleSubmittedInput }
        : {}),
      additionalContext: resolvedAdditionalContext,
      cloudProjectId: options.cloudProjectId,
      origin: options.origin,
      ...getRuntimeModelFields(),
    }

    resetAttachments()
    clearSubmittedInput()
    if (paneIsBusy) {
      if (options.interruptWhenBusy) {
        const sent = await interruptAndSendQueuedMessage(queuedMessage)
        if (!sent) {
          restoreSubmittedInput(inputScopeKey, submittedInput)
          restoreAttachments(inputScopeKey, currentAttachments)
        } else {
          clearCodeCommentsAfterCommit('send_success', codeCommentContexts)
          cleanupSubmittedAttachmentSource()
        }
        return sent
      }
      setQueuedMessages(messages => [...messages, queuedMessage])
      clearCodeCommentsAfterCommit('send_success', codeCommentContexts)
      cleanupSubmittedAttachmentSource()
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
      clearCodeCommentsAfterCommit('send_success', codeCommentContexts)
      cleanupSubmittedAttachmentSource()
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
      clearCodeCommentsAfterCommit('send_success', codeCommentContexts)
      cleanupSubmittedAttachmentSource()
    } else {
      restoreSubmittedInput(inputScopeKey, submittedInput)
      restoreAttachments(inputScopeKey, currentAttachments)
      setErrorForScope(inputScopeKey, sendError ?? i18n.t('workbench.project_chat_send_failed'))
    }
    return result.accepted || isRuntimeTaskBusyError(sendError)
  }

  return { send }
}
export type PaneSubmissionCommands = ReturnType<typeof createPaneSubmissionCommands>
