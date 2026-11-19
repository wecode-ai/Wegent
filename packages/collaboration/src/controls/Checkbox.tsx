import { CheckboxIndicator, Checkbox as UiCheckbox } from '@ui-sdk/react/checkbox'
import { Check, Minus } from 'lucide-react'
import type { ComponentProps } from 'react'
import { activityClassNames as cn } from '../issue-detail/activityClassNames'

type CheckboxProps = Omit<ComponentProps<typeof UiCheckbox>, 'children' | 'className'> & {
  className?: string
}

export function Checkbox({ className, ...props }: CheckboxProps) {
  return (
    <UiCheckbox
      {...props}
      className={cn(
        className,
        'group/checkbox inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-md outline-none keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-focus/40 disabled:cursor-not-allowed disabled:opacity-40 md:min-h-6 md:min-w-6'
      )}
    >
      <span className="flex h-4 w-4 items-center justify-center rounded border border-border bg-background group-data-[checked]/checkbox:border-text-primary group-data-[checked]/checkbox:bg-text-primary group-data-[indeterminate]/checkbox:border-text-primary group-data-[indeterminate]/checkbox:bg-text-primary">
        <CheckboxIndicator className="text-background">
          <Check
            aria-hidden="true"
            className="h-3 w-3 group-data-[indeterminate]/checkbox:hidden"
          />
          <Minus
            aria-hidden="true"
            className="hidden h-3 w-3 group-data-[indeterminate]/checkbox:block"
          />
        </CheckboxIndicator>
      </span>
    </UiCheckbox>
  )
}
