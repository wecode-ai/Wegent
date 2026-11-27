import { X, type LucideIcon } from 'lucide-react'
import { SearchableSelect, type SearchableSelectOption } from '../controls/SearchableSelect'
import { ComposerContextButton } from '../composer/ComposerContextButton'
import { composerIconActionDensity } from '../controls/recipes'

/** Selected chips describe pending changes; selection never persists an Issue. */
export function IssueCommentActionPicker({
  testId,
  label,
  placeholder = label,
  icon: Icon,
  currentLabel,
  unavailableLabel,
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
  icon?: LucideIcon
  currentLabel?: string
  unavailableLabel?: string
  value: string
  options: SearchableSelectOption[]
  disabled: boolean
  searchLabel: string
  emptyLabel: string
  clearLabel: string
  onChange(value: string): void
}) {
  const selected = options.find(option => option.value === value)
  const name = value ? (unavailableLabel ?? selected?.label ?? value) : currentLabel
  return (
    <span
      className={`task-detail-comment-action-chip${value ? ' is-selected' : ''}${name ? ' has-action-value' : ''}`}
    >
      <SearchableSelect
        testId={testId}
        accessibleLabel={name ? `${label}: ${name}` : placeholder}
        triggerTitle={unavailableLabel}
        value={value}
        activateSelected={Boolean(unavailableLabel)}
        onChange={onChange}
        disabled={disabled}
        searchPlaceholder={searchLabel}
        emptyLabel={emptyLabel}
        appearance="composer"
        className="task-detail-comment-action-picker"
        triggerContent={
          <>
            {Icon ? (
              <Icon
                aria-hidden="true"
                className="task-detail-comment-action-icon h-4 w-4 shrink-0"
              />
            ) : null}
            {name ? (
              <span className="task-detail-comment-action-value min-w-0 truncate" title={name}>
                {name}
              </span>
            ) : (
              <span className="task-detail-comment-action-label min-w-0 truncate">
                {placeholder}
              </span>
            )}
          </>
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
