import type { TFunction } from 'i18next'
import type { RuntimeTaskAddress } from '@/types/api'
import type { WorkbenchContextValue } from '@/features/workbench/workbenchContextTypes'
import type { DesktopPaneWorkspaceState } from './desktopPaneWorkspaceState'

export interface DesktopPaneSubagentInput {
  currentRuntimeTask: RuntimeTaskAddress | null
  selectedSubagentStatus: string | undefined
  loadRuntimeTranscriptForPane: WorkbenchContextValue['loadRuntimeTranscriptForPane']
  tChat: TFunction<'chat'>
}
/** Child-thread history belongs to its exact device, task and read service. */
export function createDesktopPaneSubagents(state: DesktopPaneWorkspaceState) {
  const requested = new Set<string>()
  let input: DesktopPaneSubagentInput | null = null
  let lastAttempt: {
    task: RuntimeTaskAddress
    thread: string
    status: string
    loader: DesktopPaneSubagentInput['loadRuntimeTranscriptForPane']
    tChat: DesktopPaneSubagentInput['tChat']
  } | null = null
  let scope: string | null = null
  let generation = 0
  let previousLoader: DesktopPaneSubagentInput['loadRuntimeTranscriptForPane'] | null = null
  return {
    reconcile(next: DesktopPaneSubagentInput) {
      input = next
      const nextScope = JSON.stringify(next.currentRuntimeTask)
      if (scope !== nextScope || previousLoader !== next.loadRuntimeTranscriptForPane) {
        scope = nextScope
        previousLoader = next.loadRuntimeTranscriptForPane
        generation += 1
        requested.clear()
        lastAttempt = null
        if (Object.keys(state.getSnapshot().subagentTranscripts).length)
          state.setSubagentTranscripts({})
      }
      const threadId = state.getSnapshot().selectedSubagentConversationId
      if (
        !next.currentRuntimeTask ||
        !threadId ||
        (next.selectedSubagentStatus !== 'done' && next.selectedSubagentStatus !== 'error') ||
        requested.has(threadId)
      )
        return
      if (
        lastAttempt?.task === next.currentRuntimeTask &&
        lastAttempt.thread === threadId &&
        lastAttempt.status === next.selectedSubagentStatus &&
        lastAttempt.loader === next.loadRuntimeTranscriptForPane &&
        lastAttempt.tChat === next.tChat
      )
        return
      lastAttempt = {
        task: next.currentRuntimeTask,
        thread: threadId,
        status: next.selectedSubagentStatus,
        loader: next.loadRuntimeTranscriptForPane,
        tChat: next.tChat,
      }
      requested.add(threadId)
      const version = generation
      state.setSubagentTranscripts(current => ({
        ...current,
        [threadId]: { loading: true, messages: [], error: null },
      }))
      void next
        .loadRuntimeTranscriptForPane(
          { ...next.currentRuntimeTask, threadId },
          { includeFullContent: true, threadOnly: true }
        )
        .then(transcript => {
          if (version !== generation) return
          state.setSubagentTranscripts(current => ({
            ...current,
            [threadId]: { loading: false, messages: transcript.messages, error: null },
          }))
        })
        .catch(error => {
          if (version !== generation) return
          requested.delete(threadId)
          state.setSubagentTranscripts(current => ({
            ...current,
            [threadId]: {
              loading: false,
              messages: [],
              error:
                error instanceof Error
                  ? error.message
                  : (input?.tChat('subagent.history_load_failed') ??
                    next.tChat('subagent.history_load_failed')),
            },
          }))
        })
    },
    suspend() {
      generation += 1
      requested.clear()
      lastAttempt = null
    },
  }
}
