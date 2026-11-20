import { ScrollAreaScrollbar, ScrollAreaThumb } from '@wegent/collaboration/controls/ScrollArea'

import { cn } from '@/lib/utils'
import { forwardRef, type RefObject } from 'react'

interface WorkbenchScrollbarProps {
  orientation: 'horizontal' | 'vertical'
  testId: string
  thumbTestId: string
  className?: string
  thumbClassName?: string
  keyboard?: {
    label: string
    viewportId: string
    viewportRef: RefObject<HTMLDivElement | null>
  }
}

export const WorkbenchScrollbar = forwardRef<HTMLDivElement, WorkbenchScrollbarProps>(
  function WorkbenchScrollbar(
    { orientation, testId, thumbTestId, className, thumbClassName, keyboard },
    ref
  ) {
    return (
      <ScrollAreaScrollbar
        ref={ref}
        orientation={orientation}
        data-testid={testId}
        role={keyboard ? 'scrollbar' : undefined}
        tabIndex={keyboard ? 0 : undefined}
        render={keyboard ? <div aria-hidden={false} /> : undefined}
        aria-label={keyboard?.label}
        aria-controls={keyboard?.viewportId}
        aria-orientation={keyboard ? orientation : undefined}
        aria-valuemin={keyboard ? 0 : undefined}
        aria-valuemax={keyboard ? 0 : undefined}
        aria-valuenow={keyboard ? 0 : undefined}
        onKeyDown={
          keyboard
            ? event => {
                if (event.defaultPrevented) return
                const viewport = keyboard.viewportRef.current
                if (!viewport) return
                const range = Math.max(0, viewport.scrollHeight - viewport.clientHeight)
                const positions: Record<string, number> = {
                  ArrowUp: viewport.scrollTop - 40,
                  ArrowDown: viewport.scrollTop + 40,
                  PageUp: viewport.scrollTop - viewport.clientHeight,
                  PageDown: viewport.scrollTop + viewport.clientHeight,
                  Home: 0,
                  End: range,
                }
                const position = positions[event.key]
                if (position === undefined) return
                event.preventDefault()
                viewport.scrollTop = Math.max(0, Math.min(range, position))
              }
            : undefined
        }
        className={cn(
          'workbench-scrollbar z-10 flex touch-none select-none bg-transparent',
          orientation === 'vertical' ? 'w-2' : 'h-2 flex-col',
          keyboard &&
            'outline-none keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-focus',
          className
        )}
      >
        <ScrollAreaThumb
          data-testid={thumbTestId}
          className={cn('workbench-scrollbar-thumb relative flex-1 rounded-full', thumbClassName)}
        />
      </ScrollAreaScrollbar>
    )
  }
)
