import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { DialogSurface } from '../controls/DialogSurface'
import { useFocusRequest } from '../dom-events'
import { collaborationTestIds } from '../testIds'

interface IssueConversationDrawersProps {
  embedded?: boolean
  active?: boolean
  label: string
  children: (close: () => void) => ReactNode
  conversation: ReactNode
  conversationKey?: string
  canClose?: () => boolean
  onClose: () => void
  onCloseConversation: () => void
}

/** One overlay owns both panes, so the conversation cannot fall behind its Issue. */
export function IssueConversationDrawers({
  embedded = false,
  active = true,
  label,
  children,
  conversation,
  conversationKey,
  canClose,
  onClose,
  onCloseConversation,
}: IssueConversationDrawersProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const trackRef = useRef<HTMLDivElement>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const closeCommittedRef = useRef(false)
  const [retainedConversation, setRetainedConversation] = useState(conversation)
  const [dismissing, setDismissing] = useState(false)
  const hasConversation = Boolean(conversation)
  const requestClose = () => {
    if (canClose?.() !== false) setDismissing(true)
  }
  if (conversation && conversation !== retainedConversation) {
    setRetainedConversation(conversation)
  }

  useLayoutEffect(() => {
    if (dismissing && closeCommittedRef.current) return
    if (!dismissing) {
      closeCommittedRef.current = false
      if (hasConversation) return
    }
    let active = true
    const finishExit = async () => {
      // getAnimations flushes style and includes the transition started by this commit.
      // Re-check after cancellation (for example, resizing or enabling reduced motion).
      const runningAnimations = () =>
        (trackRef.current?.getAnimations() ?? []).filter(
          animation => animation.playState !== 'finished' && animation.playState !== 'idle'
        )
      let animations = runningAnimations()
      while (animations.length > 0) {
        await Promise.allSettled(animations.map(animation => animation.finished))
        if (!active) return
        animations = runningAnimations()
      }
      if (!active) return
      if (dismissing) {
        if (closeCommittedRef.current) return
        closeCommittedRef.current = true
        onClose()
      } else setRetainedConversation(null)
    }
    void finishExit()
    return () => {
      active = false
    }
  }, [hasConversation, dismissing, onClose])
  useFocusRequest(containerRef, conversationKey, {
    enabled: active && hasConversation,
    selector: '[data-testid="ai-chat-modal-close"]',
    preventScroll: true,
    restoreFocus: true,
    restoreWithin: '.issue-drawer-conversation',
  })

  return (
    <DialogSurface
      active={!embedded}
      suspended={!active}
      initialFocus={() =>
        containerRef.current?.querySelector<HTMLElement>(
          hasConversation
            ? '[data-testid="ai-chat-modal-close"]'
            : '[data-testid="cloud-todo-detail-close"]'
        ) ?? null
      }
      onClose={() => {
        if (hasConversation) onCloseConversation()
        else requestClose()
      }}
      render={
        <div
          ref={containerRef}
          className={`issue-conversation-drawers-backdrop${embedded ? ' issue-conversation-drawers-embedded' : ''}`}
          data-testid={collaborationTestIds.issueDetail}
          onKeyDown={event => {
            if (
              embedded &&
              !event.defaultPrevented &&
              event.currentTarget.contains(event.target as Node) &&
              event.key === 'Escape'
            ) {
              event.stopPropagation()
              if (hasConversation) onCloseConversation()
              else requestClose()
            }
          }}
          role={embedded ? 'region' : undefined}
          aria-label={label}
          onMouseDown={event => {
            if (event.currentTarget === event.target) {
              if (hasConversation) onCloseConversation()
              else requestClose()
            }
          }}
        />
      }
    >
      <div ref={viewportRef} className="issue-drawer-viewport">
        <div
          ref={trackRef}
          className="issue-conversation-drawers"
          data-testid="issue-conversation-drawers"
          data-has-conversation={hasConversation}
          data-dismissing={dismissing}
          inert={dismissing}
        >
          <div className="issue-drawer-surface issue-drawer-detail">{children(requestClose)}</div>
          <div className="issue-drawer-surface issue-drawer-conversation" inert={!hasConversation}>
            {conversation || retainedConversation}
          </div>
        </div>
      </div>
    </DialogSurface>
  )
}
