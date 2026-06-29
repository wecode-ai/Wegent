import { ArrowDown } from 'lucide-react'
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import type { DeviceInfo, RuntimeTurnNavigationItem, TurnFileChangesSummary } from '@/types/api'
import type { WorkbenchMessage } from '@/types/workbench'
import { MessageList } from './MessageList'
import { MessageTurnNavigation } from './MessageTurnNavigation'

const BOTTOM_THRESHOLD = 48
const STABLE_SCROLL_DELAYS = [0]

interface ConversationScrollSnapshot {
  scrollTop: number
}

interface RuntimeTranscriptGap {
  start: number
  end: number
}

const conversationScrollSnapshots = new Map<string, ConversationScrollSnapshot>()

interface ScrollableMessageAreaProps {
  messages: WorkbenchMessage[]
  loading?: boolean
  isWaitingForAssistant?: boolean
  hasMoreBefore?: boolean
  loadingMoreBefore?: boolean
  turnNavigation?: RuntimeTurnNavigationItem[]
  className?: string
  scrollerClassName?: string
  scrollButtonClassName?: string
  scrollTestId?: string
  conversationKey?: string | number | null
  devices?: DeviceInfo[]
  onRetryFailedMessage?: (message: WorkbenchMessage) => void
  onSwitchModelForFailedMessage?: (message: WorkbenchMessage) => void
  onLoadFileChangesDiff?: (turnId: number) => Promise<string>
  onRevertFileChanges?: (turnId: number) => Promise<TurnFileChangesSummary>
  onOpenFileChangesReview?: (request: {
    turnId: number
    loadDiff: () => Promise<string>
    reviewTitle?: string
    defaultFileTreeVisible?: boolean
    focusFilePath?: string
  }) => void
  onOpenWorkspaceFile?: (path: string) => void
  onLoadMoreBefore?: () => Promise<void> | void
  onLoadTurnNavigationItem?: (item: RuntimeTurnNavigationItem) => Promise<void> | void
  onLoadTranscriptGap?: (gap: RuntimeTranscriptGap) => Promise<void> | void
}

export const ScrollableMessageArea = memo(function ScrollableMessageArea(
  props: ScrollableMessageAreaProps
) {
  return <ScrollableMessagePaneFrame paneProps={props} />
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
    previous.scrollButtonClassName !== next.scrollButtonClassName ? 'scrollButtonClassName' : null,
    previous.scrollTestId !== next.scrollTestId ? 'scrollTestId' : null,
    previous.conversationKey !== next.conversationKey ? 'conversationKey' : null,
    previous.devices !== next.devices ? 'devices' : null,
    previous.onLoadMoreBefore !== next.onLoadMoreBefore ? 'onLoadMoreBefore' : null,
    previous.onLoadTurnNavigationItem !== next.onLoadTurnNavigationItem
      ? 'onLoadTurnNavigationItem'
      : null,
    previous.onLoadTranscriptGap !== next.onLoadTranscriptGap ? 'onLoadTranscriptGap' : null,
  ].filter((key): key is string => key !== null)

  return changed.length === 0
}

