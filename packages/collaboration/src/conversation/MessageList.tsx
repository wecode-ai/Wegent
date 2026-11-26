import type { UserMessageServices } from './UserMessage'
import { MessageListMessage } from './MessageListMessage'
import { hideAnsweredQuestionSummaries } from './answeredQuestionPresentation'
import { isStandInActivityMessage, isCompletedStandInActivityTrace } from './standInActivity'
import {
  isCancelledAssistantMessage,
  shouldHideFailedAssistantContent,
  getDisplayProcessingBlocks,
} from './assistantMessagePresentation'
import { Fragment, memo, useCallback, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useDocumentEvent, useWindowEvent, useElementTypography } from '../dom-events'
import {
  createMessageTextSelectionState,
  type ConversationShareSelectionContext,
} from './messageTextSelectionState'
import { createMessageListViewportPort } from './messageListViewportPort'
import { defaultRangeExtractor, type Range as VirtualRange } from '@tanstack/react-virtual'
import type { CSSProperties, ReactNode, RefObject } from 'react'
import type { RequestUserInputResponse, TurnFileChangesSummary } from '@wegent/chat-core/runtime'
import type {
  RuntimeConversationTurn,
  SubagentBlock,
  WorkbenchMessage,
} from '@wegent/chat-core/runtime-conversation'
import type { MarkdownFileOpenOptions as WorkspaceFileOpenOptions } from '../markdown/MarkdownServices'
import { stripPluginWorkspaceResultMarkers } from '@wegent/chat-core/plugin-workspace-result'
import { activityClassNames as cn } from '../issue-detail/activityClassNames'
import { AssistantThinkingIndicator } from './AssistantThinkingIndicator'
import type { RequestUserInputPayload } from './RequestUserInputCard'
import {
  resolveAsyncRequestUserInputAnswers,
  resolveAsyncRequestUserInputReplies,
} from '@wegent/chat-core/runtime-user-input'
import {
  getMessagePretextIntrinsicHeight,
  getMessageLayoutSignature,
  readMessageLayoutTypography,
  messageLayoutTypographyFromStyles,
  MESSAGE_LAYOUT_CSS_PROPERTIES,
  getMessageFontMetricsRevision,
} from './messagePretextLayout'
import type { AssistantPlanOpenRequest } from './AssistantPlanCard'
import { getConversationVirtualMeasurements } from './conversationViewportCache'
import type { ConversationLayoutChangeReason } from './scrollableMessageTypes'
import { SelectionActionsPopover } from './SelectionActionsPopover'
import {
  useConversationVirtualizer,
  type ConversationVirtualizer,
} from './useConversationVirtualizer'
import { useMessageRowMeasure, useMessageRowMeasurements } from './useMessageRowMeasurements'
import {
  createMarkdownWindowingScope,
  useMarkdownWindowingViewport,
  MarkdownWindowingContext,
  MarkdownWindowingDisabledContext,
} from '../markdown/MarkdownWindowingScope'

export interface MessageListProps {
  showProcessingStatus?: boolean
  userMessageServices: UserMessageServices
  virtualize?: boolean
  useContentVisibility?: boolean
  onVirtualMeasurement?: (details: VirtualMessageMeasurement) => void
  renderVisualization?: (
    part: { file: string; mode?: 'wide'; title?: string },
    message: WorkbenchMessage
  ) => ReactNode
  messages: WorkbenchMessage[]
  turns?: RuntimeConversationTurn[]
  scrollElementRef?: RefObject<HTMLDivElement | null>
  scrollTailHeight?: number
  initialDistanceFromBottomPx?: number
  onBeforeUserMessageToggle?: () => void
  onVirtualLayoutChange?: (reason?: ConversationLayoutChangeReason) => void
  layoutRevision?: string
  className?: string
  conversationKey?: string | number | null
  isWaitingForAssistant?: boolean
  waitingIndicatorStyle?: 'dots'
  disableContentVisibility?: boolean
  forceVirtualMessageId?: string | null
  searchMessageId?: string
  devices?: Array<{ device_id: string; status: string }>
  onContinueInNewConversation?: () => void
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
  onShareSelectionAsIssue?: (text: string, context: ConversationShareSelectionContext) => void
  onAddSelectionToConversation?: (text: string) => void
  onAskSelectionInSidebar?: (text: string) => void
  onFillSelectionToAnswer?: (text: string) => void
  virtualScrollAdjustmentEnabled?: boolean
  virtualAnchor?: 'start' | 'end'
  virtualAnchorToEnd?: boolean
  virtualizerRef?: RefObject<ConversationVirtualizer | null>
  onVirtualScrollAdjustment?: (delta: number) => void
  onNativeScrollRange?: () => void
  renderGapAfterMessage?: (
    message: WorkbenchMessage,
    nextMessage: WorkbenchMessage | undefined
  ) => ReactNode
}

