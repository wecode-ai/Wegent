import { ArrowDown } from 'lucide-react'
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { RefObject } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import type {
  DeviceInfo,
  RequestUserInputResponse,
  RuntimeTurnNavigationItem,
  TurnFileChangesSummary,
} from '@/types/api'
import type { WorkbenchMessage } from '@/types/workbench'
import type { WorkspaceFileOpenOptions } from '@/types/workspace-files'
import { MessageList } from './MessageList'
import { MessageTurnNavigation } from './MessageTurnNavigation'
import type { RequestUserInputPayload } from './RequestUserInputCard'
import type { AssistantPlanOpenRequest } from './AssistantPlanCard'
import {
  cacheConversationScrollSnapshot,
  getConversationScrollSnapshot,
  hasConversationScrollSnapshot,
  type ConversationScrollSnapshot,
} from '@/features/workbench/runtimeConversationCache'

const BOTTOM_THRESHOLD = 48
const SCROLLED_TO_BOTTOM_THRESHOLD = 8
const STABLE_SCROLL_DELAYS = [0, 50, 150, 300]
interface RuntimeTranscriptGap {
  start: number
  end: number
}

interface ScrollableMessageAreaProps {
  messages: WorkbenchMessage[]
  loading?: boolean
  isWaitingForAssistant?: boolean
  hasMoreBefore?: boolean
  loadingMoreBefore?: boolean
  turnNavigation?: RuntimeTurnNavigationItem[]
  className?: string
  scrollerClassName?: string
  messageListClassName?: string
  stickyFooter?: ReactNode
  stickyFooterClassName?: string
  scrollButtonClassName?: string
  scrollTestId?: string
  externalScrollRef?: RefObject<HTMLDivElement | null>
  turnNavigationPortalTarget?: Element | null
  conversationKey?: string | number | null
  devices?: DeviceInfo[]
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
  onEditLastUserMessage?: (
    message: WorkbenchMessage,
    content: string
  ) => Promise<boolean | void> | boolean | void
  canEditLastUserMessage?: boolean
  onForkMessage?: (message: WorkbenchMessage) => void
  hideRequestUserInputBlocks?: boolean
  hiddenRequestUserInputIds?: ReadonlySet<string>
  onAddSelectionToConversation?: (text: string) => void
  onAskSelectionInSidebar?: (text: string) => void
  autoScrollSuspended?: boolean
  onLoadMoreBefore?: () => Promise<void> | void
  onLoadFullTranscript?: () => Promise<void> | void
  loadingFullTranscript?: boolean
  onLoadTurnNavigationItem?: (item: RuntimeTurnNavigationItem) => Promise<void> | void
  onLoadTranscriptGap?: (gap: RuntimeTranscriptGap) => Promise<void> | void
}

export const ScrollableMessageArea = memo(function ScrollableMessageArea(
  props: ScrollableMessageAreaProps
) {
  return <ScrollableMessagePaneContent {...props} />
}, areScrollableMessageAreaPropsEqual)

function areScrollableMessageAreaPropsEqual(
  previous: ScrollableMessageAreaProps,
  next: ScrollableMessageAreaProps
): boolean {
  const changed = [
    previous.messages !== next.messages ? 'messages' : null,
    previous.loading !== next.loading ? 'loading' : null,
    previous.isWaitingForAssistant !== next.isWaitingForAssistant ? 'isWaitingForAssistant' : null,
    previous.hasMoreBefore !== next.hasMoreBefore ? 'hasMoreBefore' : null,
    previous.loadingMoreBefore !== next.loadingMoreBefore ? 'loadingMoreBefore' : null,
    previous.turnNavigation !== next.turnNavigation ? 'turnNavigation' : null,
    previous.className !== next.className ? 'className' : null,
    previous.scrollerClassName !== next.scrollerClassName ? 'scrollerClassName' : null,
    previous.messageListClassName !== next.messageListClassName ? 'messageListClassName' : null,
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
    previous.onLoadFullTranscript !== next.onLoadFullTranscript ? 'onLoadFullTranscript' : null,
    previous.loadingFullTranscript !== next.loadingFullTranscript ? 'loadingFullTranscript' : null,
    previous.onLoadTurnNavigationItem !== next.onLoadTurnNavigationItem
      ? 'onLoadTurnNavigationItem'
      : null,
    previous.onLoadTranscriptGap !== next.onLoadTranscriptGap ? 'onLoadTranscriptGap' : null,
  ].filter((key): key is string => key !== null)

  return changed.length === 0
}

