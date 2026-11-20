import {
  SegmentedControlItem,
  SegmentedControl as UiSegmentedControl,
} from '@ui-sdk/react/segmented-control'
import type { ReactNode } from 'react'
import { activityClassNames as cn } from '../issue-detail/activityClassNames'

export interface SegmentOption<T extends string> {
  value: T
  label: ReactNode
  testId: string
  title?: string
  disabled?: boolean
}

export function SegmentedControl<T extends string>({
  label,
  value,
  options,
  disabled,
  onChange,
  className,
}: {
  label: string
  value: T
  options: readonly SegmentOption<T>[]
  disabled?: boolean
  onChange(value: T): void
  className?: string
}) {
  return (
    <UiSegmentedControl
      aria-label={label}
      value={value}
      disabled={disabled}
      onValueChange={next => {
        if (next !== null) onChange(next)
      }}
      className={cn(
        'flex w-full shrink-0 gap-0.5 rounded-lg border border-border bg-muted p-0.5 md:w-[300px]',
        className
      )}
    >
      {options.map(option => (
        <SegmentedControlItem
          key={option.value}
          value={option.value}
          disabled={option.disabled}
          title={option.title}
          data-testid={option.testId}
          className="flex min-h-11 min-w-11 flex-1 items-center justify-center rounded-md px-2 text-sm font-medium text-text-secondary outline-none hover:text-text-primary keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-focus/40 data-[checked]:bg-background data-[checked]:text-text-primary data-[checked]:shadow-sm data-[disabled]:opacity-40 md:min-h-8"
        >
          <span className="truncate">{option.label}</span>
        </SegmentedControlItem>
      ))}
    </UiSegmentedControl>
  )
}
