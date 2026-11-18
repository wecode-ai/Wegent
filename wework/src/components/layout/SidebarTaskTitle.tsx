import { useRef } from 'react'
import { cn } from '@/lib/utils'
import { useSidebarTitleScroll } from './useSidebarTitleScroll'

interface SidebarTaskTitleProps {
  text: string
  testId: string
  textTestId?: string
  dragActivator?: boolean
  shimmering?: boolean
  shimmerTestId?: string
  className?: string
}

export function SidebarTaskTitle({
  text,
  testId,
  textTestId,
  dragActivator = false,
  shimmering,
  shimmerTestId,
  className,
}: SidebarTaskTitleProps) {
  const containerRef = useRef<HTMLSpanElement>(null)
  const viewportRef = useRef<HTMLSpanElement>(null)
  const textRef = useRef<HTMLSpanElement>(null)
  useSidebarTitleScroll(containerRef, viewportRef, textRef, text)

  return (
    <span
      ref={containerRef}
      data-sidebar-drag-activator={dragActivator ? '' : undefined}
      data-testid={testId}
      className={cn(
        'runtime-task-title relative min-w-0 flex-1',
        shimmering && 'is-updated',
        className
      )}
    >
      <span ref={viewportRef} className="sidebar-task-title-viewport">
        {shimmering && (
          <span
            aria-hidden="true"
            className="runtime-task-title-shimmer"
            data-testid={shimmerTestId}
          />
        )}
        <span ref={textRef} data-testid={textTestId} className="sidebar-task-title-text">
          {text}
        </span>
      </span>
    </span>
  )
}
