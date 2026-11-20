import type { ReactNode } from 'react'
import { activityClassNames as cn } from '../issue-detail/activityClassNames'
import type { ControlDensity, SelectionTriggerAppearance } from './recipes'
import { SelectContent, SelectItem, SelectRoot, SelectTrigger } from './SelectParts'

export interface SelectFieldOption<T extends string> {
  value: T
  label: string
  icon?: ReactNode
  description?: string
  disabled?: boolean
  testId?: string
}

export interface SelectFieldProps<T extends string> {
  value: T
  options: readonly SelectFieldOption<T>[]
  onChange(value: T): void
  testId: string
  menuTestId?: string
  accessibleLabel: string
  placeholder?: string
  disabled?: boolean
  invalid?: boolean
  className?: string
  density?: ControlDensity
  appearance?: SelectionTriggerAppearance
  triggerContent?: ReactNode
  footer?: ReactNode
}

export function SelectField<T extends string>({
  value,
  options,
  onChange,
  testId,
  menuTestId,
  accessibleLabel,
  placeholder,
  disabled,
  invalid,
  className,
  density,
  appearance,
  triggerContent,
  footer,
}: SelectFieldProps<T>) {
  return (
    <SelectRoot
      value={value}
      items={[...options]}
      disabled={disabled}
      onValueChange={next => {
        if (next !== null) onChange(next)
      }}
    >
      <SelectTrigger
        density={density}
        appearance={appearance}
        data-testid={testId}
        data-value={value}
        aria-label={accessibleLabel}
        aria-invalid={invalid || undefined}
        className={cn(invalid && 'border-destructive', className)}
      >
        {triggerContent ?? (value ? undefined : placeholder)}
      </SelectTrigger>
      <SelectContent data-testid={menuTestId ?? testId + '-menu'} data-embedded-browser-occlusion>
        {options.map(option => (
          <SelectItem
            key={option.value}
            value={option.value}
            label={option.label}
            disabled={option.disabled}
            data-testid={option.testId ?? `${testId}-option-${option.value}`}
          >
            <span className="flex min-w-0 items-center gap-2">
              {option.icon}
              <span className="min-w-0 flex-1">
                <span className="block truncate">{option.label}</span>
                {option.description && (
                  <span className="block truncate text-xs text-text-secondary">
                    {option.description}
                  </span>
                )}
              </span>
            </span>
          </SelectItem>
        ))}
        {footer && <div className="mt-1 border-t border-border pt-1">{footer}</div>}
      </SelectContent>
    </SelectRoot>
  )
}
