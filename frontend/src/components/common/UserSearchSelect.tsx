// SPDX-FileCopyrightText: 2025 WeCode, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useState, useEffect, useRef } from 'react';
import { Search, X, Check } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { userApis } from '@/apis/user';
import { useTranslation } from '@/hooks/useTranslation';
import type { SearchUser } from '@/types/api';

interface UserSearchSelectProps {
  /** Currently selected users */
  selectedUsers: SearchUser[];
  /** Callback when selected users change */
  onSelectedUsersChange: (users: SearchUser[]) => void;
  /** Whether the component is disabled */
  disabled?: boolean;
  /** Placeholder text for the search input */
  placeholder?: string;
  /** Whether to allow multiple selection (default: true) */
  multiple?: boolean;
  /** Custom class name for the container */
  className?: string;
}

/**
 * A reusable user search and select component with:
 * - 300ms debounced search
 * - Multi-select support with badges
 * - Click outside to close dropdown
 */
export function UserSearchSelect({
  selectedUsers,
  onSelectedUsersChange,
  disabled = false,
  placeholder,
  multiple = true,
  className = '',
}: UserSearchSelectProps) {
  const { t } = useTranslation();
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchUser[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [showDropdown, setShowDropdown] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Search users with 300ms debounce
  useEffect(() => {
    if (!searchQuery.trim()) {
      setSearchResults([]);
      setShowDropdown(false);
      return;
    }

    const timeoutId = setTimeout(async () => {
      setIsSearching(true);
      try {
        const response = await userApis.searchUsers(searchQuery);
        setSearchResults(response.users || []);
        setShowDropdown(true);
      } catch (error) {
        console.error('Failed to search users:', error);
        setSearchResults([]);
      } finally {
        setIsSearching(false);
      }
    }, 300);

    return () => clearTimeout(timeoutId);
  }, [searchQuery]);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node) &&
        searchInputRef.current &&
        !searchInputRef.current.contains(event.target as Node)
      ) {
        setShowDropdown(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, []);

  // Handle selecting a user from search results
  const handleSelectUser = (user: SearchUser) => {
    if (multiple) {
      // Multi-select mode: add to selected list
      if (!selectedUsers.find(u => u.id === user.id)) {
        onSelectedUsersChange([...selectedUsers, user]);
      }
    } else {
      // Single-select mode: replace selected
      onSelectedUsersChange([user]);
    }
    setSearchQuery('');
    setSearchResults([]);
    setShowDropdown(false);
  };

  // Handle removing a selected user
  const handleRemoveUser = (userId: number) => {
    onSelectedUsersChange(selectedUsers.filter(u => u.id !== userId));
  };

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
              if (searchResults.length > 0) {
                setShowDropdown(true);
              }
            }}
            placeholder={placeholder || t('common:userSearch.placeholder')}
            disabled={disabled}
            className="pl-9"
          />
        </div>

        {/* Search Results Dropdown */}
        {showDropdown && (searchResults.length > 0 || isSearching) && (
          <div
            ref={dropdownRef}
            className="absolute z-50 w-full mt-1 bg-base border border-border rounded-md shadow-lg max-h-48 overflow-y-auto"
          >
            {isSearching ? (
              <div className="p-3 text-sm text-text-muted text-center">
                {t('common:actions.loading')}
              </div>
            ) : (
              searchResults.map(user => {
                const isSelected = selectedUsers.some(u => u.id === user.id);
                return (
                  <button
                    key={user.id}
                    onClick={() => handleSelectUser(user)}
                    disabled={isSelected}
                    className="w-full flex items-center gap-3 p-3 hover:bg-surface cursor-pointer text-left disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <div className="flex-1">
                      <span className="font-medium text-sm text-text-primary">
                        {user.user_name}
                      </span>
                      {user.email && <div className="text-xs text-text-muted">{user.email}</div>}
                    </div>
                    {isSelected && <Check className="h-4 w-4 text-green-500" />}
                  </button>
                );
              })
            )}
          </div>
        )}
      </div>

      {/* Selected Users */}
      {selectedUsers.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {selectedUsers.map(user => (
            <Badge key={user.id} variant="secondary" className="pr-1">
              {user.user_name}
              <button
                onClick={() => handleRemoveUser(user.id)}
                className="ml-1 hover:bg-accent rounded-full p-0.5"
                disabled={disabled}
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}
