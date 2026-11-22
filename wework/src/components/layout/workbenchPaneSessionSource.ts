import { createWorkbenchDeviceReconnect } from '@/features/workbench/workbenchDeviceReconnect'
import {
  subscribeWorkbenchWindowActivity,
  type WorkbenchWindowActivity,
} from '@/desktop/workbenchWindowActivity'
import { createPaneSessionDiagnostics } from './workbenchPaneSessionDiagnostics'
import type { SetStateAction } from 'react'
import type { RuntimeTranscriptLoader } from '@/types/workbench'
import { getRuntimeTaskChatScopeKey } from '@/features/workbench/workbenchProviderHelpers'
import {
  getRuntimeConversationMessages,
  isRuntimeConversationArchived,
  subscribeRuntimeConversation,
} from '@/features/workbench/runtimeConversationCache'
import {
  abortableRuntimeRead,
  cancelledRuntimeRead,
} from '@/features/workbench/runtimeConversationReadCancellation'
import {
  createPaneSessionState,
  type PaneSessionState,
  type PaneSessionStateActions,
} from './workbenchPaneSessionState'
import { createPaneSessionFrame, type PaneSessionExternal } from './workbenchPaneSessionFrame'
import { createPaneSessionView } from './workbenchPaneSessionView'
import type {
  PaneCommandContext,
  PaneCommands,
  PaneTransactionState,
} from './workbenchPaneCommandContext'
import { createPaneCoreCommands } from './workbenchPaneCoreCommands'
import { createPaneTranscriptCommands } from './workbenchPaneTranscriptCommands'
import { createPaneMessagesCommands } from './workbenchPaneMessagesCommands'
import { createPaneSubmissionCommands } from './workbenchPaneSubmissionCommands'
import { createPaneQueueGoalCommands } from './workbenchPaneQueueGoalCommands'
import { createRuntimeConversationSearchSource } from './runtimeConversationSearchSource'
import { hydrateRuntimePaneGoal, hydrateRuntimePaneTranscript } from './workbenchPaneHydration'
import {
  clearRuntimePaneGoalSeed,
  isPendingGoalVisibleForRuntimeTarget,
  runtimeTaskLoadTargetFromAddress,
  runtimeTaskLoadAddressKey,
} from './workbenchPaneSessionHelpers'

