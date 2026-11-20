import { cn } from '@/lib/utils'
import {
  HoverCardContent,
  HoverCardTrigger,
  HoverCard as UiHoverCard,
} from '@wegent/collaboration/controls/HoverCard'
import { X } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Button } from './button'

interface HoverCardProps {
  children: ReactNode
  content: ReactNode
  testId: string
  interactive?: boolean
  openOnFocus?: boolean
  pinOnInteraction?: boolean
  pinOnInteractionSelector?: string
  pinned?: boolean
  onPinnedChange?(pinned: boolean): void
  onOpenChange?(open: boolean): void
  closeLabel?: string
  cardClassName?: string
  estimatedWidth?: number
  estimatedHeight?: number
  placement?: 'anchor' | 'viewport-right'
  viewportTop?: number
}

export function HoverCard({
  children,
  content,
  testId,
  interactive = false,
  openOnFocus = false,
  pinOnInteraction = false,
  pinOnInteractionSelector,
  pinned: controlledPinned,
  onPinnedChange,
  onOpenChange,
  closeLabel = 'Close',
  cardClassName,
  estimatedWidth = 310,
}: HoverCardProps) {
  const [open, setOpen] = useState(false)
  const [internalPinned, setInternalPinned] = useState(false)
  const pinned = controlledPinned ?? internalPinned
  const updatePinned = (next: boolean) => {
    setInternalPinned(next)
    onPinnedChange?.(next)
  }
  const close = () => {
    updatePinned(false)
    setOpen(false)
    onOpenChange?.(false)
  }
  return (
    <UiHoverCard
      open={open || pinned}
      delay={450}
      closeDelay={120}
      onOpenChange={(next, details) => {
        if (next && details.reason === 'trigger-focus' && !openOnFocus) {
          details.cancel()
          return
        }
        if (!next && pinned && ['trigger-hover', 'focus-out'].includes(details.reason)) {
          details.cancel()
          return
        }
        if (!next && pinned) updatePinned(false)
        setOpen(next)
        onOpenChange?.(next)
      }}
    >
      <HoverCardTrigger render={<div />} data-testid={`${testId}-trigger`}>
        {children}
      </HoverCardTrigger>
      <HoverCardContent
        data-testid={testId}
        data-pinned={pinned ? 'true' : 'false'}
        side="right"
        align="start"
        sideOffset={8}
        collisionPadding={8}
        style={{ width: estimatedWidth }}
        onClickCapture={event => {
          if (
            pinOnInteraction &&
            event.target instanceof Element &&
            (!pinOnInteractionSelector || event.target.closest(pinOnInteractionSelector))
          )
            updatePinned(true)
        }}
        className={cn(
          'z-system-popover max-h-[min(360px,var(--available-height))] max-w-[calc(100vw-1rem)] overflow-y-auto rounded-xl border border-border bg-popover p-3 text-sm text-text-primary shadow-lg',
          interactive ? 'pointer-events-auto' : 'pointer-events-none',
          pinned && 'pr-10',
          cardClassName
        )}
      >
        {pinned && (
          <Button
            variant="ghost"
            size="icon"
            data-testid={`${testId}-close`}
            aria-label={closeLabel}
            onClick={close}
            className="absolute right-2 top-2 h-7 w-7"
          >
            <X aria-hidden="true" className="h-4 w-4" />
          </Button>
        )}
        {content}
      </HoverCardContent>
    </UiHoverCard>
  )
}
