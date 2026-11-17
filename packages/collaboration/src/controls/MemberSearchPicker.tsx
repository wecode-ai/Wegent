// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { Check, Search } from 'lucide-react'
import type { ReactNode, Ref } from 'react'

const focus =
  'focus-visible:outline-none keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-[color-mix(in_srgb,rgb(var(--color-focus-ring))_80%,rgb(var(--color-text-primary))_20%)] keyboard:focus-visible:ring-offset-2'

/** Shared member search fields used by project creation and project settings. */
export function MemberSearchPicker<User extends { id: number; user_name: string }>({
  query,
  onQueryChange,
  users,
  onSelect,
  placeholder,
  emptyLabel,
  addLabel,
  addingLabel,
  inputTestId,
  resultTestId,
  inputRef,
  savingUserId = null,
  loadingLabel,
  error,
  children,
  searchable = true,
  selectedUserIds,
  userDescription,
}: {
  query: string
  onQueryChange(query: string): void
  users: User[]
  onSelect(user: User): void
  placeholder: string
  emptyLabel: string
  addLabel: string
  addingLabel: string
  inputTestId: string
  resultTestId(id: number): string
  inputRef?: Ref<HTMLInputElement>
  savingUserId?: number | null
  loadingLabel?: string
  error?: string
  children?: ReactNode
  selectedUserIds?: ReadonlySet<number>
  userDescription?(user: User): string | undefined
  searchable?: boolean
}) {
  return (
    <>
      {searchable && (
        <label className="flex min-h-11 items-center gap-2 rounded-lg border border-border px-3 keyboard:focus-within:ring-2 keyboard:focus-within:ring-[color-mix(in_srgb,rgb(var(--color-focus-ring))_80%,rgb(var(--color-text-primary))_20%)] md:min-h-9">
          <Search className="h-4 w-4 shrink-0 text-text-muted" />
          <input
            ref={inputRef}
            data-testid={inputTestId}
            value={query}
            onChange={event => onQueryChange(event.target.value)}
            aria-label={placeholder}
            placeholder={placeholder}
            className="min-w-0 flex-1 bg-transparent text-sm outline-none"
          />
        </label>
      )}
      {children}
      <div className="mt-2 max-h-52 overflow-y-auto">
        {loadingLabel && <p role="status">{loadingLabel}</p>}
        {error && <p role="alert">{error}</p>}
        {users.map(user => (
          <button
            key={user.id}
            type="button"
            data-testid={resultTestId(user.id)}
            aria-pressed={selectedUserIds ? selectedUserIds.has(user.id) : undefined}
            disabled={savingUserId !== null}
            onClick={() => onSelect(user)}
            className={`flex min-h-11 w-full items-center gap-2 rounded-lg px-2 text-left hover:bg-muted disabled:opacity-40 ${focus}`}
          >
            <span className="min-w-0 flex-1 truncate text-sm">
              {user.user_name}
              {userDescription?.(user) && (
                <span className="block text-xs text-text-muted">{userDescription(user)}</span>
              )}
            </span>
            <span className="text-xs text-text-muted">
              {selectedUserIds?.has(user.id) ? (
                <Check aria-hidden="true" className="h-4 w-4" />
              ) : savingUserId === user.id ? (
                addingLabel
              ) : (
                addLabel
              )}
            </span>
          </button>
        ))}
        {query.trim() && !users.length && !loadingLabel && !error && (
          <p className="px-2 py-3 text-sm text-text-muted">{emptyLabel}</p>
        )}
      </div>
    </>
  )
}
