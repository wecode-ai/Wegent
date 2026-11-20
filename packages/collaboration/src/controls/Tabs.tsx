import { TabsList as UiTabsList, TabsTab as UiTabsTab } from '@ui-sdk/react/tabs'
import type { ComponentProps } from 'react'
import { activityClassNames as cn } from '../issue-detail/activityClassNames'

export { TabsPanel, Tabs as TabsRoot } from '@ui-sdk/react/tabs'

type TabAppearance = 'underline' | 'surface'

export function TabsList({
  className,
  appearance = 'underline',
  ...props
}: Omit<ComponentProps<typeof UiTabsList>, 'className'> & {
  className?: string
  appearance?: TabAppearance
}) {
  return (
    <UiTabsList
      {...props}
      className={cn(
        'flex items-center gap-1',
        appearance === 'underline' && 'border-b border-border',
        className
      )}
    />
  )
}

export function TabsTab({
  className,
  appearance = 'underline',
  ...props
}: Omit<ComponentProps<typeof UiTabsTab>, 'className'> & {
  className?: string
  appearance?: TabAppearance
}) {
  return (
    <UiTabsTab
      {...props}
      className={cn(
        'shrink-0 px-3 text-sm text-text-secondary outline-none hover:text-text-primary keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-focus/40 aria-selected:font-medium aria-selected:text-text-primary',
        appearance === 'underline' &&
          'min-h-11 border-b-2 border-transparent aria-selected:border-text-primary md:min-h-9',
        className
      )}
    />
  )
}
