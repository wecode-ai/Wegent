import type { ReactNode } from 'react'
import type { RefObject } from 'react'

import type {
  RequestUserInputResponse,
  RuntimeTurnNavigationItem,
  TurnFileChangesSummary,
} from '@wegent/chat-core/runtime'
import type {
  RuntimeConversationTurn,
  SubagentBlock,
  WorkbenchMessage,
} from '@wegent/chat-core/runtime-conversation'
import type { MarkdownFileOpenOptions as WorkspaceFileOpenOptions } from '../markdown/MarkdownServices'
import { type MessageListProps } from './MessageList'
import type { ConversationSearchTarget } from './useConversationSearchTarget'
import type { ConversationMessageTarget } from './turnNavigationTypes'
import type { ConversationViewportAnchor } from './conversationViewportCache'

import type { RequestUserInputPayload } from './RequestUserInputCard'
import type { AssistantPlanOpenRequest } from './AssistantPlanCard'

export const BOTTOM_THRESHOLD = 48
export const SCROLLED_TO_BOTTOM_THRESHOLD = 8
export const SCROLL_ANCHOR_SELECTOR = '[data-scroll-anchor]'
export interface RuntimeTranscriptGap {
  start: number
  end: number
}

export interface RuntimeTranscriptRange {
  start: number
  end: number
}

export interface UserViewportAnchor extends ConversationViewportAnchor {
  element: HTMLElement
  scrollTopPx: number
}

export interface ScrollableMessageAreaProps extends Pick<
  MessageListProps,
  | 'userMessageServices'
  | 'virtualize'
  | 'useContentVisibility'
  | 'onVirtualMeasurement'
  | 'renderVisualization'
> {
  messages: WorkbenchMessage[]
  renderGapAfterMessage?: MessageListProps['renderGapAfterMessage']
  turns?: RuntimeConversationTurn[]
  loading?: boolean
  historyError?: ReactNode
  isWaitingForAssistant?: boolean
  hasMoreBefore?: boolean
  beforeCursor?: string | null
  loadingMoreBefore?: boolean
  historyLoadingMode?: 'automatic' | 'manual'
  turnNavigation?: RuntimeTurnNavigationItem[]
  loadedTranscriptRanges?: RuntimeTranscriptRange[]
  className?: string
  scrollerClassName?: string
  contentClassName?: string
  messageListClassName?: string
  contentFooter?: ReactNode
  contentFooterClassName?: string
  stickyFooter?: ReactNode
  stickyFooterClassName?: string
  scrollButtonClassName?: string
  scrollTestId?: string
  externalScrollRef?: RefObject<HTMLDivElement | null>
  externalScrollInteractionRef?: RefObject<HTMLElement | null>
  turnNavigationPortalTarget?: Element | null
  conversationKey?: string | number | null
  devices?: MessageListProps['devices']
  onRetryFailedMessage?: (message: WorkbenchMessage) => void
  onSwitchModelForFailedMessage?: (message: WorkbenchMessage) => void
  onLoadFileChangesDiff?: (
    subtaskId: string,
    fileChanges?: TurnFileChangesSummary
  ) => Promise<string>
  onRevertFileChanges?: (
    subtaskId: string,
    fileChanges?: TurnFileChangesSummary
  ) => Promise<TurnFileChangesSummary>
  onOpenFileChangesReview?: (request: {
    subtaskId: string
    loadDiff: () => Promise<string>
    reviewTitle?: string
    defaultFileTreeVisible?: boolean
    focusFilePath?: string
  }) => void
  fileChangesDiffPreviewDisabledSubtaskId?: string | null
  onOpenWorkspaceFile?: (path: string, options?: WorkspaceFileOpenOptions) => void
  onOpenLocalSkillFile?: (path: string) => void
  onRequestUserInputSubmit?: (response: RequestUserInputResponse) => void
  onRequestUserInputIgnore?: (payload: RequestUserInputPayload) => void
  onOpenAssistantPlan?: (request: AssistantPlanOpenRequest) => void
  onOpenSubagent?: (block: SubagentBlock) => void
  onEditLastUserMessage?: (
    message: WorkbenchMessage,
    content: string
  ) => Promise<boolean | void> | boolean | void
  canEditLastUserMessage?: boolean
  onForkMessage?: (message: WorkbenchMessage) => Promise<void> | void
  hideRequestUserInputBlocks?: boolean
  hiddenRequestUserInputIds?: ReadonlySet<string>
  onAddSelectionToConversation?: (text: string) => void
  onAskSelectionInSidebar?: (text: string) => void
  onFillSelectionToAnswer?: (text: string) => void
  autoScrollSuspended?: boolean
  searchTarget?: ConversationSearchTarget | null
  messageTarget?: ConversationMessageTarget
  searchNavigationPaused?: boolean
  onSearchNavigationFailure?: (target: ConversationSearchTarget) => void
  onLoadMoreBefore?: () => Promise<void> | void
  onLoadTurnNavigationItem?: (item: RuntimeTurnNavigationItem) => Promise<void> | void
  onLoadTranscriptGap?: (gap: RuntimeTranscriptGap) => Promise<void> | void
  initialScrollPosition?: 'restore' | 'latest'
}
