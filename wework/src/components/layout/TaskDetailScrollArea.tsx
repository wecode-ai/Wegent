import { useId, type CSSProperties, type ReactNode, type RefObject } from 'react'
import { cn } from '@/lib/utils'
import { TaskDetailScrollbar } from './TaskDetailScrollbar'

interface TaskDetailScrollAreaProps {
  children: ReactNode
  defaultEmbeddedBrowserLabel: string
  frameClassName?: string
  frameStyle?: CSSProperties
  hasConversation: boolean
  overlay?: ReactNode
  scrollbarRef: RefObject<HTMLDivElement | null>
  showPageTopBar: boolean
  viewportRef: RefObject<HTMLDivElement | null>
}

export function TaskDetailScrollArea({
  children,
  defaultEmbeddedBrowserLabel,
  frameClassName,
  frameStyle,
  hasConversation,
  overlay,
  scrollbarRef,
  showPageTopBar,
  viewportRef,
}: TaskDetailScrollAreaProps) {
  const viewportId = useId()
  return (
    <div data-testid="desktop-workbench-scroll-frame" className={frameClassName} style={frameStyle}>
      <div
        id={viewportId}
        ref={viewportRef}
        data-testid="desktop-workbench-content"
        data-scroll-origin={hasConversation ? 'bottom' : 'top'}
        data-embedded-browser-label={defaultEmbeddedBrowserLabel}
        className={cn(
          'relative flex h-full min-w-0 flex-1',
          hasConversation
            ? 'scrollbar-none flex-col-reverse overflow-x-hidden overflow-y-auto [overflow-anchor:none]'
            : 'overflow-hidden',
          showPageTopBar && 'pt-11'
        )}
      >
        {children}
      </div>
      {hasConversation ? (
        <TaskDetailScrollbar
          viewportRef={viewportRef}
          scrollbarRef={scrollbarRef}
          viewportId={viewportId}
        />
      ) : null}
      {overlay}
    </div>
  )
}
