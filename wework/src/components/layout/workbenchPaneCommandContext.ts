import type { RuntimeTaskAddress } from '@/types/api'
import type { WorkbenchMessage } from '@/types/workbench'
import type { CodeCommentContext } from '@/types/workspace-files'
import type { LoadedTranscriptRange, RuntimeTaskLoadTarget } from './workbenchPaneSessionTypes'
import type { PaneSessionFrame } from './workbenchPaneSessionFrame'
import type { PaneSessionStateActions } from './workbenchPaneSessionState'
import type { PaneCoreCommands } from './workbenchPaneCoreCommands'
import type { PaneTranscriptCommands } from './workbenchPaneTranscriptCommands'
import type { PaneMessagesCommands } from './workbenchPaneMessagesCommands'
import type { PaneSubmissionCommands } from './workbenchPaneSubmissionCommands'
import type { PaneQueueGoalCommands } from './workbenchPaneQueueGoalCommands'
export type PaneCommands = PaneCoreCommands &
  PaneTranscriptCommands &
  PaneMessagesCommands &
  PaneSubmissionCommands &
  PaneQueueGoalCommands
export interface PaneTransactionState {
  codeCommentContexts: CodeCommentContext[]
  browserAnnotationCommandSequence: number
  mounted: boolean
  inputRevision: number
  draftEditVersions: Map<string, number>
  activeInputScope: string
  loadedRuntimeTranscriptKey: string | null
  refreshWorkLists: PaneSessionFrame['refreshWorkLists']
  currentRuntimeTask: RuntimeTaskAddress | null
  runtimeTaskLoadTarget: RuntimeTaskLoadTarget | null
  displayedTranscriptIdentity: string | null
  loadedTranscriptRanges: LoadedTranscriptRange[]
  interruptAndSendInFlight: boolean
  continuationInFlight: boolean
  messages: WorkbenchMessage[]
}
export interface PaneCommandContext {
  ownerKey: string
  frame: PaneSessionFrame
  actions: PaneSessionStateActions
  live: PaneTransactionState
  commands: PaneCommands
}
