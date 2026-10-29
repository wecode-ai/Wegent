import { ArrowDown } from 'lucide-react'
import { memo, useCallback, useMemo } from 'react'

import { useConversationTranslation } from './ConversationTranslation'
import { activityClassNames as cn } from '../issue-detail/activityClassNames'
import { CompositedSpinner } from '../issue-detail/CompositedSpinner'

import { MessageList } from './MessageList'
import { MessageTurnNavigation } from './MessageTurnNavigation'
import { ConversationHistoryBoundary } from './ConversationHistoryBoundary'

import { getConversationScrollSnapshot } from './conversationViewportCache'
import type { ScrollableMessageAreaProps } from './scrollableMessageTypes'
import { getInitialDistanceFromBottomPx } from './conversationScrollGeometry'
import { useConversationScrollController } from './useConversationScrollController'
import { useConversationSearchTarget } from './useConversationSearchTarget'
export const ScrollableMessageArea = memo(function ScrollableMessageArea(
  props: ScrollableMessageAreaProps
) {
  return <ScrollableMessagePaneContent {...props} />
})

function ScrollableMessagePaneContent({
  userMessageServices,
  virtualize = true,
  useContentVisibility,
  onVirtualMeasurement,
  renderVisualization,
  messages,
  renderGapAfterMessage,
  turns,
  loading = false,
  historyError,
  isWaitingForAssistant = false,
  hasMoreBefore = false,
  loadingMoreBefore = false,
  historyLoadingMode = 'automatic',
  turnNavigation,
  loadedTranscriptRanges,
  className,
  scrollerClassName,
  contentClassName,
  messageListClassName,
  contentFooter,
  contentFooterClassName,
  stickyFooter,
  stickyFooterClassName,
  scrollButtonClassName,
  scrollTestId = 'chat-message-scroll-area',
  externalScrollRef,
  externalScrollInteractionRef,
  turnNavigationPortalTarget,
  conversationKey,
  devices,
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
  canEditLastUserMessage,
  onForkMessage,
  hideRequestUserInputBlocks,
  hiddenRequestUserInputIds,
  onAddSelectionToConversation,
  onAskSelectionInSidebar,
  autoScrollSuspended = false,
  searchTarget,
  searchNavigationPaused = false,
  onSearchNavigationFailure,
  onLoadMoreBefore,
  onLoadTurnNavigationItem,
  onLoadTranscriptGap,
  initialScrollPosition = 'restore',
}: ScrollableMessageAreaProps) {
  const { t, translate } = useConversationTranslation()
  const {
    internalScrollRef,
    scrollRef,
    contentRef,
    stickyFooterRef,
    contentFooterRef,
    scrollTailHeight,
    virtualizerRef,
    currentScrollKey,
    showScrollButton,
    turnNavigationLoading,
    turnNavigationTargetMessageId,
    handleTurnNavigationScrollTargetChange,
    handleTurnNavigationLoadStateChange,
    handleContentLayoutChange,
    handleScrollToBottom,
    preserveScrollPositionForNextLayout,
    prepareForHistoryPrepend,
    preserveUserMessagePosition,
    renderTranscriptGapAfterMessage,
    onVirtualScrollAdjustment,
    virtualAnchorToEnd,
    virtualAnchor,
    virtualScrollAdjustmentEnabled,
  } = useConversationScrollController({
    messages,
    externalScrollRef,
    externalScrollInteractionRef,
    loading,
    isWaitingForAssistant,
    conversationKey,
    onLoadTranscriptGap,
    loadedTranscriptRanges,
    autoScrollSuspended,
    initialScrollPosition,
  })
  const hasMessages = messages.length > 0
  const firstMessage = messages[0]
  const firstAssistantMessage = messages.find(message => message.role === 'assistant')
  const historyBoundaryKey = JSON.stringify([
    loadedTranscriptRanges?.[0]?.start,
    firstMessage?.id,
    firstAssistantMessage?.id,
    firstAssistantMessage?.runtimeDisplayItems?.[0]?.id,
    firstAssistantMessage?.blocks?.[0]?.id,
  ])
  const prepareHistory = useCallback(
    (automatic: boolean) => {
      if (automatic) prepareForHistoryPrepend()
      else preserveScrollPositionForNextLayout()
    },
    [prepareForHistoryPrepend, preserveScrollPositionForNextLayout]
  )
  // Initial virtual positioning belongs to the list mount, not subsequent search scrolling.
  const initialDistanceFromBottomPx = useMemo(
    () =>
      hasMessages && initialScrollPosition === 'restore'
        ? getInitialDistanceFromBottomPx(currentScrollKey)
        : 0,
    [currentScrollKey, hasMessages, initialScrollPosition]
  )
  const renderMessageGap = useCallback<
    NonNullable<ScrollableMessageAreaProps['renderGapAfterMessage']>
  >(
    (message, nextMessage) => {
      const transcriptGap = renderTranscriptGapAfterMessage?.(message, nextMessage)
      const customGap = renderGapAfterMessage?.(message, nextMessage)
      if (!transcriptGap) return customGap
      if (!customGap) return transcriptGap
      return (
        <>
          {transcriptGap}
          {customGap}
        </>
      )
    },
    [renderTranscriptGapAfterMessage, renderGapAfterMessage]
  )
  useConversationSearchTarget({
    target: searchTarget,
    navigationPaused: searchNavigationPaused,
    contentRef,
    scrollRef,
    interactionRef: externalScrollInteractionRef,
    onNavigationTargetChange: handleTurnNavigationScrollTargetChange,
    onNavigationFailure: onSearchNavigationFailure,
  })
  const scrollToBottomButton = showScrollButton ? (
    <button
      type="button"
      data-testid="scroll-to-bottom-button"
      onClick={handleScrollToBottom}
      className={cn(
        'absolute bottom-4 left-1/2 z-10 flex h-9 w-9 -translate-x-1/2 items-center justify-center rounded-full border border-border bg-surface text-text-primary shadow-sm hover:bg-muted',
        scrollButtonClassName
      )}
      aria-label={t('workbench.scroll_to_bottom')}
    >
      <ArrowDown className="h-4 w-4" />
    </button>
  ) : null

  return (
    <div className={cn('relative min-h-0 flex-1', className)}>
      {loadingMoreBefore && !autoScrollSuspended && (
        <div
          role="status"
          aria-label={t('workbench.loading_older_messages')}
          data-testid="runtime-transcript-history-loading"
          className="pointer-events-none absolute inset-x-0 top-2 z-20 flex justify-center"
        >
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-background/90 text-text-secondary">
            <CompositedSpinner className="h-4 w-4" />
          </span>
        </div>
      )}
      {turnNavigationLoading && (
        <div
          className="pointer-events-none absolute left-1/2 top-5 z-30 flex -translate-x-1/2 items-center gap-2 rounded-full border border-border bg-background/95 px-3 py-1.5 text-xs font-medium text-text-secondary shadow-[0_8px_22px_rgba(15,23,42,0.12)]"
          data-testid="message-turn-navigation-loading"
        >
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary opacity-80" />
          <span>{t('message_navigation.loading_target')}</span>
        </div>
      )}
      <div
        ref={internalScrollRef}
        data-testid={scrollTestId}
        data-scroll-origin="top"
        className={cn(
          'h-full overflow-y-auto [overflow-anchor:none]',
          'flex flex-col',
          scrollerClassName
        )}
      >
        <div
          ref={contentRef}
          data-testid={`${scrollTestId}-content`}
          className={cn(
            'min-w-0 [overflow-anchor:none]',
            'flex flex-1 shrink-0 flex-col',
            contentClassName
          )}
        >
          {messages.length === 0 ? (
            loading ? (
              <div
                data-testid="chat-loading-state"
                className="flex min-h-full items-center justify-center px-6 py-16 text-center text-sm text-text-muted"
              >
                {t('workbench.loading_conversation')}
              </div>
            ) : historyError ? (
              historyError
            ) : (
              <div
                data-testid="chat-empty-state"
                className="flex min-h-full flex-col items-center justify-center px-6 py-16 text-center"
              >
                <h2 className="text-sm font-medium text-text-primary">
                  {t('workbench.empty_conversation_title')}
                </h2>
                <p className="mt-2 max-w-sm text-xs leading-5 text-text-muted">
                  {t('workbench.empty_conversation_description')}
                </p>
              </div>
            )
          ) : (
            <>
              {historyError}
              {hasMoreBefore && (
                <ConversationHistoryBoundary
                  key={`history:${currentScrollKey ?? 'keyless-conversation'}`}
                  boundaryKey={historyBoundaryKey}
                  loading={loading || loadingMoreBefore}
                  failed={Boolean(historyError)}
                  suspended={autoScrollSuspended}
                  manual={historyLoadingMode === 'manual'}
                  scrollRef={scrollRef}
                  onPrepare={prepareHistory}
                  onLoad={onLoadMoreBefore}
                />
              )}
              <MessageList
                userMessageServices={userMessageServices}
                virtualize={virtualize}
                useContentVisibility={useContentVisibility}
                onVirtualMeasurement={onVirtualMeasurement}
                renderVisualization={renderVisualization}
                key={currentScrollKey ?? 'keyless-conversation'}
                messages={messages}
                turns={turns}
                onBeforeUserMessageToggle={preserveUserMessagePosition}
                onVirtualLayoutChange={handleContentLayoutChange}
                scrollElementRef={scrollRef}
                initialDistanceFromBottomPx={initialDistanceFromBottomPx}
                className={messageListClassName}
                conversationKey={conversationKey}
                forceVirtualMessageId={
                  searchTarget?.messageId ??
                  turnNavigationTargetMessageId ??
                  (currentScrollKey
                    ? getConversationScrollSnapshot(currentScrollKey)?.anchor?.messageId
                    : null)
                }
                searchMessageId={searchTarget?.messageId}
                isWaitingForAssistant={isWaitingForAssistant}
                disableContentVisibility={turnNavigationLoading}
                devices={devices}
                onRetryFailedMessage={onRetryFailedMessage}
                onSwitchModelForFailedMessage={onSwitchModelForFailedMessage}
                onLoadFileChangesDiff={onLoadFileChangesDiff}
                onRevertFileChanges={onRevertFileChanges}
                onOpenFileChangesReview={onOpenFileChangesReview}
                fileChangesDiffPreviewDisabledSubtaskId={fileChangesDiffPreviewDisabledSubtaskId}
                onOpenWorkspaceFile={onOpenWorkspaceFile}
                onOpenLocalSkillFile={onOpenLocalSkillFile}
                onRequestUserInputSubmit={onRequestUserInputSubmit}
                onRequestUserInputIgnore={onRequestUserInputIgnore}
                onOpenAssistantPlan={onOpenAssistantPlan}
                onOpenSubagent={onOpenSubagent}
                onEditLastUserMessage={onEditLastUserMessage}
                canEditLastUserMessage={canEditLastUserMessage}
                onForkMessage={onForkMessage}
                hideRequestUserInputBlocks={hideRequestUserInputBlocks}
                hiddenRequestUserInputIds={hiddenRequestUserInputIds}
                onAddSelectionToConversation={onAddSelectionToConversation}
                onAskSelectionInSidebar={onAskSelectionInSidebar}
                virtualAnchorToEnd={virtualAnchorToEnd}
                virtualAnchor={virtualAnchor}
                virtualScrollAdjustmentEnabled={virtualScrollAdjustmentEnabled}
                virtualizerRef={virtualizerRef}
                scrollTailHeight={scrollTailHeight}
                onVirtualScrollAdjustment={onVirtualScrollAdjustment}
                renderGapAfterMessage={renderMessageGap}
              />
              {contentFooter ? (
                <div
                  ref={contentFooterRef}
                  data-testid={`${scrollTestId}-content-footer`}
                  className={contentFooterClassName}
                >
                  {contentFooter}
                </div>
              ) : null}
            </>
          )}
        </div>
        {stickyFooter ? (
          <div
            ref={stickyFooterRef}
            data-testid={`${scrollTestId}-sticky-footer`}
            className={cn('sticky bottom-0 z-10 w-full shrink-0', stickyFooterClassName)}
          >
            <div className="relative h-0">{scrollToBottomButton}</div>
            {stickyFooter}
          </div>
        ) : null}
      </div>
      <MessageTurnNavigation
        key={currentScrollKey ?? 'keyless-conversation'}
        translate={translate}
        messages={messages}
        turnNavigation={turnNavigation}
        scrollRef={scrollRef}
        interactionRef={externalScrollInteractionRef}
        contentRef={contentRef}
        onLoadTurnNavigationItem={onLoadTurnNavigationItem}
        onNavigationLoadStateChange={handleTurnNavigationLoadStateChange}
        onNavigationScrollTargetChange={handleTurnNavigationScrollTargetChange}
        portalTarget={turnNavigationPortalTarget}
      />
      {!stickyFooter ? scrollToBottomButton : null}
    </div>
  )
}