function ScrollableMessagePaneFrame({ paneProps }: { paneProps: ScrollableMessageAreaProps }) {
  return (
    <div
      data-active-conversation-pane="true"
      className={cn('relative min-h-0 flex-1 bg-background', paneProps.className, 'z-10')}
    >
      <MemoizedScrollableMessagePaneContent {...paneProps} className="h-full" />
    </div>
  )
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
  scrollButtonClassName,
  scrollTestId = 'chat-message-scroll-area',
  conversationKey,
  devices,
  onRetryFailedMessage,
  onSwitchModelForFailedMessage,
  onLoadFileChangesDiff,
  onRevertFileChanges,
  onOpenFileChangesReview,
  onOpenWorkspaceFile,
  onLoadMoreBefore,
  onLoadTurnNavigationItem,
  onLoadTranscriptGap,
}: ScrollableMessageAreaProps) {
  const { t } = useTranslation('common')
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const isAtBottomRef = useRef(true)
  const turnNavigationLoadingRef = useRef(false)
  const previousConversationKeyRef = useRef<string | number | null | undefined>(undefined)
  const previousLastMessageIdRef = useRef<string | null>(null)
  const previousMessageCountRef = useRef(0)
  const scrollTimersRef = useRef<Array<ReturnType<typeof setTimeout>>>([])
  const scrollFrameRef = useRef<number | null>(null)
  const restoringScrollKeyRef = useRef<string | null>(null)
  const applyingSavedScrollRef = useRef(false)
  const scheduledScrollStateSignatureRef = useRef<string | null>(null)
  const completedScrollStateSignatureRef = useRef<string | null>(null)
  const loadingTranscriptGapKeyRef = useRef<string | null>(null)
  const [showScrollButton, setShowScrollButton] = useState(false)
  const [turnNavigationLoading, setTurnNavigationLoading] = useState(false)
  const [loadingTranscriptGapKey, setLoadingTranscriptGapKey] = useState<string | null>(null)
  const lastMessage = messages[messages.length - 1]
  const currentScrollKey = useMemo(() => scrollPositionKey(conversationKey), [conversationKey])
  const messageScrollSignature = useMemo(() => {
    if (!lastMessage) return 'empty'

    const blockSignature = (lastMessage.blocks ?? [])
      .map(block => {
        if (block.type === 'thinking' || block.type === 'text') {
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

  const clearScheduledScrolls = useCallback(() => {
    scrollTimersRef.current.forEach(timer => clearTimeout(timer))
    scrollTimersRef.current = []
    applyingSavedScrollRef.current = false

    if (scrollFrameRef.current !== null) {
      cancelAnimationFrame(scrollFrameRef.current)
      scrollFrameRef.current = null
    }
  }, [])

  const isTurnNavigationAutoScrollSuspended = useCallback(
    () => turnNavigationLoadingRef.current,
    []
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
    [loadTranscriptGap, loadingTranscriptGapKey]
  )

  const saveCurrentScrollPosition = useCallback(
    (scrollTop?: number) => {
      const element = scrollRef.current
      if (!element || currentScrollKey === null || messages.length === 0) return
      conversationScrollSnapshots.set(currentScrollKey, createScrollSnapshot(element, scrollTop))
    },
    [currentScrollKey, messages.length]
  )

  const updateScrollState = useCallback(
    (options: { forceSave?: boolean; skipSave?: boolean } = {}) => {
      const element = scrollRef.current
      if (!element) return

      if (messages.length === 0) {
        isAtBottomRef.current = true
        setShowScrollButton(false)
        return
      }

      const overflow = element.scrollHeight > element.clientHeight + 8
      const distanceToBottom = element.scrollHeight - element.clientHeight - element.scrollTop
      const isAtBottom = distanceToBottom <= BOTTOM_THRESHOLD
      isAtBottomRef.current = isAtBottom
      if (!isAtBottom && restoringScrollKeyRef.current !== currentScrollKey) {
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
      const element = scrollRef.current
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
      setShowScrollButton(false)
    },
    [saveCurrentScrollPosition]
  )

  const restoreSavedScrollPosition = useCallback(
    (key: string, options: { clearScheduled?: boolean } = {}) => {
      const element = scrollRef.current
      const savedSnapshot = conversationScrollSnapshots.get(key)
      if (!element || !savedSnapshot) return

      if (options.clearScheduled) {
        clearScheduledScrolls()
      }
      const maxScrollTop = Math.max(0, element.scrollHeight - element.clientHeight)
      const nextScrollTop = Math.min(getRestoredScrollTop(savedSnapshot), maxScrollTop)
      applyingSavedScrollRef.current = true
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
      isAtBottomRef.current = isAtBottom
      setShowScrollButton(overflow && !isAtBottom)
      conversationScrollSnapshots.set(key, savedSnapshot)

      const applyingTimer = setTimeout(() => {
        applyingSavedScrollRef.current = false
      }, 0)
      scrollTimersRef.current.push(applyingTimer)
    },
    [clearScheduledScrolls]
  )

  const scheduleStableRestoreSavedScrollPosition = useCallback(
    (key: string) => {
      clearScheduledScrolls()
      restoringScrollKeyRef.current = key

      STABLE_SCROLL_DELAYS.forEach(delay => {
        const timer = setTimeout(() => {
          restoreSavedScrollPosition(key, { clearScheduled: false })
        }, delay)
        scrollTimersRef.current.push(timer)
      })

      const clearRestoreTimer = setTimeout(
        () => {
          if (restoringScrollKeyRef.current === key) {
            restoringScrollKeyRef.current = null
          }
        },
        Math.max(...STABLE_SCROLL_DELAYS) + 50
      )
      scrollTimersRef.current.push(clearRestoreTimer)
    },
    [clearScheduledScrolls, restoreSavedScrollPosition]
  )

  const scrollToBottom = useCallback(
    (behavior: ScrollBehavior = 'auto', options: { saveSnapshot?: boolean } = {}) => {
      const element = scrollRef.current
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

      STABLE_SCROLL_DELAYS.forEach(delay => {
        const timer = setTimeout(() => {
          scrollToBottom(behavior, options)
        }, delay)
        scrollTimersRef.current.push(timer)
      })
    },
    [clearScheduledScrolls, scrollToBottom]
  )

  useLayoutEffect(() => {
    const conversationChanged = previousConversationKeyRef.current !== conversationKey
    const messagesLoaded = previousMessageCountRef.current === 0 && messages.length > 0
    const lastMessageChanged = previousLastMessageIdRef.current !== (lastMessage?.id ?? null)
    const shouldRestoreScroll = Boolean(
      currentScrollKey &&
      messages.length > 0 &&
      (conversationChanged || messagesLoaded) &&
      conversationScrollSnapshots.has(currentScrollKey)
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

    if (isTurnNavigationAutoScrollSuspended()) {
      clearScheduledScrolls()
      return
    }

    if (shouldRestoreScroll && currentScrollKey) {
      scheduleStableRestoreSavedScrollPosition(currentScrollKey)
      return
    }

    if (shouldForceBottom || isAtBottomRef.current) {
      setScrollToBottom('auto', { saveSnapshot: false })
      scheduleStableScrollToBottom('auto', { saveSnapshot: false })
    }
  }, [
    conversationKey,
    currentScrollKey,
    clearScheduledScrolls,
    isTurnNavigationAutoScrollSuspended,
    lastMessage,
    messageScrollSignature,
    messages.length,
    scheduleStableRestoreSavedScrollPosition,
    scheduleStableScrollToBottom,
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
    if (!content || typeof ResizeObserver === 'undefined') return

    const resizeObserver = new ResizeObserver(() => {
      const restoringKey = restoringScrollKeyRef.current
      if (restoringKey && restoringKey === currentScrollKey) {
        restoreSavedScrollPosition(restoringKey, { clearScheduled: false })
        return
      }

      if (isTurnNavigationAutoScrollSuspended()) {
        return
      }

      if (isAtBottomRef.current) {
        scrollToBottom('auto', { saveSnapshot: false })
      }
    })

    resizeObserver.observe(content)
    return () => resizeObserver.disconnect()
  }, [
    currentScrollKey,
    isTurnNavigationAutoScrollSuspended,
    restoreSavedScrollPosition,
    scrollToBottom,
  ])

  useEffect(() => clearScheduledScrolls, [clearScheduledScrolls])

  const handleScrollToBottom = () => {
    scrollToBottom('smooth', { saveSnapshot: true })
  }

  return (
    <div className={cn('relative min-h-0 flex-1', className)}>
      <MessageTurnNavigation
        messages={messages}
        turnNavigation={turnNavigation}
        scrollRef={scrollRef}
        contentRef={contentRef}
        onLoadTurnNavigationItem={onLoadTurnNavigationItem}
        onNavigationLoadStateChange={handleTurnNavigationLoadStateChange}
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
        ref={scrollRef}
        data-testid={scrollTestId}
        className={cn(
          'h-full overflow-x-hidden overflow-y-auto',
          turnNavigationLoading && '[overflow-anchor:none]',
          scrollerClassName
        )}
        onScroll={() => {
          if (
            applyingSavedScrollRef.current &&
            restoringScrollKeyRef.current === currentScrollKey
          ) {
            updateScrollState({ skipSave: true })
            return
          }
          applyingSavedScrollRef.current = false
          restoringScrollKeyRef.current = null
          updateScrollState({ forceSave: true })
        }}
      >
        <div
          ref={contentRef}
          data-testid={`${scrollTestId}-content`}
          className={cn(
            'min-w-0 overflow-x-hidden',
            turnNavigationLoading && '[overflow-anchor:none]'
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
                    '在下方输入问题、粘贴上下文或添加附件，Codex 会在这里展示回复。'
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
                conversationKey={conversationKey}
                isWaitingForAssistant={isWaitingForAssistant}
                disableContentVisibility={turnNavigationLoading}
                devices={devices}
                onRetryFailedMessage={onRetryFailedMessage}
                onSwitchModelForFailedMessage={onSwitchModelForFailedMessage}
                onLoadFileChangesDiff={onLoadFileChangesDiff}
                onRevertFileChanges={onRevertFileChanges}
                onOpenFileChangesReview={onOpenFileChangesReview}
                onOpenWorkspaceFile={onOpenWorkspaceFile}
                renderGapAfterMessage={renderTranscriptGapAfterMessage}
              />
            </>
          )}
        </div>
      </div>
      {showScrollButton && (
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
      )}
    </div>
  )
}

const MemoizedScrollableMessagePaneContent = memo(
  ScrollableMessagePaneContent,
  areScrollableMessageAreaPropsEqual
)

function scrollPositionKey(conversationKey: string | number | null | undefined): string | null {
  return conversationKey == null ? null : String(conversationKey)
}

function createScrollSnapshot(
  scroller: HTMLElement,
  scrollTop?: number
): ConversationScrollSnapshot {
  return {
    scrollTop: scrollTop ?? scroller.scrollTop,
  }
}

function getRestoredScrollTop(snapshot: ConversationScrollSnapshot): number {
  return Math.max(0, snapshot.scrollTop)
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
