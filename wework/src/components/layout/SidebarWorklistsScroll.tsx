import * as ScrollArea from '@radix-ui/react-scroll-area'
import type { ReactNode, RefObject, UIEventHandler } from 'react'
import { cn } from '@/lib/utils'
import { WorkbenchScrollbar } from './WorkbenchScrollbar'

interface SidebarWorklistsScrollProps {
  children: ReactNode
  viewportRef: RefObject<HTMLDivElement | null>
  scrolled: boolean
  locked: boolean
  onScroll: UIEventHandler<HTMLDivElement>
}

export function SidebarWorklistsScroll({
  children,
  viewportRef,
  scrolled,
  locked,
  onScroll,
}: SidebarWorklistsScrollProps) {
  return (
    <ScrollArea.Root
      type="auto"
      data-testid="sidebar-worklists-scroll-area"
      className="relative -mr-1.5 mb-2 mt-0.5 min-h-0 flex-1 pr-1.5"
    >
      <ScrollArea.Viewport
        ref={viewportRef}
        data-testid="sidebar-worklists-scroll"
        data-scrolled={scrolled}
        onScroll={onScroll}
        style={{ overflowY: locked ? 'hidden' : 'scroll' }}
        className={cn(
          'sidebar-worklists-viewport h-full w-full border-t border-transparent pb-3 [overflow-anchor:none] [mask-image:linear-gradient(to_bottom,black_0,black_calc(100%_-_16px),transparent_100%)]',
          scrolled &&
            'border-border [mask-image:linear-gradient(to_bottom,transparent_0,black_12px,black_calc(100%_-_16px),transparent_100%)]'
        )}
      >
        {children}
      </ScrollArea.Viewport>
      <WorkbenchScrollbar
        orientation="vertical"
        testId="sidebar-worklists-scrollbar"
        thumbTestId="sidebar-worklists-scrollbar-thumb"
        className="sidebar-worklists-scrollbar -translate-x-[3px]"
        thumbClassName="sidebar-worklists-scrollbar-thumb"
      />
    </ScrollArea.Root>
  )
}
