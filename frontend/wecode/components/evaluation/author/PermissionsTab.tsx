// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useCallback, useEffect } from 'react'
import { Plus, Trash2, Users, Shield, UserCheck, UserCog, Calendar } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'
import { UserSearchSelect } from '@/components/common/UserSearchSelect'
import {
  listAuthorPermissions,
  grantAuthorPermission,
  revokeAuthorPermission,
} from '@wecode/api/evaluation-author'
import { PermissionRole, type Permission, getRoleLabel } from '@wecode/types/evaluation'
import type { SearchUser } from '@/types/api'

/**
 * Props for the PermissionsTab component
 */
interface PermissionsTabProps {
  /** Topic ID */
  topicId: number
}

const PERMISSIONS_PER_PAGE = 20

/**
 * Get the appropriate icon based on role
 */
function getRoleIcon(role: string) {
  switch (role) {
    case PermissionRole.GRADER:
      return <Shield className="w-3.5 h-3.5" />
    case PermissionRole.QUESTION_CREATOR:
      return <UserCog className="w-3.5 h-3.5" />
    case PermissionRole.RESPONDENT:
    default:
      return <UserCheck className="w-3.5 h-3.5" />
  }
}

/**
 * Get the badge variant based on role
 */
function getRoleBadgeVariant(role: string): 'default' | 'secondary' | 'success' | 'warning' {
  switch (role) {
    case PermissionRole.GRADER:
      return 'success'
    case PermissionRole.QUESTION_CREATOR:
      return 'warning'
    case PermissionRole.RESPONDENT:
    default:
      return 'secondary'
  }
}

/**
 * Get user initials from name
 */
function getUserInitials(name: string): string {
  if (!name) return '?'
  const parts = name.split(' ')
  if (parts.length >= 2) {
    return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase()
  }
  return name.slice(0, 2).toUpperCase()
}

/**
 * Generate a consistent color for user avatar based on user ID
 */
function getAvatarColor(userId: number): string {
  const colors = [
    'bg-blue-500',
    'bg-green-500',
    'bg-purple-500',
    'bg-pink-500',
    'bg-indigo-500',
    'bg-teal-500',
    'bg-orange-500',
    'bg-cyan-500',
  ]
  return colors[userId % colors.length]
}

/**
 * Empty state component when no permissions exist
 */
function EmptyState({ onAddUser }: { onAddUser: () => void }) {
  const { t } = useTranslation('evaluation')

  const handleClick = () => {
    onAddUser()
  }

  return (
    <div className="bg-white rounded-2xl border border-gray-100 border-dashed p-12 text-center">
      <div className="w-16 h-16 rounded-2xl bg-gray-50 flex items-center justify-center mx-auto mb-4">
        <Users className="w-8 h-8 text-gray-400" />
      </div>
      <h3 className="text-lg font-semibold text-gray-900 mb-2">
        {t('permissions.no_permissions')}
      </h3>
      <p className="text-sm text-gray-500 mb-6 max-w-sm mx-auto">
        {t('permissions.no_permissions_description')}
      </p>
      <Button onClick={handleClick} className="bg-[#DF2029] hover:bg-[#c81d25] text-white">
        <Plus className="w-4 h-4 mr-2" />
        {t('permissions.add')}
      </Button>
    </div>
  )
}

/**
 * Loading skeleton for permissions list
 */
function PermissionsListSkeleton() {
  return (
    <div className="space-y-4">
      {[1, 2, 3].map(i => (
        <div key={i} className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
          <div className="flex items-center gap-4">
            <Skeleton className="w-12 h-12 rounded-full shrink-0" />
            <div className="flex-1 space-y-2">
              <div className="flex items-center justify-between">
                <Skeleton className="h-5 w-48" />
                <Skeleton className="h-6 w-24" />
              </div>
              <Skeleton className="h-4 w-64" />
            </div>
            <Skeleton className="h-8 w-8 rounded-lg shrink-0" />
          </div>
        </div>
      ))}
    </div>
  )
}

/**
 * PermissionCard - Individual permission card component
 *
 * Features:
 * - User avatar with initials
 * - User name and email
 * - Role badge with appropriate color
 * - Granted date
 * - Delete action with confirmation
 *
 * Design:
 * - White rounded-2xl card with border
 * - Hover effects: shadow and slight translate
 */
interface PermissionCardProps {
  /** The permission data to display */
  permission: Permission
  /** Callback when delete is clicked */
  onDelete: (permission: Permission) => void
}

