import { reduceWorkbenchMessages } from '@wegent/chat-core'

import { type SetStateAction } from 'react'

import type { RuntimePaneMessageAction } from '@/features/workbench/runtimePaneMessages'

import type { RuntimePaneQueuedMessage, WorkbenchMessage } from '@/types/workbench'
import type { CodeCommentContext } from '@/types/workspace-files'
import type { BrowserAnnotationCommand, BrowserAnnotationScope } from '@/types/browser-annotation'

import {
  hasBrowserAnnotationScope,
  isBrowserAnnotationContext,
} from '@/lib/browser-annotation-context'
import {
  applyRuntimeConversationAction,
  cacheRuntimeConversationQueuedMessagesByKey,
  cacheRuntimeConversationQueuePausedByKey,
  getRuntimeConversationQueuedMessagesByKey,
  getRuntimeConversationQueuePausedByKey,
} from '@/features/workbench/runtimeConversationCache'

import type { PaneCommandContext } from './workbenchPaneCommandContext'

export function createPaneCoreCommands(sessionOwner: PaneCommandContext) {
  const setQueuedMessages = (update: SetStateAction<RuntimePaneQueuedMessage[]>) => {
    const { queuedMessageScopeKey } = sessionOwner.frame

    if (!queuedMessageScopeKey) return
    const previous = getRuntimeConversationQueuedMessagesByKey(queuedMessageScopeKey)
    const next = typeof update === 'function' ? update(previous) : update
    if (next === previous) return
    cacheRuntimeConversationQueuedMessagesByKey(queuedMessageScopeKey, next)
  }

  const setQueuedMessagesPaused = (update: SetStateAction<boolean>) => {
    const { queuedMessageScopeKey } = sessionOwner.frame

    if (!queuedMessageScopeKey) return
    const previous = getRuntimeConversationQueuePausedByKey(queuedMessageScopeKey)
    const next = typeof update === 'function' ? update(previous) : update
    if (next === previous) return
    cacheRuntimeConversationQueuePausedByKey(queuedMessageScopeKey, next)
  }

  const scopedSetInput = (value: string) => {
    const { inputScopeKey, setInputForScope } = sessionOwner.frame
    sessionOwner.live.inputRevision += 1
    setInputForScope(inputScopeKey, value)
    return { appliedSynchronously: true } as const
  }

  const replaceInputForScope = (scopeKey: string, value: string) => {
    sessionOwner.frame.projectChat.replaceInputForScope(scopeKey, value)
  }

  const replaceInput = (value: string) => {
    const { inputScopeKey } = sessionOwner.frame
    const { replaceInputForScope } = sessionOwner.commands
    return replaceInputForScope(inputScopeKey, value)
  }

  const getDraftEditVersion = () => {
    return sessionOwner.live.draftEditVersions.get(sessionOwner.frame.inputScopeKey) ?? 0
  }

  const setErrorForScope = (scopeKey: string, nextError: string | null) => {
    const { projectChat } = sessionOwner.frame
    const { setLocalError } = sessionOwner.actions

    if (projectChat.setComposerErrorForScope) {
      projectChat.setComposerErrorForScope(scopeKey, nextError)
      return
    }
    if (projectChat.setComposerError) {
      projectChat.setComposerError(nextError)
      return
    }
    setLocalError(nextError)
  }

  const setError = (nextError: string | null) => {
    const { inputScopeKey } = sessionOwner.frame
    const { setErrorForScope } = sessionOwner.commands
    return setErrorForScope(inputScopeKey, nextError)
  }

  const clearError = () => {
    const { setError } = sessionOwner.commands
    return setError(null)
  }

  const onDraftEdit = () => {
    const { inputScopeKey } = sessionOwner.frame
    const { clearError } = sessionOwner.commands

    if (sessionOwner.live.activeInputScope !== inputScopeKey) return
    sessionOwner.live.draftEditVersions.set(
      inputScopeKey,
      (sessionOwner.live.draftEditVersions.get(inputScopeKey) ?? 0) + 1
    )
    clearError()
  }

  const clearCodeCommentsAfterCommit = (
    reason: BrowserAnnotationCommand['reason'],
    contexts: CodeCommentContext[]
  ) => {
    const { setCodeCommentContexts, setBrowserAnnotationCommand } = sessionOwner.actions

    // Native cleanup clears the entire page; retain an edited annotation batch.
    const submittedAnnotations = contexts.filter(isBrowserAnnotationContext)
    const currentAnnotations = sessionOwner.live.codeCommentContexts.filter(
      isBrowserAnnotationContext
    )
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

    sessionOwner.live.browserAnnotationCommandSequence += 1
    setBrowserAnnotationCommand({
      sequence: sessionOwner.live.browserAnnotationCommandSequence,
      type: 'clear_all_and_exit',
      reason,
    })
  }

  const setGoalDraftActive = (active: boolean) => {
    const { inputScopeKey, setGoalDraftActiveForScope } = sessionOwner.frame
    return setGoalDraftActiveForScope(inputScopeKey, active)
  }

  const dispatchMessages = (action: RuntimePaneMessageAction) => {
    const { setDraftMessages } = sessionOwner.actions

    const address =
      sessionOwner.live.runtimeTaskLoadTarget?.address ?? sessionOwner.live.currentRuntimeTask
    if (address) {
      applyRuntimeConversationAction(address, action)
    } else {
      setDraftMessages(current => reduceWorkbenchMessages(current, action) as WorkbenchMessage[])
    }
  }

  const readCurrentPaneBusy = () => {
    const { currentRuntimeTask, lifecycleStore, paneStatus } = sessionOwner.frame
    return currentRuntimeTask
      ? (lifecycleStore.getTask(currentRuntimeTask)?.derived.isBusy ?? paneStatus.isBusy)
      : paneStatus.isBusy
  }

  const addCodeComment = (context: CodeCommentContext) => {
    const { setCodeCommentContexts } = sessionOwner.actions

    setCodeCommentContexts(current => [...current.filter(item => item.id !== context.id), context])
  }

  const replaceBrowserCodeComments = (
    scope: BrowserAnnotationScope,
    contexts: CodeCommentContext[]
  ) => {
    const { setCodeCommentContexts } = sessionOwner.actions

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
  }

  const removeBrowserCodeComments = (scope: BrowserAnnotationScope) => {
    const { setCodeCommentContexts } = sessionOwner.actions

    setCodeCommentContexts(current =>
      current.filter(context => !hasBrowserAnnotationScope(context, scope))
    )
  }

  const clearCodeComments = () => {
    const { codeCommentContexts } = sessionOwner.frame
    const { clearCodeCommentsAfterCommit } = sessionOwner.commands

    clearCodeCommentsAfterCommit('composer_clear', codeCommentContexts)
  }
  return {
    setQueuedMessages,
    setQueuedMessagesPaused,
    scopedSetInput,
    replaceInputForScope,
    replaceInput,
    getDraftEditVersion,
    setErrorForScope,
    setError,
    clearError,
    onDraftEdit,
    clearCodeCommentsAfterCommit,
    setGoalDraftActive,
    dispatchMessages,
    readCurrentPaneBusy,
    addCodeComment,
    replaceBrowserCodeComments,
    removeBrowserCodeComments,
    clearCodeComments,
    setInput: scopedSetInput,
  }
}
export type PaneCoreCommands = ReturnType<typeof createPaneCoreCommands>
