import { X } from 'lucide-react'
import { SearchableSelect, type SearchableSelectOption } from '../controls/SearchableSelect'
import { ComposerContextButton } from '../composer/ComposerContextButton'
import { composerIconActionDensity } from '../controls/recipes'

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
        appearance="composer"
        className="task-detail-comment-action-picker"
        triggerContent={
          value ? (
            <>
              <span className="min-w-0 truncate">{label}</span>
              <span className="min-w-0 truncate">{selected?.label ?? value}</span>
            </>
          ) : (
            <span className="min-w-0 truncate">{placeholder}</span>
          )
        }
        options={options}
      />
      {value ? (
        <ComposerContextButton
          className={`${composerIconActionDensity} justify-center`}
          data-testid={`${testId}-clear`}
          aria-label={clearLabel}
          title={clearLabel}
          disabled={disabled}
          onClick={() => onChange('')}
        >
          <X className="h-3.5 w-3.5" />
        </ComposerContextButton>
      ) : null}
    </span>
  )
}
