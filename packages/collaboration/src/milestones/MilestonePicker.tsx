import { Flag, ChevronDown } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { MilestonesApi } from './types'
import { useMilestones } from './useMilestones'
import { IssueDetailSearchableSelect } from '../issue-detail/IssueDetailControls'
import './milestones.css'

export function MilestonePicker({
  api,
  query: providedQuery,
  placeholder,
  onMissingValue,
  projectId,
  value,
  onChange,
  disabled,
  compact = false,
  appearance = 'field',
  label,
  noneLabel,
  errorLabel,
  retryLabel,
  allLabel,
  searchLabel = label,
  emptyLabel = noneLabel,
  testId = 'issue-milestone',
}: {
  api?: MilestonesApi
  query?: ReturnType<typeof useMilestones>
  placeholder?: string
  onMissingValue?(): void
  projectId: string
  value: string | null | undefined
  onChange(value: string | null): Promise<void> | void
  disabled?: boolean
  compact?: boolean
  appearance?: 'field' | 'property'
  label: string
  noneLabel: string
  errorLabel: string
  retryLabel: string
  allLabel?: string
  searchLabel?: string
  emptyLabel?: string
  testId?: string
}) {
  const ownedQuery = useMilestones(api, projectId, providedQuery === undefined)
  const query = providedQuery ?? ownedQuery
  useEffect(() => {
    if (
      !query.loading &&
      !query.error &&
      value &&
      value !== 'all' &&
      !query.items.some(item => item.id === value)
    )
      onMissingValue?.()
  }, [onMissingValue, query.error, query.items, query.loading, value])
  const selectedTitle =
    query.items.find(item => item.id === value)?.title ??
    (value === 'all' ? allLabel : value === undefined ? placeholder : value ? label : noneLabel) ??
    label
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  if (!api) return null
  return (
    <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2 text-sm leading-normal">
      {!compact && appearance !== 'property' && !allLabel ? (
        <span className="shrink-0 text-text-secondary">{label}</span>
      ) : null}
      <IssueDetailSearchableSelect
        testId={testId}
        accessibleLabel={label}
        value={value ?? ''}
        disabled={disabled || busy || query.loading || query.error}
        searchPlaceholder={searchLabel}
        emptyLabel={emptyLabel}
        className={
          appearance === 'property'
            ? 'task-detail-state-assignee'
            : `${allLabel ? 'milestone-picker-filter ' : ''}inline-flex min-h-8 min-w-0 max-w-full items-center gap-2 rounded-lg border border-border bg-background px-3 text-xs text-text-secondary outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-focus max-md:min-h-11`
        }
        triggerContent={
          <>
            {appearance === 'property' ? <Flag aria-hidden="true" size={16} /> : null}
            <span className="max-w-40 truncate" title={selectedTitle}>
              {selectedTitle}
            </span>
            <ChevronDown className="h-3 w-3 shrink-0" aria-hidden="true" />
          </>
        }
        options={[
          ...(allLabel ? [{ value: 'all', label: allLabel }] : []),
          { value: '', label: noneLabel },
          ...(value && value !== 'all' && !query.items.some(item => item.id === value)
            ? [{ value, label }]
            : []),
          ...query.items
            .filter(item => allLabel || item.state === 'open' || item.id === value)
            .map(item => ({ value: item.id, label: item.title })),
        ]}
        onChange={next => {
          setBusy(true)
          setFailed(false)
          void Promise.resolve()
            .then(() => onChange(next || null))
            .catch(() => setFailed(true))
            .finally(() => setBusy(false))
        }}
      />
      {query.error || failed ? (
        <span role="alert" className="text-destructive">
          {errorLabel}
          {query.error ? (
            <button
              type="button"
              data-testid={`${testId}-retry`}
              onClick={query.reload}
              className="ml-2 underline"
            >
              {retryLabel}
            </button>
          ) : null}
        </span>
      ) : null}
    </div>
  )
}
