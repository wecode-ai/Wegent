import { useCallback } from 'react'
import { cn } from '@/lib/utils'
import { bindSidebarTitleScroll } from './sidebarTitleScroll'

interface SidebarTaskTitleProps {
  text: string
  testId: string
  textTestId?: string
  shimmerTestId?: string
  className?: string
}

export function SidebarTaskTitle({
  text,
  testId,
  textTestId,
  shimmerTestId,
  className,
}: SidebarTaskTitleProps) {
  const bindTitle = useCallback(
    (container: HTMLSpanElement | null) => {
      if (!container) return
      return bindSidebarTitleScroll(
        container,
        container.querySelector<HTMLSpanElement>('.sidebar-task-title-viewport'),
        container.querySelector<HTMLSpanElement>('.sidebar-task-title-text'),
        shimmerTestId
          ? container.querySelector<HTMLSpanElement>('[data-sidebar-title-shimmer-host]')
          : null
      )
    },
    [shimmerTestId]
  )

  return (
    <span
      ref={bindTitle}
      data-sidebar-drag-activator={textTestId ? '' : undefined}
      data-testid={testId}
      className={cn('runtime-task-title relative min-w-0 flex-1', className)}
    >
      <span className="sidebar-task-title-viewport">
        {shimmerTestId && (
          <span
            aria-hidden="true"
            className="contents"
            data-sidebar-title-shimmer-host=""
            data-shimmer-testid={shimmerTestId}
          />
        )}
        <span data-testid={textTestId} className="sidebar-task-title-text">
          {text}
        </span>
      </span>
    </span>
  )
}