function PermissionCard({ permission, onDelete }: PermissionCardProps) {
  const { t } = useTranslation('evaluation')
  const userInitials = getUserInitials(permission.user_name || '')
  const avatarColor = getAvatarColor(permission.user_id)

  return (
    <div
      className="
        bg-white rounded-2xl border border-gray-100 shadow-sm
        hover:shadow-md hover:-translate-y-[2px]
        transition-all duration-250
        p-5
      "
    >
      <div className="flex items-center gap-4">
        {/* User Avatar */}
        <div
          className={`
            shrink-0 w-12 h-12 rounded-full
            ${avatarColor}
            flex items-center justify-center
            text-white font-semibold text-sm
          `}
        >
          {userInitials}
        </div>

        {/* User Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-3">
            <div className="flex-1 min-w-0">
              <h3 className="text-base font-semibold text-gray-900 truncate">
                {permission.user_name || `User #${permission.user_id}`}
              </h3>
              {permission.user_email && (
                <p className="text-sm text-gray-500 truncate">{permission.user_email}</p>
              )}
            </div>

            {/* Role Badge */}
            <Badge
              variant={getRoleBadgeVariant(permission.role)}
              className="flex items-center gap-1 text-xs shrink-0"
            >
              {getRoleIcon(permission.role)}
              <span>
                {t(`permissions.roles.${permission.role}`) || getRoleLabel(permission.role)}
              </span>
            </Badge>
          </div>

          {/* Meta info */}
          <div className="flex items-center gap-4 mt-2 text-xs text-gray-400">
            <span className="flex items-center gap-1">
              <Calendar className="w-3 h-3" />
              {t('permissions.granted_at')} {new Date(permission.granted_at).toLocaleDateString()}
            </span>
          </div>
        </div>

        {/* Delete Action */}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onDelete(permission)}
          className="h-8 w-8 p-0 text-gray-400 hover:text-red-600 shrink-0"
          aria-label={t('permissions.remove')}
        >
          <Trash2 className="w-4 h-4" />
        </Button>
      </div>
    </div>
  )
}

/**
 * PermissionsTab - Tab content for managing permissions
 *
 * Features:
 * - Card-based permission list with user avatars
 * - Add User dialog with multi-select user search
 * - Role selection dropdown
 * - Delete permission with confirmation
 * - Empty state when no permissions
 * - Loading skeleton state
 * - Pagination support
 *
 * Design:
 * - Clean white cards with consistent spacing
 * - Red accent (#DF2029) for primary actions
 * - Smooth transitions and hover effects
 */
