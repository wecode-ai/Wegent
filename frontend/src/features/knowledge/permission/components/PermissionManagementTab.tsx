// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useState } from 'react'
import { Check, X, UserPlus, Pencil, Trash2, Users, Clock, Shield } from 'lucide-react'
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
import type { MemberRole, PendingPermissionInfo, PermissionUserInfo } from '@/types/knowledge'
import { ASSIGNABLE_ROLES } from '@/types/base-role'

interface PermissionManagementTabProps {
  kbId: number
}

export function PermissionManagementTab({ kbId }: PermissionManagementTabProps) {
  const { t } = useTranslation('knowledge')
  const [showAddUser, setShowAddUser] = useState(false)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editingRole, setEditingRole] = useState<MemberRole>('Reporter')
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

  if (loading && !permissions) {
    return (
      <div className="flex items-center justify-center py-12">
        <Spinner />
      </div>
    )
  }

  const pendingCount = permissions?.pending.length || 0
  const approvedCount =
    (permissions?.approved.Owner?.length || 0) +
    (permissions?.approved.Maintainer?.length || 0) +
    (permissions?.approved.Developer?.length || 0) +
    (permissions?.approved.Reporter?.length || 0) +
    (permissions?.approved.RestrictedAnalyst?.length || 0)

  return (
    <div className="space-y-6 p-4">
      {/* Header with Add User button */}
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <Shield className="w-5 h-5" />
          {t('document.permission.management')}
        </h2>
        <Button variant="outline" size="sm" onClick={() => setShowAddUser(true)}>
          <UserPlus className="w-4 h-4 mr-2" />
          {t('document.permission.addUser')}
        </Button>
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
      </Card>

      {/* Approved Users Section */}
      <Card padding="default" className="space-y-4">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Users className="w-4 h-4 text-primary" />
          {t('document.permission.approvedUsers')}
          {approvedCount > 0 && (
            <span className="bg-primary/10 text-primary px-2 py-0.5 rounded-full text-xs">
              {approvedCount}
            </span>
          )}
        </div>

        {approvedCount === 0 ? (
          <p className="text-sm text-text-muted py-4 text-center">
            {t('document.permission.noApprovedUsers')}
          </p>
        ) : (
          <div className="space-y-4">
            {/* Owner permissions */}
            {(permissions?.approved.Owner?.length || 0) > 0 && (
              <PermissionGroup
                title={t('document.permission.role.Owner')}
                users={permissions!.approved.Owner}
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
            {/* Maintainer permissions */}
            {(permissions?.approved.Maintainer?.length || 0) > 0 && (
              <PermissionGroup
                title={t('document.permission.role.Maintainer')}
                users={permissions!.approved.Maintainer}
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
            {/* Developer permissions */}
            {(permissions?.approved.Developer?.length || 0) > 0 && (
              <PermissionGroup
                title={t('document.permission.role.Developer')}
                users={permissions!.approved.Developer}
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
            {/* Reporter permissions */}
            {(permissions?.approved.Reporter?.length || 0) > 0 && (
              <PermissionGroup
                title={t('document.permission.role.Reporter')}
                users={permissions!.approved.Reporter}
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
            {/* RestrictedAnalyst permissions */}
            {(permissions?.approved.RestrictedAnalyst?.length || 0) > 0 && (
              <PermissionGroup
                title={t('document.permission.role.RestrictedAnalyst')}
                users={permissions!.approved.RestrictedAnalyst}
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
              <div className="font-medium text-sm truncate">{user.username}</div>
              <div className="text-xs text-text-muted truncate">
                {user.email || t('document.permission.noEmail')}
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