const EMPTY_TURNS: RuntimeConversationTurn[] = []
const EMPTY_DEVICES: NonNullable<MessageListProps['devices']> = []
const VIRTUAL_MESSAGE_OVERSCAN = 2
const FULLY_RENDERED_MESSAGE_COUNT = VIRTUAL_MESSAGE_OVERSCAN * 2 + 1
const MESSAGE_LIST_GAP_PX = 16
const MESSAGE_LIST_PADDING_TOP_PX = 32
const MESSAGE_LIST_PADDING_BOTTOM_PX = 8

export interface VirtualMessageMeasurement {
  messageId: string | null
  previousSize: number | null
  measuredSize: number
  previousTotalSize: number
  nextTotalSize: number
}

export const MessageList = memo(function MessageList({
  userMessageServices,
  virtualize = true,
  useContentVisibility = false,
  onVirtualMeasurement,
  renderVisualization,
  showProcessingStatus,
  messages,
  turns = EMPTY_TURNS,
  scrollElementRef,
  initialDistanceFromBottomPx = 0,
  scrollTailHeight = 0,
  onBeforeUserMessageToggle,
  onVirtualLayoutChange,
  layoutRevision,
  className,
  conversationKey,
  isWaitingForAssistant = false,
  waitingIndicatorStyle,
  disableContentVisibility = false,
  forceVirtualMessageId = null,
  searchMessageId,
  devices = EMPTY_DEVICES,
  onContinueInNewConversation,
  onRetryFailedMessage,
  onSwitchModelForFailedMessage,
  onLoadFileChangesDiff,
  onRevertFileChanges,
  onOpenFileChangesReview,
  fileChangesDiffPreviewDisabledSubtaskId,
  onOpenWorkspaceFile,
  onOpenLocalSkillFile,
  onRequestUserInputSubmit,
  onRequestUserInputIgnore,
  onOpenAssistantPlan,
  onOpenSubagent,
  onEditLastUserMessage,
  canEditLastUserMessage = false,
  onForkMessage,
  hideRequestUserInputBlocks,
  hiddenRequestUserInputIds,
  onShareSelectionAsIssue,
  onAddSelectionToConversation,
  onAskSelectionInSidebar,
  onFillSelectionToAnswer,
  virtualAnchorToEnd = true,
  virtualAnchor = 'end',
  virtualScrollAdjustmentEnabled = true,
  virtualizerRef,
  onVirtualScrollAdjustment,
  onNativeScrollRange,
  renderGapAfterMessage,
}: MessageListProps) {
  const listRef = useRef<HTMLDivElement>(null)
  // Register business font-cache invalidation before the native typography observer mounts.
  const fontEpoch = getMessageFontMetricsRevision()
  const [initialTypography] = useState(() => readMessageLayoutTypography(scrollElementRef?.current))
  const nativeTypography = useElementTypography(
    listRef,
    MESSAGE_LAYOUT_CSS_PROPERTIES,
    virtualize && scrollElementRef !== undefined,
    layoutRevision
  )
  const layout = useMemo(
    () => ({
      width: nativeTypography?.contentWidth ?? 0,
      typography: nativeTypography
        ? messageLayoutTypographyFromStyles(nativeTypography)
        : initialTypography,
      fontEpoch,
    }),
    [nativeTypography, initialTypography, fontEpoch]
  )
  const layoutWidth = layout.width
  const layoutPropertiesKey = JSON.stringify([
    className ?? null,
    layout.typography,
    layout.fontEpoch,
  ])
  const layoutKey = JSON.stringify([layoutWidth, layoutPropertiesKey])
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null)
  const [submittingEditMessageId, setSubmittingEditMessageId] = useState<string | null>(null)
  const resolvedMessages = useMemo(() => resolveAsyncRequestUserInputAnswers(messages), [messages])
  const replyQuestionsByMessageId = useMemo(
    () => resolveAsyncRequestUserInputReplies(messages),
    [messages]
  )
  const runtimeTurnsById = useMemo(
    () => new Map(turns.flatMap(turn => (turn.id ? [[turn.id, turn] as const] : []))),
    [turns]
  )
  const visibleMessages = useMemo(() => {
    const displayMessages =
      showProcessingStatus === false
        ? hideAnsweredQuestionSummaries(resolvedMessages)
        : resolvedMessages
    const userTurns = new Set(
      resolvedMessages
        .filter(message => message.role === 'user' && !isStandInActivityMessage(message))
        .map(message => message.turnId)
    )
    const activityTurns = new Set(
      resolvedMessages
        .filter(isStandInActivityMessage)
        .map(message => message.turnId)
        .filter(turnId => turnId && !userTurns.has(turnId))
    )
    return displayMessages.filter((message, index) => {
      if (isStandInActivityMessage(message)) return false
      const questionSummaryRemoved = message !== resolvedMessages[index]
      if (questionSummaryRemoved && !shouldRenderMessage(message, false)) return false
      if (message.turnId && activityTurns.has(message.turnId) && message.role === 'assistant') {
        const turn = runtimeTurnsById.get(message.turnId)
        if (message.status !== 'done' || (turn && turn.status !== 'done')) return true
        if (
          turn?.error ||
          turn?.stoppedNotice ||
          turn?.fileChanges ||
          turn?.references?.length ||
          turn?.memoryCitations?.length
        )
          return true
        if (isCompletedStandInActivityTrace(message)) return false
      }
      return questionSummaryRemoved || shouldRenderMessage(message)
    })
  }, [resolvedMessages, runtimeTurnsById, showProcessingStatus])
  // Native crash history may retain an open status; only its latest root turn is live.
  const latestNativeTurnId = turns[findLastIndex(turns, turn => turn.id !== null)]?.id
  const lastAssistantMessageIdByTurn = useMemo(() => {
    const result = new Map<string, string>()
    visibleMessages.forEach(message => {
      if (message.role === 'assistant' && message.turnId) {
        result.set(message.turnId, message.id)
      }
    })
    return result
  }, [visibleMessages])
  const editableLastUserMessageId = useMemo(
    () =>
      editableLastUserMessage(
        visibleMessages,
        canEditLastUserMessage && Boolean(onEditLastUserMessage)
      )?.id ?? null,
    [canEditLastUserMessage, onEditLastUserMessage, visibleMessages]
  )
  const activeEditingMessageId =
    editingMessageId === editableLastUserMessageId ? editingMessageId : null
  const activeSubmittingEditMessageId =
    submittingEditMessageId === editableLastUserMessageId ? submittingEditMessageId : null
  const shouldShowWaitingIndicator =
    isWaitingForAssistant &&
    // Outcome views hide the thinking indicator inside streaming assistant messages.
    (showProcessingStatus === false ||
      waitingIndicatorStyle === 'dots' ||
      !resolvedMessages.some(
        message => message.role === 'assistant' && message.status === 'streaming'
      ))
  const rowCount = visibleMessages.length + (shouldShowWaitingIndicator ? 1 : 0)
  const hasViewportRows = virtualize && scrollElementRef !== undefined
  // The complete list already fits within the virtualizer's render budget.
  // Keep the same row nodes and let the browser size them directly.
  const virtualMessages = hasViewportRows && rowCount > FULLY_RENDERED_MESSAGE_COUNT
  // Validate the actual column before hydrating sizes or preparing the transcript.
  const virtualLayoutReady = virtualMessages && layoutWidth > 0
  const virtualMeasurementKey =
    virtualMessages && conversationKey != null ? String(conversationKey) : null
  const measurementSignatures = useMemo(
    () =>
      new Map(
        virtualMessages
          ? visibleMessages.map(message => [message.id, getMessageLayoutSignature(message)])
          : []
      ),
    [visibleMessages, virtualMessages]
  )
  const measurementLayout = useMemo(
    () => ({ key: layoutKey, messages: measurementSignatures }),
    [layoutKey, measurementSignatures]
  )
  const initialMeasurementsCache = useMemo(
    () =>
      virtualMeasurementKey === null
        ? []
        : (getConversationVirtualMeasurements(virtualMeasurementKey, measurementLayout) ?? []),
    [measurementLayout, virtualMeasurementKey]
  )
  const measuredSizes = useMemo(
    () => new Map(initialMeasurementsCache.map(item => [item.key, item.size])),
    [initialMeasurementsCache]
  )
  const listLayoutClass = className
    ? 'mx-auto flex min-w-0 shrink-0 flex-col gap-4 pb-2 pt-8'
    : 'mx-auto flex w-full min-w-0 max-w-3xl shrink-0 flex-col gap-4 px-6 pb-2 pt-8'
  const forcedVirtualMessageIndex = useMemo(
    () =>
      forceVirtualMessageId === null
        ? -1
        : visibleMessages.findIndex(message => message.id === forceVirtualMessageId),
    [forceVirtualMessageId, visibleMessages]
  )
  const streamingVirtualMessageIndex = useMemo(
    () => findLastIndex(visibleMessages, message => message.status === 'streaming'),
    [visibleMessages]
  )
  const sizingKey = (message: WorkbenchMessage) =>
    message.status === 'streaming' ? undefined : measurementLayout.messages.get(message.id)
  const readRows = () =>
    visibleMessages.map(message => ({
      id: message.id,
      size: sizingKey(message),
    }))
  const [previousRows, setRows] = useState(readRows)
  const rowsChanged =
    previousRows.length !== visibleMessages.length ||
    visibleMessages.some(
      (message, index) =>
        message.id !== previousRows[index].id || sizingKey(message) !== previousRows[index].size
    )
  const geometryRows = rowsChanged ? readRows() : previousRows
  if (rowsChanged) setRows(geometryRows)
  // TanStack rebuilds its geometry when the key reader changes. Streamed text
  // updates keep the same rows and ResizeObserver supplies their real sizes.
  const getItemKey = useCallback(
    (index: number) => geometryRows[index]?.id ?? 'assistant-waiting',
    [geometryRows]
  )
  const estimateSize = useCallback(
    (index: number) => {
      const message = visibleMessages[index]
      if (!message) return 32
      if (!virtualLayoutReady) return 220
      return Math.ceil(
        measuredSizes.get(message.id) ??
          getMessagePretextIntrinsicHeight(message, layoutWidth, layout.typography)
      )
    },
    [measuredSizes, layoutWidth, layout.typography, virtualLayoutReady, visibleMessages]
  )
  const rangeExtractor = useCallback(
    (range: VirtualRange) => {
      const indexes = defaultRangeExtractor(range)
      const forcedIndexes = [
        ...new Set([forcedVirtualMessageIndex, streamingVirtualMessageIndex]),
      ].filter(index => index >= 0 && !indexes.includes(index))
      return [...indexes, ...forcedIndexes].sort((left, right) => left - right)
    },
    [forcedVirtualMessageIndex, streamingVirtualMessageIndex]
  )
  const [viewportPort] = useState(createMessageListViewportPort)
  const recordMeasurement = useCallback(
    (row: HTMLElement, width: number, size: number) => {
      viewportPort.recordMeasurement(row, width, size, layoutWidth, measurementLayout)
    },
    [viewportPort, layoutWidth, measurementLayout]
  )
  const measureElement = useMessageRowMeasure(onVirtualMeasurement, recordMeasurement, layoutWidth)
  const {
    virtualizer: messageVirtualizer,
    tailHeight,
    scrollMargin,
    viewportReady,
  } = useConversationVirtualizer({
    count: rowCount,
    enabled: virtualLayoutReady,
    getItemKey,
    estimateSize,
    measureElement,
    gap: MESSAGE_LIST_GAP_PX,
    paddingStart: MESSAGE_LIST_PADDING_TOP_PX,
    paddingEnd: MESSAGE_LIST_PADDING_BOTTOM_PX,
    overscan: VIRTUAL_MESSAGE_OVERSCAN,
    anchorTo: virtualAnchor,
    scrollEndThreshold: virtualAnchorToEnd ? 8 : -1,
    followOnAppend: virtualAnchorToEnd ? 'auto' : false,
    rangeExtractor,
    initialMeasurementsCache,
    initialDistanceFromBottomPx,
    scrollTailHeight,
    scrollElementRef,
    listRef,
    virtualizerRef,
    onScrollAdjustment: onVirtualScrollAdjustment,
  })
  messageVirtualizer.shouldAdjustScrollPositionOnItemSizeChange = virtualScrollAdjustmentEnabled
    ? undefined
    : () => false
  const virtualTotalSize = virtualMessages ? messageVirtualizer.getTotalSize() : 0
  const virtualRows = messageVirtualizer.getVirtualItems()
  const { measureRow, measureRows } = useMessageRowMeasurements(
    listRef,
    messageVirtualizer,
    virtualLayoutReady
  )
  const markdownWindowingState = useMemo(() => {
    const scope = createMarkdownWindowingScope(
      scrollElementRef,
      (element, materialized) => viewportPort.chunkLayout(scope, element, materialized),
      layout.typography.rootFontSize,
      onNativeScrollRange
    )
    return { conversationKey, scope }
  }, [
    conversationKey,
    scrollElementRef,
    layoutPropertiesKey,
    layout.typography.rootFontSize,
    viewportPort,
    onNativeScrollRange,
  ])
  useMarkdownWindowingViewport(markdownWindowingState.scope)

  const hasSelectionActions = Boolean(
    onShareSelectionAsIssue ||
    onAddSelectionToConversation ||
    onAskSelectionInSidebar ||
    onFillSelectionToAnswer
  )
  const selectionState = useMemo(
    () =>
      createMessageTextSelectionState(conversationKey, useContentVisibility, hasSelectionActions),
    [conversationKey, useContentVisibility, hasSelectionActions]
  )
  const { isTextSelectionActive, textSelection } = useSyncExternalStore(
    selectionState.subscribe,
    selectionState.getSnapshot,
    selectionState.getSnapshot
  )
  const observeSelection = useContentVisibility || hasSelectionActions
  useDocumentEvent('pointerup', selectionState.finalize, {
    enabled: observeSelection,
  })
  useDocumentEvent('pointercancel', selectionState.finalize, {
    enabled: observeSelection,
  })
  useDocumentEvent('mouseup', selectionState.finalize, {
    enabled: observeSelection,
  })
  useDocumentEvent('keyup', selectionState.finalize, {
    enabled: observeSelection,
  })
  useDocumentEvent('focusin', selectionState.finalize, {
    enabled: observeSelection,
  })
  useDocumentEvent('selectionchange', selectionState.schedule, {
    enabled: observeSelection,
  })
  useWindowEvent('scroll', () => selectionState.update(true), {
    capture: true,
    enabled: observeSelection && (isTextSelectionActive || textSelection !== null),
  })
  useWindowEvent('blur', () => selectionState.update(), {
    enabled: observeSelection,
  })
  const attachList = useCallback(
    (element: HTMLDivElement | null) => {
      listRef.current = element
      if (!element) return
      const release = selectionState.attach(element)
      const releaseViewport = viewportPort.attach(element)
      return () => {
        listRef.current = null
        release()
        releaseViewport()
      }
    },
    [selectionState, viewportPort]
  )
  useLayoutEffect(() => {
    viewportPort.update({
      scope: markdownWindowingState.scope,
      virtual: virtualMessages,
      ready: virtualLayoutReady,
      layoutKey,
      layoutWidth,
      layoutPropertiesKey,
      measurementKey: virtualMeasurementKey,
      measurementLayout,
      virtualizer: messageVirtualizer,
      rows: virtualRows,
      totalSize: virtualTotalSize,
      searchMessageId,
      scrollElementRef,
      measureRow,
      measureRows,
      onLayoutChange: onVirtualLayoutChange,
    })
  })

  const applySelectionAction = (action: (text: string) => void) => {
    if (!textSelection) return
    action(textSelection.text)
    document.getSelection()?.removeAllRanges()
    selectionState.clearCapture()
  }

  if (visibleMessages.length === 0 && !shouldShowWaitingIndicator) {
    return null
  }

  const content = (
    <div
      ref={attachList}
      className={cn(listLayoutClass, className, virtualMessages && 'relative gap-0 pb-0 pt-0')}
      data-conversation-message-list=""
      data-conversation-layout-width={layoutWidth}
      data-conversation-message-count={messages.length}
      data-conversation-visible-count={visibleMessages.length}
      data-conversation-virtual-messages={virtualMessages}
      data-conversation-viewport-ready={viewportReady}
      data-conversation-virtualizer-enabled={messageVirtualizer.options.enabled}
      data-conversation-virtual-row-count={virtualRows.length}
      data-conversation-virtual-range={JSON.stringify(messageVirtualizer.range ?? null)}
      data-conversation-scroll-rect={JSON.stringify(messageVirtualizer.scrollRect ?? null)}
      data-conversation-scroll-connected={messageVirtualizer.scrollElement?.isConnected ?? false}
      data-conversation-scroll-element={
        messageVirtualizer.scrollElement
          ? (messageVirtualizer.scrollElement.dataset.testid ?? 'unmarked')
          : 'none'
      }
    >
      {hasSelectionActions &&
        textSelection &&
        textSelection.conversationKey === conversationKey && (
          <SelectionActionsPopover
            position={{ left: textSelection.left, top: textSelection.top }}
            onShareAsIssue={
              onShareSelectionAsIssue
                ? () =>
                    applySelectionAction(text =>
                      onShareSelectionAsIssue(text, {
                        ...textSelection,
                        messages,
                        turns,
                      })
                    )
                : undefined
            }
            onAddToConversation={
              onAddSelectionToConversation
                ? () => applySelectionAction(onAddSelectionToConversation)
                : undefined
            }
            onAskInSidebar={
              onAskSelectionInSidebar
                ? () => applySelectionAction(onAskSelectionInSidebar)
                : undefined
            }
            onFillAnswer={
              onFillSelectionToAnswer
                ? () => applySelectionAction(onFillSelectionToAnswer)
                : undefined
            }
          />
        )}
      {(virtualMessages
        ? virtualRows.map((virtualRow, position) => ({
            index: virtualRow.index,
            key: virtualRow.key,
            style: {
              flexShrink: 0,
              marginTop: Math.max(
                0,
                virtualRow.start - (virtualRows[position - 1]?.end ?? scrollMargin)
              ),
            } satisfies CSSProperties,
          }))
        : Array.from({ length: rowCount }, (_, index) => ({
            index,
            key: visibleMessages[index]?.id ?? 'assistant-waiting',
            style: undefined,
          }))
      ).map(row => {
        const { index } = row
        const message = visibleMessages[index]
        if (!message)
          return (
            <article
              key={row.key}
              data-index={hasViewportRows ? index : undefined}
              data-message-row={hasViewportRows ? true : undefined}
              style={row.style}
              className="min-w-0"
              role={waitingIndicatorStyle === 'dots' ? undefined : 'status'}
              data-testid="message-assistant-waiting"
            >
              <AssistantThinkingIndicator variant={waitingIndicatorStyle} />
            </article>
          )
        const nextMessage = visibleMessages[index + 1]
        const isHistoricalTurn = Boolean(
          message.turnId && latestNativeTurnId && message.turnId !== latestNativeTurnId
        )
        const article = (
          <article
            className={cn(
              'min-w-0',
              useContentVisibility &&
                !disableContentVisibility &&
                searchMessageId !== message.id &&
                !isTextSelectionActive &&
                '[content-visibility:auto]',
              message.role === 'user' && 'flex justify-end'
            )}
            data-message-id={message.id}
            data-testid={`message-${message.role}`}
          >
            <MessageListMessage
              message={message}
              runtimeTurn={
                message.turnId && lastAssistantMessageIdByTurn.get(message.turnId) === message.id
                  ? runtimeTurnsById.get(message.turnId)
                  : undefined
              }
              forceExpanded={searchMessageId === message.id}
              // Waiting for the next assistant must not keep a completed turn's process open.
              isActiveTurn={
                message.role === 'assistant' && message.status === 'streaming' && !isHistoricalTurn
              }
              isHistoricalTurn={isHistoricalTurn}
              userMessageServices={userMessageServices}
              renderVisualization={renderVisualization}
              showProcessingStatus={showProcessingStatus}
              conversationKey={conversationKey}
              devices={devices}
              replyQuestions={replyQuestionsByMessageId.get(message.id)}
              editable={message.id === editableLastUserMessageId}
              editing={message.id === activeEditingMessageId}
              editSubmitting={message.id === activeSubmittingEditMessageId}
              setEditingMessageId={setEditingMessageId}
              setSubmittingEditMessageId={setSubmittingEditMessageId}
              onBeforeUserMessageToggle={onBeforeUserMessageToggle}
              onOpenWorkspaceFile={onOpenWorkspaceFile}
              onOpenLocalSkillFile={onOpenLocalSkillFile}
              onEditLastUserMessage={onEditLastUserMessage}
              onContinueInNewConversation={onContinueInNewConversation}
              onRetryFailedMessage={onRetryFailedMessage}
              onSwitchModelForFailedMessage={onSwitchModelForFailedMessage}
              onLoadFileChangesDiff={onLoadFileChangesDiff}
              onRevertFileChanges={onRevertFileChanges}
              onOpenFileChangesReview={onOpenFileChangesReview}
              fileChangesDiffPreviewDisabledSubtaskId={fileChangesDiffPreviewDisabledSubtaskId}
              onRequestUserInputSubmit={onRequestUserInputSubmit}
              onRequestUserInputIgnore={onRequestUserInputIgnore}
              onOpenAssistantPlan={onOpenAssistantPlan}
              onOpenSubagent={onOpenSubagent}
              hideRequestUserInputBlocks={hideRequestUserInputBlocks}
              hiddenRequestUserInputIds={hiddenRequestUserInputIds}
              onForkMessage={onForkMessage}
            />
          </article>
        )
        const searchableArticle = (
          <MarkdownWindowingDisabledContext.Provider value={searchMessageId === message.id}>
            {article}
          </MarkdownWindowingDisabledContext.Provider>
        )
        const gap = renderGapAfterMessage?.(message, nextMessage)
        return hasViewportRows ? (
          <div key={row.key} data-index={index} data-message-row style={row.style}>
            {searchableArticle}
            {gap}
          </div>
        ) : (
          <Fragment key={row.key}>
            {searchableArticle}
            {gap}
          </Fragment>
        )
      })}
      {virtualMessages && (
        <div
          aria-hidden="true"
          className="shrink-0"
          data-virtual-message-tail
          style={{
            height: Math.max(
              0,
              virtualTotalSize -
                tailHeight -
                (virtualRows.at(-1)?.end ?? scrollMargin) +
                scrollMargin
            ),
          }}
        />
      )}
    </div>
  )
  return (
    <MarkdownWindowingContext.Provider value={markdownWindowingState.scope}>
      {content}
    </MarkdownWindowingContext.Provider>
  )
})

