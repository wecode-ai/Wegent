import { SupersededConversationRead } from '@/features/workbench/runtimeConversationSynchronization'

import { syncRuntimeGoal } from '@/features/workbench/runtimeTaskLifecycle/goalSynchronization'
import { transcriptRangeFromPage } from '@wegent/chat-core/runtime-transcript-page'

import { logRuntimeTaskCreateStage } from '@/lib/runtime-create-diagnostics'

import {
  beginRuntimeGoalSnapshot,
  getRuntimeConversationMessages,
  getRuntimeConversationTurns,
  isRuntimeGoalSnapshotCurrent,
  runtimeConversationSnapshotSettlesLatestTurn,
} from '@/features/workbench/runtimeConversationCache'

import type { PaneCommandContext } from './workbenchPaneCommandContext'
import {
  runtimeTranscriptHasMoreBefore,
  isPendingGoalVisibleForRuntimeTarget,
  getRuntimePaneGoalSeed,
  resolveHydratedRuntimeGoal,
  runtimeAddressDebug,
  summarizeWorkbenchMessages,
  debugRuntimePaneMessageFlow,
  scheduleRuntimeTurnNavigationLoad,
} from './workbenchPaneSessionHelpers'
export function hydrateRuntimePaneGoal(context: PaneCommandContext, signal: AbortSignal) {
  const { getRuntimeGoal, lifecycleStore, runtimeTaskLoadTarget } = context.frame
  const { setPendingGoalState } = context.actions

  if (!runtimeTaskLoadTarget) return

  const seededGoal = getRuntimePaneGoalSeed(runtimeTaskLoadTarget.address, context.ownerKey)
  if (seededGoal) {
    lifecycleStore.goalStatusReceived(runtimeTaskLoadTarget.address, seededGoal.goal.status)
    setPendingGoalState(current =>
      current && isPendingGoalVisibleForRuntimeTarget(current, runtimeTaskLoadTarget.address)
        ? current
        : seededGoal
    )
  }

  if (context.frame.paneStatus.isCreatingTask) return

  const snapshotVersion = beginRuntimeGoalSnapshot(runtimeTaskLoadTarget.address)
  void getRuntimeGoal(runtimeTaskLoadTarget.address)
    .then(response => {
      if (
        !signal.aborted &&
        response.accepted &&
        isRuntimeGoalSnapshotCurrent(runtimeTaskLoadTarget.address, snapshotVersion)
      ) {
        const loadedGoal = response.goal ?? null
        const resolvedGoal = resolveHydratedRuntimeGoal(
          runtimeTaskLoadTarget.address,
          loadedGoal,
          seededGoal,
          context.ownerKey
        )
        if (import.meta.env.VITE_WEWORK_RUNTIME_DEBUG === '1') {
          console.info('[Wework] Runtime goal hydration resolved', {
            address: runtimeAddressDebug(runtimeTaskLoadTarget.address),
            accepted: response.accepted,
            goalStatus: loadedGoal?.status ?? null,
          })
        }
        syncRuntimeGoal(lifecycleStore, runtimeTaskLoadTarget.address, resolvedGoal)
        if (loadedGoal?.status === 'active') {
          void context.live.refreshWorkLists().catch(() => undefined)
        }
      }
    })
    .catch(error => {
      if (!signal.aborted) {
        console.error('[Wework] Runtime goal load failed', {
          address: runtimeAddressDebug(runtimeTaskLoadTarget.address),
          error,
        })
      }
    })
}
export function hydrateRuntimePaneTranscript(context: PaneCommandContext, signal: AbortSignal) {
  const {
    runtimeTranscriptPageSize,
    lifecycleStore,
    runtimeTaskLoadTarget,
    loadRuntimeTranscriptForPane,
    isTranscriptScopeCurrent,
  } = context.frame
  const {
    setTranscriptLoadingKey,
    setTranscriptError,
    setTranscriptHasMoreBefore,
    setTranscriptBeforeCursor,
    setTranscriptLoadingMoreBeforeKey,
    setTranscriptFullContent,
    setLoadedTranscriptRanges,
    setTurnNavigation,
  } = context.actions

  if (!runtimeTaskLoadTarget) {
    context.live.loadedRuntimeTranscriptKey = null
    setTranscriptLoadingKey(null)
    setTranscriptError(null)
    setTranscriptLoadingMoreBeforeKey(null)
    return
  }

  const { key: loadKey, address } = runtimeTaskLoadTarget
  if (
    context.live.loadedRuntimeTranscriptKey === loadKey &&
    context.live.displayedTranscriptIdentity === runtimeTaskLoadTarget.identityKey
  ) {
    setTranscriptLoadingKey(current => (current === loadKey ? null : current))
    return
  }

  let cancelNavigationLoad = () => {}
  signal.addEventListener('abort', () => cancelNavigationLoad(), { once: true })
  const cachedSeededMessages = getRuntimeConversationMessages(address)
  const seededMessages =
    context.live.displayedTranscriptIdentity === runtimeTaskLoadTarget.identityKey
      ? context.live.messages.length > 0
        ? context.live.messages
        : cachedSeededMessages
      : cachedSeededMessages
  context.live.displayedTranscriptIdentity = runtimeTaskLoadTarget.identityKey
  debugRuntimePaneMessageFlow('transcript-load-start', {
    address: runtimeAddressDebug(address),
    key: loadKey,
    seededCount: seededMessages.length,
    seededMessages: summarizeWorkbenchMessages(seededMessages),
  })
  setTranscriptLoadingKey(loadKey)
  setTranscriptError(null)
  setTranscriptHasMoreBefore(false)
  setTranscriptBeforeCursor(null)
  setTranscriptLoadingMoreBeforeKey(null)
  setTranscriptFullContent(false)
  setLoadedTranscriptRanges([])
  setTurnNavigation([])
  const turnsAtLoadStart = getRuntimeConversationTurns(address)
  void Promise.resolve()
    .then(() =>
      loadRuntimeTranscriptForPane(address, {
        limit: runtimeTranscriptPageSize,
      })
    )
    .then(transcript => {
      logRuntimeTaskCreateStage('pane-transcript-received', {
        taskId: address.taskId,
        deviceId: address.deviceId,
        cancelled: signal.aborted,
        messageCount: transcript.messages.length,
        turnCount: transcript.turns.length,
      })
      if (!signal.aborted && isTranscriptScopeCurrent()) {
        const preserveActiveTurn =
          getRuntimeConversationTurns(address) !== turnsAtLoadStart &&
          (lifecycleStore.getTask(address)?.derived.isRunning ?? false) &&
          !runtimeConversationSnapshotSettlesLatestTurn(address, transcript.turns)
        lifecycleStore.syncTranscript(address, transcript, { preserveActiveTurn })
        const nextMessages = getRuntimeConversationMessages(address)
        context.live.loadedRuntimeTranscriptKey = loadKey
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
        if (
          transcript.runtime === 'codex' &&
          transcript.fullContent !== true &&
          runtimeTranscriptHasMoreBefore(transcript) &&
          (!transcript.turnNavigation || transcript.turnNavigation.length === 0)
        ) {
          cancelNavigationLoad = scheduleRuntimeTurnNavigationLoad(() => {
            void loadRuntimeTranscriptForPane(address, { navigationOnly: true })
              .then(navigationTranscript => {
                if (
                  !signal.aborted &&
                  isTranscriptScopeCurrent() &&
                  navigationTranscript.turnNavigation
                ) {
                  setTurnNavigation(navigationTranscript.turnNavigation)
                }
              })
              .catch(error => {
                if (!signal.aborted && isTranscriptScopeCurrent()) {
                  console.error('[Wework] Runtime turn navigation load failed', {
                    address,
                    error,
                  })
                }
              })
          })
        }
      }
    })
    .catch(error => {
      if (error instanceof SupersededConversationRead) return
      if (!signal.aborted && isTranscriptScopeCurrent()) {
        context.live.loadedRuntimeTranscriptKey = null
        setTranscriptFullContent(false)
        setTranscriptHasMoreBefore(false)
        setTranscriptBeforeCursor(null)
        setLoadedTranscriptRanges([])
        setTurnNavigation([])
        setTranscriptError(error)
        console.error('[Wework] Runtime pane transcript load failed', {
          key: loadKey,
          address,
          error,
        })
      }
    })
    .finally(() => {
      debugRuntimePaneMessageFlow('transcript-load-settled', {
        key: loadKey,
        cancelled: signal.aborted,
        activeKey: context.live.runtimeTaskLoadTarget?.key,
      })
      if (!signal.aborted && isTranscriptScopeCurrent()) {
        setTranscriptLoadingKey(current => (current === loadKey ? null : current))
      }
    })
}
