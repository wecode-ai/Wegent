import { ArrowDown } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import type { DeviceInfo, TurnFileChangesSummary } from '@/types/api'
import type { WorkbenchMessage } from '@/types/workbench'
import { MessageList } from './MessageList'
import { MessageTurnNavigation } from './MessageTurnNavigation'

const BOTTOM_THRESHOLD = 48
const STABLE_SCROLL_DELAYS = [0, 50, 150, 300]
const MESSAGE_ANCHOR_SELECTOR = '[data-message-id]'
const SCROLL_ANCHOR_SELECTOR = '[data-scroll-anchor]'

interface ConversationScrollSnapshot {
  scrollTop: number
  anchorMessageId?: string
  anchorOffsetTop?: number
  anchorDocumentTop?: number
  anchorIndex?: number
  anchorKind?: 'message' | 'content'
}

const conversationScrollSnapshots = new Map<string, ConversationScrollSnapshot>()

interface ScrollableMessageAreaProps {
  messages: WorkbenchMessage[]
  loading?: boolean
  isWaitingForAssistant?: boolean
  hasMoreBefore?: boolean
  loadingMoreBefore?: boolean
  className?: string
  scrollerClassName?: string
  scrollButtonClassName?: string
  scrollTestId?: string
  conversationKey?: string | number | null
  devices?: DeviceInfo[]
  onRetryFailedMessage?: (message: WorkbenchMessage) => void
  onSwitchModelForFailedMessage?: (message: WorkbenchMessage) => void
  onLoadFileChangesDiff?: (subtaskId: number) => Promise<string>
  onRevertFileChanges?: (subtaskId: number) => Promise<TurnFileChangesSummary>
  onOpenFileChangesReview?: (request: {
    subtaskId: number
    loadDiff: () => Promise<string>
    reviewTitle?: string
    defaultFileTreeVisible?: boolean
    focusFilePath?: string
  }) => void
  onOpenWorkspaceFile?: (path: string) => void
  onLoadMoreBefore?: () => Promise<void> | void
}

