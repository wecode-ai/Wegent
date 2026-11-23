import { Popover, PopoverContent } from '@wegent/collaboration/controls/Popover'
import { useCollaborationPortalTheme } from '@wegent/collaboration/theme'
import { useCallback, useRef, type ReactNode, type Ref } from 'react'

const OPEN_POPOVER_BODY_ATTRIBUTE = 'data-wework-anchor-popover-open'

let openPopoverCount = 0

interface AnchorPopoverProps {
  anchor: HTMLElement | null
  title: string
  testId: string
  onClose: () => void
  children: ReactNode
  header?: ReactNode
  wide?: boolean
  profile?: boolean
  onBodyScroll?: (scrollTop: number) => void
  bodyRef?: Ref<HTMLDivElement>
}

export function AnchorPopover({
  anchor,
  title,
  testId,
  onClose,
  children,
  header,
  wide = false,
  profile = false,
  onBodyScroll,
  bodyRef,
}: AnchorPopoverProps) {
  const popoverRef = useRef<HTMLDivElement>(null)
  const theme = useCollaborationPortalTheme()

  const attachPopover = useCallback((node: HTMLDivElement | null) => {
    popoverRef.current = node
    if (!node) return
    openPopoverCount += 1
    document.body.setAttribute(OPEN_POPOVER_BODY_ATTRIBUTE, '')
    return () => {
      popoverRef.current = null
      openPopoverCount = Math.max(0, openPopoverCount - 1)
      if (openPopoverCount === 0) document.body.removeAttribute(OPEN_POPOVER_BODY_ATTRIBUTE)
    }
  }, [])

  if (!anchor) return null

  return (
    <Popover
      open
      dismissible
      onOpenChange={(next, details) => {
        if (next) return
        details.cancel()
        // Focus can move during a child dialog's teardown. The anchor owns its own toggle.
        if (
          details.reason === 'focus-out' ||
          details.reason === 'window-blur' ||
          (details.reason === 'outside-press' && details.event?.composedPath().includes(anchor))
        )
          return
        onClose()
      }}
    >
      <PopoverContent
        {...theme}
        ref={attachPopover}
        anchor={anchor}
        side="top"
        sideOffset={8}
        collisionPadding={16}
        initialFocus={() => popoverRef.current}
        finalFocus={() => (anchor.isConnected ? anchor : null)}
        data-testid={testId}
        aria-label={title}
        className={
          theme.className +
          ' electron-titlebar-interactive-region flex flex-col overflow-hidden z-system-popover max-w-[calc(100vw-2rem)] border border-border bg-popover text-text-primary shadow-lg ' +
          (profile
            ? 'w-[374px] max-h-[min(640px,var(--available-height))] rounded-xl'
            : (wide ? 'w-[374px] ' : 'w-70 ') +
              'max-h-[var(--available-height)] rounded-xl ' +
              (header ? '' : 'p-1'))
        }
      >
        {header ??
          (!profile && (
            <p className="shrink-0 px-2 pb-1.5 pt-2 text-xs font-medium text-text-primary">
              {title}
            </p>
          ))}
        <div
          ref={bodyRef}
          onScroll={onBodyScroll ? event => onBodyScroll(event.currentTarget.scrollTop) : undefined}
          className={
            profile
              ? 'min-h-0 overflow-y-auto overscroll-contain'
              : wide
                ? `min-h-0 overflow-y-auto overscroll-contain ${header ? '' : 'px-1 pb-1'}`
                : `min-h-0 max-h-[264px] overflow-y-auto overscroll-contain ${header ? '' : 'px-1 pb-1'}`
          }
          style={wide ? { maxHeight: 'min(400px, calc(100vh - 112px))' } : undefined}
        >
          {children}
        </div>
      </PopoverContent>
    </Popover>
  )
}
