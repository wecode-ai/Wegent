import {
  transcriptRangeFromPage,
  mergeTranscriptRanges,
  runtimeTurnNavigationLoadOptions,
} from '@wegent/chat-core/runtime-transcript-page'

import type { RuntimeTurnNavigationItem } from '@/types/api'

import { runtimeTranscriptHasMoreBefore } from './workbenchPaneSessionHelpers'
import type { LoadedTranscriptRange } from './workbenchPaneSessionTypes'
import type { PaneCommandContext } from './workbenchPaneCommandContext'

export function createPaneTranscriptCommands(sessionOwner: PaneCommandContext) {
  const reloadRuntimeTranscript = () => {
    const { setTranscriptError, setTranscriptReloadVersion } = sessionOwner.actions

    sessionOwner.live.loadedRuntimeTranscriptKey = null
    setTranscriptError(null)
    setTranscriptReloadVersion(version => version + 1)
  }

  const loadMoreTranscriptBefore = async () => {
    const {
      isTranscriptScopeCurrent,
      loadRuntimeTranscriptForPane,
      runtimeTaskLoadTarget,
      runtimeTranscriptPageSize,
      transcriptBeforeCursor,
      transcriptFullContent,
      transcriptLoadingMoreBefore,
    } = sessionOwner.frame
    const {
      setTranscriptError,
      setTranscriptHasMoreBefore,
      setTranscriptBeforeCursor,
      setTranscriptLoadingMoreBeforeKey,
      setLoadedTranscriptRanges,
      setTurnNavigation,
    } = sessionOwner.actions

    if (
      !isTranscriptScopeCurrent() ||
      !runtimeTaskLoadTarget ||
      !transcriptBeforeCursor ||
      transcriptLoadingMoreBefore ||
      transcriptFullContent
    )
      return

    const { key: loadKey, address } = runtimeTaskLoadTarget
    const beforeCursor = transcriptBeforeCursor
    setTranscriptLoadingMoreBeforeKey(loadKey)
    try {
      const transcript = await loadRuntimeTranscriptForPane(address, {
        limit: runtimeTranscriptPageSize,
        beforeCursor,
      })
      if (!isTranscriptScopeCurrent()) return
      setTranscriptError(null)
      const nextRanges = mergeTranscriptRanges(
        sessionOwner.live.loadedTranscriptRanges,
        transcriptRangeFromPage(transcript)
      )
      setTranscriptHasMoreBefore(runtimeTranscriptHasMoreBefore(transcript))
      setTranscriptBeforeCursor(transcript.beforeCursor ?? null)
      setLoadedTranscriptRanges(nextRanges)
      setTurnNavigation(current =>
        transcript.turnNavigation && transcript.turnNavigation.length > 0
          ? transcript.turnNavigation
          : current
      )
    } catch (error) {
      if (!isTranscriptScopeCurrent()) return
      setTranscriptError(error)
      console.error('[Wework] Runtime pane older transcript load failed', {
        key: loadKey,
        address,
        beforeCursor,
        error,
      })
    } finally {
      if (isTranscriptScopeCurrent()) {
        setTranscriptLoadingMoreBeforeKey(current => (current === loadKey ? null : current))
      }
    }
  }

  const loadTranscriptTurnNavigationItem = async (item: RuntimeTurnNavigationItem) => {
    const {
      isTranscriptScopeCurrent,
      loadRuntimeTranscriptForPane,
      runtimeTaskLoadTarget,
      runtimeTranscriptPageSize,
      transcriptBeforeCursor,
      transcriptFullContent,
      transcriptHasMoreBefore,
    } = sessionOwner.frame
    const {
      setTranscriptHasMoreBefore,
      setTranscriptBeforeCursor,
      setLoadedTranscriptRanges,
      setTurnNavigation,
    } = sessionOwner.actions

    if (!isTranscriptScopeCurrent() || !runtimeTaskLoadTarget || !item.cursor) {
      return
    }
    if (transcriptFullContent) {
      return
    }
    if (sessionOwner.live.messages.some(message => message.id === item.id)) {
      return
    }

    const { address } = runtimeTaskLoadTarget
    const loadOptions = runtimeTurnNavigationLoadOptions(
      item,
      sessionOwner.live.loadedTranscriptRanges,
      runtimeTranscriptPageSize
    )
    const transcript = await loadRuntimeTranscriptForPane(address, loadOptions)
    if (!isTranscriptScopeCurrent()) return
    const nextHasMoreBefore =
      loadOptions.beforeCursor === undefined
        ? transcriptHasMoreBefore
        : runtimeTranscriptHasMoreBefore(transcript)
    const nextBeforeCursor =
      loadOptions.beforeCursor === undefined
        ? transcriptBeforeCursor
        : (transcript.beforeCursor ?? null)
    const nextRanges = mergeTranscriptRanges(
      sessionOwner.live.loadedTranscriptRanges,
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
  }

  const loadTranscriptGap = async (gap: LoadedTranscriptRange) => {
    const {
      isTranscriptScopeCurrent,
      loadRuntimeTranscriptForPane,
      runtimeTaskLoadTarget,
      runtimeTranscriptPageSize,
      transcriptFullContent,
    } = sessionOwner.frame
    const { setLoadedTranscriptRanges, setTurnNavigation } = sessionOwner.actions

    if (
      !isTranscriptScopeCurrent() ||
      !runtimeTaskLoadTarget ||
      transcriptFullContent ||
      gap.end <= gap.start
    )
      return

    const { address } = runtimeTaskLoadTarget
    const limit = Math.min(runtimeTranscriptPageSize, gap.end - gap.start)
    const loadOptions = {
      limit,
      afterCursor: `offset:${gap.start}`,
    }
    const transcript = await loadRuntimeTranscriptForPane(address, loadOptions)
    if (!isTranscriptScopeCurrent()) return
    const nextRanges = mergeTranscriptRanges(
      sessionOwner.live.loadedTranscriptRanges,
      transcriptRangeFromPage(transcript)
    )
    setLoadedTranscriptRanges(nextRanges)
    setTurnNavigation(current =>
      transcript.turnNavigation && transcript.turnNavigation.length > 0
        ? transcript.turnNavigation
        : current
    )
  }
  return {
    reloadRuntimeTranscript,
    loadMoreTranscriptBefore,
    loadTranscriptTurnNavigationItem,
    loadTranscriptGap,
  }
}
export type PaneTranscriptCommands = ReturnType<typeof createPaneTranscriptCommands>
