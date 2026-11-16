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
  defaultOpen?: boolean
  value: AuthEntry[]
  onChange: (entries: AuthEntry[]) => void
  /** Namespace ID to exclude from group search (the KB's owning namespace) */
  excludedNamespaceId?: string
  boundNamespaceIds?: string[]
}

export function KnowledgeBaseAuthSection({
  defaultOpen = false,
  value,
  onChange,
  excludedNamespaceId,
  boundNamespaceIds,
}: KnowledgeBaseAuthSectionProps) {
  const { t } = useTranslation('knowledge')
  const [open, setOpen] = useState(defaultOpen)
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

  const removeEntry = (entry: AuthEntry) => {
    onChange(value.filter(e => e.entityType !== entry.entityType || e.entityId !== entry.entityId))
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
          className="min-h-11 min-w-11 flex items-center gap-2 text-sm font-medium text-text-primary hover:text-primary transition-colors w-full text-left"
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
                      key={JSON.stringify([entry.entityType, entry.entityId])}
                      className="inline-flex items-center gap-1.5 pl-2.5 pr-1 rounded-full bg-muted/70 border border-border text-sm"
                    >
                      <span className="truncate max-w-[120px]">{entry.label}</span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="min-h-11 min-w-11 md:h-8 md:w-8 md:min-h-8 md:min-w-8 text-text-muted hover:text-error flex-shrink-0 p-0"
                        data-testid={`remove-auth-${entry.entityType}-${entry.entityId}`}
                        aria-label={t('document.permission.remove')}
                        onClick={() => removeEntry(entry)}
                      >
                        <X className="w-3 h-3" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
              {/* Search box + Role selector inline */}
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  {section.renderSearch({
                    role,
                    selectedEntries: entries,
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
                    boundEntityIds: section.type === 'namespace' ? boundNamespaceIds : undefined,
                  })}
                </div>
                <Select
                  value={role}
                  onValueChange={v => setRoleForType(section.type, v as MemberRole)}
                >
                  <SelectTrigger
                    data-testid={`auth-role-${section.type}`}
                    className="w-28 h-11 min-w-[44px] flex-shrink-0"
                  >
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
  selectedEntries = [],
}: {
  role: MemberRole
  onSelect: (entry: AuthEntry) => void
  selectedEntries?: AuthEntry[]
}) {
  const { t } = useTranslation('knowledge')

  const loc = (key: string, fallback: string) => {
    const v = t(key)
    return v && v !== key ? v : fallback
  }

  return (
    <UserSearchSelect
      selectedUsers={selectedEntries.map(entry => ({
        id: Number(entry.entityId),
        user_name: entry.label,
      }))}
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
      resultsLayout="inline"
      clearSearchOnSelect={false}
      hideSelectedUsers
      inputTestId="knowledge-auth-user-search"
      className="[&_input]:min-h-11 [&_button]:min-h-11 [&_button]:min-w-11"
    />
  )
}

function NamespaceAuthSearch({
  role,
  onSelect,
  excludedEntityId,
  boundEntityIds,
  selectedEntries = [],
}: {
  role: MemberRole
  onSelect: (entry: AuthEntry) => void
  excludedEntityId?: string
  boundEntityIds?: string[]
  selectedEntries?: AuthEntry[]
}) {
  const { t } = useTranslation('knowledge')
  const { user: currentUser } = useUser()

  const loc = (key: string, fallback: string) => {
    const v = t(key)
    return v && v !== key ? v : fallback
  }
  const [groups, setGroups] = useState<Group[]>([])
  const [searching, setSearching] = useState(false)
  const [searchFailed, setSearchFailed] = useState(false)
  const searchRevision = useRef(0)
  const [searchQuery, setSearchQuery] = useState('')
  const [showDropdown, setShowDropdown] = useState(false)

  const performSearch = useCallback(async (query: string) => {
    const revision = ++searchRevision.current
    setSearching(true)
    setSearchFailed(false)
    try {
      const result = await searchGroups({ q: query, limit: 20 })
      if (searchRevision.current === revision) setGroups(result.items || [])
    } catch (_err) {
      if (searchRevision.current === revision) setSearchFailed(true)
    } finally {
      if (searchRevision.current === revision) setSearching(false)
    }
  }, [])

  useEffect(
    () => () => {
      searchRevision.current++
    },
    []
  )

  // Debounced search when query changes
  useEffect(() => {
    // Invalidate old requests and hide stale results during the debounce window.
    searchRevision.current++
    setSearching(true)
    setSearchFailed(false)
    const timer = setTimeout(() => {
      performSearch(searchQuery)
    }, 300)
    return () => clearTimeout(timer)
  }, [searchQuery, performSearch])

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
  }

  return (
    <div className="relative">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-text-muted" />
        <Input
          data-testid="add-namespace-group-search"
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
          className="min-h-11 pl-9"
        />
      </div>
      {showDropdown && (
        <div
          data-testid="knowledge-auth-namespace-results"
          className="w-full mt-1 bg-base border border-border rounded-md shadow-lg max-h-48 overflow-y-auto overscroll-contain"
        >
          {searching ? (
            <div className="flex items-center justify-center p-3">
              <Spinner className="w-4 h-4" />
            </div>
          ) : searchFailed ? (
            <div role="alert" className="p-3 text-sm text-error">
              <p>{t('document.permission.groupSearchFailed')}</p>
              <Button
                type="button"
                variant="outline"
                className="min-h-11 min-w-11"
                data-testid="retry-auth-group-search"
                onClick={() => void performSearch(searchQuery)}
              >
                {t('document.navigation.retry')}
              </Button>
            </div>
          ) : filteredGroups.length === 0 ? (
            <div className="p-3 text-sm text-text-muted text-center">
              {searchQuery.trim()
                ? loc('document.permission.noGroupResults', '没有匹配的组')
                : loc('document.permission.noGroups', '暂无可用群组')}
            </div>
          ) : (
            filteredGroups.map(group => {
              const isBound =
                group.name === excludedEntityId || !!boundEntityIds?.includes(String(group.id))
              const isSelected = selectedEntries.some(entry => entry.entityId === String(group.id))
              return (
                <button
                  key={group.id}
                  data-testid={`auth-select-namespace-${group.id}`}
                  type="button"
                  onClick={() => handleSelect(group)}
                  disabled={isBound || isSelected}
                  aria-pressed={isSelected}
                  className={`w-full min-h-11 flex items-center justify-between gap-3 p-3 text-left ${
                    isBound || isSelected
                      ? 'opacity-50 cursor-not-allowed'
                      : 'hover:bg-surface cursor-pointer'
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
  renderSearch: ({ role, onSelect, selectedEntries }) => (
    <UserAuthSearch role={role} onSelect={onSelect} selectedEntries={selectedEntries} />
  ),
})

registerAuthSection({
  type: 'namespace',
  labelKey: 'document.permission.namespace',
  renderSearch: ({ role, onSelect, excludedEntityId, boundEntityIds, selectedEntries }) => (
    <NamespaceAuthSearch
      role={role}
      onSelect={onSelect}
      excludedEntityId={excludedEntityId}
      boundEntityIds={boundEntityIds}
      selectedEntries={selectedEntries}
    />
  ),
})
