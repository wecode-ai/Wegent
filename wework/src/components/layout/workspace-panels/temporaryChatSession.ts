import type { SetStateAction } from 'react'
import type { RuntimeTaskAddress } from '@/types/api'
import type {
  RuntimeConversationTurn,
  RuntimePaneQueuedMessage,
  WorkbenchMessage,
} from '@/types/workbench'
import type { WorkbenchPaneContextValue } from '@/features/workbench/workbenchContextTypes'
import type { createRuntimeContextUsageStore } from '@wegent/chat-core/runtime-context-usage'
import type { RuntimeTaskLifecycleStore } from '@/features/workbench/runtimeTaskLifecycle'
import type { RuntimeConversationQueuePort } from '@wegent/collaboration/execution/runtimeConversationQueue'
import { runtimePaneQueue } from './runtimePaneQueues'
import {
  getRuntimeConversationMessages,
  getRuntimeConversationTurns,
  subscribeRuntimeConversation,
} from '@/features/workbench/runtimeConversationCache'
import { createAppliedRuntimeGuidanceMessage } from '@/features/workbench/runtimeGuidanceMessages'
import { deriveRuntimePaneStatus } from '@/features/workbench/runtimePaneStatus'
import {
  selectPrivateHistory,
  type PrivateHistorySource,
} from '@/features/collaboration-exp/private/privateConversationHistory'
import { conversationOutcomePresentation } from './conversationOutcomePresentation'
import { isMainWindowFocused, subscribeMainWindowFocus } from '@/desktop/windowFocus'

interface TemporaryChatDraftPort {
  value: string
  onChange(value: string): void
}
export interface TemporaryChatSessionOptions {
  instanceId: string
  address: RuntimeTaskAddress | null
  initialAddress: RuntimeTaskAddress | null
  initialInput: string
  draft?: TemporaryChatDraftPort
  storedInput?: string
  writeDraft(scope: string, input: string): void
  draftRequest?: { id: number; text: string }
  onDraftRequestConsumed?(id: number): void
  autoSubmitInitialInput: boolean
  sendInitialInput(text: string): Promise<boolean>
  modelPending: boolean
  active: boolean
  readOnly: boolean
  sendEphemeral: boolean
  historySource?: PrivateHistorySource
  hideProcessing: boolean
  focusRequestKey?: string
  sourceMessageIds?: string[]
  onHistorySourceAvailabilityChange?(available: boolean): void
  markReadWhenActive: boolean
  messageViewId: string
  lifecycleStore: RuntimeTaskLifecycleStore
  contextUsageStore: ReturnType<typeof createRuntimeContextUsageStore>
  loadTranscript: WorkbenchPaneContextValue['loadRuntimeTranscriptForPane']
  subscribeStream: WorkbenchPaneContextValue['subscribeRuntimeTaskStream']
  queue: ReturnType<typeof runtimePaneQueue>
  queuePort(): RuntimeConversationQueuePort<number>
}
interface TemporaryChatSessionSnapshot {
  draftScope: string
  input: string
  replaceDraftKey: number
  error: string | null
  sending: boolean
  messages: WorkbenchMessage[]
  turns: RuntimeConversationTurn[]
  acceptedSourceMessageIds: string[]
  historyLoading: boolean
  historyError: string | null
  historyBeforeCursor: string | null
  historyLoadingMoreBefore: boolean
  hiddenRequestUserInputIds: ReadonlySet<string>
  queuedMessages: RuntimePaneQueuedMessage[]
}
const taskKey = (address: RuntimeTaskAddress | null) =>
  address ? JSON.stringify([address.deviceId, address.taskId]) : ''
const addressKey = (address: RuntimeTaskAddress | null) =>
  address
    ? JSON.stringify([
        address.deviceId,
        address.taskId,
        address.runtime ?? null,
        address.threadId ?? null,
        address.runtimeHandle ?? null,
        address.projectSession ?? null,
        address.issueExecution ?? null,
      ])
    : ''
const ownerKey = (options: TemporaryChatSessionOptions) =>
  JSON.stringify([options.instanceId, taskKey(options.initialAddress)])

