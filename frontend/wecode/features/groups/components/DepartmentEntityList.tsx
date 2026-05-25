// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useTranslation } from '@/hooks/useTranslation'
import { listGroupEntityMembers, removeGroupEntityMember } from '@/apis/groups'
import { groupPermissionExtensionApi } from '@wecode/apis/group-permission-extension'
import { ASSIGNABLE_ROLES, BASE_ROLES } from '@/types/base-role'
import type { GroupExtensionListProps } from '@/features/groups/extension-loader'
import type { GroupEntityMember } from '@/types/group'
import { ArrowUpDown, ChevronDown, ChevronUp } from 'lucide-react'
import { toast } from '@/hooks/use-toast'

export function DepartmentEntityList({
  groupName,
  canManage,
  refreshTrigger,
  userRole,
  onCountChange,
}: GroupExtensionListProps) {
  const { t } = useTranslation('groups')
  const [members, setMembers] = useState<GroupEntityMember[]>([])
  const [loading, setLoading] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [sortField, setSortField] = useState<'name' | 'role' | 'joinDate'>('name')
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc')
  const [isSavingRole, setIsSavingRole] = useState(false)

  const editableRoleOptions = userRole === 'Owner' ? BASE_ROLES : ASSIGNABLE_ROLES

  const filteredMembers = members.filter(m => {
    const query = searchQuery.trim().toLowerCase()
    if (!query) return true
    return (
      (m.entity_display_name || '').toLowerCase().includes(query) ||
      m.entity_id.toLowerCase().includes(query) ||
      (m.invited_by_user_name || '').toLowerCase().includes(query) ||
      m.role.toLowerCase().includes(query)
    )
  })

  const sortedMembers = [...filteredMembers].sort((a, b) => {
    let comparison = 0
    if (sortField === 'name') {
      const aName = (a.entity_display_name || a.entity_id).toLowerCase()
      const bName = (b.entity_display_name || b.entity_id).toLowerCase()
      comparison = aName.localeCompare(bName, undefined, { numeric: true, sensitivity: 'base' })
    } else if (sortField === 'role') {
      comparison = a.role.localeCompare(b.role)
    } else {
      comparison = new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    }
    return sortOrder === 'asc' ? comparison : -comparison
  })

  useEffect(() => {
    onCountChange?.(sortedMembers.length)
  }, [sortedMembers.length, onCountChange])

  const loadMembers = async () => {
    setLoading(true)
    try {
      const data = await listGroupEntityMembers(groupName)
      setMembers(data)
      onCountChange?.(data.length)
    } catch (err) {
      console.error('Failed to load entity members:', err)
      toast({
        variant: 'destructive',
        title: t('groups:groupMembers.loadMembersFailed'),
      })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadMembers()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupName, refreshTrigger])

  const handleRemove = async (entityType: string, entityId: string) => {
    if (!confirm(t('groups:groupMembers.confirmRemove'))) return

    try {
      await removeGroupEntityMember(groupName, entityType, entityId)
      setMembers(prev => {
        const updated = prev.filter(m => !(m.entity_type === entityType && m.entity_id === entityId))
        onCountChange?.(updated.length)
        return updated
      })
    } catch (err) {
      console.error('Failed to remove entity member:', err)
      toast({
        variant: 'destructive',
        title: t('groups:groupMembers.removeMemberFailed'),
      })
    }
  }

  const handleRoleChange = async (member: GroupEntityMember, newRole: string) => {
    if (newRole === member.role || isSavingRole) return

    setIsSavingRole(true)
    try {
      const updated = await groupPermissionExtensionApi.updateGroupEntityMemberRole(
        groupName,
        member.entity_type,
        member.entity_id,
        newRole
      )
      setMembers(prev =>
        prev.map(m =>
          m.entity_type === updated.entity_type && m.entity_id === updated.entity_id
            ? { ...m, role: updated.role }
            : m
        )
      )
    } catch (err) {
      console.error('Failed to update entity member role:', err)
      toast({
        variant: 'destructive',
        title: t('groups:groupMembers.updateRoleFailed'),
      })
    } finally {
      setIsSavingRole(false)
    }
  }

  const handleSort = (field: 'name' | 'role' | 'joinDate') => {
    if (sortField === field) {
      setSortOrder(current => (current === 'asc' ? 'desc' : 'asc'))
      return
    }
    setSortField(field)
    setSortOrder(field === 'joinDate' ? 'desc' : 'asc')
  }

  const SortIcon = ({ field }: { field: 'name' | 'role' | 'joinDate' }) => {
    if (sortField !== field) {
      return <ArrowUpDown className="ml-1 h-3.5 w-3.5 text-text-muted/80" />
    }
    return sortOrder === 'asc' ? (
      <ChevronUp className="ml-1 h-3.5 w-3.5 text-primary" />
    ) : (
      <ChevronDown className="ml-1 h-3.5 w-3.5 text-primary" />
    )
  }

  const getRoleBadgeVariant = (
    role: string
  ): 'default' | 'secondary' | 'success' | 'error' | 'warning' | 'info' => {
    switch (role) {
      case 'Owner':
        return 'error'
      case 'Maintainer':
        return 'default'
      case 'Developer':
        return 'secondary'
      case 'Reporter':
        return 'info'
      case 'RestrictedAnalyst':
        return 'warning'
      default:
        return 'info'
    }
  }

  if (loading && members.length === 0) {
    return <div className="text-center py-8 text-text-secondary">{t('common:actions.loading')}</div>
  }

  return (
    <div className="space-y-3">
      <div className="w-full md:max-w-xs">
        <Input
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          placeholder={t('groups:groupMembers.searchMembersPlaceholder')}
          disabled={loading}
          data-testid="department-entity-search-input"
        />
      </div>
      <div className="border border-border rounded-lg overflow-hidden">
        <div className="overflow-x-auto max-h-[400px]">
          <table className="w-full">
            <thead className="bg-muted border-b border-border sticky top-0">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-text-primary">
                  <button
                    type="button"
                    onClick={() => handleSort('name')}
                    className="inline-flex items-center text-left transition-colors hover:text-primary"
                  >
                    {t('knowledge:document.permission.orgDepartment')}
                    <SortIcon field="name" />
                  </button>
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-text-primary">
                  <button
                    type="button"
                    onClick={() => handleSort('role')}
                    className="inline-flex items-center text-left transition-colors hover:text-primary"
                  >
                    {t('groups:groups.role')}
                    <SortIcon field="role" />
                  </button>
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-text-primary">
                  {t('groups:groupMembers.invitedBy')}
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-text-primary">
                  <button
                    type="button"
                    onClick={() => handleSort('joinDate')}
                    className="inline-flex items-center text-left transition-colors hover:text-primary"
                  >
                    {t('groups:groupMembers.joinDate')}
                    <SortIcon field="joinDate" />
                  </button>
                </th>
                <th className="px-4 py-3 text-right text-xs font-medium text-text-primary">
                  {t('groups:groupMembers.actions')}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {sortedMembers.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-sm text-text-secondary">
                    {t('groups:groupMembers.noMembersFound')}
                  </td>
                </tr>
              )}
              {sortedMembers.map(member => (
                <tr key={`${member.entity_type}-${member.entity_id}`} className="hover:bg-surface">
                  <td className="px-4 py-3 text-sm font-medium text-text-primary">
                    {member.entity_display_name || member.entity_id}
                  </td>
                  <td className="px-4 py-3 text-sm">
                    {canManage ? (
                      <Select
                        value={member.role}
                        onValueChange={value => handleRoleChange(member, value)}
                        disabled={isSavingRole}
                      >
                        <SelectTrigger className="h-8 w-[180px]">
                          <SelectValue>
                            {t(`groups:groups.roles.${member.role}`)}
                          </SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          {editableRoleOptions.map(r => (
                            <SelectItem key={r} value={r}>
                              <div className="flex flex-col">
                                <span>{t(`groups:groups.roles.${r}`)}</span>
                                <span className="text-xs text-text-muted">
                                  {t(`groups:groupMembers.roleDescriptions.${r}`)}
                                </span>
                              </div>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <Badge variant={getRoleBadgeVariant(member.role)}>
                        {t(`groups:groups.roles.${member.role}`)}
                      </Badge>
                    )}
                  </td>
                  <td className="px-4 py-3 text-sm text-text-secondary">
                    {member.invited_by_user_name || '-'}
                  </td>
                  <td className="px-4 py-3 text-sm text-text-secondary">
                    {new Date(member.created_at).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-3 text-sm text-right">
                    {canManage && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleRemove(member.entity_type, member.entity_id)}
                        className="text-error hover:text-error"
                      >
                        {t('groups:groupMembers.remove')}
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
