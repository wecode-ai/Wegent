import { useId } from 'react'
import { Checkbox } from '../controls/Checkbox'

interface WorkdayOnlyFieldProps {
  checked: boolean
  onChange(checked: boolean): void
  label: string
  description: string
  testId: string
}

export function WorkdayOnlyField({
  checked,
  onChange,
  label,
  description,
  testId,
}: WorkdayOnlyFieldProps) {
  const descriptionId = useId()
  return (
    <div className="space-y-1.5 py-2">
      <label className="!flex min-h-11 items-center gap-2 text-sm text-text-primary md:min-h-8">
        <Checkbox
          aria-label={label}
          aria-describedby={descriptionId}
          checked={checked}
          data-testid={testId}
          onCheckedChange={checked => onChange(checked === true)}
        />
        <span>{label}</span>
      </label>
      <p className="text-xs leading-5 text-text-secondary" id={descriptionId}>
        {description}
      </p>
    </div>
  )
}
