import {
  ScrollArea as UiScrollArea,
  ScrollAreaViewport as UiScrollAreaViewport,
  ScrollAreaContent as UiScrollAreaContent,
  ScrollAreaScrollbar as UiScrollAreaScrollbar,
  ScrollAreaThumb as UiScrollAreaThumb,
  ScrollAreaCorner as UiScrollAreaCorner,
} from '@ui-sdk/react/scroll-area'
import type { ComponentProps } from 'react'
import { activityClassNames as cn } from '../issue-detail/activityClassNames'

export type {
  ScrollAreaController,
  ScrollAreaOptions,
  ScrollAreaPrimitive,
  ScrollAreaScrollOptions,
  ScrollAreaScrollToEndState,
  ScrollAreaScrollbarProps,
  ScrollAreaScrollbarState,
  ScrollAreaState,
  ScrollAreaThumbState,
  ScrollAreaType,
} from '@ui-sdk/react/scroll-area'
export { ScrollAreaScrollToEnd } from '@ui-sdk/react/scroll-area'

export function ScrollArea({
  className,
  ...props
}: ComponentProps<typeof UiScrollArea>) {
  return (
    <UiScrollArea
      {...props}
      className={(state) =>
        cn(
          'relative min-h-0 min-w-0 overflow-hidden',
          typeof className === 'function' ? className(state) : className,
        )
      }
    />
  )
}

export function ScrollAreaViewport({
  className,
  ...props
}: ComponentProps<typeof UiScrollAreaViewport>) {
  return (
    <UiScrollAreaViewport
      {...props}
      className={(state) =>
        cn(
          'h-full w-full min-h-0 min-w-0 outline-none keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-inset keyboard:focus-visible:ring-focus/40',
          typeof className === 'function' ? className(state) : className,
        )
      }
    />
  )
}

export function ScrollAreaContent({
  className,
  ...props
}: ComponentProps<typeof UiScrollAreaContent>) {
  return (
    <UiScrollAreaContent
      {...props}
      className={(state) =>
        cn(
          'min-w-full',
          typeof className === 'function' ? className(state) : className,
        )
      }
    />
  )
}

export function ScrollAreaScrollbar({
  className,
  ...props
}: ComponentProps<typeof UiScrollAreaScrollbar>) {
  return (
    <UiScrollAreaScrollbar
      {...props}
      className={(state) =>
        cn(
          'z-10 flex touch-none select-none bg-transparent p-0.5',
          state.orientation === 'vertical' ? 'w-2' : 'h-2 flex-col',
          typeof className === 'function' ? className(state) : className,
        )
      }
    />
  )
}

export function ScrollAreaThumb({
  className,
  ...props
}: ComponentProps<typeof UiScrollAreaThumb>) {
  return (
    <UiScrollAreaThumb
      {...props}
      className={(state) =>
        cn(
          'relative flex-1 rounded-full bg-text-muted hover:bg-text-secondary',
          typeof className === 'function' ? className(state) : className,
        )
      }
    />
  )
}

export function ScrollAreaCorner({
  className,
  ...props
}: ComponentProps<typeof UiScrollAreaCorner>) {
  return (
    <UiScrollAreaCorner
      {...props}
      className={(state) =>
        cn(
          'bg-transparent',
          typeof className === 'function' ? className(state) : className,
        )
      }
    />
  )
}
