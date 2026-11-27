import { SelectField, type SelectFieldProps } from '../controls/SelectField'
import { Button as ControlButton } from '../markdown/Button'
// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useMemo, useSyncExternalStore, useRef, useState } from 'react'
import {
  createAsyncResource,
  getIdleResourceSnapshot,
  subscribeIdleResource,
} from '@wegent/chat-core/async-resource'
import { useFocusRequest } from '../dom-events'
import { X } from 'lucide-react'

import { ConfirmationDialog } from '../controls/ConfirmationDialog'
import { MemberSearchPicker } from '../controls/MemberSearchPicker'
import type { CollaborationPriority, CollaborationStatus } from '../types'

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
          <ControlButton
            variant="unstyled"
            type="button"
            data-testid="cloud-todo-collaborator-retry"
            onClick={search.retry}
            className="min-h-11 px-2 text-sm underline md:min-h-9"
          >
            {retryLabel}
          </ControlButton>
        )}
        <div className="mt-2 flex flex-wrap gap-1">
          {selected.map(user => (
            <ControlButton
              variant="unstyled"
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
            </ControlButton>
          ))}
        </div>
      </MemberSearchPicker>
      <ControlButton
        variant="primary"
        size="sm"
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
      </ControlButton>
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
  density?: SelectFieldProps<TValue>['density']
  appearance?: SelectFieldProps<TValue>['appearance']
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
  density,
  appearance,
  onChange,
}: IssueDetailSelectProps<TValue>) {
  return (
    <SelectField
      value={value}
      options={includeUnset ? [{ value: '' as TValue, label: unsetLabel }, ...options] : options}
      testId={testId}
      density={density}
      appearance={appearance}
      accessibleLabel={accessibleLabel}
      className={className}
      disabled={disabled}
      onChange={onChange}
    />
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
  includeNone = true,
  ...props
}: Omit<IssueDetailSelectProps<CollaborationPriority>, 'options'> & {
  labels: Record<CollaborationPriority, string>
  includeNone?: boolean
}) {
  return (
    <IssueDetailSelect
      {...props}
      options={(['none', 'low', 'medium', 'high', 'urgent'] as const)
        .filter(value => includeNone || value !== 'none')
        .map(value => ({
          value,
          label: labels[value],
        }))}
    />
  )
}
