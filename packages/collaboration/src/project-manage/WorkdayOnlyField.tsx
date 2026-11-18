import { useId } from 'react'

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
        <input
          aria-describedby={descriptionId}
          checked={checked}
          className="!h-4 !min-h-0 !w-4 shrink-0 rounded border-border !p-0 accent-text-primary"
          data-testid={testId}
          onChange={event => onChange(event.target.checked)}
          type="checkbox"
        />
        <span>{label}</span>
      </label>
      <p className="text-xs leading-5 text-text-secondary" id={descriptionId}>
        {description}
      </p>
    </div>
  )
}
