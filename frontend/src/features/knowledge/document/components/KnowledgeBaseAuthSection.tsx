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
  const [userRole, setUserRole] = useState<MemberRole>('Reporter' as MemberRole)
  const [groupRole, setGroupRole] = useState<MemberRole>('Reporter' as MemberRole)

  // Safe translation helper that falls back when key is not found
  const loc = (key: string, fallback: string) => {
    const v = t(key)
    return v && v !== key ? v : fallback
  }

  const userEntries = value.filter(e => e.entityType === 'user')
  const namespaceEntries = value.filter(e => e.entityType === 'namespace')

  const removeEntry = (id: string) => {
    onChange(value.filter(e => e.id !== id))
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
          {loc('document.permission.authorization', '授权')}
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
            {loc('document.permission.individual', '个人')}
          </Label>
          {/* Selected user entries - shown ABOVE the search box as inline chips */}
          {userEntries.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {userEntries.map(entry => (
                <div
                  key={entry.id}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-muted/70 border border-border text-sm"
                >
                  <span className="truncate max-w-[120px]">{entry.label}</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-4 w-4 text-text-muted hover:text-error flex-shrink-0 p-0"
                    onClick={() => removeEntry(entry.id)}
                  >
                    <X className="w-3 h-3" />
                  </Button>
                </div>
              ))}
            </div>
          )}
          {/* Search box + Role selector inline */}
          <div className="flex items-center gap-2">
            <div className="flex-1">
              <UserSearchSelect
                selectedUsers={[]}
                onSelectedUsersChange={(users) => {
                  if (users.length > 0) {
                    const user = users[users.length - 1]
                    const exists = userEntries.some(e => e.entityId === String(user.id))
                    if (!exists) {
                      onChange([
                        ...value,
                        {
                          id: `user-${user.id}`,
                          label: user.user_name,
                          entityType: 'user',
                          entityId: String(user.id),
                          role: userRole,
                        },
                      ])
                    }
                  }
                }}
                placeholder={loc('document.permission.searchUserPlaceholder', '搜索用户...')}
                multiple={false}
                hideSelectedUsers
              />
            </div>
            <Select value={userRole} onValueChange={v => setUserRole(v as MemberRole)}>
              <SelectTrigger className="w-28 h-10 min-w-[44px] flex-shrink-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="Maintainer">
                  <div>
                    <div className="font-medium">{t('document.permission.role.Maintainer')}</div>
                    <div className="text-xs text-text-muted">
                      {t('document.permission.role.MaintainerDescription')}
                    </div>
                  </div>
                </SelectItem>
                <SelectItem value="Developer">
                  <div>
                    <div className="font-medium">{t('document.permission.role.Developer')}</div>
                    <div className="text-xs text-text-muted">
                      {t('document.permission.role.DeveloperDescription')}
                    </div>
                  </div>
                </SelectItem>
                <SelectItem value="Reporter">
                  <div>
                    <div className="font-medium">{t('document.permission.role.Reporter')}</div>
                    <div className="text-xs text-text-muted">
                      {t('document.permission.role.ReporterDescription')}
                    </div>
                  </div>
                </SelectItem>
                <SelectItem value="RestrictedAnalyst">
                  <div>
                    <div className="font-medium">
                      {t('document.permission.role.RestrictedAnalyst')}
                    </div>
                    <div className="text-xs text-text-muted">
                      {t('document.permission.role.RestrictedAnalystDescription')}
                    </div>
                  </div>
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* Group Section */}
        <div className="space-y-2">
          <Label className="text-xs font-medium">
            {loc('document.permission.namespace', '群组')}
          </Label>
          {/* Selected group entries - shown ABOVE the search box as inline chips */}
          {namespaceEntries.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {namespaceEntries.map(entry => (
                <div
                  key={entry.id}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-muted/70 border border-border text-sm"
                >
                  <span className="truncate max-w-[120px]">{entry.label}</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-4 w-4 text-text-muted hover:text-error flex-shrink-0 p-0"
                    onClick={() => removeEntry(entry.id)}
                  >
                    <X className="w-3 h-3" />
                  </Button>
                </div>
              ))}
            </div>
          )}
          {/* Search box + Role selector inline */}
          <div className="flex items-center gap-2">
            <div className="flex-1">
              <GroupSearchInput
                role={groupRole}
                onSelect={(entry) => {
                  const exists = namespaceEntries.some(e => e.entityId === entry.entityId)
                  if (exists) return
                  onChange([...value, entry])
                }}
              />
            </div>
            <Select value={groupRole} onValueChange={v => setGroupRole(v as MemberRole)}>
              <SelectTrigger className="w-28 h-10 min-w-[44px] flex-shrink-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="Maintainer">
                  <div>
                    <div className="font-medium">{t('document.permission.role.Maintainer')}</div>
                    <div className="text-xs text-text-muted">
                      {t('document.permission.role.MaintainerDescription')}
                    </div>
                  </div>
                </SelectItem>
                <SelectItem value="Developer">
                  <div>
                    <div className="font-medium">{t('document.permission.role.Developer')}</div>
                    <div className="text-xs text-text-muted">
                      {t('document.permission.role.DeveloperDescription')}
                    </div>
                  </div>
                </SelectItem>
                <SelectItem value="Reporter">
                  <div>
                    <div className="font-medium">{t('document.permission.role.Reporter')}</div>
                    <div className="text-xs text-text-muted">
                      {t('document.permission.role.ReporterDescription')}
                    </div>
                  </div>
                </SelectItem>
                <SelectItem value="RestrictedAnalyst">
                  <div>
                    <div className="font-medium">
                      {t('document.permission.role.RestrictedAnalyst')}
                    </div>
                    <div className="text-xs text-text-muted">
                      {t('document.permission.role.RestrictedAnalystDescription')}
                    </div>
                  </div>
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

// Group search input component
interface GroupSearchInputProps {
  onSelect: (entry: AuthEntry) => void
  role: MemberRole
}

function GroupSearchInput({ onSelect, role }: GroupSearchInputProps) {
  const { t } = useTranslation('knowledge')

  const loc = (key: string, fallback: string) => {
    const v = t(key)
    return v && v !== key ? v : fallback
  }
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
      role,
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
          onFocus={() => {
            if (!fetching && groups.length === 0) fetchGroups()
            setShowDropdown(true)
          }}
          placeholder={loc('document.permission.searchGroupPlaceholder', '搜索群组...')}
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
                ? t('common:userSearch.noResults') || '未找到结果'
                : loc('document.permission.noGroups', '暂无可用群组')}
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