export function ScrollableMessageArea({
  messages,
  loading = false,
  isWaitingForAssistant = false,
  hasMoreBefore = false,
  loadingMoreBefore = false,
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
}: ScrollableMessageAreaProps) {
  const { t } = useTranslation('common')
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const isAtBottomRef = useRef(true)
  const previousConversationKeyRef = useRef<string | number | null | undefined>(undefined)
  const previousLastMessageIdRef = useRef<string | null>(null)
  const previousMessageCountRef = useRef(0)
  const scrollTimersRef = useRef<Array<ReturnType<typeof setTimeout>>>([])
  const scrollFrameRef = useRef<number | null>(null)
  const restoringScrollKeyRef = useRef<string | null>(null)
  const applyingSavedScrollRef = useRef(false)
  const [showScrollButton, setShowScrollButton] = useState(false)
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

  const clearScheduledScrolls = useCallback(() => {
    scrollTimersRef.current.forEach(timer => clearTimeout(timer))
    scrollTimersRef.current = []
    applyingSavedScrollRef.current = false

    if (scrollFrameRef.current !== null) {
      cancelAnimationFrame(scrollFrameRef.current)
      scrollFrameRef.current = null
    }
  }, [])

  const saveCurrentScrollPosition = useCallback(
    (scrollTop?: number) => {
      const element = scrollRef.current
      const content = contentRef.current
      if (!element || currentScrollKey === null || messages.length === 0) return
      conversationScrollSnapshots.set(
        currentScrollKey,
        createScrollSnapshot(element, content, scrollTop)
      )
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
    (behavior: ScrollBehavior = 'auto') => {
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
      saveCurrentScrollPosition(element.scrollHeight)
      isAtBottomRef.current = true
      setShowScrollButton(false)
    },
    [saveCurrentScrollPosition]
  )

  const restoreSavedScrollPosition = useCallback(
    (key: string, options: { clearScheduled?: boolean } = {}) => {
      const element = scrollRef.current
      const content = contentRef.current
      const savedSnapshot = conversationScrollSnapshots.get(key)
      if (!element || !savedSnapshot) return

      if (options.clearScheduled) {
        clearScheduledScrolls()
      }
      const maxScrollTop = Math.max(0, element.scrollHeight - element.clientHeight)
      const nextScrollTop = Math.min(
        getRestoredScrollTop(element, content, savedSnapshot),
        maxScrollTop
      )
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
    (behavior: ScrollBehavior = 'auto') => {
      const element = scrollRef.current
      if (!element) return

      if (scrollFrameRef.current !== null) {
        cancelAnimationFrame(scrollFrameRef.current)
      }

      scrollFrameRef.current = requestAnimationFrame(() => {
        scrollFrameRef.current = null
        setScrollToBottom(behavior)
      })
    },
    [setScrollToBottom]
  )

  const scheduleStableScrollToBottom = useCallback(
    (behavior: ScrollBehavior = 'auto') => {
      clearScheduledScrolls()

      STABLE_SCROLL_DELAYS.forEach(delay => {
        const timer = setTimeout(() => {
          scrollToBottom(behavior)
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

    if (messages.length === 0) return

    if (shouldRestoreScroll && currentScrollKey) {
      scheduleStableRestoreSavedScrollPosition(currentScrollKey)
      return
    }

    if (shouldForceBottom || isAtBottomRef.current) {
      setScrollToBottom()
      scheduleStableScrollToBottom()
    }
  }, [
    conversationKey,
    currentScrollKey,
    lastMessage,
    messageScrollSignature,
    messages.length,
    scheduleStableRestoreSavedScrollPosition,
    scheduleStableScrollToBottom,
    setScrollToBottom,
  ])

  useLayoutEffect(() => {
    const frame = requestAnimationFrame(() => {
      updateScrollState()
    })
    return () => cancelAnimationFrame(frame)
  }, [isWaitingForAssistant, messages, updateScrollState])

  useEffect(() => {
    const content = contentRef.current
    if (!content || typeof ResizeObserver === 'undefined') return

    const resizeObserver = new ResizeObserver(() => {
      const restoringKey = restoringScrollKeyRef.current
      if (restoringKey && restoringKey === currentScrollKey) {
        restoreSavedScrollPosition(restoringKey, { clearScheduled: false })
        return
      }

      if (isAtBottomRef.current) {
        scrollToBottom()
      }
    })

    resizeObserver.observe(content)
    return () => resizeObserver.disconnect()
  }, [currentScrollKey, restoreSavedScrollPosition, scrollToBottom])

  useEffect(() => clearScheduledScrolls, [clearScheduledScrolls])

  const handleScrollToBottom = () => {
    scrollToBottom('smooth')
  }

  return (
    <div className={cn('relative min-h-0 flex-1', className)}>
      <MessageTurnNavigation messages={messages} scrollRef={scrollRef} contentRef={contentRef} />
      <div
        ref={scrollRef}
        data-testid={scrollTestId}
        className={cn('h-full overflow-x-hidden overflow-y-auto', scrollerClassName)}
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
          className={cn('min-w-0 overflow-x-hidden')}
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
                devices={devices}
                onRetryFailedMessage={onRetryFailedMessage}
                onSwitchModelForFailedMessage={onSwitchModelForFailedMessage}
                onLoadFileChangesDiff={onLoadFileChangesDiff}
                onRevertFileChanges={onRevertFileChanges}
                onOpenFileChangesReview={onOpenFileChangesReview}
                onOpenWorkspaceFile={onOpenWorkspaceFile}
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

function scrollPositionKey(conversationKey: string | number | null | undefined): string | null {
  return conversationKey == null ? null : String(conversationKey)
}

function createScrollSnapshot(
  scroller: HTMLElement,
  content: HTMLElement | null,
  scrollTop?: number
): ConversationScrollSnapshot {
  const snapshot: ConversationScrollSnapshot = {
    scrollTop: scrollTop ?? scroller.scrollTop,
  }
  if (scrollTop !== undefined || !content) return snapshot

  const anchor = findTopVisibleMessageAnchor(scroller, content)
  if (!anchor) return snapshot

  const scrollerRect = scroller.getBoundingClientRect()
  const anchorRect = anchor.getBoundingClientRect()
  const message = anchor.matches(MESSAGE_ANCHOR_SELECTOR)
    ? anchor
    : anchor.closest<HTMLElement>(MESSAGE_ANCHOR_SELECTOR)
  const messageId = message?.dataset.messageId
  if (!messageId) return snapshot

  snapshot.anchorMessageId = messageId
  snapshot.anchorOffsetTop = anchorRect.top - scrollerRect.top
  snapshot.anchorDocumentTop = snapshot.scrollTop + snapshot.anchorOffsetTop
  snapshot.anchorKind = anchor.matches(SCROLL_ANCHOR_SELECTOR) ? 'content' : 'message'
  if (message && snapshot.anchorKind === 'content') {
    snapshot.anchorIndex = getMessageScrollAnchors(message).indexOf(anchor)
  }
  return snapshot
}

function getRestoredScrollTop(
  scroller: HTMLElement,
  content: HTMLElement | null,
  snapshot: ConversationScrollSnapshot
): number {
  if (!content || !snapshot.anchorMessageId || snapshot.anchorOffsetTop === undefined) {
    return Math.max(0, snapshot.scrollTop)
  }

  const anchor = findSavedAnchor(content, snapshot)
  if (!anchor || !hasMeasurableRect(anchor)) {
    return Math.max(0, snapshot.scrollTop)
  }

  const scrollerRect = scroller.getBoundingClientRect()
  const anchorRect = anchor.getBoundingClientRect()
  const currentAnchorOffsetTop = anchorRect.top - scrollerRect.top
  if (snapshot.anchorDocumentTop !== undefined) {
    const currentAnchorDocumentTop = scroller.scrollTop + currentAnchorOffsetTop
    return Math.max(0, snapshot.scrollTop + currentAnchorDocumentTop - snapshot.anchorDocumentTop)
  }

  return Math.max(0, scroller.scrollTop + currentAnchorOffsetTop - snapshot.anchorOffsetTop)
}

function findTopVisibleMessageAnchor(
  scroller: HTMLElement,
  content: HTMLElement
): HTMLElement | null {
  return (
    findTopVisibleAnchor(scroller, Array.from(content.querySelectorAll(SCROLL_ANCHOR_SELECTOR))) ??
    findTopVisibleAnchor(scroller, Array.from(content.querySelectorAll(MESSAGE_ANCHOR_SELECTOR)))
  )
}

function findTopVisibleAnchor(scroller: HTMLElement, anchors: Element[]): HTMLElement | null {
  const scrollerRect = scroller.getBoundingClientRect()
  let nearestAnchor: HTMLElement | null = null
  let nearestDistance = Number.POSITIVE_INFINITY

  for (const anchor of anchors) {
    if (!(anchor instanceof HTMLElement)) continue
    if (!hasMeasurableRect(anchor)) continue

    const rect = anchor.getBoundingClientRect()
    if (rect.bottom > scrollerRect.top && rect.top < scrollerRect.bottom) {
      return anchor
    }

    const distance = Math.abs(rect.top - scrollerRect.top)
    if (distance < nearestDistance) {
      nearestDistance = distance
      nearestAnchor = anchor
    }
  }

  return nearestAnchor
}

function findSavedAnchor(
  content: HTMLElement,
  snapshot: ConversationScrollSnapshot
): HTMLElement | null {
  const message = findMessageAnchorById(content, snapshot.anchorMessageId ?? '')
  if (!message) return null
  if (snapshot.anchorKind !== 'content' || snapshot.anchorIndex === undefined) return message

  return getMessageScrollAnchors(message)[snapshot.anchorIndex] ?? message
}

function findMessageAnchorById(content: HTMLElement, messageId: string): HTMLElement | null {
  if (!messageId) return null
  return (
    Array.from(content.querySelectorAll<HTMLElement>(MESSAGE_ANCHOR_SELECTOR)).find(
      anchor => anchor.dataset.messageId === messageId
    ) ?? null
  )
}

function getMessageScrollAnchors(message: HTMLElement): HTMLElement[] {
  return Array.from(message.querySelectorAll<HTMLElement>(SCROLL_ANCHOR_SELECTOR))
}

function hasMeasurableRect(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect()
  return rect.bottom > rect.top
}
