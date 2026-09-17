import type { ReactNode } from 'react'
import type { RefObject } from 'react'

import type {
  RequestUserInputResponse,
  RuntimeTurnNavigationItem,
  TurnFileChangesSummary,
} from '@wegent/chat-core/runtime'
import type { SubagentBlock, WorkbenchMessage } from '@wegent/chat-core/runtime-conversation'
import type { MarkdownFileOpenOptions as WorkspaceFileOpenOptions } from '../markdown/MarkdownServices'
import { type MessageListProps } from './MessageList'

import type { RequestUserInputPayload } from './RequestUserInputCard'
import type { AssistantPlanOpenRequest } from './AssistantPlanCard'

export const BOTTOM_THRESHOLD = 48
export const SCROLLED_TO_BOTTOM_THRESHOLD = 8
export const STABLE_SCROLL_DELAYS = [0, 50, 150, 300, 600, 1000]
export const STABLE_SCROLL_RELEASE_RETRIES = 12
export const SCROLL_ANCHOR_SELECTOR = '[data-scroll-anchor]'
export interface RuntimeTranscriptGap {
  start: number
  end: number
}

export interface RuntimeTranscriptRange {
  start: number
  end: number
}

export interface UserViewportAnchor {
  messageId: string
  anchorIndex: number
  offsetFromScrollerTop: number
  textOffset: number | null
  scrollTopPx: number
  maximumOffsetPx: number
  clientWidthPx: number
  clientHeightPx: number
}

export interface PendingLayoutScrollPosition {
  conversationKey: string | null
  scrollHeightPx: number
  distanceFromBottomPx: number
  distanceFromTopPx?: number
  previousOverflowAnchor: string
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
  loading?: boolean
  isWaitingForAssistant?: boolean
  hasMoreBefore?: boolean
  loadingMoreBefore?: boolean
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
  autoScrollSuspended?: boolean
  onLoadMoreBefore?: () => Promise<void> | void
  onLoadTurnNavigationItem?: (item: RuntimeTurnNavigationItem) => Promise<void> | void
  onLoadTranscriptGap?: (gap: RuntimeTranscriptGap) => Promise<void> | void
  initialScrollPosition?: 'restore' | 'latest'
  scrollOrigin?: 'top' | 'bottom'
}