function shouldRenderMessage(message: WorkbenchMessage, allowEmptyStreaming = true): boolean {
  if (message.role !== 'assistant') return true
  if ((allowEmptyStreaming && message.status === 'streaming') || message.status === 'failed')
    return true
  if (isCancelledAssistantMessage(message)) return true
  if (message.fileChanges) return true
  if (message.references?.length || message.memoryCitations?.length) {
    return true
  }

  const visibleContent = shouldHideFailedAssistantContent(message)
    ? ''
    : stripPluginWorkspaceResultMarkers(message.content)
  if (visibleContent.trim()) return true

  return getDisplayProcessingBlocks(message.blocks).length > 0
}

function editableLastUserMessage(
  messages: WorkbenchMessage[],
  canEdit: boolean
): WorkbenchMessage | null {
  if (!canEdit) return null

  const lastUserIndex = findLastIndex(messages, message => message.role === 'user')
  if (lastUserIndex === -1) return null

  const followingMessages = messages.slice(lastUserIndex + 1)
  if (followingMessages.length === 0) return null
  if (followingMessages.some(message => message.status === 'streaming')) return null
  if (!followingMessages.some(message => message.role === 'assistant')) return null

  return messages[lastUserIndex] ?? null
}

function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (item !== undefined && predicate(item)) return index
  }
  return -1
}
