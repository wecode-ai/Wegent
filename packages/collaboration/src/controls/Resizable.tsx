import { ResizableHandle as UiResizableHandle } from '@ui-sdk/react/resizable'
import type { ComponentProps } from 'react'
import { activityClassNames as cn } from '../issue-detail/activityClassNames'

export { Resizable, ResizablePanel } from '@ui-sdk/react/resizable'

export function ResizableHandle({ className, ...props }: ComponentProps<typeof UiResizableHandle>) {
  return (
    <UiResizableHandle
      {...props}
      className={state =>
        cn(
          'relative z-10 shrink-0 bg-border/60 outline-none data-[orientation=horizontal]:w-px data-[orientation=vertical]:h-px data-hovering:bg-focus/40 data-dragging:bg-focus/60 keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-focus/40',
          typeof className === 'function' ? className(state) : className
        )
      }
    />
  )
}
