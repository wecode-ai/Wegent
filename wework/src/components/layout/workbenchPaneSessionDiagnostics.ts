import {
  DEBUG_SNAPSHOT_INTERVAL_MS,
  compareMessageStyles,
  summarizeRuntimePaneMemory,
  summarizeMessages,
  updateRuntimePaneDebugSnapshot,
} from '@/lib/debugPanel'
import type { PaneSessionFrame } from './workbenchPaneSessionFrame'

export function createPaneSessionDiagnostics(owner: {
  readFrame(): PaneSessionFrame
  isActive(): boolean
}) {
  let timer: ReturnType<typeof setTimeout> | undefined
  const clearTimer = () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }
  const publishDebugSnapshot = () => {
    timer = undefined
    if (!owner.isActive()) return
    const frame = owner.readFrame()
    if (!frame.debugSnapshotEnabled) return
    updateRuntimePaneDebugSnapshot(
      {
        currentRuntimeTask: frame.currentRuntimeTask,
        status: frame.paneStatus,
        messageSummary: summarizeMessages(frame.messages),
        messageStyleComparison: compareMessageStyles(frame.messages),
        memory: summarizeRuntimePaneMemory({
          messages: frame.messages,
          currentRuntimeTask: frame.currentRuntimeTask,
          loadedRanges: frame.loadedTranscriptRanges,
        }),
        queuedMessages: frame.queuedMessages,
        guidanceMessages: frame.guidanceMessages,
        codeCommentContextCount: frame.codeCommentContexts.length,
        inputLength: frame.getInput().length,
        transcript: {
          loading: frame.transcriptLoading,
          hasMoreBefore: frame.transcriptHasMoreBefore,
          loadingMoreBefore: frame.transcriptLoadingMoreBefore,
          beforeCursor: frame.transcriptBeforeCursor,
          turnNavigationCount: frame.turnNavigation.length,
          loadedRanges: frame.loadedTranscriptRanges,
        },
        subagentStatuses: frame.subagentStatuses,
        goal: frame.goal,
        goalDraftActive: frame.goalDraftActive,
      },
      { enabled: frame.debugSnapshotEnabled }
    )
  }
  return {
    observe(frame: PaneSessionFrame) {
      if (!owner.isActive()) return
      if (!frame.debugSnapshotEnabled) clearTimer()
      else if (timer === undefined)
        timer = setTimeout(publishDebugSnapshot, DEBUG_SNAPSHOT_INTERVAL_MS)
    },
    dispose: clearTimer,
  }
}
