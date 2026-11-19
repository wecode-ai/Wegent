import { createParts } from '@ui-sdk/react/primitive'
import type { ComponentProps } from 'react'
import { activityClassNames as cn } from '../issue-detail/activityClassNames'
import { sortablePrimitive } from './sortablePrimitive'

const {
  Root: SortableRoot,
  Item,
  Handle,
  DragArea: SortableDragArea,
} = createParts(sortablePrimitive, { root: 'div', item: 'div', handle: 'button', 'drag-area': 'div' })
export { SortableRoot, SortableDragArea }
export function SortableItem({ className, ...props }: ComponentProps<typeof Item>) {
  return (
    <Item
      {...props}
      className={state =>
        cn(
          'relative data-grabbed:z-10 data-grabbed:opacity-40',
          typeof className === 'function' ? className(state) : className
        )
      }
    />
  )
}
export function SortableHandle({ className, ...props }: ComponentProps<typeof Handle>) {
  return (
    <Handle
      {...props}
      className={state =>
        cn(
          'h-11 w-11 min-h-11 min-w-11 md:h-7 md:w-7 md:min-h-7 md:min-w-7 inline-flex items-center justify-center [&_svg]:size-4 hover:bg-muted touch-none cursor-grab select-none rounded-md outline-none active:cursor-grabbing keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-focus/40 aria-disabled:cursor-default aria-disabled:opacity-40',
          typeof className === 'function' ? className(state) : className
        )
      }
    />
  )
}

export type { SortableChangeDetails } from './sortablePrimitive'