export function PermissionsTab({ topicId }: PermissionsTabProps) {
  const { toast } = useToast()
  const { t } = useTranslation('evaluation')

  const [permissions, setPermissions] = useState<Permission[]>([])
  const [loading, setLoading] = useState(true)
  const [addDialogOpen, setAddDialogOpen] = useState(false)

  // Pagination state
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)

  // Add form state
  const [selectedUsers, setSelectedUsers] = useState<SearchUser[]>([])
  const [newRole, setNewRole] = useState<string>(PermissionRole.RESPONDENT)
  const [adding, setAdding] = useState(false)

  // Revoke dialog state
  const [revokeDialogOpen, setRevokeDialogOpen] = useState(false)
  const [permissionToRevoke, setPermissionToRevoke] = useState<Permission | null>(null)

  // Load permissions data
  const loadPermissions = useCallback(async () => {
    setLoading(true)
    try {
      const permissionsData = await listAuthorPermissions(topicId, {
        page,
        limit: PERMISSIONS_PER_PAGE,
      })
      setPermissions(permissionsData.items)
      setTotal(permissionsData.total)
    } catch (_error) {
      toast({
        title: t('errors.load_failed'),
        description: t('errors.not_found'),
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
    }
  }, [topicId, page, toast, t])

  useEffect(() => {
    if (topicId) {
      loadPermissions()
    }
  }, [topicId, loadPermissions])

  // Handle grant permission
  const handleGrantPermission = async () => {
    if (selectedUsers.length === 0) {
      toast({
        title: t('errors.save_failed'),
        description: t('permissions.select_user'),
        variant: 'destructive',
      })
      return
    }

    setAdding(true)
    try {
      // Grant permission to all selected users
      for (const user of selectedUsers) {
        await grantAuthorPermission(topicId, {
          user_id: user.id,
          role: newRole,
        })
      }

      toast({
        title: t('permissions.granted_success'),
        description: '',
      })
      setAddDialogOpen(false)
      setSelectedUsers([])
      setNewRole(PermissionRole.RESPONDENT)
      loadPermissions()
    } catch (error) {
      toast({
        title: t('errors.save_failed'),
        description: error instanceof Error ? error.message : t('errors.save_failed'),
        variant: 'destructive',
      })
    } finally {
      setAdding(false)
    }
  }

  // Handle revoke permission
  const handleRevokePermission = async () => {
    if (!permissionToRevoke) return

    try {
      await revokeAuthorPermission(topicId, permissionToRevoke.user_id)
      toast({
        title: t('permissions.revoked_success'),
        description: '',
      })
      setRevokeDialogOpen(false)
      setPermissionToRevoke(null)
      loadPermissions()
    } catch (_error) {
      toast({
        title: t('errors.delete_failed'),
        description: '',
        variant: 'destructive',
      })
    }
  }

  // Open revoke dialog
  const openRevokeDialog = (permission: Permission) => {
    setPermissionToRevoke(permission)
    setRevokeDialogOpen(true)
  }

  // Handle add user button click
  const handleAddUser = () => {
    setAddDialogOpen(true)
  }

  // Calculate total pages
  const totalPages = Math.ceil(total / PERMISSIONS_PER_PAGE)

  return (
    <Dialog open={addDialogOpen} onOpenChange={setAddDialogOpen}>
      {loading && permissions.length === 0 ? (
        // Loading skeleton
        <div className="space-y-6">
          <div className="flex items-center justify-between">
            <Skeleton className="h-6 w-32" />
            <Skeleton className="h-10 w-32" />
          </div>
          <PermissionsListSkeleton />
        </div>
      ) : permissions.length === 0 ? (
        // Empty state
        <div className="space-y-6">
          <div className="flex items-center justify-between">
            <div className="text-sm text-gray-500">{t('permissions.no_permissions')}</div>
            <DialogTrigger asChild>
              <Button
                onClick={handleAddUser}
                className="bg-[#DF2029] hover:bg-[#c81d25] text-white"
              >
                <Plus className="w-4 h-4 mr-2" />
                {t('permissions.add')}
              </Button>
            </DialogTrigger>
          </div>
          <EmptyState onAddUser={handleAddUser} />
        </div>
      ) : (
        // Normal list with permissions
        <div className="space-y-6">
          <div className="flex items-center justify-between">
            <div className="text-sm text-gray-500">
              {total} {total === 1 ? t('permissions.user') : t('permissions.users')}
            </div>
            <DialogTrigger asChild>
              <Button
                onClick={handleAddUser}
                className="bg-[#DF2029] hover:bg-[#c81d25] text-white"
              >
                <Plus className="w-4 h-4 mr-2" />
                {t('permissions.add')}
              </Button>
            </DialogTrigger>
          </div>

          <div className="space-y-4">
            {permissions.map(permission => (
              <PermissionCard
                key={permission.id}
                permission={permission}
                onDelete={openRevokeDialog}
              />
            ))}
          </div>

          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-4 pt-4">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={page === 1 || loading}
              >
                {t('common:previous', 'Previous')}
              </Button>
              <span className="text-sm text-gray-500">
                {t('common:page', 'Page')} {page} of {totalPages}
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages || loading}
              >
                {t('common:next', 'Next')}
              </Button>
            </div>
          )}
        </div>
      )}

      {/* Add Permission Dialog Content */}
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('permissions.add')}</DialogTitle>
          <DialogDescription>{t('permissions.add_description')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label>{t('permissions.user')} *</Label>
            <UserSearchSelect
              selectedUsers={selectedUsers}
              onSelectedUsersChange={setSelectedUsers}
              placeholder={t('permissions.search_user_placeholder')}
              multiple={true}
              autoFocus={true}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="role">{t('permissions.role')}</Label>
            <Select value={newRole} onValueChange={setNewRole}>
              <SelectTrigger id="role">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={PermissionRole.RESPONDENT}>
                  {t('permissions.roles.respondent')}
                </SelectItem>
                <SelectItem value={PermissionRole.GRADER}>
                  {t('permissions.roles.grader')}
                </SelectItem>
                <SelectItem value={PermissionRole.QUESTION_CREATOR}>
                  {t('permissions.roles.question_creator')}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setAddDialogOpen(false)}>
            {t('common:actions.cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={handleGrantPermission}
            disabled={adding || selectedUsers.length === 0}
          >
            {adding ? t('common:actions.saving') : t('common:actions.save')}
          </Button>
        </DialogFooter>
      </DialogContent>

      {/* Revoke Confirmation Dialog */}
      <AlertDialog open={revokeDialogOpen} onOpenChange={setRevokeDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('permissions.remove')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('permissions.remove_description')}
              {permissionToRevoke && (
                <span className="block mt-2 font-medium text-gray-900">
                  {permissionToRevoke.user_name || `User #${permissionToRevoke.user_id}`}
                </span>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleRevokePermission}
              className="bg-red-600 hover:bg-red-700 text-white"
            >
              {t('common:actions.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  )
}
