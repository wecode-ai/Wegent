import { ArrowDown } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import type { WorkbenchMessage } from '@/types/workbench'
import { MessageList } from './MessageList'

interface ScrollableMessageAreaProps {
  messages: WorkbenchMessage[]
  className?: string
}

export function ScrollableMessageArea({
  messages,
  className,
}: ScrollableMessageAreaProps) {
  const { t } = useTranslation('common')
  const scrollRef = useRef<HTMLDivElement>(null)
  const [showScrollButton, setShowScrollButton] = useState(false)

  const updateScrollState = useCallback(() => {
    const element = scrollRef.current
    if (!element) return

    const overflow = element.scrollHeight > element.clientHeight + 8
    const distanceToBottom = element.scrollHeight - element.clientHeight - element.scrollTop
    setShowScrollButton(overflow && distanceToBottom > 48)
  }, [])

  useEffect(() => {
    updateScrollState()
  }, [messages, updateScrollState])

  const handleScrollToBottom = () => {
    const element = scrollRef.current
    if (!element) return

    element.scrollTo({
      top: element.scrollHeight,
      behavior: 'smooth',
    })
    setShowScrollButton(false)
  }

  return (
    <div className={cn('relative min-h-0 flex-1', className)}>
      <div
        ref={scrollRef}
        data-testid="chat-message-scroll-area"
        className="h-full overflow-auto"
        onScroll={updateScrollState}
      >
        <MessageList messages={messages} />
      </div>
      {showScrollButton && (
        <button
          type="button"
          data-testid="scroll-to-bottom-button"
          onClick={handleScrollToBottom}
          className="absolute bottom-4 left-1/2 z-10 flex h-9 w-9 -translate-x-1/2 items-center justify-center rounded-full border border-border bg-white text-text-primary shadow-sm hover:bg-muted"
          aria-label={t('workbench.scroll_to_bottom', '下拉到底')}
        >
          <ArrowDown className="h-4 w-4" />
        </button>
      )}
    </div>
  )
}
