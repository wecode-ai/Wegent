// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { Search, X, ChevronDown, ChevronRight } from 'lucide-react'

import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@/components/ui/collapsible'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { UserSearchSelect } from '@/components/common/UserSearchSelect'
import { searchGroups } from '@/apis/groups'
import { useTranslation } from '@/hooks/useTranslation'
import { useUser } from '@/features/common/UserContext'
import {
  registerAuthSection,
  getAuthSections,
  subscribeAuthSections,
  type AuthEntry,
} from '../auth-section-registry'
import type { MemberRole } from '@/types/knowledge'
import type { SearchUser } from '@/types/api'
import type { Group } from '@/types/group'

export type { AuthEntry }

interface KnowledgeBaseAuthSectionProps {
  value: AuthEntry[]
  onChange: (entries: AuthEntry[]) => void
  /** Namespace ID to exclude from group search (the KB's owning namespace) */
  excludedNamespaceId?: string
}

export function KnowledgeBaseAuthSection({
  value,
  onChange,
  excludedNamespaceId,
}: KnowledgeBaseAuthSectionProps) {
  const { t } = useTranslation('knowledge')
  const [open, setOpen] = useState(false)
  // Per-section role state, keyed by entity type
  const [roles, setRoles] = useState<Record<string, MemberRole>>({
    user: 'Reporter' as MemberRole,
    namespace: 'Reporter' as MemberRole,
  })

  const loc = (key: string, fallback: string) => {
    const v = t(key)
    return v && v !== key ? v : fallback
  }

  const [sections, setSections] = useState(getAuthSections)
  useEffect(() => {
    return subscribeAuthSections(() => setSections(getAuthSections()))
  }, [])

  // Load optional KB extensions (e.g., org_department in internal builds)
  useEffect(() => {
    import('../extension-loader').then(({ loadKBExtensions }) => {
      loadKBExtensions().catch((err: unknown) => {
        console.warn('Failed to load KB extensions:', err)
      })
    })
  }, [])

  const totalCount = value.length

  const removeEntry = (id: string) => {
    onChange(value.filter(e => e.id !== id))
  }

  const getRoleForType = (type: string): MemberRole => {
    return roles[type] || ('Reporter' as MemberRole)
  }

  const setRoleForType = (type: string, role: MemberRole) => {
    setRoles(prev => ({ ...prev, [type]: role }))
    // Sync role for all existing entries of this type so the section selector
    // acts as the unified role for every selected item in the section.
    onChange(value.map(e => (e.entityType === type ? { ...e, role } : e)))
  }

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
        {sections.map(section => {
          const entries = value.filter(e => e.entityType === section.type)
          const role = getRoleForType(section.type)

          return (
            <div key={section.type} className="space-y-2">
              <Label className="text-xs font-medium">
                {t(section.labelKey) || section.labelKey}
              </Label>
              {/* Selected entries - shown ABOVE the search box as inline chips */}
              {entries.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {entries.map(entry => (
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
                  {section.renderSearch({
                    role,
                    onSelect: (entry: AuthEntry) => {
                      const exists = value.some(
                        e => e.entityType === entry.entityType && e.entityId === entry.entityId
                      )
                      if (!exists) {
                        onChange([...value, entry])
                      }
                    },
                    excludedEntityId:
                      section.type === 'namespace' ? excludedNamespaceId : undefined,
                  })}
                </div>
                <Select
                  value={role}
                  onValueChange={v => setRoleForType(section.type, v as MemberRole)}
                >
                  <SelectTrigger className="w-28 h-11 min-w-[44px] flex-shrink-0">
                    <span className="truncate">{t(`document.permission.role.${role}`)}</span>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Maintainer">
                      <div>
                        <div className="font-medium">
                          {t('document.permission.role.Maintainer')}
                        </div>
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
          )
        })}
      </CollapsibleContent>
    </Collapsible>
  )
}

// ==================== Built-in auth section renderers ====================

function UserAuthSearch({
  role,
  onSelect,
}: {
  role: MemberRole
  onSelect: (entry: AuthEntry) => void
}) {
  const { t } = useTranslation('knowledge')

  const loc = (key: string, fallback: string) => {
    const v = t(key)
    return v && v !== key ? v : fallback
  }

  return (
    <UserSearchSelect
      selectedUsers={[]}
      onSelectedUsersChange={(users: SearchUser[]) => {
        if (users.length > 0) {
          const user = users[users.length - 1]
          onSelect({
            id: `user-${user.id}`,
            label: user.user_name,
            entityType: 'user',
            entityId: String(user.id),
            role,
          })
        }
      }}
      placeholder={loc('document.permission.searchUserPlaceholder', '搜索用户...')}
      multiple={false}
      hideSelectedUsers
    />
  )
}

function NamespaceAuthSearch({
  role,
  onSelect,
  excludedEntityId,
}: {
  role: MemberRole
  onSelect: (entry: AuthEntry) => void
  excludedEntityId?: string
}) {
  const { t } = useTranslation('knowledge')
  const { user: currentUser } = useUser()

  const loc = (key: string, fallback: string) => {
    const v = t(key)
    return v && v !== key ? v : fallback
  }
  const [groups, setGroups] = useState<Group[]>([])
  const [searching, setSearching] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [showDropdown, setShowDropdown] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)

  const performSearch = useCallback(async (query: string) => {
    setSearching(true)
    try {
      const result = await searchGroups({ q: query, limit: 20 })
      setGroups(result.items || [])
    } catch (_err) {
      // silently fail
    } finally {
      setSearching(false)
    }
  }, [])

  // Load initial groups on mount
  useEffect(() => {
    performSearch('')
  }, [performSearch])

  // Debounced search when query changes
  useEffect(() => {
    const timer = setTimeout(() => {
      performSearch(searchQuery)
    }, 300)
    return () => clearTimeout(timer)
  }, [searchQuery, performSearch])

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

  // Sort groups: owned by current user first, then by display_name
  const filteredGroups = [...groups].sort((a, b) => {
    const aOwned = currentUser ? a.owner_user_id === currentUser.id : false
    const bOwned = currentUser ? b.owner_user_id === currentUser.id : false
    if (aOwned && !bOwned) return -1
    if (!aOwned && bOwned) return 1
    return (a.display_name || a.name).localeCompare(b.display_name || b.name)
  })

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
            if (!searching && groups.length === 0) performSearch(searchQuery)
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
          {searching ? (
            <div className="flex items-center justify-center p-3">
              <Spinner className="w-4 h-4" />
            </div>
          ) : filteredGroups.length === 0 ? (
            <div className="p-3 text-sm text-text-muted text-center">
              {searchQuery.trim()
                ? loc('document.permission.noGroupResults', '没有匹配的组')
                : loc('document.permission.noGroups', '暂无可用群组')}
            </div>
          ) : (
            filteredGroups.map(group => {
              const isBound = excludedEntityId ? group.name === excludedEntityId : false
              return (
                <button
                  key={group.id}
                  type="button"
                  onClick={() => !isBound && handleSelect(group)}
                  disabled={isBound}
                  className={`w-full flex items-center justify-between gap-3 p-3 text-left ${
                    isBound ? 'opacity-50 cursor-not-allowed' : 'hover:bg-surface cursor-pointer'
                  }`}
                >
                  <span
                    className={`font-medium text-sm truncate ${
                      isBound ? 'text-text-muted' : 'text-text-primary'
                    }`}
                  >
                    {group.display_name || group.name}
                  </span>
                  {isBound ? (
                    <span className="flex-shrink-0 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] leading-tight font-medium bg-muted text-text-muted border border-border">
                      {loc('document.permission.alreadyBound', '已绑定')}
                    </span>
                  ) : group.my_role ? (
                    <span className="flex-shrink-0 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] leading-tight font-medium bg-primary/10 text-primary border border-primary/20">
                      {t(`document.permission.role.${group.my_role}`)}
                    </span>
                  ) : null}
                </button>
              )
            })
          )}
        </div>
      )}
    </div>
  )
}

// ==================== Register built-in auth sections ====================

registerAuthSection({
  type: 'user',
  labelKey: 'document.permission.individual',
  renderSearch: ({ role, onSelect }) => <UserAuthSearch role={role} onSelect={onSelect} />,
})

registerAuthSection({
  type: 'namespace',
  labelKey: 'document.permission.namespace',
  renderSearch: ({ role, onSelect, excludedEntityId }) => (
    <NamespaceAuthSearch role={role} onSelect={onSelect} excludedEntityId={excludedEntityId} />
  ),
})
