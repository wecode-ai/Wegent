import { X } from 'lucide-react'
import { SearchableSelect, type SearchableSelectOption } from '../controls/SearchableSelect'
import { Button as ControlButton } from '../markdown/Button'

/** Selected chips describe pending changes; selection never persists an Issue. */
export function IssueCommentActionPicker({
  testId,
  label,
  placeholder = label,
  value,
  options,
  disabled,
  searchLabel,
  emptyLabel,
  clearLabel,
  onChange,
}: {
  testId: string
  label: string
  placeholder?: string
  value: string
  options: SearchableSelectOption[]
  disabled: boolean
  searchLabel: string
  emptyLabel: string
  clearLabel: string
  onChange(value: string): void
}) {
  const selected = options.find(option => option.value === value)
  return (
    <span className={`task-detail-comment-action-chip${value ? ' is-selected' : ''}`}>
      <SearchableSelect
        testId={testId}
        accessibleLabel={value ? `${label}: ${selected?.label ?? value}` : placeholder}
        value={value}
        onChange={onChange}
        disabled={disabled}
        searchPlaceholder={searchLabel}
        emptyLabel={emptyLabel}
        className="task-detail-comment-action-picker"
        triggerContent={
          value ? (
            <>
              <span>{label}</span>
              <span className="truncate">{selected?.label ?? value}</span>
            </>
          ) : (
            <span>{placeholder}</span>
          )
        }
        options={options}
      />
      {value ? (
        <ControlButton
          variant="unstyled"
          type="button"
          data-testid={`${testId}-clear`}
          aria-label={clearLabel}
          title={clearLabel}
          disabled={disabled}
          onClick={() => onChange('')}
        >
          <X className="h-3.5 w-3.5" />
        </ControlButton>
      ) : null}
    </span>
  )
}
