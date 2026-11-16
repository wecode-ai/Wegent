// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useId, useRef, useState, type ChangeEventHandler, type ReactNode } from 'react'
import * as Popover from '@radix-ui/react-popover'
import { Check, Search } from 'lucide-react'

import type { CollaborationPriority, CollaborationStatus } from '../types'
import { useCollaborationPortalTheme } from '../theme'
import { useEscapeKey } from '../markdown/useEscapeKey'

export interface IssueDetailSelectProps<TValue extends string> {
  value: TValue
  options: Array<{ value: TValue; label: string }>
  testId: string
  accessibleLabel: string
  className?: string
  disabled?: boolean
  includeUnset?: boolean
  unsetLabel?: string
  onChange(value: TValue): void
}

export function IssueDetailSelect<TValue extends string>({
  value,
  options,
  testId,
  accessibleLabel,
  className,
  disabled,
  includeUnset,
  unsetLabel = '未设置',
  onChange,
}: IssueDetailSelectProps<TValue>) {
  const handleChange: ChangeEventHandler<HTMLSelectElement> = event => {
    onChange(event.target.value as TValue)
  }
  return (
    <select
      data-testid={testId}
      aria-label={accessibleLabel}
      value={value}
      onChange={handleChange}
      disabled={disabled}
      className={className}
    >
      {includeUnset ? <option value="">{unsetLabel}</option> : null}
      {options.map(option => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  )
}

export function IssueDetailStatusSelect({
  statuses,
  ...props
}: Omit<IssueDetailSelectProps<string>, 'options'> & {
  statuses: Array<Pick<CollaborationStatus, 'id' | 'name'>>
}) {
  return (
    <IssueDetailSelect
      {...props}
      options={statuses.map(status => ({
        value: status.id,
        label: status.name,
      }))}
    />
  )
}

export function IssueDetailPrioritySelect({
  labels,
  ...props
}: Omit<IssueDetailSelectProps<CollaborationPriority>, 'options'> & {
  labels: Record<CollaborationPriority, string>
}) {
  return (
    <IssueDetailSelect
      {...props}
      options={(['none', 'low', 'medium', 'high', 'urgent'] as const).map(value => ({
        value,
        label: labels[value],
      }))}
    />
  )
}

export interface IssueDetailSearchableSelectOption<TValue extends string = string> {
  value: TValue
  label: string
  description?: string
  group?: string
  section?: string
  searchText?: string
}

export interface IssueDetailSearchableSelectAction {
  label: string
  icon?: ReactNode
  testId: string
  onSelect(): void
}

export interface IssueDetailSearchableSelectProps<TValue extends string> {
  value: TValue
  options: IssueDetailSearchableSelectOption<TValue>[]
  actions?: IssueDetailSearchableSelectAction[]
  testId: string
  accessibleLabel: string
  className?: string
  disabled?: boolean
  searchPlaceholder: string
  emptyLabel: string
  triggerContent?: ReactNode
  footer?: ReactNode
  contentClassName?: string
  modal?: boolean
  groupLimit?: number
  showAllLabel?(group: string, count: number): string
  onChange(value: TValue): void
}

function visibleSearchableSelectOptions<TValue extends string>(
  options: IssueDetailSearchableSelectOption<TValue>[],
  value: TValue,
  normalizedQuery: string,
  groupLimit: number | undefined,
  expandedGroups: Set<string>
) {
  if (normalizedQuery) {
    return options.filter(option =>
      `${option.label} ${option.description ?? ''} ${option.searchText ?? ''} ${option.group ?? ''} ${option.section ?? ''}`
        .toLocaleLowerCase()
        .includes(normalizedQuery)
    )
  }
  if (!groupLimit) return options

  const groupCounts = new Map<string, number>()
  return options.filter(option => {
    if (!option.group || expandedGroups.has(option.group)) return true
    const visibleCount = groupCounts.get(option.group) ?? 0
    if (visibleCount < groupLimit || option.value === value) {
      groupCounts.set(option.group, visibleCount + 1)
      return true
    }
    return false
  })
}

export function IssueDetailSearchableSelect<TValue extends string>({
  value,
  options,
  actions = [],
  testId,
  accessibleLabel,
  className,
  disabled,
  searchPlaceholder,
  emptyLabel,
  triggerContent,
  footer,
  contentClassName,
  modal = false,
  groupLimit,
  showAllLabel,
  onChange,
}: IssueDetailSearchableSelectProps<TValue>) {
  const portalTheme = useCollaborationPortalTheme()
  const valueDescriptionId = useId()
  const searchInputRef = useRef<HTMLInputElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  useEscapeKey(() => setOpen(false), open, contentRef)
  const [activeValue, setActiveValue] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set())
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const effectiveGroupLimit = showAllLabel ? groupLimit : undefined
  const visibleOptions = visibleSearchableSelectOptions(
    options,
    value,
    normalizedQuery,
    effectiveGroupLimit,
    expandedGroups
  )
  const groupCounts = new Map<string, number>()
  const tabValue = visibleOptions.some(option => option.value === activeValue)
    ? activeValue
    : (visibleOptions.find(option => option.value === value)?.value ?? visibleOptions[0]?.value)
  const selectedOption = options.find(option => option.value === value)
  const selectedDescription = selectedOption
    ? [selectedOption.group, selectedOption.label, selectedOption.description]
        .filter(Boolean)
        .join(' · ')
    : value
  options.forEach(option => {
    if (!option.group) return
    groupCounts.set(option.group, (groupCounts.get(option.group) ?? 0) + 1)
  })

  return (
    <Popover.Root
      modal={modal}
      open={open}
      onOpenChange={nextOpen => {
        setOpen(nextOpen)
        if (nextOpen) {
          setQuery('')
          setExpandedGroups(new Set())
          setActiveValue(value)
        }
      }}
    >
      <Popover.Trigger asChild>
        <button
          type="button"
          data-testid={testId}
          data-value={value}
          aria-label={accessibleLabel}
          aria-describedby={valueDescriptionId}
          title={selectedDescription}
          aria-haspopup="dialog"
          disabled={disabled}
          className={className}
        >
          {triggerContent}
          <span id={valueDescriptionId} className="sr-only">
            {selectedDescription}
          </span>
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          {...portalTheme}
          ref={contentRef}
          aria-label={accessibleLabel}
          data-testid={`${testId}-menu`}
          sideOffset={4}
          collisionPadding={8}
          style={{ ...portalTheme.style, maxWidth: 'calc(100vw - 16px)' }}
          onOpenAutoFocus={event => {
            event.preventDefault()
            searchInputRef.current?.focus({ preventScroll: true })
          }}
          onEscapeKeyDown={event => {
            event.preventDefault()
            event.stopPropagation()
            setOpen(false)
          }}
          onKeyDown={event => {
            const searching = event.target === searchInputRef.current
            if (searching && event.key === 'Enter') {
              event.preventDefault()
              event.stopPropagation()
              return
            }
            if (
              !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) ||
              (searching && ['Home', 'End'].includes(event.key))
            )
              return
            const options = Array.from(
              contentRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? []
            )
            if (!options.length) return
            event.preventDefault()
            const current = options.indexOf(document.activeElement as HTMLButtonElement)
            const next =
              event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? options.length - 1
                  : event.key === 'ArrowDown'
                    ? (current + 1) % options.length
                    : current <= 0
                      ? options.length - 1
                      : current - 1
            options[next]?.focus()
          }}
          className={`${portalTheme.className} z-system-popover flex max-h-[min(320px,var(--radix-popover-content-available-height))] w-72 flex-col overflow-hidden rounded-xl border border-border bg-background p-1.5 text-text-primary shadow-lg ${contentClassName ?? ''}`}
        >
          <label className="flex min-h-11 shrink-0 items-center gap-2 rounded-lg bg-muted px-2.5 text-text-secondary md:min-h-8">
            <Search className="h-3.5 w-3.5 shrink-0" />
            <input
              ref={searchInputRef}
              data-testid={`${testId}-search`}
              value={query}
              onChange={event => setQuery(event.target.value)}
              placeholder={searchPlaceholder}
              aria-label={searchPlaceholder}
              className="min-h-11 min-w-0 flex-1 bg-transparent text-sm text-text-primary outline-none placeholder:text-text-secondary md:min-h-8"
            />
          </label>
          <div
            role="listbox"
            aria-label={accessibleLabel}
            className="mt-1 min-h-0 overflow-y-auto overscroll-contain"
          >
            {visibleOptions.map((option, index) => {
              const showSection =
                option.section && option.section !== visibleOptions[index - 1]?.section
              const previousGroup = visibleOptions[index - 1]?.group
              const nextGroup = visibleOptions[index + 1]?.group
              const showGroup = Boolean(option.group && option.group !== previousGroup)
              const totalInGroup = option.group ? (groupCounts.get(option.group) ?? 0) : 0
              const showAll =
                !normalizedQuery &&
                Boolean(option.group) &&
                option.group !== nextGroup &&
                Boolean(effectiveGroupLimit) &&
                totalInGroup > (effectiveGroupLimit ?? 0) &&
                !expandedGroups.has(option.group!)
              return (
                <div key={option.value}>
                  {showSection ? (
                    <p className="px-2.5 pb-1 pt-2 text-xs font-medium text-text-secondary">
                      {option.section}
                    </p>
                  ) : null}
                  {showGroup ? (
                    <p
                      className={`px-2.5 pb-1 pt-2 text-xs font-medium text-text-secondary ${option.section ? 'pl-5' : ''}`}
                    >
                      {option.group}
                    </p>
                  ) : null}
                  <button
                    type="button"
                    role="option"
                    aria-selected={option.value === value}
                    tabIndex={option.value === tabValue ? 0 : -1}
                    onFocus={() => setActiveValue(option.value)}
                    data-testid={`${testId}-option-${option.value || 'empty'}`}
                    onClick={() => {
                      onChange(option.value)
                      setOpen(false)
                    }}
                    className={`flex min-h-11 w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-muted keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-ring md:min-h-9 ${option.section ? 'pl-7' : ''} ${
                      option.value === value ? 'bg-muted font-medium' : ''
                    }`}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{option.label}</span>
                      {option.description && (
                        <span className="block truncate text-xs text-text-secondary">
                          {option.description}
                        </span>
                      )}
                    </span>
                    {option.value === value ? <Check className="h-3.5 w-3.5 shrink-0" /> : null}
                  </button>
                  {showAll && option.group ? (
                    <button
                      type="button"
                      data-testid={`${testId}-show-all-${option.group}`}
                      onClick={() =>
                        setExpandedGroups(current => {
                          const next = new Set(current)
                          next.add(option.group!)
                          return next
                        })
                      }
                      className="flex min-h-11 w-full items-center rounded-lg px-2.5 py-2 text-left text-sm font-medium text-text-secondary hover:bg-muted hover:text-text-primary md:min-h-9"
                    >
                      {showAllLabel?.(option.group, totalInGroup)}
                    </button>
                  ) : null}
                </div>
              )
            })}
            {visibleOptions.length === 0 ? (
              <p role="status" className="px-3 py-6 text-center text-xs text-text-secondary">
                {emptyLabel}
              </p>
            ) : null}
          </div>
          {actions.length > 0 ? (
            <div className="mt-1 shrink-0 border-t border-border pt-1">
              {actions.map(action => (
                <button
                  key={action.testId}
                  type="button"
                  data-testid={action.testId}
                  onClick={() => {
                    setOpen(false)
                    action.onSelect()
                  }}
                  className="flex min-h-11 w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm font-medium text-text-secondary transition-colors hover:bg-muted hover:text-text-primary focus-visible:outline-none keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-focus/30 md:min-h-9"
                >
                  {action.icon ? (
                    <span
                      aria-hidden="true"
                      className="flex h-4 w-4 shrink-0 items-center justify-center"
                    >
                      {action.icon}
                    </span>
                  ) : null}
                  <span className="min-w-0 flex-1 truncate">{action.label}</span>
                </button>
              ))}
            </div>
          ) : null}
          {footer ? (
            <div className="mt-1 shrink-0 border-t border-border pt-1">{footer}</div>
          ) : null}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
