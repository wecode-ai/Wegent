// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import {
  useMemo,
  useSyncExternalStore,
  useRef,
  useState,
  type ChangeEventHandler,
  type ReactNode,
} from 'react'
import {
  createAsyncResource,
  getIdleResourceSnapshot,
  subscribeIdleResource,
} from '@wegent/chat-core/async-resource'
import { useFocusRequest } from '../dom-events'
import * as Popover from '@radix-ui/react-popover'
import { Check, Search, X } from 'lucide-react'

import type { CollaborationPriority, CollaborationStatus } from '../types'
import { useCollaborationPortalTheme } from '../theme'
import { useEscapeKey } from '../markdown/useEscapeKey'
import { MemberSearchPicker } from '../controls/MemberSearchPicker'
import { ConfirmationDialog } from '../controls/ConfirmationDialog'
import { isImeComposingEvent } from '@wegent/chat-core/ime'

export function IssueDetailCollaboratorPicker({
  members,
  onAdd,
  busy,
  label,
  addLabel,
  className,
  searchUsers,
  outsideLabel,
  confirmLabel,
  cancelLabel,
  emptyLabel,
  retryLabel,
  projectMemberIds,
  excludedUserIds,
}: {
  projectMemberIds?: ReadonlySet<number>
  excludedUserIds?: ReadonlySet<number>
  members: ReadonlyArray<{ user_id: number; user_name: string }>
  onAdd(ids: number[]): Promise<void>
  busy: boolean
  label: string
  addLabel: string
  compact?: boolean
  className?: string
  searchUsers?: (query: string) => Promise<Array<{ id: number; user_name: string }>>
  outsideLabel: string
  retryLabel: string
  confirmLabel: string
  cancelLabel: string
  emptyLabel: string
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  useFocusRequest(inputRef, 'initial-collaborator-focus')
  const memberIds = projectMemberIds ?? new Set(members.map(member => member.user_id))
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<Array<{ id: number; user_name: string }>>([])
  const [confirming, setConfirming] = useState(false)
  const search = useIssuePeopleSearch(query, searchUsers)
  const matchingMembers = members.filter(member =>
    member.user_name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
  )
  const users = [
    ...matchingMembers.map(member => ({
      id: member.user_id,
      user_name: member.user_name,
    })),
    ...search.users.filter(user => !matchingMembers.some(member => member.user_id === user.id)),
  ].filter(user => !excludedUserIds?.has(user.id))
  return (
    <div className={`min-w-0 ${className ?? ''}`}>
      <MemberSearchPicker
        inputRef={inputRef}
        query={query}
        onQueryChange={setQuery}
        users={users}
        onSelect={user =>
          setSelected(current =>
            current.some(entry => entry.id === user.id)
              ? current.filter(entry => entry.id !== user.id)
              : [...current, user]
          )
        }
        savingUserId={busy ? -1 : null}
        selectedUserIds={new Set(selected.map(user => user.id))}
        userDescription={user => (memberIds.has(user.id) ? undefined : outsideLabel)}
        placeholder={label}
        emptyLabel={emptyLabel}
        addLabel={addLabel}
        addingLabel={addLabel}
        inputTestId="cloud-todo-collaborator-select"
        resultTestId={id => `cloud-todo-collaborator-option-${id}`}
        loadingLabel={search.loading ? '…' : undefined}
        error={search.error}
      >
        {search.error && (
          <button
            type="button"
            data-testid="cloud-todo-collaborator-retry"
            onClick={search.retry}
            className="min-h-11 px-2 text-sm underline md:min-h-9"
          >
            {retryLabel}
          </button>
        )}
        <div className="mt-2 flex flex-wrap gap-1">
          {selected.map(user => (
            <button
              type="button"
              key={user.id}
              data-testid={`cloud-todo-selected-collaborator-${user.id}`}
              disabled={busy}
              aria-label={`${cancelLabel} ${user.user_name}`}
              className="inline-flex min-h-11 items-center gap-1 rounded-lg bg-muted px-2 text-sm md:min-h-8"
              onClick={() => setSelected(current => current.filter(entry => entry.id !== user.id))}
            >
              {user.user_name}
              <X className="h-3 w-3" aria-hidden="true" />
            </button>
          ))}
        </div>
      </MemberSearchPicker>
      <button
        type="button"
        data-testid="cloud-todo-confirm-collaborator"
        disabled={!selected.length || busy}
        className="mt-2 min-h-11 rounded-lg bg-text-primary px-3 text-sm text-background disabled:opacity-40 md:min-h-9"
        onClick={() => {
          if (selected.some(user => !memberIds.has(user.id))) setConfirming(true)
          else void onAdd(selected.map(user => user.id)).catch(() => undefined)
        }}
      >
        {addLabel} {selected.length || ''}
      </button>
      {confirming && (
        <ConfirmationDialog
          title={confirmLabel}
          subject={selected.map(user => user.user_name).join(', ')}
          description={outsideLabel}
          labels={{
            cancel: cancelLabel,
            confirm: confirmLabel,
            pending: addLabel,
            failed: emptyLabel,
          }}
          testIdPrefix="issue-outside-collaborator"
          onClose={() => setConfirming(false)}
          onConfirm={() => onAdd(selected.map(user => user.id))}
        />
      )}
    </div>
  )
}

export function useIssuePeopleSearch(
  query: string,
  searchUsers?: (query: string) => Promise<Array<{ id: number; user_name: string }>>
) {
  const resource = useMemo(
    () =>
      query.trim() && searchUsers
        ? createAsyncResource(query, () => searchUsers(query.trim()), { delayMs: 250 })
        : null,
    [query, searchUsers]
  )
  const snapshot = useSyncExternalStore(
    resource?.subscribe ?? subscribeIdleResource,
    resource?.getSnapshot ?? getIdleResourceSnapshot,
    getIdleResourceSnapshot
  )
  return {
    users: snapshot.status === 'ready' ? (snapshot.data ?? []) : [],
    error: snapshot.status === 'error' ? String(snapshot.error) : undefined,
    retry: () => {
      void resource?.reload()
    },
    loading: Boolean(resource && snapshot.status !== 'ready' && snapshot.status !== 'error'),
  }
}

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
  open?: boolean
  onOpenChange?(open: boolean): void
  showAllLabel?(group: string, count: number): string
  onSearchChange?(query: string): void
  searchStatus?: ReactNode
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
  open: controlledOpen,
  onOpenChange,
  onChange,
  onSearchChange,
  searchStatus,
}: IssueDetailSearchableSelectProps<TValue>) {
  const portalTheme = useCollaborationPortalTheme()
  const searchInputRef = useRef<HTMLInputElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const [internalOpen, setInternalOpen] = useState(false)
  const open = controlledOpen ?? internalOpen
  const setOpen = (value: boolean) => {
    setInternalOpen(value)
    onOpenChange?.(value)
  }
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
          onSearchChange?.('')
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
          title={selectedDescription}
          aria-haspopup="dialog"
          disabled={disabled}
          className={className}
        >
          {triggerContent}
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
            if (!isImeComposingEvent(event)) setOpen(false)
          }}
          onKeyDown={event => {
            if (isImeComposingEvent(event)) {
              event.stopPropagation()
              return
            }
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
              onChange={event => {
                setQuery(event.target.value)
                onSearchChange?.(event.target.value)
              }}
              placeholder={searchPlaceholder}
              aria-label={searchPlaceholder}
              className="min-h-11 min-w-0 flex-1 bg-transparent text-sm text-text-primary outline-none placeholder:text-text-secondary md:min-h-8"
            />
          </label>
          {searchStatus}
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