/** One pane owns query cancellation, local drafts and the shared conversation subscriptions. */
export function createWorkbenchPaneSessionSource(initial: PaneSessionExternal) {
  const reconnect = createWorkbenchDeviceReconnect()
  let external = initial
  let accountId = initial.workbench.state.user?.id
  let state = createPaneSessionState(initial.currentRuntimeTask)
  const lifecycleStore = initial.lifecycleStore
  const ownerKey = JSON.stringify([lifecycleStore.notificationScope, accountId ?? null])
  const listeners = new Set<() => void>()
  let readerController = new AbortController()
  let goalReaderController = new AbortController()
  let goalReadScope: readonly unknown[] | undefined
  let readScope: readonly unknown[] | undefined
  let queryRevision = 0
  let started = false
  let externalSignature: readonly unknown[] | undefined
  let queueKey: string | null = null
  let queueSend: PaneSessionExternal['workbench']['sendRuntimePaneMessage'] | undefined
  let releaseQueue: (() => void) | undefined
  let conversationKey: string | null | undefined
  let unsubscribeConversation: (() => void) | undefined
  let unsubscribeLifecycle: (() => void) | undefined
  let unsubscribeSearch: (() => void) | undefined
  let stopWindowActivity: (() => void) | undefined
  let windowActivity: WorkbenchWindowActivity = 'foreground'
  let pendingStreamPresentation = false
  let conversationFrame: number | undefined
  let conversationTimer: ReturnType<typeof setTimeout> | undefined
  const cancelConversationPublication = () => {
    if (conversationFrame !== undefined) cancelAnimationFrame(conversationFrame)
    if (conversationTimer !== undefined) clearTimeout(conversationTimer)
    conversationFrame = undefined
    conversationTimer = undefined
  }
  const flushConversation = () => {
    cancelConversationPublication()
    pendingStreamPresentation = false
    if (isActive()) publish()
  }
  const presentStreamingProgress = () => {
    pendingStreamPresentation = true
    if (windowActivity === 'foreground') flushConversation()
    else if (windowActivity === 'background' && conversationTimer === undefined)
      conversationTimer = setTimeout(flushConversation, 500)
  }
  const publishConversation = () => {
    if (conversationFrame !== undefined || conversationTimer !== undefined) return
    if (typeof requestAnimationFrame === 'function')
      conversationFrame = requestAnimationFrame(flushConversation)
    else conversationTimer = setTimeout(flushConversation, 16)
  }
  let publishing = false
  let publishAgain = false
  let reconciling = false

  const isActive = () => listeners.size > 0
  const currentInputScope = () =>
    external.currentRuntimeTask
      ? getRuntimeTaskChatScopeKey(external.currentRuntimeTask)
      : external.workbench.projectChat.scopeKey
  const target = () => {
    const current = external.currentRuntimeTask
      ? runtimeTaskLoadTargetFromAddress(external.currentRuntimeTask)
      : null
    const retained = state.retainedRuntimeTaskLoadTarget
    const candidate = current ?? retained
    return candidate && !isRuntimeConversationArchived(candidate.address) ? candidate : null
  }
  const readPort = () => {
    const controller = readerController
    const read = external.workbench.loadRuntimeTranscriptForPane
    const isCurrent = () =>
      isActive() && readerController === controller && !controller.signal.aborted
    const readTranscript: RuntimeTranscriptLoader = (address, options = {}) => {
      if (!isCurrent()) return Promise.reject(cancelledRuntimeRead())
      const signal = options.signal
        ? AbortSignal.any([controller.signal, options.signal])
        : controller.signal
      if (signal.aborted) return Promise.reject(cancelledRuntimeRead())
      return abortableRuntimeRead(read(address, { ...options, signal }), signal)
    }
    return { read: readTranscript, isCurrent }
  }
  const frame = () => createPaneSessionFrame(external, state, readPort())
  const diagnostics = createPaneSessionDiagnostics({ readFrame: frame, isActive })
  const live: PaneTransactionState = {
    browserAnnotationCommandSequence: 0,
    draftEditVersions: initial.draftEditVersions,
    loadedRuntimeTranscriptKey: null as string | null,
    displayedTranscriptIdentity: null as string | null,
    interruptAndSendInFlight: false,
    continuationInFlight: false,

    get codeCommentContexts() {
      return state.codeCommentContexts
    },
    get mounted() {
      return isActive()
    },
    get inputRevision() {
      return state.inputRevision
    },
    get activeInputScope() {
      return currentInputScope()
    },
    get refreshWorkLists() {
      return external.workbench.refreshWorkLists
    },
    get currentRuntimeTask() {
      return external.currentRuntimeTask
    },
    get runtimeTaskLoadTarget() {
      return target()
    },
    get loadedTranscriptRanges() {
      return state.loadedTranscriptRanges
    },
    get messages() {
      const current = target()
      return current ? getRuntimeConversationMessages(current.address) : state.draftMessages
    },
  }
  const actions = Object.fromEntries(
    (Object.keys(state) as (keyof PaneSessionState)[]).map(key => [
      `set${key[0].toUpperCase()}${key.slice(1)}`,
      (value: SetStateAction<PaneSessionState[typeof key]>) => {
        const next = typeof value === 'function' ? value(state[key] as never) : value
        if (Object.is(next, state[key])) return
        state = { ...state, [key]: next }
        publish()
        if (key === 'transcriptReloadVersion') reconcile()
      },
    ])
  ) as PaneSessionStateActions
  const bind = (): PaneCommandContext => {
    const context: PaneCommandContext = {
      ownerKey,
      frame: frame(),
      actions,
      live,
      get commands() {
        return commands
      },
    }
    const commands = {
      ...createPaneCoreCommands(context),
      ...createPaneTranscriptCommands(context),
      ...createPaneMessagesCommands(context),
      ...createPaneSubmissionCommands(context),
      ...createPaneQueueGoalCommands(context),
    }
    return context
  }
  const searchOptions = () => ({
    target: target(),
    getTarget: () => (isActive() ? target() : null),
    searchTranscript: external.workbench.searchRuntimeTranscriptForPane,
    loadTranscript: readPort().read,
    reloadRevision: queryRevision,
  })
  const search = createRuntimeConversationSearchSource(searchOptions())
  const attachmentCommands: Pick<
    PaneSessionExternal['attachmentState'],
    'handleFileSelect' | 'removeAttachment' | 'dismissAttachmentError'
  > = {
    handleFileSelect: files => external.attachmentState.handleFileSelect(files),
    removeAttachment: id => external.attachmentState.removeAttachment(id),
    dismissAttachmentError: filename => external.attachmentState.dismissAttachmentError(filename),
  }

  const commands: PaneCommands = {
    setQueuedMessages: (...args: Parameters<PaneCommands['setQueuedMessages']>) => {
      return bind().commands.setQueuedMessages(...args)
    },
    setQueuedMessagesPaused: (...args: Parameters<PaneCommands['setQueuedMessagesPaused']>) => {
      return bind().commands.setQueuedMessagesPaused(...args)
    },
    scopedSetInput: (...args: Parameters<PaneCommands['scopedSetInput']>) => {
      return bind().commands.scopedSetInput(...args)
    },
    replaceInputForScope: (...args: Parameters<PaneCommands['replaceInputForScope']>) => {
      return bind().commands.replaceInputForScope(...args)
    },
    replaceInput: (...args: Parameters<PaneCommands['replaceInput']>) => {
      return bind().commands.replaceInput(...args)
    },
    getDraftEditVersion: (...args: Parameters<PaneCommands['getDraftEditVersion']>) => {
      return bind().commands.getDraftEditVersion(...args)
    },
    setErrorForScope: (...args: Parameters<PaneCommands['setErrorForScope']>) => {
      return bind().commands.setErrorForScope(...args)
    },
    setError: (...args: Parameters<PaneCommands['setError']>) => {
      return bind().commands.setError(...args)
    },
    clearError: (...args: Parameters<PaneCommands['clearError']>) => {
      return bind().commands.clearError(...args)
    },
    onDraftEdit: (...args: Parameters<PaneCommands['onDraftEdit']>) => {
      return bind().commands.onDraftEdit(...args)
    },
    clearCodeCommentsAfterCommit: (
      ...args: Parameters<PaneCommands['clearCodeCommentsAfterCommit']>
    ) => {
      return bind().commands.clearCodeCommentsAfterCommit(...args)
    },
    setGoalDraftActive: (...args: Parameters<PaneCommands['setGoalDraftActive']>) => {
      return bind().commands.setGoalDraftActive(...args)
    },
    dispatchMessages: (...args: Parameters<PaneCommands['dispatchMessages']>) => {
      return bind().commands.dispatchMessages(...args)
    },
    readCurrentPaneBusy: (...args: Parameters<PaneCommands['readCurrentPaneBusy']>) => {
      return bind().commands.readCurrentPaneBusy(...args)
    },
    reloadRuntimeTranscript: (...args: Parameters<PaneCommands['reloadRuntimeTranscript']>) => {
      return bind().commands.reloadRuntimeTranscript(...args)
    },
    loadMoreTranscriptBefore: (...args: Parameters<PaneCommands['loadMoreTranscriptBefore']>) => {
      if (!isActive()) return Promise.resolve(undefined)
      return bind().commands.loadMoreTranscriptBefore(...args)
    },
    loadTranscriptTurnNavigationItem: (
      ...args: Parameters<PaneCommands['loadTranscriptTurnNavigationItem']>
    ) => {
      if (!isActive()) return Promise.resolve(undefined)
      return bind().commands.loadTranscriptTurnNavigationItem(...args)
    },
    loadTranscriptGap: (...args: Parameters<PaneCommands['loadTranscriptGap']>) => {
      if (!isActive()) return Promise.resolve(undefined)
      return bind().commands.loadTranscriptGap(...args)
    },
    getRuntimeModelFields: (...args: Parameters<PaneCommands['getRuntimeModelFields']>) => {
      return bind().commands.getRuntimeModelFields(...args)
    },
    appendLocalUserMessage: (...args: Parameters<PaneCommands['appendLocalUserMessage']>) => {
      return bind().commands.appendLocalUserMessage(...args)
    },
    applyLocalRequestUserInputResponses: (
      ...args: Parameters<PaneCommands['applyLocalRequestUserInputResponses']>
    ) => {
      return bind().commands.applyLocalRequestUserInputResponses(...args)
    },
    sendRuntimeMessage: (...args: Parameters<PaneCommands['sendRuntimeMessage']>) => {
      if (!isActive()) return Promise.resolve({ accepted: false, queued: false })
      return bind().commands.sendRuntimeMessage(...args)
    },
    retainRuntimeQueuedMessage: (
      ...args: Parameters<PaneCommands['retainRuntimeQueuedMessage']>
    ) => {
      return bind().commands.retainRuntimeQueuedMessage(...args)
    },
    interruptAndSendQueuedMessage: (
      ...args: Parameters<PaneCommands['interruptAndSendQueuedMessage']>
    ) => {
      if (!isActive()) return Promise.resolve(false)
      return bind().commands.interruptAndSendQueuedMessage(...args)
    },
    dispatchContinuation: (...args: Parameters<PaneCommands['dispatchContinuation']>) => {
      if (!isActive()) return Promise.resolve(false)
      return bind().commands.dispatchContinuation(...args)
    },
    sendContinuation: (...args: Parameters<PaneCommands['sendContinuation']>) => {
      if (!isActive()) return Promise.resolve(false)
      return bind().commands.sendContinuation(...args)
    },
    retryFailedMessageInPane: (...args: Parameters<PaneCommands['retryFailedMessageInPane']>) => {
      if (!isActive()) return Promise.resolve(false)
      return bind().commands.retryFailedMessageInPane(...args)
    },
    editLastUserMessageInPane: (...args: Parameters<PaneCommands['editLastUserMessageInPane']>) => {
      if (!isActive()) return Promise.resolve(false)
      return bind().commands.editLastUserMessageInPane(...args)
    },
    ignoreRequestUserInput: (...args: Parameters<PaneCommands['ignoreRequestUserInput']>) => {
      if (!isActive()) return Promise.resolve(undefined)
      return bind().commands.ignoreRequestUserInput(...args)
    },
    sendQueuedMessage: (...args: Parameters<PaneCommands['sendQueuedMessage']>) => {
      if (!isActive()) return Promise.resolve(undefined)
      return bind().commands.sendQueuedMessage(...args)
    },
    sendQueuedMessageAsGuidance: (
      ...args: Parameters<PaneCommands['sendQueuedMessageAsGuidance']>
    ) => {
      if (!isActive()) return Promise.resolve(false)
      return bind().commands.sendQueuedMessageAsGuidance(...args)
    },
    setDefaultCollaborationMode: (
      ...args: Parameters<PaneCommands['setDefaultCollaborationMode']>
    ) => {
      return bind().commands.setDefaultCollaborationMode(...args)
    },
    sendRequestUserInputResponse: (
      ...args: Parameters<PaneCommands['sendRequestUserInputResponse']>
    ) => {
      if (!isActive()) return Promise.resolve(false)
      return bind().commands.sendRequestUserInputResponse(...args)
    },
    send: (...args: Parameters<PaneCommands['send']>) => {
      if (!isActive()) return Promise.resolve(false)
      return bind().commands.send(...args)
    },
    addCodeComment: (...args: Parameters<PaneCommands['addCodeComment']>) => {
      return bind().commands.addCodeComment(...args)
    },
    replaceBrowserCodeComments: (
      ...args: Parameters<PaneCommands['replaceBrowserCodeComments']>
    ) => {
      return bind().commands.replaceBrowserCodeComments(...args)
    },
    removeBrowserCodeComments: (...args: Parameters<PaneCommands['removeBrowserCodeComments']>) => {
      return bind().commands.removeBrowserCodeComments(...args)
    },
    clearCodeComments: (...args: Parameters<PaneCommands['clearCodeComments']>) => {
      return bind().commands.clearCodeComments(...args)
    },
    cancelQueuedMessage: (...args: Parameters<PaneCommands['cancelQueuedMessage']>) => {
      if (!isActive()) return Promise.resolve(undefined)
      return bind().commands.cancelQueuedMessage(...args)
    },
    forceStartQueuedMessage: (...args: Parameters<PaneCommands['forceStartQueuedMessage']>) => {
      if (!isActive()) return Promise.resolve(undefined)
      return bind().commands.forceStartQueuedMessage(...args)
    },
    resumeQueuedMessages: (...args: Parameters<PaneCommands['resumeQueuedMessages']>) => {
      if (!isActive()) return
      return bind().commands.resumeQueuedMessages(...args)
    },
    resumeQueuedMessagesWithInput: (
      ...args: Parameters<PaneCommands['resumeQueuedMessagesWithInput']>
    ) => {
      if (!isActive()) return Promise.resolve(undefined)
      return bind().commands.resumeQueuedMessagesWithInput(...args)
    },
    clearQueuedMessages: (...args: Parameters<PaneCommands['clearQueuedMessages']>) => {
      return bind().commands.clearQueuedMessages(...args)
    },
    reorderQueuedMessages: (...args: Parameters<PaneCommands['reorderQueuedMessages']>) => {
      return bind().commands.reorderQueuedMessages(...args)
    },
    editQueuedMessage: (...args: Parameters<PaneCommands['editQueuedMessage']>) => {
      return bind().commands.editQueuedMessage(...args)
    },
    sendQueuedAsGuidance: (...args: Parameters<PaneCommands['sendQueuedAsGuidance']>) => {
      if (!isActive()) return Promise.resolve(undefined)
      return bind().commands.sendQueuedAsGuidance(...args)
    },
    interruptAndSendQueued: (...args: Parameters<PaneCommands['interruptAndSendQueued']>) => {
      if (!isActive()) return Promise.resolve(undefined)
      return bind().commands.interruptAndSendQueued(...args)
    },
    compactContext: (...args: Parameters<PaneCommands['compactContext']>) => {
      if (!isActive()) return Promise.resolve(false)
      return bind().commands.compactContext(...args)
    },
    setCurrentGoal: (...args: Parameters<PaneCommands['setCurrentGoal']>) => {
      if (!isActive()) return Promise.resolve(false)
      return bind().commands.setCurrentGoal(...args)
    },
    cancelGoalDraft: (...args: Parameters<PaneCommands['cancelGoalDraft']>) => {
      return bind().commands.cancelGoalDraft(...args)
    },
    editCurrentGoal: (...args: Parameters<PaneCommands['editCurrentGoal']>) => {
      return bind().commands.editCurrentGoal(...args)
    },
    updateCurrentGoalStatus: (...args: Parameters<PaneCommands['updateCurrentGoalStatus']>) => {
      if (!isActive()) return Promise.resolve(false)
      return bind().commands.updateCurrentGoalStatus(...args)
    },
    pauseCurrentGoal: (...args: Parameters<PaneCommands['pauseCurrentGoal']>) => {
      return bind().commands.pauseCurrentGoal(...args)
    },
    resumeCurrentGoal: (...args: Parameters<PaneCommands['resumeCurrentGoal']>) => {
      if (!isActive()) return Promise.resolve(false)
      return bind().commands.resumeCurrentGoal(...args)
    },
    pauseCurrentResponse: (...args: Parameters<PaneCommands['pauseCurrentResponse']>) => {
      if (!isActive()) return Promise.resolve()
      return bind().commands.pauseCurrentResponse(...args)
    },
    clearCurrentGoal: (...args: Parameters<PaneCommands['clearCurrentGoal']>) => {
      if (!isActive()) return Promise.resolve(false)
      return bind().commands.clearCurrentGoal(...args)
    },
    cancelGuidanceMessage: (...args: Parameters<PaneCommands['cancelGuidanceMessage']>) => {
      return bind().commands.cancelGuidanceMessage(...args)
    },
    setInput: (...args: Parameters<PaneCommands['setInput']>) => {
      return bind().commands.setInput(...args)
    },
  }
  let snapshot = createPaneSessionView(frame(), commands, search, attachmentCommands)
  const differs = (previous: readonly unknown[] | undefined, next: readonly unknown[]) =>
    !previous || next.some((value, index) => !Object.is(value, previous[index]))
  function publish() {
    if (publishing) {
      publishAgain = true
      return
    }
    publishing = true
    try {
      do {
        publishAgain = false
        const current = frame()
        if (
          current.runtimeTaskLoadTarget &&
          current.threadGoal &&
          current.threadGoal.threadId !== 'pending'
        ) {
          clearRuntimePaneGoalSeed(current.runtimeTaskLoadTarget.address, ownerKey)
          if (
            state.pendingGoalState &&
            isPendingGoalVisibleForRuntimeTarget(
              state.pendingGoalState,
              current.runtimeTaskLoadTarget.address
            )
          ) {
            state = { ...state, pendingGoalState: null }
            publishAgain = true
            continue
          }
        }
        snapshot = createPaneSessionView(current, commands, search, attachmentCommands)
        diagnostics.observe(current)
        for (const listener of listeners) listener()
      } while (publishAgain)
    } finally {
      publishing = false
    }
  }
  function reconcile() {
    if (!isActive() || reconciling) return
    reconciling = true
    try {
      let current = frame()
      reconnect.update({
        deviceId: current.runtimeTaskLoadTarget?.address.deviceId,
        devices: current.workbenchState.devices,
        onReconnect: commands.reloadRuntimeTranscript,
      })
      const retained = current.ownerArchived
        ? null
        : (current.currentRuntimeTaskLoadTarget ?? state.retainedRuntimeTaskLoadTarget)
      if (retained?.address !== state.retainedRuntimeTaskLoadTarget?.address) {
        state = { ...state, retainedRuntimeTaskLoadTarget: retained }
        current = frame()
      }
      const nextQueueKey = current.queuedMessageScopeKey
      if (queueKey !== nextQueueKey || queueSend !== current.sendRuntimePaneMessage) {
        queueKey = nextQueueKey
        queueSend = current.sendRuntimePaneMessage
        releaseQueue?.()
        releaseQueue = current.queueController?.attach({
          lifecycleStore,
          sendRuntimePaneMessage: current.sendRuntimePaneMessage,
        })
      }
      const observedTarget = current.candidateRuntimeTaskLoadTarget
      const nextConversationKey = observedTarget
        ? `${observedTarget.key}:${current.ownerArchived}`
        : null
      if (conversationKey !== nextConversationKey) {
        conversationKey = nextConversationKey
        unsubscribeConversation?.()
        cancelConversationPublication()
        pendingStreamPresentation = false
        unsubscribeConversation = observedTarget
          ? subscribeRuntimeConversation(
              observedTarget.address,
              (action, coalesced) => {
                if (!isActive()) return
                if (coalesced) presentStreamingProgress()
                else if (!action) {
                  reconcile()
                  flushConversation()
                } else if (windowActivity !== 'foreground' || action.type === 'user_added')
                  flushConversation()
                else publishConversation()
              },
              { retainWhileSubscribed: !current.ownerArchived }
            )
          : undefined
      }
      const nextGoalReadScope = [current.runtimeTaskLoadTarget?.key, current.getRuntimeGoal]
      if (differs(goalReadScope, nextGoalReadScope)) {
        goalReadScope = nextGoalReadScope
        goalReaderController.abort()
        goalReaderController = new AbortController()
        if (current.runtimeTaskLoadTarget)
          hydrateRuntimePaneGoal(bind(), goalReaderController.signal)
      }
      const nextReadScope = [current.runtimeTaskLoadTarget?.key, state.transcriptReloadVersion]
      if (differs(readScope, nextReadScope)) {
        const previousTarget = readScope?.[0]
        readScope = nextReadScope
        readerController.abort()
        readerController = new AbortController()
        queryRevision++
        if (previousTarget !== current.runtimeTaskLoadTarget?.key)
          state = { ...state, answeredRequestUserInputIds: new Set() }
        unsubscribeSearch?.()
        unsubscribeSearch = search.subscribe(searchOptions(), publish)
        const targetContext = bind()
        if (targetContext.frame.runtimeTaskLoadTarget) {
          hydrateRuntimePaneTranscript(targetContext, readerController.signal)
        } else {
          live.loadedRuntimeTranscriptKey = null
          state = {
            ...state,
            transcriptLoadingKey: null,
            transcriptError: null,
            transcriptLoadingMoreBeforeKey: null,
          }
        }
      } else {
        unsubscribeSearch?.()
        unsubscribeSearch = search.subscribe(searchOptions(), publish)
      }
    } finally {
      reconciling = false
    }
  }
  return {
    ownerKey,
    matches(next: PaneSessionExternal) {
      const nextId = next.workbench.state.user?.id
      return (
        next.lifecycleStore === lifecycleStore &&
        (accountId === undefined || nextId == null || nextId === accountId)
      )
    },
    getSnapshot: () => snapshot,
    subscribe(next: PaneSessionExternal, listener: () => void) {
      const previousInputScope = currentInputScope()
      external = next
      accountId ??= next.workbench.state.user?.id
      listeners.add(listener)
      if (previousInputScope !== currentInputScope())
        state = { ...state, inputRevision: state.inputRevision + 1 }
      const chat = next.workbench.projectChat
      const inputScope = currentInputScope()
      const signature = [
        next.t,
        next.workbench.state.devices,
        next.currentRuntimeTask ? runtimeTaskLoadAddressKey(next.currentRuntimeTask) : null,
        next.currentRuntimeTask?.workspacePath,
        next.workbench.state.runtimeWork,
        inputScope,
        chat.inputByScope[inputScope],
        chat.getInputRevisionForScope(inputScope),
        chat.composerErrorByScope?.[inputScope],
        chat.composerError,
        chat.goalDraftActiveByScope?.[inputScope],
        next.attachmentState.attachments,
        next.attachmentState.uploadingFiles,
        next.attachmentState.errors,
        next.debugSnapshotEnabled,
      ]
      const changed = differs(externalSignature, signature)
      externalSignature = signature
      const resuming = !started
      if (!started) {
        started = true
        stopWindowActivity = subscribeWorkbenchWindowActivity(activity => {
          const resumed = activity === 'foreground' && windowActivity !== 'foreground'
          windowActivity = activity
          if (resumed) flushConversation()
          else if (pendingStreamPresentation) {
            cancelConversationPublication()
            presentStreamingProgress()
          }
        })
        let revision = lifecycleStore.getTaskRevision(frame().lifecycleAddress)
        unsubscribeLifecycle = lifecycleStore.subscribe(() => {
          const nextRevision = lifecycleStore.getTaskRevision(frame().lifecycleAddress)
          if (revision === nextRevision) return
          revision = nextRevision
          publish()
        })
      }
      reconcile()
      if (changed || resuming) publish()
      return () => {
        listeners.delete(listener)
        queueMicrotask(() => {
          if (listeners.size) return
          started = false
          readerController.abort()
          goalReaderController.abort()
          goalReadScope = undefined
          cancelConversationPublication()
          pendingStreamPresentation = false
          stopWindowActivity?.()
          stopWindowActivity = undefined
          windowActivity = 'foreground'
          readScope = undefined
          releaseQueue?.()
          releaseQueue = undefined
          queueKey = null
          queueSend = undefined
          unsubscribeConversation?.()
          unsubscribeConversation = undefined
          conversationKey = undefined
          unsubscribeLifecycle?.()
          unsubscribeLifecycle = undefined
          unsubscribeSearch?.()
          unsubscribeSearch = undefined
          diagnostics.dispose()
        })
      }
    },
  }
}
