import {
  Select as UiSelect,
  type SelectProps,
  SelectItemIndicator,
  SelectValue,
  SelectContent as UiSelectContent,
  SelectGroupLabel as UiSelectGroupLabel,
  SelectItem as UiSelectItem,
  SelectTrigger as UiSelectTrigger,
} from '@ui-sdk/react/select'
import { Check, ChevronDown } from 'lucide-react'
import type { ComponentProps, ReactNode } from 'react'
import { activityClassNames as cn } from '../issue-detail/activityClassNames'
import { useCollaborationPortalTheme } from '../theme'
import {
  controlOption,
  controlPopup,
  selectionTriggerClasses,
  type SelectionTriggerAppearance,
  type ControlDensity,
} from './recipes'
export { SelectGroup } from '@ui-sdk/react/select'

export function SelectRoot<T = string, Multiple extends boolean | undefined = false>(
  props: SelectProps<T, Multiple>
) {
  return <UiSelect<T, Multiple> virtualFocus {...props} />
}

type TriggerProps = Omit<ComponentProps<typeof UiSelectTrigger>, 'className' | 'children'> & {
  className?: string
  children?: ReactNode
  density?: ControlDensity
  appearance?: SelectionTriggerAppearance
}
export function SelectTrigger({
  className,
  children,
  density = 'default',
  appearance = 'outline',
  ...props
}: TriggerProps) {
  return (
    <UiSelectTrigger
      {...props}
      className={cn(selectionTriggerClasses(appearance, density), className)}
    >
      {children ?? (
        <SelectValue
          className="min-w-0 flex-1 truncate"
          render={(valueProps, state) => (
            <span
              {...valueProps}
              data-value={typeof state.value === 'string' ? state.value : undefined}
            />
          )}
        />
      )}
      <ChevronDown aria-hidden="true" className="h-4 w-4 shrink-0 text-text-secondary" />
    </UiSelectTrigger>
  )
}

type ContentProps = Omit<ComponentProps<typeof UiSelectContent>, 'className'> & {
  className?: string
}
export function SelectContent({ className, children, ...props }: ContentProps) {
  const theme = useCollaborationPortalTheme()
  return (
    <UiSelectContent
      {...theme}
      align="start"
      sideOffset={4}
      collisionPadding={8}
      {...props}
      className={cn(
        theme.className,
        controlPopup,
        'min-w-[var(--anchor-width)] data-[closed]:invisible',
        className
      )}
    >
      {children}
    </UiSelectContent>
  )
}

type ItemProps = Omit<ComponentProps<typeof UiSelectItem<string>>, 'className' | 'children'> & {
  className?: string
  children?: ReactNode
}
export function SelectItem({ className, children, ...props }: ItemProps) {
  return (
    <UiSelectItem {...props} data-value={props.value} className={cn(controlOption, className)}>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      <SelectItemIndicator>
        <Check aria-hidden="true" className="h-4 w-4 shrink-0" />
      </SelectItemIndicator>
    </UiSelectItem>
  )
}

export function SelectGroupLabel({ children }: { children: ReactNode }) {
  return (
    <UiSelectGroupLabel className="px-2.5 pb-1 pt-2 text-xs font-medium text-text-secondary">
      {children}
    </UiSelectGroupLabel>
  )
}
