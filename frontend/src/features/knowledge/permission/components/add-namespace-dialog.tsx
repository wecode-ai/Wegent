// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useState, useRef, FormEvent } from 'react'
import { Users, XCircle, Search } from 'lucide-react'
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useTranslation } from '@/hooks/useTranslation'
import { knowledgePermissionApi } from '@/apis/knowledge-permission'
import { listGroups } from '@/apis/groups'
import { ASSIGNABLE_ROLES } from '@/types/base-role'
import type { MemberRole } from '@/types/knowledge'
import type { Group } from '@/types/group'

interface AddNamespaceDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  kbId: number
  onSuccess?: () => void
}

export function AddNamespaceDialog({
  open,
  onOpenChange,
  kbId,
  onSuccess,
}: AddNamespaceDialogProps) {
  const { t } = useTranslation('knowledge')

  const loc = (key: string, fallback: string) => {
    const v = t(key)
    return v && v !== key ? v : fallback
  }

  const [groups, setGroups] = useState<Group[]>([])
  const [selectedGroup, setSelectedGroup] = useState<Group | null>(null)
  const [role, setRole] = useState<MemberRole>('Reporter')
  const [loading, setLoading] = useState(false)
  const [fetchingGroups, setFetchingGroups] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [showDropdown, setShowDropdown] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)

  // Fetch groups when dialog opens
  useEffect(() => {
    if (open) {
      fetchGroups()
    }
  }, [open])

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
    setFetchingGroups(true)
    try {
      const result = await listGroups({ limit: 100 })
      setGroups(result.items || [])
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to fetch groups'
      setError(message)
    } finally {
      setFetchingGroups(false)
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

  const handleSelectGroup = (group: Group) => {
    setSelectedGroup(group)
    setSearchQuery('')
    setShowDropdown(false)
    setError(null)
  }

  const handleRemoveGroup = () => {
    setSelectedGroup(null)
    setSearchQuery('')
  }

  const handleSubmit = async (e?: FormEvent) => {
    e?.preventDefault()
    setError(null)

    if (!selectedGroup) {
      setError(t('common:required') || '请选择群组')
      return
    }

    setLoading(true)
    try {
      await knowledgePermissionApi.addNamespacePermission(kbId, selectedGroup.id, role)
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
    setSelectedGroup(null)
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
            <label className="text-sm font-medium">
              {loc('document.permission.selectGroup', '选择群组')}
            </label>
            {selectedGroup ? (
              <div className="flex items-center justify-between p-2 rounded-lg bg-muted/50 border border-border">
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate">
                    {selectedGroup.display_name || selectedGroup.name}
                  </div>
                  <div className="text-xs text-text-muted">
                    {t('document.permission.groupMembers') || '群组成员'}: {selectedGroup.member_count || '?'}
                  </div>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 flex-shrink-0 text-text-muted hover:text-error"
                  onClick={handleRemoveGroup}
                >
                  <XCircle className="w-4 h-4" />
                </Button>
              </div>
            ) : fetchingGroups ? (
              <div className="flex items-center justify-center py-4">
                <Spinner />
              </div>
            ) : (
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
                    data-testid="add-namespace-group-search"
                  />
                </div>
                {showDropdown && (
                  <div
                    ref={dropdownRef}
                    className="absolute z-50 w-full mt-1 bg-base border border-border rounded-md shadow-lg max-h-48 overflow-y-auto"
                    data-testid="add-namespace-group-dropdown"
                  >
                    {filteredGroups.length === 0 ? (
                      <div className="p-3 text-sm text-text-muted text-center">
                        {searchQuery.trim()
                          ? (t('common:userSearch.noResults') || '未找到结果')
                          : loc('document.permission.noGroups', '暂无可用群组')}
                      </div>
                    ) : (
                      filteredGroups.map(group => (
                        <button
                          key={group.id}
                          type="button"
                          onClick={() => handleSelectGroup(group)}
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
            )}
          </div>

          {/* Role selector */}
          <div className="space-y-2">
            <label className="text-sm font-medium">
              {loc('document.permission.role.label', '角色')}
            </label>
            <Select value={role} onValueChange={v => setRole(v as MemberRole)}>
              <SelectTrigger className="w-full h-11 min-w-[44px]">
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
            <div className="flex items-center gap-1.5 text-sm text-error bg-error/10 px-3 py-2 rounded-lg">
              <XCircle className="w-3.5 h-3.5 flex-shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={handleClose}>
              {t('common:actions.cancel')}
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={loading || !selectedGroup}
            >
              {loading ? <Spinner className="w-4 h-4" /> : loc('document.permission.add', '添加')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
