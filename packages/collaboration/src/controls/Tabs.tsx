import { TabsList as UiTabsList, TabsTab as UiTabsTab } from '@ui-sdk/react/tabs'
import type { ComponentProps } from 'react'
import { activityClassNames as cn } from '../issue-detail/activityClassNames'

export { TabsPanel, Tabs as TabsRoot } from '@ui-sdk/react/tabs'

export function TabsList({
  className,
  ...props
}: Omit<ComponentProps<typeof UiTabsList>, 'className'> & {
  className?: string
}) {
  return (
    <UiTabsList
      {...props}
      className={cn('flex items-center gap-1 border-b border-border', className)}
    />
  )
}

export function TabsTab({
  className,
  ...props
}: Omit<ComponentProps<typeof UiTabsTab>, 'className'> & {
  className?: string
}) {
  return (
    <UiTabsTab
      {...props}
      className={cn(
        'min-h-11 shrink-0 border-b-2 border-transparent px-3 text-sm text-text-secondary outline-none hover:text-text-primary keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-focus/40 aria-selected:border-text-primary aria-selected:font-medium aria-selected:text-text-primary md:min-h-9',
        className
      )}
    />
  )
}
