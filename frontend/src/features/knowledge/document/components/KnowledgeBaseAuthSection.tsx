// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect, useRef } from 'react'
import { Search, X, ChevronDown, ChevronRight } from 'lucide-react'
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from '@/components/ui/collapsible'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { UserSearchSelect } from '@/components/common/UserSearchSelect'
import { listGroups } from '@/apis/groups'
import { useTranslation } from '@/hooks/useTranslation'
import { ASSIGNABLE_ROLES } from '@/types/base-role'
import type { MemberRole } from '@/types/knowledge'
import type { SearchUser } from '@/types/api'
import type { Group } from '@/types/group'

export interface AuthEntry {
  id: string
  label: string
  entityType: 'user' | 'namespace'
  entityId: string
  role: MemberRole
}

interface KnowledgeBaseAuthSectionProps {
  value: AuthEntry[]
  onChange: (entries: AuthEntry[]) => void
}

export function KnowledgeBaseAuthSection({
  value,
  onChange,
}: KnowledgeBaseAuthSectionProps) {
  const { t } = useTranslation('knowledge')
  const [open, setOpen] = useState(false)

  const userEntries = value.filter(e => e.entityType === 'user')
  const namespaceEntries = value.filter(e => e.entityType === 'namespace')

  const addUserEntry = (user: SearchUser, role: MemberRole) => {
    const exists = userEntries.some(e => e.entityId === String(user.id))
    if (exists) return
    onChange([
      ...value,
      {
        id: `user-${user.id}`,
        label: user.user_name,
        entityType: 'user',
        entityId: String(user.id),
        role,
      },
    ])
  }

  const removeEntry = (id: string) => {
    onChange(value.filter(e => e.id !== id))
  }

  const updateEntryRole = (id: string, role: MemberRole) => {
    onChange(
      value.map(e => (e.id === id ? { ...e, role } : e))
    )
  }

  const totalCount = userEntries.length + namespaceEntries.length

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="border-t border-border pt-4">
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-2 text-sm font-medium text-text-primary hover:text-primary transition-colors w-full text-left"
          data-testid="auth-section-trigger"
        >
          {open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
          {t('document.permission.authorization') || '授权'}
          {totalCount > 0 && (
            <span className="bg-primary/10 text-primary px-2 py-0.5 rounded-full text-xs">
              {totalCount}
            </span>
          )}
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-3 space-y-4">
        {/* User Section */}
        <div className="space-y-2">
          <Label className="text-xs font-medium">
            {t('document.permission.individual') || '个人'}
          </Label>
          <UserSearchSelect
            selectedUsers={[]}
            onSelectedUsersChange={(users) => {
              if (users.length > 0) {
                const user = users[users.length - 1]
                addUserEntry({ id: user.id, user_name: user.user_name }, 'Reporter' as MemberRole)
              }
            }}
            placeholder={t('document.permission.searchUserPlaceholder') || '搜索用户...'}
            multiple={false}
            hideSelectedUsers
          />
          {userEntries.length > 0 && (
            <div className="space-y-1 max-h-32 overflow-y-auto">
              {userEntries.map(entry => (
                <div
                  key={entry.id}
                  className="flex items-center justify-between p-2 rounded-lg bg-muted/50"
                >
                  <span className="text-sm truncate flex-1">{entry.label}</span>
                  <div className="flex items-center gap-2">
                    <Select
                      value={entry.role}
                      onValueChange={v => updateEntryRole(entry.id, v as MemberRole)}
                    >
                      <SelectTrigger className="w-24 h-8 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {ASSIGNABLE_ROLES.map(role => (
                          <SelectItem key={role} value={role} className="text-xs">
                            {t(`document.permission.role.${role}`)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 text-text-muted hover:text-error flex-shrink-0"
                      onClick={() => removeEntry(entry.id)}
                    >
                      <X className="w-3 h-3" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Group Section */}
        <div className="space-y-2">
          <Label className="text-xs font-medium">
            {t('document.permission.namespace') || '群组'}
          </Label>
          <GroupSearchSelect
            onSelect={(entry) => {
              const exists = namespaceEntries.some(e => e.entityId === entry.entityId)
              if (exists) return
              onChange([...value, entry])
            }}
          />
          {namespaceEntries.length > 0 && (
            <div className="space-y-1 max-h-32 overflow-y-auto">
              {namespaceEntries.map(entry => (
                <div
                  key={entry.id}
                  className="flex items-center justify-between p-2 rounded-lg bg-muted/50"
                >
                  <span className="text-sm truncate flex-1">{entry.label}</span>
                  <div className="flex items-center gap-2">
                    <Select
                      value={entry.role}
                      onValueChange={v => updateEntryRole(entry.id, v as MemberRole)}
                    >
                      <SelectTrigger className="w-24 h-8 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {ASSIGNABLE_ROLES.map(role => (
                          <SelectItem key={role} value={role} className="text-xs">
                            {t(`document.permission.role.${role}`)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 text-text-muted hover:text-error flex-shrink-0"
                      onClick={() => removeEntry(entry.id)}
                    >
                      <X className="w-3 h-3" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

// Group search select component
interface GroupSearchSelectProps {
  onSelect: (entry: AuthEntry) => void
}

function GroupSearchSelect({ onSelect }: GroupSearchSelectProps) {
  const { t } = useTranslation('knowledge')
  const [groups, setGroups] = useState<Group[]>([])
  const [fetching, setFetching] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [showDropdown, setShowDropdown] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    fetchGroups()
  }, [])

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node) &&
        inputRef.current &&
        !inputRef.current.contains(event.target as Node)
      ) {
        setShowDropdown(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const fetchGroups = async () => {
    setFetching(true)
    try {
      const result = await listGroups({ limit: 200 })
      setGroups(result.items || [])
    } catch (_err) {
      // silently fail
    } finally {
      setFetching(false)
    }
  }

  const filteredGroups = searchQuery.trim()
    ? groups.filter(
        g =>
          (g.display_name || g.name)
            .toLowerCase()
            .includes(searchQuery.trim().toLowerCase())
      )
    : groups

  const handleSelect = (group: Group) => {
    onSelect({
      id: `namespace-${group.id}`,
      label: group.display_name || group.name,
      entityType: 'namespace',
      entityId: String(group.id),
      role: 'Reporter' as MemberRole,
    })
    setSearchQuery('')
    setShowDropdown(false)
  }

  return (
    <div className="relative">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-text-muted" />
        <Input
          ref={inputRef}
          value={searchQuery}
          onChange={e => {
            setSearchQuery(e.target.value)
            setShowDropdown(true)
          }}
          onFocus={() => setShowDropdown(true)}
          placeholder={t('document.permission.searchGroupPlaceholder') || '搜索群组...'}
          className="pl-9"
        />
      </div>
      {showDropdown && (
        <div
          ref={dropdownRef}
          className="absolute z-50 w-full mt-1 bg-base border border-border rounded-md shadow-lg max-h-48 overflow-y-auto"
        >
          {fetching ? (
            <div className="flex items-center justify-center p-3">
              <Spinner className="w-4 h-4" />
            </div>
          ) : filteredGroups.length === 0 ? (
            <div className="p-3 text-sm text-text-muted text-center">
              {searchQuery.trim()
                ? t('common:userSearch.noResults')
                : (t('document.permission.noGroups') || '暂无群组')}
            </div>
          ) : (
            filteredGroups.map(group => (
              <button
                key={group.id}
                type="button"
                onClick={() => handleSelect(group)}
                className="w-full flex items-center gap-3 p-3 hover:bg-surface cursor-pointer text-left"
              >
                <span className="font-medium text-sm text-text-primary">
                  {group.display_name || group.name}
                </span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}
