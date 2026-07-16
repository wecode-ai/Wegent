// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useState } from 'react'
import { Check, X, UserPlus, Pencil, Trash2, User, Users, Clock } from 'lucide-react'

import { getPermissionTabs, subscribePermissionTabs } from '../permission-tab-registry'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Spinner } from '@/components/ui/spinner'
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
import { AddNamespaceDialog } from './add-namespace-dialog'
import { ASSIGNABLE_ROLES } from '@/types/base-role'
import type {
  MemberRole,
  PendingPermissionInfo,
  PermissionUserInfo,
  ApprovedPermissionsByRole,
} from '@/types/knowledge'

/**
 * Build role-grouped members by applying a filter to each role list.
 */
function buildRoleGroups(
  approved: ApprovedPermissionsByRole,
  filter: (user: PermissionUserInfo) => boolean
): ApprovedPermissionsByRole {
  return {
    Owner: approved.Owner.filter(filter),
    Maintainer: approved.Maintainer.filter(filter),
    Developer: approved.Developer.filter(filter),
    Reporter: approved.Reporter.filter(filter),
    RestrictedAnalyst: approved.RestrictedAnalyst.filter(filter),
  }
}

interface PermissionManagementTabProps {
  kbId: number
  /** The namespace this KB belongs to; groups in this namespace are excluded from group authorization */
  kbNamespace?: string
  /**
   * Extension tabs rendered alongside standard tabs (Personal/Groups).
   * Used by internal deployments to add entity-type permission panels.
   */
  extensionTabs?: Array<{
    label: string
    icon?: React.ReactNode
    render: (props: { kbId: number }) => React.ReactNode
  }>
}

