import * as ScrollArea from '@radix-ui/react-scroll-area'
import { forwardRef } from 'react'
import { cn } from '@/lib/utils'

interface WorkbenchScrollbarProps {
  orientation: 'horizontal' | 'vertical'
  testId: string
  thumbTestId: string
  className?: string
  thumbClassName?: string
}

export const WorkbenchScrollbar = forwardRef<HTMLDivElement, WorkbenchScrollbarProps>(
  function WorkbenchScrollbar(
    { orientation, testId, thumbTestId, className, thumbClassName },
    ref
  ) {
    return (
      <ScrollArea.Scrollbar
        ref={ref}
        orientation={orientation}
        data-testid={testId}
        className={cn(
          'workbench-scrollbar z-10 flex touch-none select-none bg-transparent',
          orientation === 'vertical' ? 'w-2' : 'h-2 flex-col',
          className
        )}
      >
        <ScrollArea.Thumb
          data-testid={thumbTestId}
          className={cn('workbench-scrollbar-thumb relative flex-1 rounded-full', thumbClassName)}
        />
      </ScrollArea.Scrollbar>
    )
  }
)
