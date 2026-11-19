import type { ReactNode } from 'react'
import { SelectField, type SelectFieldOption } from '../controls/SelectField'

export function ComposerProjectSelector({
  value,
  options,
  onChange,
  label,
  disabled,
  icon,
  testId,
  menuTestId,
  labelTestId,
}: {
  value: string
  options: readonly SelectFieldOption<string>[]
  onChange(value: string): void
  label: string
  disabled?: boolean
  icon?: ReactNode
  testId: string
  menuTestId?: string
  labelTestId?: string
}) {
  return (
    <SelectField
      value={value}
      options={options}
      onChange={onChange}
      disabled={disabled}
      accessibleLabel={label}
      testId={testId}
      menuTestId={menuTestId}
      appearance="composer"
      className="max-w-full"
      triggerContent={
        <span className="flex min-w-0 items-center gap-1.5">
          {icon}
          <span data-testid={labelTestId} className="max-w-48 truncate">
            {options.find(option => option.value === value)?.label ?? label}
          </span>
        </span>
      }
    />
  )
}
