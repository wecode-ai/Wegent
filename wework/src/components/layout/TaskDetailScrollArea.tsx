import { useId, type CSSProperties, type ReactNode, type RefObject } from 'react'
import {
  ScrollArea,
  ScrollAreaContent,
  ScrollAreaViewport,
} from '@wegent/collaboration/controls/ScrollArea'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import { WorkbenchScrollbar } from './WorkbenchScrollbar'

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
  const { t } = useTranslation('common')
  return (
    <ScrollArea
      type="auto"
      data-testid="desktop-workbench-scroll-frame"
      className={frameClassName}
      style={frameStyle}
    >
      <ScrollAreaViewport
        id={viewportId}
        ref={viewportRef}
        data-testid="desktop-workbench-content"
        data-scroll-origin="top"
        tabIndex={hasConversation ? 0 : undefined}
        data-embedded-browser-label={defaultEmbeddedBrowserLabel}
        style={{ overflowX: 'hidden', overflowY: hasConversation ? 'auto' : 'hidden' }}
        className={cn(
          'relative flex h-full min-w-0 flex-1 scrollbar-none [overflow-anchor:none]',
          hasConversation && 'flex-col',
          showPageTopBar && 'pt-11'
        )}
      >
        <ScrollAreaContent
          className={cn(
            'relative flex min-h-full min-w-0 p-0',
            hasConversation ? 'flex-1 shrink-0 flex-col' : 'h-full flex-1'
          )}
        >
          {children}
        </ScrollAreaContent>
      </ScrollAreaViewport>
      {hasConversation ? (
        <WorkbenchScrollbar
          ref={scrollbarRef}
          orientation="vertical"
          testId="desktop-workbench-scrollbar"
          thumbTestId="desktop-workbench-scrollbar-thumb"
          keyboard={{ label: t('workbench.conversation_scrollbar'), viewportId, viewportRef }}
          className="absolute bottom-[3px] right-[3px] top-[3px] z-critical w-2 p-0"
        />
      ) : null}
      {overlay}
    </ScrollArea>
  )
}