function ScrollableMessagePaneContent({
  messages,
  loading = false,
  isWaitingForAssistant = false,
  hasMoreBefore = false,
  loadingMoreBefore = false,
  turnNavigation,
  className,
  scrollerClassName,
  messageListClassName,
  stickyFooter,
  stickyFooterClassName,
  scrollButtonClassName,
  scrollTestId = 'chat-message-scroll-area',
  externalScrollRef,
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
  onEditLastUserMessage,
  canEditLastUserMessage,
  onForkMessage,
  hideRequestUserInputBlocks,
  hiddenRequestUserInputIds,
  onAddSelectionToConversation,
  onAskSelectionInSidebar,
  autoScrollSuspended = false,
  onLoadMoreBefore,
  onLoadFullTranscript,
  loadingFullTranscript = false,
  onLoadTurnNavigationItem,
  onLoadTranscriptGap,
}: ScrollableMessageAreaProps) {
  const { t } = useTranslation('common')
  const internalScrollRef = useRef<HTMLDivElement>(null)
  const scrollRef = externalScrollRef ?? internalScrollRef
  const activeScrollRefRef = useRef(scrollRef)
  const contentRef = useRef<HTMLDivElement>(null)
  const stickyFooterRef = useRef<HTMLDivElement>(null)
  const isAtBottomRef = useRef(true)
  const turnNavigationLoadingRef = useRef(false)
  const turnNavigationScrollingRef = useRef(false)
  const previousConversationKeyRef = useRef<string | number | null | undefined>(undefined)
  const previousLastMessageIdRef = useRef<string | null>(null)
  const previousMessageCountRef = useRef(0)
  const scrollTimersRef = useRef<Array<ReturnType<typeof setTimeout>>>([])
  const scrollFrameRef = useRef<number | null>(null)
  const restoringScrollKeyRef = useRef<string | null>(null)
  const followingBottomKeyRef = useRef<string | null>(null)
  const userScrollPausedAutoFollowRef = useRef(false)
  const scheduledScrollStateSignatureRef = useRef<string | null>(null)
  const completedScrollStateSignatureRef = useRef<string | null>(null)
  const loadingTranscriptGapKeyRef = useRef<string | null>(null)
  const [showScrollButton, setShowScrollButton] = useState(false)
  const [turnNavigationLoading, setTurnNavigationLoading] = useState(false)
  const [turnNavigationTargetMessageId, setTurnNavigationTargetMessageId] = useState<string | null>(
    null
  )
  const [loadingTranscriptGapKey, setLoadingTranscriptGapKey] = useState<string | null>(null)
  const lastMessage = messages[messages.length - 1]
  const currentScrollKey = useMemo(() => scrollPositionKey(conversationKey), [conversationKey])
  const messageScrollSignature = useMemo(() => {
    if (!lastMessage) return 'empty'

    const blockSignature = (lastMessage.blocks ?? [])
      .map(block => {
        if (block.type === 'thinking' || block.type === 'text' || block.type === 'plan') {
          return `${block.id}:${block.status}:${block.content.length}`
        }
        if (block.type === 'file_changes') {
          return `${block.id}:${block.status}:${block.fileChanges.file_count}:${block.fileChanges.diff?.length ?? 0}`
        }
        return `${block.id}:${block.status}:${String(block.toolOutput ?? '').length}`
      })
      .join('|')

    return [
      messages.length,
      lastMessage.id,
      lastMessage.role,
      lastMessage.status,
      lastMessage.content.length,
      blockSignature,
      isWaitingForAssistant ? 'waiting' : 'idle',
    ].join(':')
  }, [isWaitingForAssistant, lastMessage, messages.length])
  const scrollStateFrameSignature = useMemo(
    () => [currentScrollKey ?? 'none', messageScrollSignature].join(':'),
    [currentScrollKey, messageScrollSignature]
  )

  useLayoutEffect(() => {
    activeScrollRefRef.current = scrollRef
  }, [scrollRef])

  const clearScheduledScrolls = useCallback(() => {
    scrollTimersRef.current.forEach(timer => clearTimeout(timer))
    scrollTimersRef.current = []
    restoringScrollKeyRef.current = null
    followingBottomKeyRef.current = null

    if (scrollFrameRef.current !== null) {
      cancelAnimationFrame(scrollFrameRef.current)
      scrollFrameRef.current = null
    }
  }, [])

  const scheduleScrollTimer = useCallback((callback: () => void, delay: number) => {
    const timer = setTimeout(() => {
      scrollTimersRef.current = scrollTimersRef.current.filter(current => current !== timer)
      callback()
    }, delay)
    scrollTimersRef.current.push(timer)
  }, [])

  const isTurnNavigationAutoScrollSuspended = useCallback(
    () => turnNavigationLoadingRef.current || turnNavigationScrollingRef.current,
    []
  )

  const handleTurnNavigationScrollTargetChange = useCallback(
    (messageId: string | null) => {
      const scrolling = messageId !== null
      turnNavigationScrollingRef.current = scrolling
      setTurnNavigationTargetMessageId(messageId)
      const element = activeScrollRefRef.current.current
      console.warn('[Wework] Message turn navigation scroll ownership', {
        scrolling,
        messageId,
        conversationKey: currentScrollKey,
        scrollTop: element?.scrollTop ?? null,
        scrollHeight: element?.scrollHeight ?? null,
        clientHeight: element?.clientHeight ?? null,
      })
      if (scrolling) {
        clearScheduledScrolls()
      }
    },
    [clearScheduledScrolls, currentScrollKey]
  )

  const handleTurnNavigationLoadStateChange = useCallback(
    (loading: boolean) => {
      turnNavigationLoadingRef.current = loading
      setTurnNavigationLoading(loading)
      if (loading) {
        clearScheduledScrolls()
      }
    },
    [clearScheduledScrolls]
  )

  const loadTranscriptGap = useCallback(
    async (gap: RuntimeTranscriptGap, reason: 'visible' | 'click') => {
      if (!onLoadTranscriptGap) return
      const gapKey = runtimeTranscriptGapKey(gap)
      if (loadingTranscriptGapKeyRef.current !== null) return

      loadingTranscriptGapKeyRef.current = gapKey
      setLoadingTranscriptGapKey(gapKey)
      handleTurnNavigationLoadStateChange(true)
      try {
        await onLoadTranscriptGap(gap)
      } catch (error) {
        console.error('[Wework] Message area transcript gap load failed', {
          gap,
          gapKey,
          reason,
          error,
        })
      } finally {
        loadingTranscriptGapKeyRef.current = null
        setLoadingTranscriptGapKey(current => (current === gapKey ? null : current))
        handleTurnNavigationLoadStateChange(false)
      }
    },
    [handleTurnNavigationLoadStateChange, onLoadTranscriptGap]
  )

  const renderTranscriptGapAfterMessage = useCallback(
    (message: WorkbenchMessage, nextMessage: WorkbenchMessage | undefined) => {
      const gap = runtimeTranscriptGapBetween(message, nextMessage)
      if (!gap) return null
      const gapKey = runtimeTranscriptGapKey(gap)
      return (
        <RuntimeTranscriptGapMarker
          key={gapKey}
          gap={gap}
          loading={loadingTranscriptGapKey === gapKey}
          scrollRef={scrollRef}
          onLoad={loadTranscriptGap}
        />
      )
    },
    [loadTranscriptGap, loadingTranscriptGapKey, scrollRef]
  )

  const saveCurrentScrollPosition = useCallback(
    (scrollTop?: number) => {
      const element = activeScrollRefRef.current.current
      if (!element || currentScrollKey === null || messages.length === 0) return
      setConversationScrollSnapshot(currentScrollKey, createScrollSnapshot(element, scrollTop))
    },
    [currentScrollKey, messages.length]
  )

  const updateScrollState = useCallback(
    (options: { forceSave?: boolean; skipSave?: boolean } = {}) => {
      const element = activeScrollRefRef.current.current
      if (!element) return

      if (messages.length === 0) {
        isAtBottomRef.current = true
        setShowScrollButton(false)
        return
      }

      const overflow = element.scrollHeight > element.clientHeight + 8
      const distanceToBottom = element.scrollHeight - element.clientHeight - element.scrollTop
      const isAtBottom = distanceToBottom <= BOTTOM_THRESHOLD
      const isScrolledToBottom = distanceToBottom <= SCROLLED_TO_BOTTOM_THRESHOLD
      isAtBottomRef.current = isAtBottom
      if (isScrolledToBottom) {
        userScrollPausedAutoFollowRef.current = false
      } else if (options.forceSave) {
        userScrollPausedAutoFollowRef.current = true
      }
      if (
        !isAtBottom &&
        restoringScrollKeyRef.current !== currentScrollKey &&
        followingBottomKeyRef.current !== currentScrollKey
      ) {
        clearScheduledScrolls()
      }
      if (
        !options.skipSave &&
        (options.forceSave || restoringScrollKeyRef.current !== currentScrollKey)
      ) {
        saveCurrentScrollPosition()
      }
      setShowScrollButton(overflow && !isAtBottom)
    },
    [clearScheduledScrolls, currentScrollKey, messages.length, saveCurrentScrollPosition]
  )

  const setScrollToBottom = useCallback(
    (behavior: ScrollBehavior = 'auto', options: { saveSnapshot?: boolean } = {}) => {
      const element = activeScrollRefRef.current.current
      if (!element) return

      if (typeof element.scrollTo === 'function') {
        element.scrollTo({
          top: element.scrollHeight,
          behavior,
        })
      } else {
        element.scrollTop = element.scrollHeight
      }
      if (options.saveSnapshot) {
        saveCurrentScrollPosition(element.scrollHeight)
      }
      isAtBottomRef.current = true
      userScrollPausedAutoFollowRef.current = false
      setShowScrollButton(false)
    },
    [saveCurrentScrollPosition]
  )

  const restoreSavedScrollPosition = useCallback((key: string) => {
    const element = activeScrollRefRef.current.current
    const savedSnapshot = getConversationScrollSnapshot(key)
    if (!element || !savedSnapshot) return

    const maxScrollTop = Math.max(0, element.scrollHeight - element.clientHeight)
    const nextScrollTop = Math.min(getRestoredScrollTop(element, savedSnapshot), maxScrollTop)
    if (typeof element.scrollTo === 'function') {
      element.scrollTo({
        top: nextScrollTop,
        behavior: 'auto',
      })
    } else {
      element.scrollTop = nextScrollTop
    }

    const overflow = element.scrollHeight > element.clientHeight + 8
    const distanceToBottom = element.scrollHeight - element.clientHeight - nextScrollTop
    const isAtBottom = distanceToBottom <= BOTTOM_THRESHOLD
    const isScrolledToBottom = distanceToBottom <= SCROLLED_TO_BOTTOM_THRESHOLD
    isAtBottomRef.current = isAtBottom
    userScrollPausedAutoFollowRef.current = !isScrolledToBottom
    setShowScrollButton(overflow && !isAtBottom)
    setConversationScrollSnapshot(key, savedSnapshot)
  }, [])

  const scheduleStableRestoreSavedScrollPosition = useCallback(
    (key: string) => {
      clearScheduledScrolls()
      restoringScrollKeyRef.current = key
      followingBottomKeyRef.current = getConversationScrollSnapshot(key)?.pinnedToBottom
        ? key
        : null

      STABLE_SCROLL_DELAYS.forEach(delay => {
        scheduleScrollTimer(() => {
          restoreSavedScrollPosition(key)
        }, delay)
      })

      scheduleScrollTimer(
        () => {
          if (restoringScrollKeyRef.current === key) {
            restoringScrollKeyRef.current = null
          }
        },
        Math.max(...STABLE_SCROLL_DELAYS) + 50
      )
    },
    [clearScheduledScrolls, restoreSavedScrollPosition, scheduleScrollTimer]
  )

  const scrollToBottom = useCallback(
    (behavior: ScrollBehavior = 'auto', options: { saveSnapshot?: boolean } = {}) => {
      const element = activeScrollRefRef.current.current
      if (!element) return

      if (scrollFrameRef.current !== null) {
        cancelAnimationFrame(scrollFrameRef.current)
      }

      scrollFrameRef.current = requestAnimationFrame(() => {
        scrollFrameRef.current = null
        setScrollToBottom(behavior, options)
      })
    },
    [setScrollToBottom]
  )

  const scheduleStableScrollToBottom = useCallback(
    (behavior: ScrollBehavior = 'auto', options: { saveSnapshot?: boolean } = {}) => {
      clearScheduledScrolls()
      followingBottomKeyRef.current = currentScrollKey
      STABLE_SCROLL_DELAYS.forEach(delay => {
        scheduleScrollTimer(() => {
          scrollToBottom(behavior, options)
        }, delay)
      })
    },
    [clearScheduledScrolls, currentScrollKey, scheduleScrollTimer, scrollToBottom]
  )

  useLayoutEffect(() => {
    const conversationChanged = previousConversationKeyRef.current !== conversationKey
    const messagesLoaded = previousMessageCountRef.current === 0 && messages.length > 0
    const lastMessageChanged = previousLastMessageIdRef.current !== (lastMessage?.id ?? null)
    const shouldRestoreScroll = Boolean(
      currentScrollKey &&
      messages.length > 0 &&
      (conversationChanged || messagesLoaded) &&
      hasConversationScrollSnapshot(currentScrollKey)
    )
    const shouldForceBottom =
      !shouldRestoreScroll &&
      (conversationChanged ||
        messagesLoaded ||
        (lastMessageChanged && lastMessage?.role === 'user'))

    previousConversationKeyRef.current = conversationKey
    previousLastMessageIdRef.current = lastMessage?.id ?? null
    previousMessageCountRef.current = messages.length

    if (messages.length === 0) {
      return
    }

    if (autoScrollSuspended || isTurnNavigationAutoScrollSuspended()) {
      clearScheduledScrolls()
      return
    }

    if (shouldRestoreScroll && currentScrollKey) {
      scheduleStableRestoreSavedScrollPosition(currentScrollKey)
      return
    }

    if (shouldForceBottom) {
      setScrollToBottom('auto', { saveSnapshot: false })
      scheduleStableScrollToBottom('auto', { saveSnapshot: false })
      return
    }

    if (isAtBottomRef.current && !userScrollPausedAutoFollowRef.current) {
      scrollToBottom('auto', { saveSnapshot: false })
    }
  }, [
    conversationKey,
    autoScrollSuspended,
    currentScrollKey,
    clearScheduledScrolls,
    isTurnNavigationAutoScrollSuspended,
    lastMessage,
    messageScrollSignature,
    messages.length,
    scheduleStableRestoreSavedScrollPosition,
    scheduleStableScrollToBottom,
    scrollToBottom,
    setScrollToBottom,
  ])

  useLayoutEffect(() => {
    if (
      completedScrollStateSignatureRef.current === scrollStateFrameSignature ||
      scheduledScrollStateSignatureRef.current === scrollStateFrameSignature
    ) {
      return
    }

    scheduledScrollStateSignatureRef.current = scrollStateFrameSignature
    const frame = requestAnimationFrame(() => {
      if (scheduledScrollStateSignatureRef.current !== scrollStateFrameSignature) return
      scheduledScrollStateSignatureRef.current = null
      completedScrollStateSignatureRef.current = scrollStateFrameSignature
      updateScrollState({ skipSave: true })
    })
    return () => {
      cancelAnimationFrame(frame)
      if (scheduledScrollStateSignatureRef.current === scrollStateFrameSignature) {
        scheduledScrollStateSignatureRef.current = null
      }
    }
  }, [scrollStateFrameSignature, updateScrollState])

  useEffect(() => {
    const content = contentRef.current
    const footer = stickyFooterRef.current
    if (!content || typeof ResizeObserver === 'undefined') return

    const resizeObserver = new ResizeObserver(() => {
      if (autoScrollSuspended || isTurnNavigationAutoScrollSuspended()) {
        if (turnNavigationScrollingRef.current) {
          console.warn('[Wework] Message turn navigation ignored content resize', {
            conversationKey: currentScrollKey,
            scrollTop: activeScrollRefRef.current.current?.scrollTop ?? null,
            scrollHeight: activeScrollRefRef.current.current?.scrollHeight ?? null,
            clientHeight: activeScrollRefRef.current.current?.clientHeight ?? null,
          })
        }
        return
      }

      const restoringKey = restoringScrollKeyRef.current
      if (restoringKey && restoringKey === currentScrollKey) {
        restoreSavedScrollPosition(restoringKey)
        return
      }

      if (followingBottomKeyRef.current === currentScrollKey) {
        setScrollToBottom('auto', { saveSnapshot: false })
        return
      }

      if (userScrollPausedAutoFollowRef.current && currentScrollKey) {
        restoreSavedScrollPosition(currentScrollKey)
        return
      }

      if (isAtBottomRef.current && !userScrollPausedAutoFollowRef.current) {
        scrollToBottom('auto', { saveSnapshot: false })
      }
    })

    resizeObserver.observe(content)
    if (footer) {
      resizeObserver.observe(footer)
    }
    return () => resizeObserver.disconnect()
  }, [
    currentScrollKey,
    autoScrollSuspended,
    isTurnNavigationAutoScrollSuspended,
    restoreSavedScrollPosition,
    scrollToBottom,
    setScrollToBottom,
    stickyFooter,
  ])

  useEffect(() => clearScheduledScrolls, [clearScheduledScrolls])

  const handleScrollToBottom = () => {
    userScrollPausedAutoFollowRef.current = false
    scrollToBottom('smooth', { saveSnapshot: true })
  }

  const pauseAutoFollowForUserScroll = useCallback(() => {
    userScrollPausedAutoFollowRef.current = true
    clearScheduledScrolls()
  }, [clearScheduledScrolls])

  const handleScroll = useCallback(() => {
    if (restoringScrollKeyRef.current === currentScrollKey) {
      updateScrollState({ skipSave: true })
      return
    }
    restoringScrollKeyRef.current = null
    updateScrollState({ forceSave: true })
  }, [currentScrollKey, updateScrollState])

  useEffect(() => {
    const externalScroller = externalScrollRef?.current
    if (!externalScroller || externalScroller === internalScrollRef.current) return

    externalScroller.addEventListener('scroll', handleScroll)
    return () => externalScroller.removeEventListener('scroll', handleScroll)
  }, [externalScrollRef, handleScroll])

  const scrollToBottomButton = showScrollButton ? (
    <button
      type="button"
      data-testid="scroll-to-bottom-button"
      onClick={handleScrollToBottom}
      className={cn(
        'absolute bottom-4 left-1/2 z-10 flex h-9 w-9 -translate-x-1/2 items-center justify-center rounded-full border border-border bg-surface text-text-primary shadow-sm hover:bg-muted',
        scrollButtonClassName
      )}
      aria-label={t('workbench.scroll_to_bottom', '下拉到底')}
    >
      <ArrowDown className="h-4 w-4" />
    </button>
  ) : null

  return (
    <div className={cn('relative min-h-0 flex-1', className)}>
      <MessageTurnNavigation
        messages={messages}
        turnNavigation={turnNavigation}
        scrollRef={scrollRef}
        contentRef={contentRef}
        onLoadTurnNavigationItem={onLoadTurnNavigationItem}
        onNavigationLoadStateChange={handleTurnNavigationLoadStateChange}
        onNavigationScrollTargetChange={handleTurnNavigationScrollTargetChange}
        portalTarget={turnNavigationPortalTarget}
      />
      {turnNavigationLoading && (
        <div
          className="pointer-events-none absolute left-1/2 top-5 z-30 flex -translate-x-1/2 items-center gap-2 rounded-full border border-border bg-background/95 px-3 py-1.5 text-xs font-medium text-text-secondary shadow-[0_8px_22px_rgba(15,23,42,0.12)]"
          data-testid="message-turn-navigation-loading"
        >
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary opacity-80" />
          <span>{t('chat:message_navigation.loading_target')}</span>
        </div>
      )}
      <div
        ref={internalScrollRef}
        data-testid={scrollTestId}
        className={cn(
          'h-full overflow-y-auto',
          stickyFooter && 'flex flex-col',
          (turnNavigationLoading || turnNavigationTargetMessageId || autoScrollSuspended) &&
            '[overflow-anchor:none]',
          scrollerClassName
        )}
        onWheel={event => {
          if (event.deltaY < 0) {
            pauseAutoFollowForUserScroll()
          }
        }}
        onTouchMove={pauseAutoFollowForUserScroll}
        onScroll={handleScroll}
      >
        <div
          ref={contentRef}
          data-testid={`${scrollTestId}-content`}
          className={cn(
            'min-w-0',
            stickyFooter && 'flex-1 shrink-0',
            (turnNavigationLoading || turnNavigationTargetMessageId || autoScrollSuspended) &&
              '[overflow-anchor:none]'
          )}
        >
          {messages.length === 0 ? (
            loading ? (
              <div
                data-testid="chat-loading-state"
                className="flex min-h-full items-center justify-center px-6 py-16 text-center text-sm text-text-muted"
              >
                {t('workbench.loading_conversation', '正在加载会话...')}
              </div>
            ) : (
              <div
                data-testid="chat-empty-state"
                className="flex min-h-full flex-col items-center justify-center px-6 py-16 text-center"
              >
                <h2 className="text-sm font-medium text-text-primary">
                  {t('workbench.empty_conversation_title', '开始新的对话')}
                </h2>
                <p className="mt-2 max-w-sm text-xs leading-5 text-text-muted">
                  {t(
                    'workbench.empty_conversation_description',
                    '在下方输入问题、粘贴上下文或添加附件，WeWork 会在这里展示回复。'
                  )}
                </p>
              </div>
            )
          ) : (
            <>
              {hasMoreBefore && (
                <div className="flex justify-center px-4 pb-2 pt-4">
                  <button
                    type="button"
                    data-testid="load-older-runtime-transcript-button"
                    onClick={() => void onLoadMoreBefore?.()}
                    disabled={loadingMoreBefore}
                    className="flex h-11 min-w-[44px] items-center justify-center rounded-md border border-border bg-surface px-4 text-xs font-medium text-text-secondary hover:bg-muted disabled:cursor-wait disabled:opacity-60"
                  >
                    {loadingMoreBefore
                      ? t('workbench.loading_older_messages')
                      : t('workbench.load_older_messages')}
                  </button>
                </div>
              )}
              <MessageList
                messages={messages}
                scrollElementRef={scrollRef}
                initialDistanceFromBottomPx={getInitialDistanceFromBottomPx(currentScrollKey)}
                className={messageListClassName}
                conversationKey={conversationKey}
                forceVirtualMessageId={turnNavigationTargetMessageId}
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
                onEditLastUserMessage={onEditLastUserMessage}
                canEditLastUserMessage={canEditLastUserMessage}
                onForkMessage={onForkMessage}
                onLoadFullTranscript={onLoadFullTranscript}
                loadingFullTranscript={loadingFullTranscript}
                hideRequestUserInputBlocks={hideRequestUserInputBlocks}
                hiddenRequestUserInputIds={hiddenRequestUserInputIds}
                onAddSelectionToConversation={onAddSelectionToConversation}
                onAskSelectionInSidebar={onAskSelectionInSidebar}
                renderGapAfterMessage={renderTranscriptGapAfterMessage}
              />
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
      {!stickyFooter ? scrollToBottomButton : null}
    </div>
  )
}

function scrollPositionKey(conversationKey: string | number | null | undefined): string | null {
  return conversationKey == null ? null : String(conversationKey)
}

function setConversationScrollSnapshot(key: string, snapshot: ConversationScrollSnapshot) {
  cacheConversationScrollSnapshot(key, snapshot)
}

function getInitialDistanceFromBottomPx(key: string | null): number {
  if (key === null) return 0
  const distance = getConversationScrollSnapshot(key)?.distanceFromBottomPx
  return typeof distance === 'number' && Number.isFinite(distance) ? Math.max(0, distance) : 0
}

function createScrollSnapshot(
  scroller: HTMLElement,
  scrollTop?: number
): ConversationScrollSnapshot {
  const resolvedScrollTop = scrollTop ?? scroller.scrollTop
  const distanceFromBottomPx = Math.max(
    0,
    scroller.scrollHeight - scroller.clientHeight - resolvedScrollTop
  )
  return {
    distanceFromBottomPx,
    pinnedToBottom: distanceFromBottomPx <= SCROLLED_TO_BOTTOM_THRESHOLD,
  }
}

function getRestoredScrollTop(scroller: HTMLElement, snapshot: ConversationScrollSnapshot): number {
  const storedDistance = Number.isFinite(snapshot.distanceFromBottomPx)
    ? snapshot.distanceFromBottomPx
    : 0
  const distance = snapshot.pinnedToBottom ? 0 : storedDistance
  return Math.max(0, scroller.scrollHeight - scroller.clientHeight - distance)
}

function RuntimeTranscriptGapMarker({
  gap,
  loading,
  scrollRef,
  onLoad,
}: {
  gap: RuntimeTranscriptGap
  loading: boolean
  scrollRef: RefObject<HTMLDivElement | null>
  onLoad: (gap: RuntimeTranscriptGap, reason: 'visible' | 'click') => Promise<void>
}) {
  const { t } = useTranslation('chat')
  const markerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (loading) return
    const marker = markerRef.current
    const scroller = scrollRef.current
    if (!marker || !scroller || typeof IntersectionObserver === 'undefined') return

    let triggered = false
    const observer = new IntersectionObserver(
      entries => {
        if (triggered || !entries.some(entry => entry.isIntersecting)) return
        triggered = true
        void onLoad(gap, 'visible')
      },
      {
        root: scroller,
        rootMargin: '160px 0px',
        threshold: 0.01,
      }
    )
    observer.observe(marker)
    return () => observer.disconnect()
  }, [gap, loading, onLoad, scrollRef])

  return (
    <div
      ref={markerRef}
      className="mx-auto flex w-full max-w-3xl justify-center px-6 py-1"
      data-runtime-transcript-gap={`${gap.start}:${gap.end}`}
      data-testid="runtime-transcript-gap-marker"
    >
      <button
        type="button"
        disabled={loading}
        onClick={() => void onLoad(gap, 'click')}
        className="flex min-h-[36px] min-w-[44px] items-center gap-2 rounded-full border border-border bg-background px-3 text-xs font-medium text-text-secondary shadow-sm hover:bg-muted disabled:cursor-wait disabled:opacity-80"
      >
        <span
          className={cn(
            'h-1.5 w-1.5 rounded-full bg-primary opacity-80',
            loading && 'animate-pulse'
          )}
        />
        <span>
          {loading ? t('message_navigation.loading_gap') : t('message_navigation.gap_missing')}
        </span>
      </button>
    </div>
  )
}

function runtimeTranscriptGapBetween(
  message: WorkbenchMessage,
  nextMessage: WorkbenchMessage | undefined
): RuntimeTranscriptGap | null {
  if (!nextMessage) return null
  const currentIndex = runtimeMessageIndex(message)
  const nextIndex = runtimeMessageIndex(nextMessage)
  if (currentIndex === null || nextIndex === null || nextIndex <= currentIndex + 1) return null

  return {
    start: currentIndex + 1,
    end: nextIndex,
  }
}

function runtimeMessageIndex(message: WorkbenchMessage): number | null {
  return typeof message.runtimeMessageIndex === 'number' &&
    Number.isFinite(message.runtimeMessageIndex)
    ? message.runtimeMessageIndex
    : null
}

function runtimeTranscriptGapKey(gap: RuntimeTranscriptGap): string {
  return `${gap.start}:${gap.end}`
}
