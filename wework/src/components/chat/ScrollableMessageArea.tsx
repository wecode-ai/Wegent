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
const STABLE_SCROLL_DELAYS = [0, 50, 150, 300, 600, 1000]
const SCROLL_ANCHOR_SELECTOR = '[data-scroll-anchor]'
interface RuntimeTranscriptGap {
  start: number
  end: number
}

interface RuntimeTranscriptRange {
  start: number
  end: number
}

interface UserViewportAnchor {
  messageId: string
  anchorIndex: number
  offsetFromScrollerTop: number
}

interface ScrollableMessageAreaProps {
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
  onForkMessage?: (message: WorkbenchMessage) => Promise<void> | void
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
    previous.loadedTranscriptRanges !== next.loadedTranscriptRanges
      ? 'loadedTranscriptRanges'
      : null,
    previous.className !== next.className ? 'className' : null,
    previous.scrollerClassName !== next.scrollerClassName ? 'scrollerClassName' : null,
    previous.contentClassName !== next.contentClassName ? 'contentClassName' : null,
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
  loadedTranscriptRanges,
  className,
  scrollerClassName,
  contentClassName,
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
  const pendingAssistantResponseStartRef = useRef(false)
  const previousLatestUserMessageIdRef = useRef<string | null>(null)
  const previousLatestGuidanceMessageIdRef = useRef<string | null>(null)
  const previousMessageCountRef = useRef(0)
  const previousLoadingRef = useRef(loading)
  const previousWaitingForAssistantRef = useRef(isWaitingForAssistant)
  const hasRenderedRef = useRef(false)
  const scrollTimersRef = useRef<Array<ReturnType<typeof setTimeout>>>([])
  const scrollFrameRef = useRef<number | null>(null)
  const restoringScrollKeyRef = useRef<string | null>(null)
  const followingBottomKeyRef = useRef<string | null>(null)
  const preserveLatestUserTurnRef = useRef(false)
  const userScrollPausedAutoFollowRef = useRef(false)
  const userScrollIntentRef = useRef(false)
  const userViewportAnchorRef = useRef<UserViewportAnchor | null>(null)
  const lastScrollTopRef = useRef<number | null>(null)
  const scheduledScrollStateSignatureRef = useRef<string | null>(null)
  const completedScrollStateSignatureRef = useRef<string | null>(null)
  const loadingTranscriptGapKeyRef = useRef<string | null>(null)
  const autoLoadedTranscriptGapKeysRef = useRef(new Set<string>())
  const [showScrollButton, setShowScrollButton] = useState(false)
  const [turnNavigationLoading, setTurnNavigationLoading] = useState(false)
  const [turnNavigationTargetMessageId, setTurnNavigationTargetMessageId] = useState<string | null>(
    null
  )
  const [loadingTranscriptGapKey, setLoadingTranscriptGapKey] = useState<string | null>(null)
  const lastMessage = messages[messages.length - 1]
  const latestGuidanceMessageId = findLatestGuidanceMessageId(messages)
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
        preserveLatestUserTurnRef.current = false
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
        preserveLatestUserTurnRef.current = false
      }
    },
    [clearScheduledScrolls]
  )

  const loadTranscriptGap = useCallback(
    async (gap: RuntimeTranscriptGap, reason: 'visible' | 'click') => {
      if (!onLoadTranscriptGap) return
      const gapKey = runtimeTranscriptGapKey(gap)
      if (loadingTranscriptGapKeyRef.current !== null) return
      if (reason === 'visible') {
        if (autoLoadedTranscriptGapKeysRef.current.has(gapKey)) return
        autoLoadedTranscriptGapKeysRef.current.add(gapKey)
      }

      loadingTranscriptGapKeyRef.current = gapKey
      setLoadingTranscriptGapKey(gapKey)
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
      }
    },
    [onLoadTranscriptGap]
  )

  useEffect(() => {
    autoLoadedTranscriptGapKeysRef.current.clear()
  }, [currentScrollKey])

  const renderTranscriptGapAfterMessage = useCallback(
    (message: WorkbenchMessage, nextMessage: WorkbenchMessage | undefined) => {
      const gap = runtimeTranscriptGapBetween(message, nextMessage, loadedTranscriptRanges)
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
    [loadTranscriptGap, loadedTranscriptRanges, loadingTranscriptGapKey, scrollRef]
  )

  const saveCurrentScrollPosition = useCallback(
    (scrollTop?: number) => {
      const element = activeScrollRefRef.current.current
      if (!element || currentScrollKey === null || messages.length === 0) return
      setConversationScrollSnapshot(currentScrollKey, createScrollSnapshot(element, scrollTop))
    },
    [currentScrollKey, messages.length]
  )

  useLayoutEffect(
    () => () => {
      saveCurrentScrollPosition()
    },
    [saveCurrentScrollPosition]
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
      const scrolledUp =
        lastScrollTopRef.current !== null && element.scrollTop < lastScrollTopRef.current - 0.5
      lastScrollTopRef.current = element.scrollTop
      isAtBottomRef.current = isAtBottom
      if (isScrolledToBottom) {
        userScrollPausedAutoFollowRef.current = false
        userViewportAnchorRef.current = null
      } else if (options.forceSave) {
        userScrollPausedAutoFollowRef.current = true
      }
      if (!isScrolledToBottom && options.forceSave) {
        if (scrolledUp) {
          clearScheduledScrolls()
        }
        preserveLatestUserTurnRef.current = false
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
      lastScrollTopRef.current = element.scrollTop
      if (options.saveSnapshot) {
        saveCurrentScrollPosition(element.scrollHeight)
      }
      isAtBottomRef.current = true
      userScrollPausedAutoFollowRef.current = false
      userViewportAnchorRef.current = null
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
    lastScrollTopRef.current = element.scrollTop

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

  const markCurrentConversationPinnedToBottom = useCallback(() => {
    if (currentScrollKey === null) return
    setConversationScrollSnapshot(currentScrollKey, {
      distanceFromBottomPx: 0,
      pinnedToBottom: true,
    })
  }, [currentScrollKey])

  const scheduleStableScrollToBottom = useCallback(
    (
      behavior: ScrollBehavior = 'auto',
      options: { saveSnapshot?: boolean; releaseAfterStable?: boolean } = {}
    ) => {
      clearScheduledScrolls()
      followingBottomKeyRef.current = currentScrollKey
      markCurrentConversationPinnedToBottom()
      STABLE_SCROLL_DELAYS.forEach(delay => {
        scheduleScrollTimer(() => {
          scrollToBottom(behavior, options)
        }, delay)
      })
      if (options.releaseAfterStable) {
        scheduleScrollTimer(
          () => {
            if (followingBottomKeyRef.current === currentScrollKey) {
              followingBottomKeyRef.current = null
              const element = activeScrollRefRef.current.current
              const distanceToBottom = element
                ? element.scrollHeight - element.clientHeight - element.scrollTop
                : Number.POSITIVE_INFINITY
              if (
                distanceToBottom <= SCROLLED_TO_BOTTOM_THRESHOLD &&
                !userScrollPausedAutoFollowRef.current
              ) {
                preserveLatestUserTurnRef.current = false
              }
            }
          },
          Math.max(...STABLE_SCROLL_DELAYS) + 50
        )
      }
    },
    [
      clearScheduledScrolls,
      currentScrollKey,
      markCurrentConversationPinnedToBottom,
      scheduleScrollTimer,
      scrollToBottom,
    ]
  )

  useLayoutEffect(() => {
    const isInitialRender = !hasRenderedRef.current
    const conversationChanged = previousConversationKeyRef.current !== conversationKey
    const messagesLoaded = previousMessageCountRef.current === 0 && messages.length > 0
    const lastMessageChanged = previousLastMessageIdRef.current !== (lastMessage?.id ?? null)
    const latestUserMessageId = messages.findLast(message => message.role === 'user')?.id ?? null
    const firstUserMessageAppended =
      !isInitialRender &&
      !conversationChanged &&
      !loading &&
      !previousLoadingRef.current &&
      previousMessageCountRef.current === 0 &&
      lastMessage?.role === 'user' &&
      latestUserMessageId !== null
    const latestUserMessageChanged =
      !conversationChanged &&
      ((previousMessageCountRef.current > 0 &&
        previousLatestUserMessageIdRef.current !== null &&
        latestUserMessageId !== null &&
        previousLatestUserMessageIdRef.current !== latestUserMessageId) ||
        firstUserMessageAppended)
    const guidanceMessageApplied =
      !conversationChanged &&
      previousMessageCountRef.current > 0 &&
      lastMessageChanged &&
      latestGuidanceMessageId !== null &&
      previousLatestGuidanceMessageIdRef.current !== latestGuidanceMessageId
    const waitingForAssistantStarted =
      !conversationChanged && !previousWaitingForAssistantRef.current && isWaitingForAssistant
    const assistantResponseStarted =
      !conversationChanged &&
      lastMessageChanged &&
      lastMessage?.role === 'assistant' &&
      !userScrollPausedAutoFollowRef.current
    const autoScrollIsSuspended = autoScrollSuspended || isTurnNavigationAutoScrollSuspended()
    if (conversationChanged) {
      pendingAssistantResponseStartRef.current = false
    }
    if (assistantResponseStarted && autoScrollIsSuspended) {
      pendingAssistantResponseStartRef.current = true
    }
    const pendingAssistantResponseStarted =
      pendingAssistantResponseStartRef.current && !autoScrollIsSuspended
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
        guidanceMessageApplied ||
        waitingForAssistantStarted ||
        latestUserMessageChanged ||
        assistantResponseStarted ||
        pendingAssistantResponseStarted ||
        (lastMessageChanged && lastMessage?.role === 'user'))

    previousConversationKeyRef.current = conversationKey
    previousLastMessageIdRef.current = lastMessage?.id ?? null
    previousLatestUserMessageIdRef.current = latestUserMessageId
    previousLatestGuidanceMessageIdRef.current = latestGuidanceMessageId
    previousMessageCountRef.current = messages.length
    previousLoadingRef.current = loading
    previousWaitingForAssistantRef.current = isWaitingForAssistant
    hasRenderedRef.current = true

    if (conversationChanged) {
      userViewportAnchorRef.current = null
      preserveLatestUserTurnRef.current = false
    } else if (latestUserMessageChanged) {
      preserveLatestUserTurnRef.current = true
    }

    if (messages.length === 0) {
      return
    }

    if (autoScrollIsSuspended) {
      clearScheduledScrolls()
      return
    }

    if (shouldRestoreScroll && currentScrollKey) {
      scheduleStableRestoreSavedScrollPosition(currentScrollKey)
      return
    }

    if (shouldForceBottom) {
      pendingAssistantResponseStartRef.current = false
      setScrollToBottom('auto', { saveSnapshot: false })
      if (preserveLatestUserTurnRef.current) {
        scheduleStableScrollToBottom('auto', {
          saveSnapshot: false,
          releaseAfterStable: true,
        })
        return
      }
      scheduleStableScrollToBottom('auto', { saveSnapshot: false })
      return
    }

    if (preserveLatestUserTurnRef.current) {
      if (followingBottomKeyRef.current !== currentScrollKey) {
        clearScheduledScrolls()
      }
      return
    }

    if (isAtBottomRef.current && !userScrollPausedAutoFollowRef.current) {
      const shouldStabilizeExternalBottom =
        externalScrollRef?.current &&
        currentScrollKey !== null &&
        getConversationScrollSnapshot(currentScrollKey)?.pinnedToBottom === true
      if (shouldStabilizeExternalBottom) {
        scheduleStableScrollToBottom('auto', { saveSnapshot: false })
      } else {
        scrollToBottom('auto', { saveSnapshot: false })
      }
    }
  }, [
    conversationKey,
    autoScrollSuspended,
    currentScrollKey,
    clearScheduledScrolls,
    externalScrollRef,
    isTurnNavigationAutoScrollSuspended,
    isWaitingForAssistant,
    lastMessage,
    latestGuidanceMessageId,
    loading,
    messageScrollSignature,
    messages,
    messages.length,
    scheduleStableRestoreSavedScrollPosition,
    scheduleStableScrollToBottom,
    scrollToBottom,
    setScrollToBottom,
  ])

  useLayoutEffect(() => {
    const turnNavigationSettled = !turnNavigationLoading && turnNavigationTargetMessageId === null
    if (
      !pendingAssistantResponseStartRef.current ||
      messages.length === 0 ||
      autoScrollSuspended ||
      !turnNavigationSettled ||
      isTurnNavigationAutoScrollSuspended()
    ) {
      return
    }

    pendingAssistantResponseStartRef.current = false
    setScrollToBottom('auto', { saveSnapshot: false })
    scheduleStableScrollToBottom('auto', { saveSnapshot: false })
  }, [
    autoScrollSuspended,
    isTurnNavigationAutoScrollSuspended,
    messages.length,
    scheduleStableScrollToBottom,
    setScrollToBottom,
    turnNavigationLoading,
    turnNavigationTargetMessageId,
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

  const captureUserViewportAnchor = useCallback(() => {
    const scroller = activeScrollRefRef.current.current
    const content = contentRef.current
    if (!scroller || !content) return
    userViewportAnchorRef.current = createUserViewportAnchor(scroller, content)
  }, [])

  const prepareForWorkspaceFileOpen = useCallback(
    (sourceElement: HTMLElement) => {
      const scroller = activeScrollRefRef.current.current
      const content = contentRef.current
      if (!scroller || !content) return
      const distanceToBottom = scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop
      if (distanceToBottom <= SCROLLED_TO_BOTTOM_THRESHOLD) return

      userScrollIntentRef.current = false
      userScrollPausedAutoFollowRef.current = true
      clearScheduledScrolls()
      userViewportAnchorRef.current = createUserViewportAnchorFromElement(
        content,
        sourceElement,
        scroller.getBoundingClientRect().top
      )
      saveCurrentScrollPosition()
    },
    [clearScheduledScrolls, saveCurrentScrollPosition]
  )

  const restoreUserViewportAnchor = useCallback(() => {
    const scroller = activeScrollRefRef.current.current
    const content = contentRef.current
    const anchor = userViewportAnchorRef.current
    if (!scroller || !content || !anchor) return

    const anchorElement = findUserViewportAnchor(content, anchor)
    if (!anchorElement) return
    const offsetFromScrollerTop =
      anchorElement.getBoundingClientRect().top - scroller.getBoundingClientRect().top
    const offsetDelta = offsetFromScrollerTop - anchor.offsetFromScrollerTop
    if (Math.abs(offsetDelta) < 0.5) return
    scroller.scrollTop += offsetDelta
    lastScrollTopRef.current = scroller.scrollTop
  }, [])

  const handleContentLayoutChange = useCallback(() => {
    if (autoScrollSuspended || isTurnNavigationAutoScrollSuspended()) {
      return
    }

    const restoringKey = restoringScrollKeyRef.current
    if (restoringKey && restoringKey === currentScrollKey) {
      restoreSavedScrollPosition(restoringKey)
      return
    }

    if (preserveLatestUserTurnRef.current) {
      return
    }

    const shouldFollowBottom =
      followingBottomKeyRef.current === currentScrollKey ||
      (currentScrollKey !== null &&
        getConversationScrollSnapshot(currentScrollKey)?.pinnedToBottom === true)
    if (shouldFollowBottom) {
      setScrollToBottom('auto', { saveSnapshot: false })
      return
    }

    if (userScrollPausedAutoFollowRef.current) {
      restoreUserViewportAnchor()
      return
    }

    if (isAtBottomRef.current) {
      scrollToBottom('auto', { saveSnapshot: false })
    }
  }, [
    autoScrollSuspended,
    currentScrollKey,
    isTurnNavigationAutoScrollSuspended,
    restoreSavedScrollPosition,
    restoreUserViewportAnchor,
    scrollToBottom,
    setScrollToBottom,
  ])

  useEffect(() => {
    const content = contentRef.current
    const footer = stickyFooterRef.current
    const scroller = activeScrollRefRef.current.current
    if (!content || !scroller || typeof ResizeObserver === 'undefined') return

    const resizeObserver = new ResizeObserver(() => {
      handleContentLayoutChange()
    })

    resizeObserver.observe(scroller)
    resizeObserver.observe(content)
    if (footer) {
      resizeObserver.observe(footer)
    }
    return () => resizeObserver.disconnect()
  }, [handleContentLayoutChange, stickyFooter])

  useEffect(() => clearScheduledScrolls, [clearScheduledScrolls])

  const handleScrollToBottom = () => {
    userScrollPausedAutoFollowRef.current = false
    userViewportAnchorRef.current = null
    preserveLatestUserTurnRef.current = false
    scrollToBottom('smooth', { saveSnapshot: true })
  }

  const markUserScrollIntent = useCallback(() => {
    userScrollIntentRef.current = true
  }, [])

  const handleScroll = useCallback(() => {
    if (autoScrollSuspended || isTurnNavigationAutoScrollSuspended()) {
      return
    }

    const userInitiated = userScrollIntentRef.current
    userScrollIntentRef.current = false
    if (userInitiated) {
      preserveLatestUserTurnRef.current = false
    }
    if (restoringScrollKeyRef.current === currentScrollKey) {
      if (!userInitiated) {
        updateScrollState({ skipSave: true })
        return
      }
      clearScheduledScrolls()
    }
    if (!userInitiated) {
      const shouldFollowBottom =
        followingBottomKeyRef.current === currentScrollKey ||
        (currentScrollKey !== null &&
          getConversationScrollSnapshot(currentScrollKey)?.pinnedToBottom === true)
      const scroller = activeScrollRefRef.current.current
      const distanceFromBottom =
        scroller === null
          ? Number.POSITIVE_INFINITY
          : scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop
      if (shouldFollowBottom && distanceFromBottom > SCROLLED_TO_BOTTOM_THRESHOLD) {
        setScrollToBottom('auto', { saveSnapshot: false })
        return
      }
      updateScrollState({ skipSave: true })
      return
    }
    updateScrollState({ forceSave: true })
    if (userScrollPausedAutoFollowRef.current) {
      captureUserViewportAnchor()
    }
  }, [
    autoScrollSuspended,
    captureUserViewportAnchor,
    clearScheduledScrolls,
    currentScrollKey,
    isTurnNavigationAutoScrollSuspended,
    setScrollToBottom,
    updateScrollState,
  ])

  useEffect(() => {
    const externalScroller = externalScrollRef?.current
    if (!externalScroller || externalScroller === internalScrollRef.current) return

    externalScroller.addEventListener('scroll', handleScroll)
    externalScroller.addEventListener('wheel', markUserScrollIntent)
    externalScroller.addEventListener('pointerdown', markUserScrollIntent)
    externalScroller.addEventListener('touchstart', markUserScrollIntent)
    externalScroller.addEventListener('keydown', markUserScrollIntent)
    return () => {
      externalScroller.removeEventListener('scroll', handleScroll)
      externalScroller.removeEventListener('wheel', markUserScrollIntent)
      externalScroller.removeEventListener('pointerdown', markUserScrollIntent)
      externalScroller.removeEventListener('touchstart', markUserScrollIntent)
      externalScroller.removeEventListener('keydown', markUserScrollIntent)
    }
  }, [externalScrollRef, handleScroll, markUserScrollIntent])

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
        onScroll={handleScroll}
        onWheel={markUserScrollIntent}
        onPointerDown={markUserScrollIntent}
        onTouchStart={markUserScrollIntent}
        onKeyDown={markUserScrollIntent}
      >
        <div
          ref={contentRef}
          data-testid={`${scrollTestId}-content`}
          className={cn(
            'min-w-0',
            stickyFooter && 'flex-1 shrink-0',
            (turnNavigationLoading || turnNavigationTargetMessageId || autoScrollSuspended) &&
              '[overflow-anchor:none]',
            contentClassName
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
                onBeforeOpenWorkspaceFile={prepareForWorkspaceFileOpen}
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
                onVirtualLayoutChange={handleContentLayoutChange}
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

function findLatestGuidanceMessageId(messages: WorkbenchMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.runtimeGuidance === true) return message.id
  }
  return null
}

function setConversationScrollSnapshot(key: string, snapshot: ConversationScrollSnapshot) {
  cacheConversationScrollSnapshot(key, snapshot)
}

function getInitialDistanceFromBottomPx(key: string | null): number {
  if (key === null) return 0
  const distance = getConversationScrollSnapshot(key)?.distanceFromBottomPx
  return typeof distance === 'number' && Number.isFinite(distance) ? Math.max(0, distance) : 0
}

function createUserViewportAnchor(
  scroller: HTMLElement,
  content: HTMLElement | null
): UserViewportAnchor | null {
  if (!content) return null
  const scrollerRect = scroller.getBoundingClientRect()
  const visibleAnchor = Array.from(
    content.querySelectorAll<HTMLElement>(SCROLL_ANCHOR_SELECTOR)
  ).find(anchor => {
    const rect = anchor.getBoundingClientRect()
    return rect.bottom > scrollerRect.top && rect.top < scrollerRect.bottom
  })
  if (!visibleAnchor) return null

  return createUserViewportAnchorFromElement(content, visibleAnchor, scrollerRect.top)
}

function createUserViewportAnchorFromElement(
  content: HTMLElement,
  element: HTMLElement,
  scrollerTop: number
): UserViewportAnchor | null {
  const visibleAnchor = element.closest<HTMLElement>(SCROLL_ANCHOR_SELECTOR)
  if (!visibleAnchor || !content.contains(visibleAnchor)) return null
  const message = visibleAnchor.closest<HTMLElement>('[data-message-id]')
  const messageId = message?.dataset.messageId
  if (!message || !messageId) return null
  const anchors = Array.from(message.querySelectorAll<HTMLElement>(SCROLL_ANCHOR_SELECTOR))
  const anchorIndex = anchors.indexOf(visibleAnchor)
  if (anchorIndex < 0) return null

  return {
    messageId,
    anchorIndex,
    offsetFromScrollerTop: visibleAnchor.getBoundingClientRect().top - scrollerTop,
  }
}

function findUserViewportAnchor(
  content: HTMLElement,
  anchor: UserViewportAnchor
): HTMLElement | null {
  const message = Array.from(content.querySelectorAll<HTMLElement>('[data-message-id]')).find(
    candidate => candidate.dataset.messageId === anchor.messageId
  )
  if (!message) return null
  return (
    Array.from(message.querySelectorAll<HTMLElement>(SCROLL_ANCHOR_SELECTOR))[anchor.anchorIndex] ??
    null
  )
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
  nextMessage: WorkbenchMessage | undefined,
  loadedRanges: RuntimeTranscriptRange[] | undefined
): RuntimeTranscriptGap | null {
  if (!nextMessage) return null
  const currentIndex = runtimeMessageIndex(message)
  const nextIndex = runtimeMessageIndex(nextMessage)
  if (currentIndex === null || nextIndex === null || nextIndex <= currentIndex + 1) return null

  let gapStart = currentIndex + 1
  const gapEnd = nextIndex
  const sortedRanges = [...(loadedRanges ?? [])]
    .filter(range => range.end > range.start)
    .sort((left, right) => left.start - right.start)

  for (const range of sortedRanges) {
    if (range.end <= gapStart) continue
    if (range.start > gapStart) {
      return { start: gapStart, end: Math.min(range.start, gapEnd) }
    }
    gapStart = Math.max(gapStart, range.end)
    if (gapStart >= gapEnd) return null
  }

  return { start: gapStart, end: gapEnd }
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
