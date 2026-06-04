import { ArrowDown } from 'lucide-react'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import type { WorkbenchMessage } from '@/types/workbench'
import { MessageList } from './MessageList'

const BOTTOM_THRESHOLD = 48
const STABLE_SCROLL_DELAYS = [0, 50, 150, 300]

interface ScrollableMessageAreaProps {
  messages: WorkbenchMessage[]
  className?: string
  scrollerClassName?: string
  scrollButtonClassName?: string
  scrollTestId?: string
  conversationKey?: string | number | null
}

export function ScrollableMessageArea({
  messages,
  className,
  scrollerClassName,
  scrollButtonClassName,
  scrollTestId = 'chat-message-scroll-area',
  conversationKey,
}: ScrollableMessageAreaProps) {
  const { t } = useTranslation('common')
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const isAtBottomRef = useRef(true)
  const previousConversationKeyRef = useRef<string | number | null | undefined>(
    undefined,
  )
  const previousLastMessageIdRef = useRef<string | null>(null)
  const previousMessageCountRef = useRef(0)
  const scrollTimersRef = useRef<Array<ReturnType<typeof setTimeout>>>([])
  const scrollFrameRef = useRef<number | null>(null)
  const [showScrollButton, setShowScrollButton] = useState(false)
  const lastMessage = messages[messages.length - 1]
  const messageScrollSignature = useMemo(() => {
    if (!lastMessage) return 'empty'

    const blockSignature = (lastMessage.blocks ?? [])
      .map(block => {
        if (block.type === 'thinking') {
          return `${block.id}:${block.status}:${block.content.length}`
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
    ].join(':')
  }, [lastMessage, messages.length])

  const clearScheduledScrolls = useCallback(() => {
    scrollTimersRef.current.forEach((timer) => clearTimeout(timer))
    scrollTimersRef.current = []

    if (scrollFrameRef.current !== null) {
      cancelAnimationFrame(scrollFrameRef.current)
      scrollFrameRef.current = null
    }
  }, [])

  const updateScrollState = useCallback(() => {
    const element = scrollRef.current
    if (!element) return

    const overflow = element.scrollHeight > element.clientHeight + 8
    const distanceToBottom =
      element.scrollHeight - element.clientHeight - element.scrollTop
    const isAtBottom = distanceToBottom <= BOTTOM_THRESHOLD
    isAtBottomRef.current = isAtBottom
    if (!isAtBottom) {
      clearScheduledScrolls()
    }
    setShowScrollButton(overflow && !isAtBottom)
  }, [clearScheduledScrolls])

  const setScrollToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
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
    isAtBottomRef.current = true
    setShowScrollButton(false)
  }, [])

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
    [setScrollToBottom],
  )

  const scheduleStableScrollToBottom = useCallback(
    (behavior: ScrollBehavior = 'auto') => {
      clearScheduledScrolls()

      STABLE_SCROLL_DELAYS.forEach((delay) => {
        const timer = setTimeout(() => {
          scrollToBottom(behavior)
        }, delay)
        scrollTimersRef.current.push(timer)
      })
    },
    [clearScheduledScrolls, scrollToBottom],
  )

  useLayoutEffect(() => {
    const conversationChanged =
      previousConversationKeyRef.current !== conversationKey
    const messagesLoaded =
      previousMessageCountRef.current === 0 && messages.length > 0
    const lastMessageChanged =
      previousLastMessageIdRef.current !== (lastMessage?.id ?? null)
    const shouldForceBottom =
      conversationChanged ||
      messagesLoaded ||
      (lastMessageChanged && lastMessage?.role === 'user')

    previousConversationKeyRef.current = conversationKey
    previousLastMessageIdRef.current = lastMessage?.id ?? null
    previousMessageCountRef.current = messages.length

    if (messages.length === 0) return

    if (shouldForceBottom || isAtBottomRef.current) {
      setScrollToBottom()
      scheduleStableScrollToBottom()
    }
  }, [
    conversationKey,
    lastMessage,
    messageScrollSignature,
    messages.length,
    scheduleStableScrollToBottom,
    setScrollToBottom,
  ])

  useLayoutEffect(() => {
    updateScrollState()
  }, [messages, updateScrollState])

  useEffect(() => {
    const content = contentRef.current
    if (!content || typeof ResizeObserver === 'undefined') return

    const resizeObserver = new ResizeObserver(() => {
      if (isAtBottomRef.current) {
        scrollToBottom()
      }
    })

    resizeObserver.observe(content)
    return () => resizeObserver.disconnect()
  }, [scrollToBottom])

  useEffect(() => clearScheduledScrolls, [clearScheduledScrolls])

  const handleScrollToBottom = () => {
    scrollToBottom('smooth')
  }

  return (
    <div className={cn('relative min-h-0 flex-1', className)}>
      <div
        ref={scrollRef}
        data-testid={scrollTestId}
        className={cn('h-full overflow-x-hidden overflow-y-auto', scrollerClassName)}
        onScroll={updateScrollState}
      >
        <div ref={contentRef} className="min-w-0 overflow-x-hidden">
          {messages.length === 0 ? (
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
                  '在下方输入问题、粘贴上下文或添加附件，Codex 会在这里展示回复。',
                )}
              </p>
            </div>
          ) : (
            <MessageList messages={messages} />
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
            scrollButtonClassName,
          )}
          aria-label={t('workbench.scroll_to_bottom', '下拉到底')}
        >
          <ArrowDown className="h-4 w-4" />
        </button>
      )}
    </div>
  )
}
