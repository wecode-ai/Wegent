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
import { AddUserDialog } from './AddUserDialog'
import type {
  PermissionLevel,
  PendingPermissionInfo,
  PermissionUserInfo,
} from '@/types/knowledge'

interface PermissionManagementTabProps {
  kbId: number
}

export function PermissionManagementTab({ kbId }: PermissionManagementTabProps) {
  const { t } = useTranslation('knowledge')
  const [showAddUser, setShowAddUser] = useState(false)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editingLevel, setEditingLevel] = useState<PermissionLevel>('view')

  const {
    permissions,
    loading,
    error,
    fetchPermissions,
    reviewPermission,
    updatePermission,
    deletePermission,
    clearError,
  } = useKnowledgePermissions({ kbId })

  // Fetch permissions on mount
  useEffect(() => {
    fetchPermissions()
  }, [fetchPermissions])

  const handleApprove = async (
    permission: PendingPermissionInfo,
    level?: PermissionLevel
  ) => {
    try {
      await reviewPermission(permission.id, 'approve', level || permission.permission_level)
    } catch (_err) {
      // Error is handled by the hook
    }
  }

  const handleReject = async (permission: PendingPermissionInfo) => {
    try {
      await reviewPermission(permission.id, 'reject')
    } catch (_err) {
      // Error is handled by the hook
    }
  }

  const handleUpdateLevel = async (permissionId: number, level: PermissionLevel) => {
    try {
      await updatePermission(permissionId, level)
      setEditingId(null)
    } catch (_err) {
      // Error is handled by the hook
    }
  }

  const handleDelete = async (permissionId: number) => {
    if (!confirm(t('permission.confirmRemove'))) return
    try {
      await deletePermission(permissionId)
    } catch (_err) {
      // Error is handled by the hook
    }
  }

  const startEditing = (permission: PermissionUserInfo) => {
    setEditingId(permission.id)
    setEditingLevel(permission.permission_level)
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
    (permissions?.approved.view.length || 0) +
    (permissions?.approved.edit.length || 0) +
    (permissions?.approved.manage.length || 0)

  return (
    <div className="space-y-6 p-4">
      {/* Header with Add User button */}
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <Shield className="w-5 h-5" />
          {t('permission.management')}
        </h2>
        <Button variant="outline" size="sm" onClick={() => setShowAddUser(true)}>
          <UserPlus className="w-4 h-4 mr-2" />
          {t('permission.addUser')}
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
          {t('permission.pendingRequests')}
          {pendingCount > 0 && (
            <span className="bg-warning/10 text-warning px-2 py-0.5 rounded-full text-xs">
              {pendingCount}
            </span>
          )}
        </div>

        {pendingCount === 0 ? (
          <p className="text-sm text-text-muted py-4 text-center">
            {t('permission.noPendingRequests')}
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
                    {permission.email || t('permission.noEmail')}
                  </div>
                  <div className="text-xs text-text-muted mt-1">
                    {t('permission.requesting')}: {t(`permission.${permission.permission_level}`)}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Select
                    defaultValue={permission.permission_level}
                    onValueChange={value => handleApprove(permission, value as PermissionLevel)}
                  >
                    <SelectTrigger className="w-24 h-8">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="view">{t('permission.view')}</SelectItem>
                      <SelectItem value="edit">{t('permission.edit')}</SelectItem>
                      <SelectItem value="manage">{t('permission.manage')}</SelectItem>
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
          {t('permission.approvedUsers')}
          {approvedCount > 0 && (
            <span className="bg-primary/10 text-primary px-2 py-0.5 rounded-full text-xs">
              {approvedCount}
            </span>
          )}
        </div>

        {approvedCount === 0 ? (
          <p className="text-sm text-text-muted py-4 text-center">
            {t('permission.noApprovedUsers')}
          </p>
        ) : (
          <div className="space-y-4">
            {/* Manage permissions */}
            {(permissions?.approved.manage.length || 0) > 0 && (
              <PermissionGroup
                title={t('permission.manage')}
                users={permissions!.approved.manage}
                editingId={editingId}
                editingLevel={editingLevel}
                setEditingLevel={setEditingLevel}
                onStartEditing={startEditing}
                onCancelEditing={cancelEditing}
                onUpdateLevel={handleUpdateLevel}
                onDelete={handleDelete}
                loading={loading}
                t={t}
              />
            )}
            {/* Edit permissions */}
            {(permissions?.approved.edit.length || 0) > 0 && (
              <PermissionGroup
                title={t('permission.edit')}
                users={permissions!.approved.edit}
                editingId={editingId}
                editingLevel={editingLevel}
                setEditingLevel={setEditingLevel}
                onStartEditing={startEditing}
                onCancelEditing={cancelEditing}
                onUpdateLevel={handleUpdateLevel}
                onDelete={handleDelete}
                loading={loading}
                t={t}
              />
            )}
            {/* View permissions */}
            {(permissions?.approved.view.length || 0) > 0 && (
              <PermissionGroup
                title={t('permission.view')}
                users={permissions!.approved.view}
                editingId={editingId}
                editingLevel={editingLevel}
                setEditingLevel={setEditingLevel}
                onStartEditing={startEditing}
                onCancelEditing={cancelEditing}
                onUpdateLevel={handleUpdateLevel}
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
  editingLevel: PermissionLevel
  setEditingLevel: (level: PermissionLevel) => void
  onStartEditing: (user: PermissionUserInfo) => void
  onCancelEditing: () => void
  onUpdateLevel: (id: number, level: PermissionLevel) => void
  onDelete: (id: number) => void
  loading: boolean
  t: (key: string) => string
}

function PermissionGroup({
  title,
  users,
  editingId,
  editingLevel,
  setEditingLevel,
  onStartEditing,
  onCancelEditing,
  onUpdateLevel,
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
            className="flex items-center justify-between p-2 rounded-lg hover:bg-muted transition-colors"
          >
            <div className="flex-1 min-w-0">
              <div className="font-medium text-sm truncate">{user.username}</div>
              <div className="text-xs text-text-muted truncate">
                {user.email || t('permission.noEmail')}
              </div>
            </div>
            {editingId === user.id ? (
              <div className="flex items-center gap-2">
                <Select value={editingLevel} onValueChange={v => setEditingLevel(v as PermissionLevel)}>
                  <SelectTrigger className="w-24 h-8">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="view">{t('permission.view')}</SelectItem>
                    <SelectItem value="edit">{t('permission.edit')}</SelectItem>
                    <SelectItem value="manage">{t('permission.manage')}</SelectItem>
                  </SelectContent>
                </Select>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-success"
                  onClick={() => onUpdateLevel(user.id, editingLevel)}
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
                  title={t('permission.modify')}
                >
                  <Pencil className="w-3.5 h-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-error hover:text-error"
                  onClick={() => onDelete(user.id)}
                  title={t('permission.remove')}
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
