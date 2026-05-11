// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useState, useRef } from 'react'
import { Check, X, UserPlus, Pencil, Trash2, Clock, Shield, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
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
import { useKnowledgePermissions } from '../hooks/useKnowledgePermissions'
import { AddUserDialog } from './add-user-dialog'
import { knowledgePermissionApi } from '@/apis/knowledge-permission'
import { listGroups } from '@/apis/groups'
import { ASSIGNABLE_ROLES } from '@/types/base-role'
import type { MemberRole, PendingPermissionInfo, PermissionUserInfo } from '@/types/knowledge'
import type { Group } from '@/types/group'

interface PermissionManagementTabProps {
  kbId: number
  /**
   * Extension tabs rendered alongside standard tabs (个人/群组).
   * Used by internal deployments to add entity-type permission panels
   * (e.g., department-level permissions).
   */
  extensionTabs?: Array<{
    label: string
    icon?: React.ReactNode
    render: (props: { kbId: number }) => React.ReactNode
  }>
}

export function PermissionManagementTab({ kbId, extensionTabs }: PermissionManagementTabProps) {
  const { t } = useTranslation('knowledge')
  const [showAddUser, setShowAddUser] = useState(false)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editingRole, setEditingRole] = useState<MemberRole>('Reporter')
  const [activeTab, setActiveTab] = useState<string>('user')
  // Track selected approval roles for pending requests
  const [approvalRoles, setApprovalRoles] = useState<Record<number, MemberRole>>({})
  // Group tab state
  const [groups, setGroups] = useState<Group[]>([])
  const [fetchingGroups, setFetchingGroups] = useState(false)
  const [groupSearch, setGroupSearch] = useState('')
  const [showGroupDropdown, setShowGroupDropdown] = useState(false)
  const [addGroupRole, setAddGroupRole] = useState<MemberRole>('Reporter')
  const groupInputRef = useRef<HTMLInputElement>(null)
  const groupDropdownRef = useRef<HTMLDivElement>(null)

  const {
    permissions,
    loading,
    error,
    fetchPermissions,
    reviewPermission,
    updatePermission,
    deletePermission,
    clearError,
  } = useKnowledgePermissions({ kbId, includePendingRequests: true })

  // Fetch permissions on mount
  useEffect(() => {
    fetchPermissions()
  }, [fetchPermissions])

  // Initialize approval roles when pending requests change
  useEffect(() => {
    if (permissions?.pending) {
      setApprovalRoles(prev => {
        const additions: Record<number, MemberRole> = {}
        permissions.pending.forEach(p => {
          if (!(p.id in prev)) {
            additions[p.id] = p.role || 'Reporter'
          }
        })
        return Object.keys(additions).length ? { ...prev, ...additions } : prev
      })
    }
  }, [permissions?.pending])

  // Close group dropdown on outside click
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        groupDropdownRef.current &&
        !groupDropdownRef.current.contains(event.target as Node) &&
        groupInputRef.current &&
        !groupInputRef.current.contains(event.target as Node)
      ) {
        setShowGroupDropdown(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const fetchGroups = async () => {
    setFetchingGroups(true)
    try {
      const result = await listGroups({ limit: 200 })
      setGroups(result.items || [])
    } catch (_err) {
      // silently fail
    } finally {
      setFetchingGroups(false)
    }
  }

  const handleApprovalRoleChange = (permissionId: number, role: MemberRole) => {
    setApprovalRoles(prev => ({ ...prev, [permissionId]: role }))
  }

  const handleApprove = async (permission: PendingPermissionInfo) => {
    try {
      const role = approvalRoles[permission.id] || permission.role || 'Reporter'
      await reviewPermission(permission.id, 'approve', role)
    } catch (_err) {
      // Error is handled by the hook
    }
  }

  const handleUpdateRole = async (permissionId: number, role: MemberRole) => {
    try {
      await updatePermission(permissionId, role)
      setEditingId(null)
    } catch (_err) {
      // Error is handled by the hook
    }
  }

  const handleDelete = async (permissionId: number) => {
    if (!confirm(t('document.permission.confirmRemove'))) return
    try {
      await deletePermission(permissionId)
    } catch (_err) {
      // Error is handled by the hook
    }
  }

  const startEditing = (permission: PermissionUserInfo) => {
    setEditingId(permission.id)
    setEditingRole(permission.role || 'Reporter')
  }

  const handleReject = async (permission: PendingPermissionInfo) => {
    try {
      await reviewPermission(permission.id, 'reject')
    } catch (_err) {
      // Error is handled by the hook
    }
  }

  const cancelEditing = () => {
    setEditingId(null)
  }

  // Group tab handlers
  const handleAddGroup = async (groupId: number) => {
    try {
      await knowledgePermissionApi.addNamespacePermission(kbId, groupId, addGroupRole)
      setGroupSearch('')
      setShowGroupDropdown(false)
      await fetchPermissions()
    } catch (_err) {
      // Error is handled by the hook
    }
  }

  const handleDeleteNamespace = async (permissionId: number) => {
    if (!confirm(t('document.permission.confirmRemove'))) return
    try {
      await deletePermission(permissionId)
    } catch (_err) {
      // Error is handled by the hook
    }
  }

  if (loading && !permissions) {
    return (
      <div className="flex items-center justify-center py-12">
        <Spinner />
      </div>
    )
  }

  const pendingCount = permissions?.pending.length || 0

  // Separate namespace members from user members
  const allApproved = permissions?.approved
  const allUserMembers: PermissionUserInfo[] = allApproved
    ? Object.values(allApproved).flat().filter(m => !m.entity_type || m.entity_type === 'user')
    : []
  const namespaceMembers: PermissionUserInfo[] = allApproved
    ? Object.values(allApproved).flat().filter(m => m.entity_type === 'namespace')
    : []

  // Filter namespace members out of role groups for user display
  const filterNamespaceOut = (users: PermissionUserInfo[]) =>
    users.filter(u => !u.entity_type || u.entity_type === 'user')
  const userRoleGroups = allApproved
    ? {
        Owner: filterNamespaceOut(allApproved.Owner),
        Maintainer: filterNamespaceOut(allApproved.Maintainer),
        Developer: filterNamespaceOut(allApproved.Developer),
        Reporter: filterNamespaceOut(allApproved.Reporter),
        RestrictedAnalyst: filterNamespaceOut(allApproved.RestrictedAnalyst),
      }
    : null

  const approvedCount =
    (userRoleGroups?.Owner?.length || 0) +
    (userRoleGroups?.Maintainer?.length || 0) +
    (userRoleGroups?.Developer?.length || 0) +
    (userRoleGroups?.Reporter?.length || 0) +
    (userRoleGroups?.RestrictedAnalyst?.length || 0)

  const filteredGroups = groupSearch.trim()
    ? groups.filter(
        g =>
          (g.display_name || g.name)
            .toLowerCase()
            .includes(groupSearch.trim().toLowerCase())
      )
    : groups

  return (
    <div className="space-y-4 p-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <Shield className="w-5 h-5" />
          {t('document.permission.management')}
        </h2>
      </div>

      {/* Error Message */}
      {error && (
        <div className="bg-error/10 text-error px-4 py-2 rounded-lg text-sm flex justify-between items-center">
          <span>{error}</span>
          <button onClick={clearError} className="text-error/70 hover:text-error">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Tabs + Content */}
      <Card padding="default" className="space-y-4">
        {/* Tabs */}
        <div className="flex border-b border-border">
          <button
            type="button"
            onClick={() => setActiveTab('user')}
            className={`flex items-center gap-1.5 px-3 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === 'user'
                ? 'border-primary text-primary'
                : 'border-transparent text-text-muted hover:text-text-primary'
            }`}
            data-testid="perm-tab-user"
          >
            {t('document.permission.individual') || '个人'}
            {approvedCount > 0 && (
              <span className="bg-primary/10 text-primary px-1.5 py-0.5 rounded-full text-xs">
                {approvedCount}
              </span>
            )}
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('namespace')}
            className={`flex items-center gap-1.5 px-3 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === 'namespace'
                ? 'border-primary text-primary'
                : 'border-transparent text-text-muted hover:text-text-primary'
            }`}
            data-testid="perm-tab-namespace"
          >
            {t('document.permission.namespace') || '群组'}
            {namespaceMembers.length > 0 && (
              <span className="bg-primary/10 text-primary px-1.5 py-0.5 rounded-full text-xs">
                {namespaceMembers.length}
              </span>
            )}
          </button>
          {/* Extension tabs */}
          {extensionTabs?.map((tab, index) => {
            const tabValue = `ext-${index}`
            return (
              <button
                key={tabValue}
                type="button"
                onClick={() => setActiveTab(tabValue)}
                className={`flex items-center gap-1.5 px-3 py-2 text-sm font-medium border-b-2 transition-colors ${
                  activeTab === tabValue
                    ? 'border-primary text-primary'
                    : 'border-transparent text-text-muted hover:text-text-primary'
                }`}
              >
                {tab.icon && <span className="w-4 h-4">{tab.icon}</span>}
                {tab.label}
              </button>
            )
          })}
        </div>

        {/* ===== 个人 Tab ===== */}
        {activeTab === 'user' && (
          <div className="space-y-4">
            {/* Pending Requests */}
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Clock className="w-4 h-4 text-warning" />
                {t('document.permission.pendingRequests')}
                {pendingCount > 0 && (
                  <span className="bg-warning/10 text-warning px-2 py-0.5 rounded-full text-xs">
                    {pendingCount}
                  </span>
                )}
              </div>

              {pendingCount === 0 ? (
                <p className="text-sm text-text-muted py-2 text-center">
                  {t('document.permission.noPendingRequests')}
                </p>
              ) : (
                <div className="space-y-2">
                  {permissions?.pending.map(permission => (
                    <div
                      key={permission.id}
                      className="flex items-center justify-between p-3 bg-muted rounded-lg"
                    >
                      <div className="flex-1">
                        <div className="font-medium text-sm">{permission.username}</div>
                        <div className="text-xs text-text-muted">
                          {permission.email || t('document.permission.noEmail')}
                        </div>
                        <div className="text-xs text-text-muted mt-1">
                          {t('document.permission.requesting')}:{' '}
                          {permission.role
                            ? t(`document.permission.role.${permission.role}`)
                            : t('document.permission.role.Reporter')}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Select
                          value={approvalRoles[permission.id] || permission.role || 'Reporter'}
                          onValueChange={value =>
                            handleApprovalRoleChange(permission.id, value as MemberRole)
                          }
                        >
                          <SelectTrigger className="w-28 h-11 min-w-[44px]">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {ASSIGNABLE_ROLES.map(role => (
                              <SelectItem key={role} value={role}>
                                {t(`document.permission.role.${role}`)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-success hover:text-success hover:bg-success/10"
                          onClick={() => handleApprove(permission)}
                          disabled={loading}
                        >
                          <Check className="w-4 h-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-error hover:text-error hover:bg-error/10"
                          onClick={() => handleReject(permission)}
                          disabled={loading}
                        >
                          <X className="w-4 h-4" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Approved Users by Role */}
            <div>
              {approvedCount === 0 ? (
                <p className="text-sm text-text-muted py-4 text-center">
                  {t('document.permission.noApprovedUsers')}
                </p>
              ) : (
                <div className="space-y-4">
                  {(userRoleGroups?.Owner?.length || 0) > 0 && (
                    <PermissionGroup
                      title={t('document.permission.role.Owner')}
                      users={userRoleGroups!.Owner}
                      editingId={editingId}
                      editingRole={editingRole}
                      setEditingRole={setEditingRole}
                      onStartEditing={startEditing}
                      onCancelEditing={cancelEditing}
                      onUpdateRole={handleUpdateRole}
                      onDelete={handleDelete}
                      loading={loading}
                      t={t}
                    />
                  )}
                  {(userRoleGroups?.Maintainer?.length || 0) > 0 && (
                    <PermissionGroup
                      title={t('document.permission.role.Maintainer')}
                      users={userRoleGroups!.Maintainer}
                      editingId={editingId}
                      editingRole={editingRole}
                      setEditingRole={setEditingRole}
                      onStartEditing={startEditing}
                      onCancelEditing={cancelEditing}
                      onUpdateRole={handleUpdateRole}
                      onDelete={handleDelete}
                      loading={loading}
                      t={t}
                    />
                  )}
                  {(userRoleGroups?.Developer?.length || 0) > 0 && (
                    <PermissionGroup
                      title={t('document.permission.role.Developer')}
                      users={userRoleGroups!.Developer}
                      editingId={editingId}
                      editingRole={editingRole}
                      setEditingRole={setEditingRole}
                      onStartEditing={startEditing}
                      onCancelEditing={cancelEditing}
                      onUpdateRole={handleUpdateRole}
                      onDelete={handleDelete}
                      loading={loading}
                      t={t}
                    />
                  )}
                  {(userRoleGroups?.Reporter?.length || 0) > 0 && (
                    <PermissionGroup
                      title={t('document.permission.role.Reporter')}
                      users={userRoleGroups!.Reporter}
                      editingId={editingId}
                      editingRole={editingRole}
                      setEditingRole={setEditingRole}
                      onStartEditing={startEditing}
                      onCancelEditing={cancelEditing}
                      onUpdateRole={handleUpdateRole}
                      onDelete={handleDelete}
                      loading={loading}
                      t={t}
                    />
                  )}
                  {(userRoleGroups?.RestrictedAnalyst?.length || 0) > 0 && (
                    <PermissionGroup
                      title={t('document.permission.role.RestrictedAnalyst')}
                      users={userRoleGroups!.RestrictedAnalyst}
                      editingId={editingId}
                      editingRole={editingRole}
                      setEditingRole={setEditingRole}
                      onStartEditing={startEditing}
                      onCancelEditing={cancelEditing}
                      onUpdateRole={handleUpdateRole}
                      onDelete={handleDelete}
                      loading={loading}
                      t={t}
                    />
                  )}
                </div>
              )}
            </div>

            {/* Add User Button */}
            <div className="flex justify-start">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowAddUser(true)}
              >
                <UserPlus className="w-4 h-4 mr-2" />
                {t('document.permission.addUser')}
              </Button>
            </div>
          </div>
        )}

        {/* ===== 群组 Tab ===== */}
        {activeTab === 'namespace' && (
          <div className="space-y-4">
            {/* Add Group - Search + Role + Add */}
            <div className="flex items-start gap-2">
              <div className="flex-1 relative">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-text-muted" />
                  <Input
                    ref={groupInputRef}
                    value={groupSearch}
                    onChange={e => {
                      setGroupSearch(e.target.value)
                      if (!fetchingGroups) fetchGroups()
                      setShowGroupDropdown(true)
                    }}
                    onFocus={() => {
                      if (!fetchingGroups && groups.length === 0) fetchGroups()
                      setShowGroupDropdown(true)
                    }}
                    placeholder={t('document.permission.searchGroupPlaceholder') || '搜索群组...'}
                    className="pl-9"
                  />
                </div>
                {showGroupDropdown && (
                  <div
                    ref={groupDropdownRef}
                    className="absolute z-50 w-full mt-1 bg-base border border-border rounded-md shadow-lg max-h-48 overflow-y-auto"
                  >
                    {fetchingGroups ? (
                      <div className="flex items-center justify-center p-3">
                        <Spinner className="w-4 h-4" />
                      </div>
                    ) : filteredGroups.length === 0 ? (
                      <div className="p-3 text-sm text-text-muted text-center">
                        {groupSearch.trim()
                          ? (t('common:userSearch.noResults') || '未找到结果')
                          : (t('document.permission.noGroups') || '暂无群组')}
                      </div>
                    ) : (
                      filteredGroups.map(group => (
                        <button
                          key={group.id}
                          type="button"
                          onClick={() => {
                            handleAddGroup(group.id as number)
                          }}
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
              <div className="flex-shrink-0">
                <Select value={addGroupRole} onValueChange={v => setAddGroupRole(v as MemberRole)}>
                  <SelectTrigger className="w-28 h-11 min-w-[44px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ASSIGNABLE_ROLES.map(role => (
                      <SelectItem key={role} value={role}>
                        {t(`document.permission.role.${role}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* Added Groups List */}
            {namespaceMembers.length === 0 ? (
              <p className="text-sm text-text-muted py-4 text-center">
                {t('document.permission.noNamespacePermissions') || '暂无群组权限'}
              </p>
            ) : (
              <div className="space-y-1">
                {namespaceMembers.map(nm => (
                  <div
                    key={nm.id}
                    className="group flex items-center justify-between p-2 rounded-lg hover:bg-muted transition-colors"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-sm truncate flex items-center gap-2">
                        {nm.username || nm.entity_id || ''}
                        <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-surface text-text-muted border-border border">
                          {t('document.permission.namespace') || '群组'}
                        </span>
                      </div>
                      <div className="text-xs text-text-muted truncate">
                        {t(`document.permission.role.${nm.role}`)}
                      </div>
                    </div>
                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-error hover:text-error"
                        onClick={() => handleDeleteNamespace(nm.id)}
                        title={t('document.permission.remove')}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ===== Extension Tab Content ===== */}
        {extensionTabs?.map((tab, index) => {
          const tabValue = `ext-${index}`
          return activeTab === tabValue ? (
            <div key={tabValue}>
              {tab.render({ kbId })}
            </div>
          ) : null
        })}
      </Card>

      {/* Add User Dialog */}
      <AddUserDialog
        open={showAddUser}
        onOpenChange={setShowAddUser}
        kbId={kbId}
        onSuccess={fetchPermissions}
      />
    </div>
  )
}

// Permission Group Component
interface PermissionGroupProps {
  title: string
  users: PermissionUserInfo[]
  editingId: number | null
  editingRole: MemberRole
  setEditingRole: (role: MemberRole) => void
  onStartEditing: (user: PermissionUserInfo) => void
  onCancelEditing: () => void
  onUpdateRole: (id: number, role: MemberRole) => void
  onDelete: (id: number) => void
  loading: boolean
  t: (key: string) => string
}

function PermissionGroup({
  title,
  users,
  editingId,
  editingRole,
  setEditingRole,
  onStartEditing,
  onCancelEditing,
  onUpdateRole,
  onDelete,
  loading,
  t,
}: PermissionGroupProps) {
  return (
    <div>
      <div className="text-xs font-medium text-text-muted mb-2">{title}</div>
      <div className="space-y-1">
        {users.map(user => (
          <div
            key={user.id}
            className="group flex items-center justify-between p-2 rounded-lg hover:bg-muted transition-colors"
          >
            <div className="flex-1 min-w-0">
              <div className="font-medium text-sm truncate flex items-center gap-2">
                {user.username}
                {user.entity_type && user.entity_type !== 'user' && (
                  <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-surface text-text-muted border-border border">
                    {user.entity_type === 'namespace' ? '群组' : user.entity_type}
                  </span>
                )}
              </div>
              <div className="text-xs text-text-muted truncate">
                {user.email || (user.entity_type && user.entity_type !== 'user' ? user.entity_id || '' : t('document.permission.noEmail'))}
              </div>
            </div>
            {editingId === user.id ? (
              <div className="flex items-center gap-2">
                <Select value={editingRole} onValueChange={v => setEditingRole(v as MemberRole)}>
                  <SelectTrigger className="w-28 h-11 min-w-[44px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ASSIGNABLE_ROLES.map(role => (
                      <SelectItem key={role} value={role}>
                        {t(`document.permission.role.${role}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-success"
                  onClick={() => onUpdateRole(user.id, editingRole)}
                  disabled={loading}
                >
                  <Check className="w-3.5 h-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={onCancelEditing}
                  disabled={loading}
                >
                  <X className="w-3.5 h-3.5" />
                </Button>
              </div>
            ) : (
              <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 hover:opacity-100">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={() => onStartEditing(user)}
                  title={t('document.permission.modify')}
                >
                  <Pencil className="w-3.5 h-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-error hover:text-error"
                  onClick={() => onDelete(user.id)}
                  title={t('document.permission.remove')}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </Button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