export function PermissionManagementTab({
  kbId,
  kbNamespace,
  extensionTabs,
}: PermissionManagementTabProps) {
  const { t } = useTranslation('knowledge')

  // Safe translation helper that falls back when key is not found
  const loc = (key: string, fallback: string) => {
    const v = t(key)
    return v && v !== key ? v : fallback
  }

  const [showAddUser, setShowAddUser] = useState(false)
  const [showAddNamespace, setShowAddNamespace] = useState(false)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editingRole, setEditingRole] = useState<MemberRole>('Reporter')
  const [activeTab, setActiveTab] = useState<string>('user')
  // Track selected approval roles for pending requests
  const [approvalRoles, setApprovalRoles] = useState<Record<number, MemberRole>>({})

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

  // Load optional KB extensions (e.g., org_department in internal builds)
  useEffect(() => {
    import('../../document/extension-loader').then(({ loadKBExtensions }) => {
      loadKBExtensions().catch((err: unknown) => {
        console.warn('Failed to load KB extensions:', err)
      })
    })
  }, [])

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

  // Track registered external permission tabs (must be before any early return)
  const [externalTabs, setExternalTabs] = useState(getPermissionTabs)
  useEffect(() => {
    return subscribePermissionTabs(() => setExternalTabs(getPermissionTabs()))
  }, [])

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

  // Filter namespace members into role groups for group display — must be before namespaceGroupCount
  const filterNamespaceIn = (users: PermissionUserInfo[]) =>
    users.filter(u => u.entity_type === 'namespace')
  const namespaceRoleGroups = allApproved
    ? {
        Owner: filterNamespaceIn(allApproved.Owner),
        Maintainer: filterNamespaceIn(allApproved.Maintainer),
        Developer: filterNamespaceIn(allApproved.Developer),
        Reporter: filterNamespaceIn(allApproved.Reporter),
        RestrictedAnalyst: filterNamespaceIn(allApproved.RestrictedAnalyst),
      }
    : null

  const namespaceGroupCount = namespaceRoleGroups
    ? Object.values(namespaceRoleGroups).reduce((sum, arr) => sum + arr.length, 0)
    : 0

  const boundNamespaceIds = namespaceRoleGroups
    ? Array.from(
        new Set(
          Object.values(namespaceRoleGroups)
            .flat()
            .map(m => m.entity_id)
            .filter((id): id is string => !!id)
        )
      )
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

  // Compute role groups for registered external permission tabs
  const externalRoleGroups: Record<string, ReturnType<typeof buildRoleGroups>> = {}
  if (allApproved) {
    for (const tab of externalTabs) {
      externalRoleGroups[tab.type] = buildRoleGroups(allApproved, tab.filter)
    }
  }

  return (
    <div className="space-y-6 p-4">
      {/* Error Message */}
      {error && (
        <div className="bg-error/10 text-error px-4 py-2 rounded-lg text-sm flex justify-between items-center">
          <span>{error}</span>
          <button onClick={clearError} className="text-error/70 hover:text-error">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

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
          <User className="w-4 h-4" />
          {loc('document.permission.individual', '个人')}
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
          <Users className="w-4 h-4" />
          {loc('document.permission.namespace', '群组')}
          {namespaceGroupCount > 0 && (
            <span className="bg-primary/10 text-primary px-1.5 py-0.5 rounded-full text-xs">
              {namespaceGroupCount}
            </span>
          )}
        </button>
        {/* Extension tabs (prop) */}
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
        {/* Registered external permission tabs */}
        {externalTabs.map(tab => {
          const tabValue = `ext-reg-${tab.type}`
          const tabGroups = externalRoleGroups[tab.type]
          const tabCount = tabGroups
            ? Object.values(tabGroups).reduce((sum, arr) => sum + arr.length, 0)
            : 0
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
              {loc(tab.labelKey, tab.label || tab.type)}
              {tabCount > 0 && (
                <span className="bg-primary/10 text-primary px-1.5 py-0.5 rounded-full text-xs">
                  {tabCount}
                </span>
              )}
            </button>
          )
        })}
      </div>

      {/* ===== User Tab ===== */}
      {activeTab === 'user' && (
        <div className="space-y-4">
          {/* Pending Requests Section */}
          <Card padding="default" className="space-y-4">
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
              <p className="text-sm text-text-muted py-4 text-center">
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
                        className="h-11 min-w-[44px] text-success hover:text-success hover:bg-success/10"
                        onClick={() => handleApprove(permission)}
                        disabled={loading}
                      >
                        <Check className="w-4 h-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-11 min-w-[44px] text-error hover:text-error hover:bg-error/10"
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
          </Card>

          {/* Approved Users Section */}
          <Card padding="default" className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Users className="w-4 h-4 text-primary" />
                {t('document.permission.approvedUsers')}
                {approvedCount > 0 && (
                  <span className="bg-primary/10 text-primary px-1.5 py-0.5 rounded-full text-xs">
                    {approvedCount}
                  </span>
                )}
              </div>
              <Button variant="outline" size="sm" onClick={() => setShowAddUser(true)}>
                <UserPlus className="w-4 h-4 mr-2" />
                {loc('document.permission.addUser', '添加用户')}
              </Button>
            </div>

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
          </Card>
        </div>
      )}

      {/* ===== Group Tab ===== */}
      {activeTab === 'namespace' && (
        <div className="space-y-4">
          <Card padding="default" className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Users className="w-4 h-4 text-primary" />
                {loc('document.permission.namespaceMembers', '群组')}
                {namespaceGroupCount > 0 && (
                  <span className="bg-primary/10 text-primary px-1.5 py-0.5 rounded-full text-xs">
                    {namespaceGroupCount}
                  </span>
                )}
              </div>
              <Button variant="outline" size="sm" onClick={() => setShowAddNamespace(true)}>
                <UserPlus className="w-4 h-4 mr-2" />
                {loc('document.permission.addNamespace', '添加群组')}
              </Button>
            </div>

            {namespaceGroupCount === 0 ? (
              <p className="text-sm text-text-muted py-4 text-center">
                {loc('document.permission.noNamespacePermissions', '暂无群组权限')}
              </p>
            ) : (
              <div className="space-y-4">
                {(namespaceRoleGroups?.Owner?.length || 0) > 0 && (
                  <PermissionGroup
                    title={t('document.permission.role.Owner')}
                    users={namespaceRoleGroups!.Owner}
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
                {(namespaceRoleGroups?.Maintainer?.length || 0) > 0 && (
                  <PermissionGroup
                    title={t('document.permission.role.Maintainer')}
                    users={namespaceRoleGroups!.Maintainer}
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
                {(namespaceRoleGroups?.Developer?.length || 0) > 0 && (
                  <PermissionGroup
                    title={t('document.permission.role.Developer')}
                    users={namespaceRoleGroups!.Developer}
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
                {(namespaceRoleGroups?.Reporter?.length || 0) > 0 && (
                  <PermissionGroup
                    title={t('document.permission.role.Reporter')}
                    users={namespaceRoleGroups!.Reporter}
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
                {(namespaceRoleGroups?.RestrictedAnalyst?.length || 0) > 0 && (
                  <PermissionGroup
                    title={t('document.permission.role.RestrictedAnalyst')}
                    users={namespaceRoleGroups!.RestrictedAnalyst}
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
          </Card>
        </div>
      )}

      {/* ===== Extension Tab Content (prop) ===== */}
      {extensionTabs?.map((tab, index) => {
        const tabValue = `ext-${index}`
        return activeTab === tabValue ? <div key={tabValue}>{tab.render({ kbId })}</div> : null
      })}

      {/* ===== Registered External Tab Content ===== */}
      {externalTabs.map(tab => {
        const tabValue = `ext-reg-${tab.type}`
        const tabGroups = externalRoleGroups[tab.type]
        const tabCount = tabGroups
          ? Object.values(tabGroups).reduce((sum, arr) => sum + arr.length, 0)
          : 0
        return activeTab === tabValue ? (
          <div key={tabValue} className="space-y-4">
            <Card padding="default" className="space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-sm font-medium">
                  {tab.icon}
                  {loc(tab.labelKey, tab.label || tab.type)}
                </div>
                {tab.renderAddButton && tab.renderAddButton({ kbId, onSuccess: fetchPermissions })}
              </div>
              {tabCount === 0 ? (
                <p className="text-sm text-text-muted py-4 text-center">
                  {loc('document.permission.noApprovedUsers', '暂无已授权用户')}
                </p>
              ) : (
                <div className="space-y-4">
                  {(tabGroups?.Owner?.length || 0) > 0 && (
                    <PermissionGroup
                      title={t('document.permission.role.Owner')}
                      users={tabGroups!.Owner}
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
                  {(tabGroups?.Maintainer?.length || 0) > 0 && (
                    <PermissionGroup
                      title={t('document.permission.role.Maintainer')}
                      users={tabGroups!.Maintainer}
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
                  {(tabGroups?.Developer?.length || 0) > 0 && (
                    <PermissionGroup
                      title={t('document.permission.role.Developer')}
                      users={tabGroups!.Developer}
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
                  {(tabGroups?.Reporter?.length || 0) > 0 && (
                    <PermissionGroup
                      title={t('document.permission.role.Reporter')}
                      users={tabGroups!.Reporter}
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
                  {(tabGroups?.RestrictedAnalyst?.length || 0) > 0 && (
                    <PermissionGroup
                      title={t('document.permission.role.RestrictedAnalyst')}
                      users={tabGroups!.RestrictedAnalyst}
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
            </Card>
          </div>
        ) : null
      })}

      {/* Add User Dialog */}
      <AddUserDialog
        open={showAddUser}
        onOpenChange={setShowAddUser}
        kbId={kbId}
        onSuccess={fetchPermissions}
      />

      {/* Add Namespace Dialog */}
      <AddNamespaceDialog
        open={showAddNamespace}
        onOpenChange={setShowAddNamespace}
        kbId={kbId}
        onSuccess={fetchPermissions}
        excludedNamespaceId={kbNamespace}
        boundNamespaceIds={boundNamespaceIds}
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

export function PermissionGroup({
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
              <div className="font-medium text-sm truncate">{user.display_name}</div>
              {user.email && <div className="text-xs text-text-muted truncate">{user.email}</div>}
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
                  className="h-11 min-w-[44px] text-success"
                  onClick={() => onUpdateRole(user.id, editingRole)}
                  disabled={loading}
                >
                  <Check className="w-3.5 h-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-11 min-w-[44px]"
                  onClick={onCancelEditing}
                  disabled={loading}
                >
                  <X className="w-3.5 h-3.5" />
                </Button>
              </div>
            ) : (
              <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-within:opacity-100">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-11 min-w-[44px]"
                  onClick={() => onStartEditing(user)}
                  title={t('document.permission.modify')}
                >
                  <Pencil className="w-3.5 h-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-11 min-w-[44px] text-error hover:text-error"
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
