// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect, useRef, ReactNode } from 'react'
import { Search, X, Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import client from '@/apis/client'
import { useUser } from '@/features/common/UserContext'
import { userApis } from '@/apis/user'
import { useTranslation } from '@/hooks/useTranslation'
import type { SearchUser } from '@/types/api'
import { cn } from '@/lib/utils'

interface UserSearchSelectProps<T extends SearchUser = SearchUser> {
  /** Currently selected users */
  selectedUsers: T[]
  /** Callback when selected users change */
  onSelectedUsersChange: (users: T[]) => void
  /** Whether the component is disabled */
  disabled?: boolean
  /** Placeholder text for the search input */
  placeholder?: string
  /** Whether to allow multiple selection (default: true) */
  multiple?: boolean
  /** Custom class name for the container */
  className?: string
  /** Stable test id for the search input when the caller owns the interaction. */
  inputTestId?: string
  /** Auto focus on input (default: false) */
  autoFocus?: boolean
  /** Custom render for no results state - receives searchQuery and clearSearch function */
  renderNoResults?: (searchQuery: string, clearSearch: () => void) => ReactNode
  /** Custom render for selected users - if provided, replaces default badge rendering */
  renderSelectedUsers?: (users: T[], onRemove: (userId: number) => void) => ReactNode
  /** Hide the default selected users display (use when handling display externally) */
  hideSelectedUsers?: boolean
  /** Let scrollable forms reserve space for results instead of overlaying controls. */
  resultsLayout?: 'overlay' | 'inline'
  /** Keep the query and results available when a caller collects multiple targets. */
  clearSearchOnSelect?: boolean
}

/**
 * A reusable user search and select component with:
 * - 300ms debounced search
 * - Multi-select support with badges
 * - Click outside to close dropdown
 * - Customizable no-results and selected users rendering
 */
export function UserSearchSelect<T extends SearchUser = SearchUser>({
  selectedUsers,
  onSelectedUsersChange,
  disabled = false,
  placeholder,
  multiple = true,
  className = '',
  inputTestId,
  autoFocus = false,
  renderNoResults,
  renderSelectedUsers,
  hideSelectedUsers = false,
  resultsLayout = 'overlay',
  clearSearchOnSelect = true,
}: UserSearchSelectProps<T>) {
  const { t } = useTranslation('common')
  const { user } = useUser()
  const searchScope = JSON.stringify([user?.id, client.getCacheScope()])
  const [stateScope, setStateScope] = useState(searchScope)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<SearchUser[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const [searchFailed, setSearchFailed] = useState(false)
  const [searchAttempt, setSearchAttempt] = useState(0)
  const [showDropdown, setShowDropdown] = useState(false)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)

  if (stateScope !== searchScope) {
    setStateScope(searchScope)
    setSearchResults([])
    setSearchFailed(false)
    setShowDropdown(false)
    setIsSearching(false)
  }

  // Search users with 300ms debounce
  useEffect(() => {
    let cancelled = false
    const trimmedQuery = searchQuery.trim()
    setSearchFailed(false)
    setSearchResults([])
    if (!trimmedQuery) {
      setSearchResults([])
      setShowDropdown(false)
      setIsSearching(false)
      return
    }

    // Mark pending immediately so loading state is shown during debounce window
    setIsSearching(true)
    setShowDropdown(true)
    const timeoutId = setTimeout(async () => {
      try {
        const response = await userApis.searchUsers(trimmedQuery)
        if (cancelled) return
        setSearchResults(response.users || [])
        setShowDropdown(true)
      } catch {
        if (cancelled) return
        setSearchFailed(true)
        setShowDropdown(true)
        setSearchResults([])
      } finally {
        if (!cancelled) setIsSearching(false)
      }
    }, 300)

    return () => {
      cancelled = true
      clearTimeout(timeoutId)
    }
  }, [searchQuery, searchScope, searchAttempt])

  // Inline results must not collapse on mousedown and move the clicked form action.
  useEffect(() => {
    if (resultsLayout === 'inline') return
    const handleClickOutside = (event: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node) &&
        searchInputRef.current &&
        !searchInputRef.current.contains(event.target as Node)
      ) {
        setShowDropdown(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [resultsLayout])

  // Handle selecting a user from search results
  const handleSelectUser = (user: SearchUser) => {
    if (multiple) {
      // Multi-select mode: add to selected list
      if (!selectedUsers.find(u => u.id === user.id)) {
        onSelectedUsersChange([...selectedUsers, user as T])
      }
    } else {
      // Single-select mode: replace selected
      onSelectedUsersChange([user as T])
    }
    if (clearSearchOnSelect) {
      setSearchQuery('')
      setSearchResults([])
      setShowDropdown(false)
    }
  }

  // Handle removing a selected user
  const handleRemoveUser = (userId: number) => {
    onSelectedUsersChange(selectedUsers.filter(u => u.id !== userId))
  }

  // Clear search query
  const clearSearch = () => {
    setSearchQuery('')
    setSearchResults([])
    setShowDropdown(false)
  }

  // Check if we should show no results
  const showNoResults =
    searchQuery.trim() && !isSearching && !searchFailed && searchResults.length === 0

  return (
    <div className={`space-y-2 ${className}`}>
      {/* Search Input */}
      <div className="relative">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-text-muted" />
          <Input
            ref={searchInputRef}
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            onFocus={() => {
              // Show dropdown if there are search results or if user has typed something
              // (to show "no results" or "loading" state)
              if (searchResults.length > 0 || searchQuery.trim()) {
                setShowDropdown(true)
              }
            }}
            placeholder={placeholder || t('common:userSearch.placeholder')}
            disabled={disabled}
            className="pl-9"
            autoFocus={autoFocus}
            data-testid={inputTestId}
          />
        </div>

        {/* Search Results Dropdown */}
        {showDropdown && (searchResults.length > 0 || isSearching || searchFailed) && (
          <div
            ref={dropdownRef}
            data-testid={inputTestId ? `${inputTestId}-results` : undefined}
            className={cn(
              'w-full mt-1 bg-base border border-border rounded-md shadow-lg max-h-48 overflow-y-auto',
              resultsLayout === 'inline' ? 'overscroll-contain' : 'absolute z-50'
            )}
          >
            {isSearching ? (
              <div className="p-3 text-sm text-text-muted text-center">
                {t('common:actions.loading')}
              </div>
            ) : searchFailed ? (
              <div role="alert" className="p-3 text-sm text-error">
                <p>{t('common:userSearch.searchFailed')}</p>
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11 min-w-11"
                  data-testid={(inputTestId || 'user-search') + '-retry'}
                  onClick={() => setSearchAttempt(value => value + 1)}
                >
                  {t('common:actions.retry')}
                </Button>
              </div>
            ) : (
              searchResults.map(user => {
                const isSelected = selectedUsers.some(u => u.id === user.id)
                return (
                  <button
                    type="button"
                    key={user.id}
                    data-testid={`user-search-result-${user.id}`}
                    onClick={() => handleSelectUser(user)}
                    disabled={isSelected}
                    aria-pressed={isSelected}
                    className="w-full flex items-center gap-3 p-3 hover:bg-surface cursor-pointer text-left disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <div
                      className={cn('flex-1', resultsLayout === 'inline' && 'min-w-0 break-words')}
                    >
                      <span className="font-medium text-sm text-text-primary">
                        {user.user_name}
                      </span>
                      {user.email && <div className="text-xs text-text-muted">{user.email}</div>}
                    </div>
                    {isSelected && <Check className="h-4 w-4 text-green-500" />}
                  </button>
                )
              })
            )}
          </div>
        )}

        {/* No Results - Custom or Default */}
        {showNoResults &&
          (renderNoResults ? (
            renderNoResults(searchQuery, clearSearch)
          ) : (
            <div className="text-center text-sm text-text-muted py-2">
              {t('common:userSearch.noResults')}
            </div>
          ))}
      </div>

      {/* Selected Users - Custom or Default */}
      {!hideSelectedUsers &&
        selectedUsers.length > 0 &&
        (renderSelectedUsers ? (
          renderSelectedUsers(selectedUsers, handleRemoveUser)
        ) : (
          <div className="flex flex-wrap gap-2">
            {selectedUsers.map(user => (
              <Badge key={user.id} variant="secondary" className="pr-1">
                {user.user_name}
                <button
                  type="button"
                  onClick={() => handleRemoveUser(user.id)}
                  className="ml-1 hover:bg-accent rounded-full p-0.5"
                  disabled={disabled}
                >
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            ))}
          </div>
        ))}
    </div>
  )
}
