import { type SetStateAction } from 'react'

import type { RuntimeTaskAddress, RuntimeTurnNavigationItem } from '@/types/api'

import type { WorkbenchMessage } from '@/types/workbench'
import type { CodeCommentContext } from '@/types/workspace-files'
import type { BrowserAnnotationCommand } from '@/types/browser-annotation'

import type {
  LoadedTranscriptRange,
  PendingRuntimeGoalState,
  RuntimeTaskLoadTarget,
} from './workbenchPaneSessionTypes'
import {
  runtimeTaskLoadTargetFromAddress,
  runtimeTaskLoadAddressKey,
} from './workbenchPaneSessionHelpers'

export interface PaneSessionState {
  codeCommentContexts: CodeCommentContext[]
  browserAnnotationCommand: BrowserAnnotationCommand | null
  localError: string | null
  answeredRequestUserInputIds: ReadonlySet<string>
  transcriptLoadingKey: string | null
  transcriptError: unknown
  transcriptReloadVersion: number
  transcriptHasMoreBefore: boolean
  transcriptBeforeCursor: string | null
  transcriptLoadingMoreBeforeKey: string | null
  transcriptFullContent: boolean
  loadedTranscriptRanges: LoadedTranscriptRange[]
  turnNavigation: RuntimeTurnNavigationItem[]
  pendingGoalState: PendingRuntimeGoalState | null
  retainedRuntimeTaskLoadTarget: RuntimeTaskLoadTarget | null
  draftMessages: WorkbenchMessage[]
}
export type PaneSessionStateActions = {
  [Key in keyof PaneSessionState as `set${Capitalize<Key>}`]: (
    value: SetStateAction<PaneSessionState[Key]>
  ) => void
}
export function createPaneSessionState(
  currentRuntimeTask: RuntimeTaskAddress | null
): PaneSessionState {
  return {
    codeCommentContexts: [],
    browserAnnotationCommand: null,
    localError: null,
    answeredRequestUserInputIds: (() => new Set())(),
    transcriptLoadingKey: (() =>
      currentRuntimeTask ? runtimeTaskLoadAddressKey(currentRuntimeTask) : null)(),
    transcriptError: null,
    transcriptReloadVersion: 0,
    transcriptHasMoreBefore: false,
    transcriptBeforeCursor: null,
    transcriptLoadingMoreBeforeKey: null,
    transcriptFullContent: false,
    loadedTranscriptRanges: [],
    turnNavigation: [],
    pendingGoalState: null,
    retainedRuntimeTaskLoadTarget: (() =>
      currentRuntimeTask ? runtimeTaskLoadTargetFromAddress(currentRuntimeTask) : null)(),
    draftMessages: [],
  }
}
