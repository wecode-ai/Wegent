import {
  Collapsible as UiCollapsible,
  CollapsiblePanel as UiCollapsiblePanel,
  CollapsibleTrigger as UiCollapsibleTrigger,
} from '@ui-sdk/react/collapsible'
import { ChevronRight } from 'lucide-react'
import type { ComponentProps } from 'react'
import { activityClassNames as cn } from '../issue-detail/activityClassNames'

export function CollapsibleRoot(props: ComponentProps<typeof UiCollapsible>) {
  return <UiCollapsible {...props} />
}

export function CollapsibleTrigger({
  className,
  children,
  ...props
}: ComponentProps<typeof UiCollapsibleTrigger>) {
  return (
    <UiCollapsibleTrigger
      {...props}
      className={state =>
        cn(
          'inline-flex min-h-11 w-full items-center gap-2 rounded-md text-left text-sm outline-none keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-focus/40 disabled:opacity-40 md:min-h-8 [&[data-open]>.collapsible-chevron]:rotate-90',
          typeof className === 'function' ? className(state) : className
        )
      }
    >
      {state => (
        <>
          <ChevronRight
            aria-hidden="true"
            className="collapsible-chevron h-4 w-4 shrink-0 transition-transform"
          />
          {typeof children === 'function' ? children(state) : children}
        </>
      )}
    </UiCollapsibleTrigger>
  )
}

export function CollapsiblePanel(props: ComponentProps<typeof UiCollapsiblePanel>) {
  return <UiCollapsiblePanel keepMounted {...props} />
}
