import { X } from 'lucide-react'
import {
  IssueDetailSearchableSelect,
  type IssueDetailSearchableSelectOption,
} from './IssueDetailControls'

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
  options: IssueDetailSearchableSelectOption[]
  disabled: boolean
  searchLabel: string
  emptyLabel: string
  clearLabel: string
  onChange(value: string): void
}) {
  const selected = options.find((option) => option.value === value)
  return (
    <span className={`task-detail-comment-action-chip${value ? ' is-selected' : ''}`}>
      <IssueDetailSearchableSelect
        testId={testId}
        accessibleLabel={value ? label : placeholder}
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
        <button
          type="button"
          data-testid={`${testId}-clear`}
          aria-label={clearLabel}
          title={clearLabel}
          disabled={disabled}
          onClick={() => onChange('')}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      ) : null}
    </span>
  )
}