/** History, pending commands and draft ownership for one temporary conversation view. */
export function createTemporaryChatSession() {
  let state: TemporaryChatSessionSnapshot = {
    draftScope: '',
    input: '',
    replaceDraftKey: 0,
    error: null,
    sending: false,
    messages: [],
    turns: [],
    acceptedSourceMessageIds: [],
    historyLoading: false,
    historyError: null,
    historyBeforeCursor: null,
    historyLoadingMoreBefore: false,
    hiddenRequestUserInputIds: new Set(),
    queuedMessages: [],
  }
  let options: TemporaryChatSessionOptions | null = null
  let initialDraftScope: string | null = null
  let observedOwner = ''
  let dataIdentity = ''
  let generation = 0
  let submissionGeneration = 0
  let observedGeneration = 0
  const listeners = new Set<() => void>()
  const stops: (() => void)[] = []
  let historyGeneration = 0
  let loadingMore = false
  let createdAddressKey = ''
  let createdOwner = ''
  let appliedDraftRequest: number | null = null
  let draftEditVersion = 0
  let autoSubmitted = false
  let autoTimer: ReturnType<typeof setTimeout> | null = null
  let reconciling = false
  let historyAvailable: boolean | undefined
  let availabilityCallback: TemporaryChatSessionOptions['onHistorySourceAvailabilityChange']
  let viewed: { store: RuntimeTaskLifecycleStore; key: string; viewId: string } | null = null
  let stopViewingFocus: (() => void) | undefined
  const nativeSubmissions = new Set<string>()
  const retries = new Set<string>()
  const observed = () => listeners.size > 0
  const publish = (next: TemporaryChatSessionSnapshot) => {
    if (next === state) return
    state = next
    for (const listener of listeners) listener()
    schedule()
  }
  const set = <K extends keyof TemporaryChatSessionSnapshot>(
    key: K,
    value: SetStateAction<TemporaryChatSessionSnapshot[K]>
  ) => {
    if (!observed()) return
    const next = typeof value === 'function' ? value(state[key]) : value
    if (!Object.is(next, state[key])) publish({ ...state, [key]: next })
  }
  function schedule() {
    if (reconciling) return
    reconciling = true
    queueMicrotask(() => {
      reconciling = false
      if (observed()) reconcile()
    })
  }
  function writeInput(update: SetStateAction<string>) {
    if (!options || !observed()) return
    const current = options.draft?.value ?? state.input
    const next = typeof update === 'function' ? update(current) : update
    if (options.draft) options.draft.onChange(next)
    else {
      options.writeDraft(`pane:${options.instanceId}`, next)
      set('input', next)
    }
  }
  function currentScope(requested: TemporaryChatSessionOptions) {
    if (!options || !observed() || ownerKey(requested) !== observedOwner) return false
    return (
      addressKey(requested.address) === addressKey(options.address) ||
      (!requested.address &&
        createdOwner === observedOwner &&
        createdAddressKey === addressKey(options.address))
    )
  }
  function releaseViewed() {
    stopViewingFocus?.()
    stopViewingFocus = undefined
    if (!viewed) return
    viewed.store.messageReceipts?.setViewed(viewed.key, false, viewed.viewId)
    viewed = null
  }
  function updateViewed() {
    if (!options || !observed()) return
    const { address, lifecycleStore, messageViewId } = options
    if (!options.active || !options.markReadWhenActive || !address) {
      releaseViewed()
      return
    }
    const key = lifecycleStore.getTask(address)?.key ?? `${address.deviceId}\0${address.taskId}`
    if (
      viewed &&
      (viewed.store !== lifecycleStore || viewed.key !== key || viewed.viewId !== messageViewId)
    )
      releaseViewed()
    viewed = { store: lifecycleStore, key, viewId: messageViewId }
    if (!stopViewingFocus)
      stopViewingFocus = subscribeMainWindowFocus(() => {
        if (observed()) updateViewed()
      })
    lifecycleStore.messageReceipts?.setViewed(key, isMainWindowFocused(), messageViewId)
    if (isMainWindowFocused() && lifecycleStore.getTask(address)?.unread)
      lifecycleStore.markRead(address)
  }
  function syncCache() {
    if (!options?.address || !observed()) return
    const messages = getRuntimeConversationMessages(options.address)
    const turns = getRuntimeConversationTurns(options.address)
    const acceptedMessages = messages.length ? messages : state.messages
    if (acceptedMessages !== state.messages || turns !== state.turns)
      publish({
        ...state,
        messages: acceptedMessages,
        turns,
        error: messages.length ? null : state.error,
      })
  }
  async function loadHistory(force = false) {
    if (!options?.address || !observed()) return
    const requested = options
    const address = requested.address!
    if (
      !force &&
      (createdAddressKey === addressKey(address) ||
        (requested.sendEphemeral && getRuntimeConversationMessages(address).length))
    ) {
      set('historyLoading', false)
      return
    }
    set('historyLoading', true)
    set('historyLoadingMoreBefore', false)
    const version = ++historyGeneration
    loadingMore = false
    const usageRevision = requested.contextUsageStore.getRevision()
    try {
      const transcript = await requested.loadTranscript(address)
      if (!currentScope(requested) || historyGeneration !== version) return
      requested.contextUsageStore.receiveTranscript(transcript.contextUsage, usageRevision)
      set('historyBeforeCursor', transcript.beforeCursor ?? null)
      requested.lifecycleStore.syncTranscript(address, transcript, {
        preserveActiveTurn:
          requested.lifecycleStore.getTask(address)?.derived.isTurnActive ?? false,
      })
      syncCache()
    } catch (error) {
      if (currentScope(requested) && historyGeneration === version)
        set('historyError', error instanceof Error ? error.message : String(error))
    } finally {
      if (currentScope(requested) && historyGeneration === version) set('historyLoading', false)
    }
  }
  async function loadMoreHistory() {
    if (!options?.address || !state.historyBeforeCursor || loadingMore || !observed()) return
    const requested = options
    const version = historyGeneration
    const before = state.historyBeforeCursor
    loadingMore = true
    set('historyLoadingMoreBefore', true)
    try {
      const transcript = await requested.loadTranscript(requested.address!, {
        limit: 5,
        beforeCursor: before,
      })
      if (!currentScope(requested) || historyGeneration !== version) return
      set('messages', getRuntimeConversationMessages(requested.address!))
      set('turns', getRuntimeConversationTurns(requested.address!))
      set('historyBeforeCursor', transcript.beforeCursor ?? null)
      set('historyError', null)
    } catch (error) {
      if (currentScope(requested) && historyGeneration === version)
        set('historyError', error instanceof Error ? error.message : String(error))
    } finally {
      if (currentScope(requested) && historyGeneration === version) {
        loadingMore = false
        set('historyLoadingMoreBefore', false)
      }
    }
  }
  function stopData() {
    stops.splice(0).forEach(stop => stop())
    historyGeneration += 1
    loadingMore = false
    if (state.historyLoading || state.historyLoadingMoreBefore)
      publish({ ...state, historyLoading: false, historyLoadingMoreBefore: false })
    releaseViewed()
    dataIdentity = ''
  }
  function connectData(requested: TemporaryChatSessionOptions) {
    stopData()
    const version = ++generation
    const isCurrent = () => observed() && generation === version
    dataIdentity = addressKey(requested.address)
    syncCache()
    if (requested.address) {
      stops.push(
        subscribeRuntimeConversation(requested.address, () => {
          if (isCurrent()) syncCache()
        })
      )
      stops.push(
        requested.subscribeStream(requested.address, {
          onContextUsageUpdated: usage => {
            if (isCurrent()) requested.contextUsageStore.receiveLive(usage)
          },
          onMessageAction: () => undefined,
          onAssistantStart: () => {
            if (isCurrent()) set('sending', false)
          },
          onAssistantSettled: () => {
            if (isCurrent()) set('sending', false)
          },
          onGuidanceApplied: payload => {
            if (!isCurrent()) return
            const message = requested.queue.applyGuidance(payload)
            if (message)
              set('messages', current => [
                ...current.filter(item => item.id !== message.id),
                createAppliedRuntimeGuidanceMessage(message, payload),
              ])
          },
        })
      )
      void loadHistory()
    }
    stops.push(
      requested.queue.subscribe(() => {
        if (isCurrent()) set('queuedMessages', requested.queue.getSnapshot())
      })
    )
    set('queuedMessages', requested.queue.getSnapshot())
    stops.push(
      requested.lifecycleStore.subscribe(() => {
        if (isCurrent()) {
          updateViewed()
          schedule()
        }
      })
    )
  }
  function reconcile() {
    if (!options) return
    const requested = options
    updateViewed()
    requested.queue.reconcileGuidance(
      new Set(
        state.messages
          .filter(message => message.role === 'user' && message.runtimeGuidance)
          .map(message => message.id)
      )
    )
    const scoped = requested.historySource
      ? selectPrivateHistory(state.turns, requested.historySource, state.acceptedSourceMessageIds)
      : { available: true, messages: state.messages, turns: state.turns }
    if (
      historyAvailable !== scoped.available ||
      availabilityCallback !== requested.onHistorySourceAvailabilityChange
    ) {
      historyAvailable = scoped.available
      availabilityCallback = requested.onHistorySourceAvailabilityChange
      availabilityCallback?.(scoped.available)
    }
    const presentation = requested.hideProcessing
      ? conversationOutcomePresentation(scoped.messages, scoped.turns)
      : scoped
    const targeted = requested.sourceMessageIds?.some(id =>
      presentation.messages.some(message => message.id === id)
    )
    if (
      requested.active &&
      ((requested.historySource && !scoped.available) ||
        (requested.focusRequestKey && requested.sourceMessageIds?.length && !targeted)) &&
      !state.historyLoading &&
      !state.historyLoadingMoreBefore &&
      state.historyBeforeCursor &&
      !state.historyError
    )
      void loadMoreHistory()
    if (requested.draftRequest && appliedDraftRequest !== requested.draftRequest.id) {
      appliedDraftRequest = requested.draftRequest.id
      draftEditVersion += 1
      writeInput(current =>
        current.trim()
          ? `${current}\n\n${requested.draftRequest!.text}`
          : requested.draftRequest!.text
      )
      set('replaceDraftKey', current => current + 1)
      requested.onDraftRequestConsumed?.(requested.draftRequest.id)
    }
    if (requested.address && requested.active && !requested.readOnly) {
      const lifecycle = requested.lifecycleStore.getTask(requested.address)
      const busy =
        state.sending ||
        deriveRuntimePaneStatus({
          messages: state.messages,
          currentRuntimeTask: requested.address,
          lifecycle,
        }).isBusy
      void requested.queue.pump(requested.queuePort(), busy)
    }
    if (autoTimer !== null) {
      clearTimeout(autoTimer)
      autoTimer = null
    }
    if (
      requested.active &&
      !requested.readOnly &&
      requested.autoSubmitInitialInput &&
      requested.initialInput.trim() &&
      !autoSubmitted &&
      !requested.modelPending
    ) {
      const scope = submissionGeneration
      autoTimer = setTimeout(() => {
        autoTimer = null
        if (!observed() || scope !== submissionGeneration || autoSubmitted) return
        autoSubmitted = true
        const edited = draftEditVersion
        const restore = () => {
          if (!observed() || scope !== submissionGeneration) return
          set('sending', false)
          if (draftEditVersion !== edited) return
          writeInput(requested.initialInput.trim())
          set('replaceDraftKey', value => value + 1)
        }
        void requested.sendInitialInput(requested.initialInput).then(accepted => {
          if (!accepted) restore()
        }, restore)
      }, 0)
    }
  }
  return {
    observe(requested: TemporaryChatSessionOptions) {
      let base: TemporaryChatSessionSnapshot | null = null
      let projection: TemporaryChatSessionSnapshot | null = null
      const read = () => {
        if (base !== state || !projection) {
          base = state
          const draftScope = `pane:${requested.instanceId}`
          const scopeChanged = state.draftScope !== draftScope
          const first = initialDraftScope === null
          const externalChanged = options?.storedInput !== requested.storedInput
          const input =
            requested.draft?.value ??
            (scopeChanged || externalChanged
              ? (requested.storedInput ??
                (first || initialDraftScope === draftScope ? requested.initialInput : ''))
              : state.input)
          const addressChanged =
            options !== null && addressKey(options.address) !== addressKey(requested.address)
          const identity = addressChanged
            ? requested.address
            : first
              ? requested.initialAddress
              : null
          const nextMessages = identity
            ? getRuntimeConversationMessages(identity)
            : addressChanged
              ? []
              : state.messages
          const nextTurns = identity
            ? getRuntimeConversationTurns(identity)
            : addressChanged
              ? []
              : state.turns
          const historyLoading =
            first || addressChanged
              ? Boolean(
                  identity &&
                  createdAddressKey !== addressKey(identity) &&
                  (!requested.sendEphemeral || nextMessages.length === 0)
                )
              : state.historyLoading
          projection =
            scopeChanged || input !== state.input || first || addressChanged
              ? {
                  ...state,
                  draftScope,
                  input,
                  messages: nextMessages,
                  turns: nextTurns,
                  historyLoading,
                  ...(addressChanged
                    ? {
                        historyBeforeCursor: null,
                        historyError: null,
                        historyLoadingMoreBefore: false,
                        error: null,
                        sending: false,
                        acceptedSourceMessageIds: [],
                        hiddenRequestUserInputIds: new Set<string>(),
                      }
                    : {}),
                }
              : state
        }
        return projection
      }
      const commandKey = JSON.stringify([ownerKey(requested), addressKey(requested.address)])
      const commandSet = <K extends keyof TemporaryChatSessionSnapshot>(
        key: K,
        value: SetStateAction<TemporaryChatSessionSnapshot[K]>
      ) => {
        if (currentScope(requested)) set(key, value)
      }
      return {
        getSnapshot: read,
        commands: {
          isCurrent: () => currentScope(requested),
          setInput: (value: SetStateAction<string>) => {
            if (currentScope(requested)) writeInput(value)
          },
          setMessages: (value: SetStateAction<WorkbenchMessage[]>) => commandSet('messages', value),
          setError: (value: SetStateAction<string | null>) => commandSet('error', value),
          setSending: (value: SetStateAction<boolean>) => commandSet('sending', value),
          setAcceptedSourceMessageIds: (value: SetStateAction<string[]>) =>
            commandSet('acceptedSourceMessageIds', value),
          setReplaceDraftKey: (value: SetStateAction<number>) =>
            commandSet('replaceDraftKey', value),
          setHiddenRequestUserInputIds: (value: SetStateAction<ReadonlySet<string>>) =>
            commandSet('hiddenRequestUserInputIds', value),
          noteDraftEdit: () => {
            if (currentScope(requested)) draftEditVersion += 1
          },
          markCreatedAddress: (address: RuntimeTaskAddress) => {
            if (currentScope(requested)) {
              createdAddressKey = addressKey(address)
              createdOwner = ownerKey(requested)
            }
          },
          nativeSubmissionPending: () => nativeSubmissions.has(commandKey),
          setNativeSubmissionPending: (pending: boolean) => {
            if (pending) nativeSubmissions.add(commandKey)
            else nativeSubmissions.delete(commandKey)
          },
          retryPending: () => retries.has(commandKey),
          setRetryPending: (pending: boolean) => {
            if (pending) retries.add(commandKey)
            else retries.delete(commandKey)
          },
          loadMoreHistory,
          retryHistory: () => {
            if (!currentScope(requested)) return
            if (state.historyBeforeCursor) void loadMoreHistory()
            else {
              set('historyLoading', true)
              set('historyError', null)
              void loadHistory(true)
            }
          },
        },
        subscribe(listener: () => void) {
          const before = options
          const projected = read()
          const owner = ownerKey(requested)
          if (observedOwner !== owner) {
            submissionGeneration += 1
            observedOwner = owner
          }
          options = requested
          if (initialDraftScope === null) initialDraftScope = projected.draftScope
          const version = ++observedGeneration
          const first = !listeners.size && stops.length === 0
          listeners.add(listener)
          if (projected !== state) publish(projected)
          const dataChanged =
            first ||
            dataIdentity !== addressKey(requested.address) ||
            before?.loadTranscript !== requested.loadTranscript ||
            before?.subscribeStream !== requested.subscribeStream ||
            before?.contextUsageStore !== requested.contextUsageStore ||
            before?.lifecycleStore !== requested.lifecycleStore ||
            before?.queue !== requested.queue
          if (dataChanged) connectData(requested)
          updateViewed()
          schedule()
          return () => {
            listeners.delete(listener)
            if (!listeners.size)
              queueMicrotask(() => {
                if (observedGeneration !== version || listeners.size) return
                submissionGeneration += 1
                generation += 1
                stopData()
                if (autoTimer !== null) clearTimeout(autoTimer)
                autoTimer = null
              })
          }
        },
      }
    },
  }
}

export type TemporaryChatSessionCommands = ReturnType<
  ReturnType<typeof createTemporaryChatSession>['observe']
>['commands']
