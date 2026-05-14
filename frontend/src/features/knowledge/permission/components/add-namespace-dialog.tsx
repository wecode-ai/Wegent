// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useState, useRef, useCallback, FormEvent } from 'react'
import { Users, X, Search, Check } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useTranslation } from '@/hooks/useTranslation'
import { useUser } from '@/features/common/UserContext'
import { knowledgePermissionApi } from '@/apis/knowledge-permission'
import { searchGroups } from '@/apis/groups'
import type { MemberRole } from '@/types/knowledge'
import type { Group } from '@/types/group'

interface AddNamespaceDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  kbId: number
  onSuccess?: () => void
  /** Namespace ID to exclude from search (the KB's owning namespace) */
  excludedNamespaceId?: string
  /** Namespace IDs already bound to the KB — marked as disabled in the picker */
  boundNamespaceIds?: string[]
}

export function AddNamespaceDialog({
  open,
  onOpenChange,
  kbId,
  onSuccess,
  excludedNamespaceId,
  boundNamespaceIds,
}: AddNamespaceDialogProps) {
  const { t } = useTranslation('knowledge')
  const { user: currentUser } = useUser()

  const loc = (key: string, fallback: string) => {
    const v = t(key)
    return v && v !== key ? v : fallback
  }

  const [groups, setGroups] = useState<Group[]>([])
  const [selectedGroups, setSelectedGroups] = useState<Group[]>([])
  const [role, setRole] = useState<MemberRole>('Reporter')
  const [loading, setLoading] = useState(false)
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [showDropdown, setShowDropdown] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)

  // Load initial groups when dialog opens
  useEffect(() => {
    if (open) {
      setSearchQuery('')
      performSearch('')
    }
  }, [open])

  // Debounced search when query changes
  useEffect(() => {
    if (!open) return
    const timer = setTimeout(() => {
      performSearch(searchQuery)
    }, 300)
    return () => clearTimeout(timer)
  }, [searchQuery, open])

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

  const performSearch = useCallback(async (query: string) => {
    setSearching(true)
    try {
      const result = await searchGroups({ q: query, limit: 20 })
      setGroups(result.items || [])
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to search groups'
      setError(message)
    } finally {
      setSearching(false)
    }
  }, [])

  // Sort groups: owned by current user first, then by display_name
  const filteredGroups = [...groups].sort((a, b) => {
    const aOwned = currentUser ? a.owner_user_id === currentUser.id : false
    const bOwned = currentUser ? b.owner_user_id === currentUser.id : false
    if (aOwned && !bOwned) return -1
    if (!aOwned && bOwned) return 1
    return (a.display_name || a.name).localeCompare(b.display_name || b.name)
  })

  const isGroupSelected = (group: Group) => selectedGroups.some(g => g.id === group.id)

  const handleToggleGroup = (group: Group) => {
    setSelectedGroups(prev =>
      prev.some(g => g.id === group.id) ? prev.filter(g => g.id !== group.id) : [...prev, group]
    )
    setSearchQuery('')
    setError(null)
  }

  const handleRemoveGroup = (groupId: number) => {
    setSelectedGroups(prev => prev.filter(g => g.id !== groupId))
  }

  const handleSubmit = async (e?: FormEvent) => {
    e?.preventDefault()
    setError(null)

    if (selectedGroups.length === 0) {
      setError(t('common:required') || 'Please select groups')
      return
    }

    setLoading(true)
    try {
      const results = await Promise.allSettled(
        selectedGroups.map(group =>
          knowledgePermissionApi.addNamespacePermission(kbId, group.id, role)
        )
      )

      const failedGroups: Group[] = []
      const succeededIds: number[] = []

      results.forEach((result, index) => {
        if (result.status === 'rejected') {
          failedGroups.push(selectedGroups[index])
        } else {
          succeededIds.push(selectedGroups[index].id)
        }
      })

      if (failedGroups.length > 0) {
        // Keep only failed groups in selection for retry
        setSelectedGroups(failedGroups)
        setError(
          `Failed to add ${failedGroups.length} group(s): ${failedGroups.map(g => g.display_name || g.name).join(', ')}`
        )
        return
      }

      resetForm()
      onSuccess?.()
      onOpenChange(false)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to add namespace permission'
      setError(message)
    } finally {
      setLoading(false)
    }
  }

  const resetForm = () => {
    setSelectedGroups([])
    setRole('Reporter')
    setSearchQuery('')
    setShowDropdown(false)
    setError(null)
  }

  const handleClose = () => {
    resetForm()
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Users className="w-5 h-5" />
            {loc('document.permission.addNamespace', '添加群组权限')}
          </DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Group search selector */}
          <div className="space-y-2">
            <Label>{loc('document.permission.selectGroup', '选择群组')}</Label>
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
                  data-testid="add-namespace-group-search"
                />
              </div>
              {showDropdown && (
                <div
                  ref={dropdownRef}
                  className="absolute z-50 w-full mt-1 bg-base border border-border rounded-md shadow-lg max-h-48 overflow-y-auto"
                  data-testid="add-namespace-group-dropdown"
                >
                  {searching ? (
                    <div className="p-3 text-sm text-text-muted text-center">
                      {t('common:actions.loading')}
                    </div>
                  ) : filteredGroups.length === 0 ? (
                    <div className="p-3 text-sm text-text-muted text-center">
                      {searchQuery.trim()
                        ? loc('document.permission.noGroupResults', '没有匹配的组')
                        : loc('document.permission.noGroups', '暂无可用群组')}
                    </div>
                  ) : (
                    filteredGroups.map(group => {
                      const selected = isGroupSelected(group)
                      const isBound =
                        (excludedNamespaceId && group.name === excludedNamespaceId) ||
                        (boundNamespaceIds?.includes(String(group.id)) ?? false)
                      return (
                        <button
                          key={group.id}
                          type="button"
                          onClick={() => !isBound && handleToggleGroup(group)}
                          disabled={isBound || selected}
                          className="w-full flex items-center gap-3 p-3 hover:bg-surface cursor-pointer text-left disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          <div className="flex-1 min-w-0">
                            <div className="font-medium text-sm text-text-primary truncate">
                              {group.display_name || group.name}
                            </div>
                            {isBound ? (
                              <div className="text-xs text-text-muted">
                                {loc('document.permission.alreadyBound', '已绑定')}
                              </div>
                            ) : group.my_role ? (
                              <div className="text-xs text-text-muted">
                                {t(`document.permission.role.${group.my_role}`)}
                              </div>
                            ) : null}
                          </div>
                          {selected && <Check className="h-4 w-4 text-green-500 flex-shrink-0" />}
                        </button>
                      )
                    })
                  )}
                </div>
              )}
            </div>
            {/* Selected group chips */}
            {selectedGroups.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {selectedGroups.map(group => (
                  <Badge key={group.id} variant="secondary" className="pr-1">
                    <span className="truncate max-w-[120px]">
                      {group.display_name || group.name}
                    </span>
                    <button
                      type="button"
                      aria-label="Remove group"
                      className="ml-1 hover:bg-accent rounded-full p-0.5"
                      onClick={() => handleRemoveGroup(group.id)}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </Badge>
                ))}
              </div>
            )}
          </div>

          {/* Role selector */}
          <div className="space-y-2">
            <Label htmlFor="namespace-role">{loc('document.permission.role.label', '角色')}</Label>
            <Select value={role} onValueChange={v => setRole(v as MemberRole)}>
              <SelectTrigger id="namespace-role">
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

          {/* Error message */}
          {error && (
            <div className="text-sm text-error bg-error/10 px-3 py-2 rounded-lg">{error}</div>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={handleClose}>
              {t('common:actions.cancel')}
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={loading || selectedGroups.length === 0}
            >
              {loading ? <Spinner className="w-4 h-4" /> : loc('document.permission.add', '添加')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