export function areScrollableMessageAreaPropsEqual(
  previous: ScrollableMessageAreaProps,
  next: ScrollableMessageAreaProps
): boolean {
  const changed = [
    previous.userMessageServices !== next.userMessageServices ? 'userMessageServices' : null,
    previous.virtualize !== next.virtualize ? 'virtualize' : null,
    previous.useContentVisibility !== next.useContentVisibility ? 'useContentVisibility' : null,
    previous.onVirtualMeasurement !== next.onVirtualMeasurement ? 'onVirtualMeasurement' : null,
    previous.renderVisualization !== next.renderVisualization ? 'renderVisualization' : null,
    previous.messages !== next.messages ? 'messages' : null,
    previous.loading !== next.loading ? 'loading' : null,
    previous.isWaitingForAssistant !== next.isWaitingForAssistant ? 'isWaitingForAssistant' : null,
    previous.hasMoreBefore !== next.hasMoreBefore ? 'hasMoreBefore' : null,
    previous.loadingMoreBefore !== next.loadingMoreBefore ? 'loadingMoreBefore' : null,
    previous.turnNavigation !== next.turnNavigation ? 'turnNavigation' : null,
    previous.loadedTranscriptRanges !== next.loadedTranscriptRanges
      ? 'loadedTranscriptRanges'
      : null,
    previous.className !== next.className ? 'className' : null,
    previous.scrollerClassName !== next.scrollerClassName ? 'scrollerClassName' : null,
    previous.contentClassName !== next.contentClassName ? 'contentClassName' : null,
    previous.messageListClassName !== next.messageListClassName ? 'messageListClassName' : null,
    previous.contentFooter !== next.contentFooter ? 'contentFooter' : null,
    previous.contentFooterClassName !== next.contentFooterClassName
      ? 'contentFooterClassName'
      : null,
    previous.stickyFooter !== next.stickyFooter ? 'stickyFooter' : null,
    previous.stickyFooterClassName !== next.stickyFooterClassName ? 'stickyFooterClassName' : null,
    previous.scrollButtonClassName !== next.scrollButtonClassName ? 'scrollButtonClassName' : null,
    previous.scrollTestId !== next.scrollTestId ? 'scrollTestId' : null,
    previous.externalScrollRef !== next.externalScrollRef ? 'externalScrollRef' : null,
    previous.turnNavigationPortalTarget !== next.turnNavigationPortalTarget
      ? 'turnNavigationPortalTarget'
      : null,
    previous.conversationKey !== next.conversationKey ? 'conversationKey' : null,
    previous.devices !== next.devices ? 'devices' : null,
    previous.onRetryFailedMessage !== next.onRetryFailedMessage ? 'onRetryFailedMessage' : null,
    previous.onSwitchModelForFailedMessage !== next.onSwitchModelForFailedMessage
      ? 'onSwitchModelForFailedMessage'
      : null,
    previous.onLoadFileChangesDiff !== next.onLoadFileChangesDiff ? 'onLoadFileChangesDiff' : null,
    previous.onRevertFileChanges !== next.onRevertFileChanges ? 'onRevertFileChanges' : null,
    previous.onOpenFileChangesReview !== next.onOpenFileChangesReview
      ? 'onOpenFileChangesReview'
      : null,
    previous.fileChangesDiffPreviewDisabledSubtaskId !==
    next.fileChangesDiffPreviewDisabledSubtaskId
      ? 'fileChangesDiffPreviewDisabledSubtaskId'
      : null,
    previous.onOpenWorkspaceFile !== next.onOpenWorkspaceFile ? 'onOpenWorkspaceFile' : null,
    previous.onOpenLocalSkillFile !== next.onOpenLocalSkillFile ? 'onOpenLocalSkillFile' : null,
    previous.onRequestUserInputSubmit !== next.onRequestUserInputSubmit
      ? 'onRequestUserInputSubmit'
      : null,
    previous.onRequestUserInputIgnore !== next.onRequestUserInputIgnore
      ? 'onRequestUserInputIgnore'
      : null,
    previous.onOpenAssistantPlan !== next.onOpenAssistantPlan ? 'onOpenAssistantPlan' : null,
    previous.onOpenSubagent !== next.onOpenSubagent ? 'onOpenSubagent' : null,
    previous.onEditLastUserMessage !== next.onEditLastUserMessage ? 'onEditLastUserMessage' : null,
    previous.onForkMessage !== next.onForkMessage ? 'onForkMessage' : null,
    previous.canEditLastUserMessage !== next.canEditLastUserMessage
      ? 'canEditLastUserMessage'
      : null,
    previous.hideRequestUserInputBlocks !== next.hideRequestUserInputBlocks
      ? 'hideRequestUserInputBlocks'
      : null,
    previous.hiddenRequestUserInputIds !== next.hiddenRequestUserInputIds
      ? 'hiddenRequestUserInputIds'
      : null,
    previous.onAddSelectionToConversation !== next.onAddSelectionToConversation
      ? 'onAddSelectionToConversation'
      : null,
    previous.onAskSelectionInSidebar !== next.onAskSelectionInSidebar
      ? 'onAskSelectionInSidebar'
      : null,
    previous.autoScrollSuspended !== next.autoScrollSuspended ? 'autoScrollSuspended' : null,
    previous.onLoadMoreBefore !== next.onLoadMoreBefore ? 'onLoadMoreBefore' : null,
    previous.onLoadTurnNavigationItem !== next.onLoadTurnNavigationItem
      ? 'onLoadTurnNavigationItem'
      : null,
    previous.onLoadTranscriptGap !== next.onLoadTranscriptGap ? 'onLoadTranscriptGap' : null,
    previous.initialScrollPosition !== next.initialScrollPosition ? 'initialScrollPosition' : null,
    previous.scrollOrigin !== next.scrollOrigin ? 'scrollOrigin' : null,
  ].filter((key): key is string => key !== null)

  return changed.length === 0
}
