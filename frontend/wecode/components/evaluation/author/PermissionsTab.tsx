// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useCallback, useEffect, useMemo } from 'react'
import {
  Plus,
  Trash2,
  Users,
  Shield,
  UserCheck,
  UserCog,
  Calendar,
  Trash,
  Settings2,
} from 'lucide-react'
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
import { userApis } from '@/apis/user'
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
 * Parse usernames from import text (one per line, comma, or space separated)
 */
function parseUsernames(text: string): string[] {
  // Split by newline, comma, or space
  const names = text
    .split(/[\n,\s]+/)
    .map(n => n.trim())
    .filter(n => n.length > 0)
  // Remove duplicates
  return [...new Set(names)]
}

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
  /** Whether the card is selected */
  selected?: boolean
  /** Callback when selection changes */
  onSelectChange?: (selected: boolean) => void
}

function PermissionCard({ permission, onDelete, selected, onSelectChange }: PermissionCardProps) {
  const { t } = useTranslation('evaluation')
  const userInitials = getUserInitials(permission.user_name || '')
  const avatarColor = getAvatarColor(permission.user_id)

  return (
    <div
      className={`
        bg-white rounded-2xl border shadow-sm
        hover:shadow-md hover:-translate-y-[2px]
        transition-all duration-250
        p-5
        ${selected ? 'border-[#DF2029] ring-1 ring-[#DF2029]' : 'border-gray-100'}
      `}
    >
      <div className="flex items-center gap-4">
        {/* Checkbox for batch selection */}
        {onSelectChange && (
          <input
            type="checkbox"
            checked={selected}
            onChange={e => onSelectChange(e.target.checked)}
            className="w-4 h-4 rounded border-gray-300 text-[#DF2029] focus:ring-[#DF2029] cursor-pointer"
          />
        )}

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

  // Batch revoke state
  const [selectedPermissions, setSelectedPermissions] = useState<Set<number>>(new Set())
  const [batchRevokeDialogOpen, setBatchRevokeDialogOpen] = useState(false)
  const [batchRevoking, setBatchRevoking] = useState(false)

  // Batch modify state (unified import and delete)
  const [batchModifyDialogOpen, setBatchModifyDialogOpen] = useState(false)
  const [batchModifyUsernames, setBatchModifyUsernames] = useState('')
  const [batchModifyRole, setBatchModifyRole] = useState<string>(PermissionRole.RESPONDENT)
  const [batchModifyAction, setBatchModifyAction] = useState<'grant' | 'delete'>('grant')
  const [batchModifying, setBatchModifying] = useState(false)

  // Parsed usernames for batch modify (memoized)
  const parsedUsernames = useMemo(
    () => parseUsernames(batchModifyUsernames),
    [batchModifyUsernames]
  )

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

  // Handle permission selection for batch operations
  const handlePermissionSelect = (permissionId: number, selected: boolean) => {
    setSelectedPermissions(prev => {
      const newSet = new Set(prev)
      if (selected) {
        newSet.add(permissionId)
      } else {
        newSet.delete(permissionId)
      }
      return newSet
    })
  }

  // Handle select all permissions
  const handleSelectAll = () => {
    if (selectedPermissions.size === permissions.length) {
      // Deselect all
      setSelectedPermissions(new Set())
    } else {
      // Select all
      setSelectedPermissions(new Set(permissions.map(p => p.id)))
    }
  }

  // Open batch revoke dialog
  const openBatchRevokeDialog = () => {
    setBatchRevokeDialogOpen(true)
  }

  // Handle batch modify permissions (grant or delete)
  const handleBatchModify = async () => {
    if (parsedUsernames.length === 0) {
      toast({
        title: t('errors.validation_failed'),
        description: t('permissions.modify_no_usernames'),
        variant: 'destructive',
      })
      return
    }

    setBatchModifying(true)
    try {
      let successCount = 0
      let failCount = 0
      const notFoundUsers: string[] = []

      for (const username of parsedUsernames) {
        try {
          // First, search for user by username to get user_id
          const userResult = await userApis.searchUsers(username)
          const matchedUser = userResult.users.find(
            u => u.user_name === username || u.user_name?.toLowerCase() === username.toLowerCase()
          )

          if (!matchedUser) {
            notFoundUsers.push(username)
            failCount++
            continue
          }

          if (batchModifyAction === 'grant') {
            // Grant permission using user_id
            await grantAuthorPermission(topicId, {
              user_id: matchedUser.id,
              role: batchModifyRole,
            })
          } else {
            // Delete permission using user_id
            await revokeAuthorPermission(topicId, matchedUser.id)
          }
          successCount++
        } catch {
          failCount++
          if (!notFoundUsers.includes(username)) {
            notFoundUsers.push(username)
          }
        }
      }

      if (failCount === 0) {
        toast({
          title:
            batchModifyAction === 'grant'
              ? t('permissions.grant_success', { count: successCount })
              : t('permissions.delete_success', { count: successCount }),
          description: '',
        })
      } else {
        toast({
          title:
            batchModifyAction === 'grant'
              ? t('permissions.grant_partial', { success: successCount, failed: failCount })
              : t('permissions.delete_partial', { success: successCount, failed: failCount }),
          description:
            notFoundUsers.length > 0
              ? `${t('permissions.users_not_found')}: ${notFoundUsers.join(', ')}`
              : '',
          variant: 'destructive',
        })
      }

      setBatchModifyDialogOpen(false)
      setBatchModifyUsernames('')
      setBatchModifyRole(PermissionRole.RESPONDENT)
      setBatchModifyAction('grant')
      loadPermissions()
    } catch (_error) {
      toast({
        title: batchModifyAction === 'grant' ? t('errors.save_failed') : t('errors.delete_failed'),
        description: '',
        variant: 'destructive',
      })
    } finally {
      setBatchModifying(false)
    }
  }

  // Handle batch revoke permissions
  const handleBatchRevoke = async () => {
    if (selectedPermissions.size === 0) return

    setBatchRevoking(true)
    try {
      const permissionsToRevoke = permissions.filter(p => selectedPermissions.has(p.id))
      let successCount = 0
      let failCount = 0

      for (const permission of permissionsToRevoke) {
        try {
          await revokeAuthorPermission(topicId, permission.user_id)
          successCount++
        } catch {
          failCount++
        }
      }

      if (failCount === 0) {
        toast({
          title: t('permissions.batch_revoked_success', { count: successCount }),
          description: '',
        })
      } else {
        toast({
          title: t('permissions.batch_revoked_partial', {
            success: successCount,
            failed: failCount,
          }),
          description: '',
          variant: 'destructive',
        })
      }

      setBatchRevokeDialogOpen(false)
      setSelectedPermissions(new Set())
      loadPermissions()
    } catch (_error) {
      toast({
        title: t('errors.delete_failed'),
        description: '',
        variant: 'destructive',
      })
    } finally {
      setBatchRevoking(false)
    }
  }

  // Calculate total pages
  const totalPages = Math.ceil(total / PERMISSIONS_PER_PAGE)
  const hasSelection = selectedPermissions.size > 0

  return (
    <>
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
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  onClick={() => setBatchModifyDialogOpen(true)}
                  className="text-gray-600 border-gray-200 hover:bg-gray-50"
                >
                  <Settings2 className="w-4 h-4 mr-2" />
                  {t('permissions.batch_modify')}
                </Button>
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
            </div>
            <EmptyState onAddUser={handleAddUser} />
          </div>
        ) : (
          // Normal list with permissions
          <div className="space-y-6">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-4">
                <div className="text-sm text-gray-500">
                  {total} {total === 1 ? t('permissions.user') : t('permissions.users')}
                </div>
                {permissions.length > 0 && (
                  <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={
                        selectedPermissions.size === permissions.length && permissions.length > 0
                      }
                      onChange={handleSelectAll}
                      className="w-4 h-4 rounded border-gray-300 text-[#DF2029] focus:ring-[#DF2029] cursor-pointer"
                    />
                    {t('permissions.select_all')}
                  </label>
                )}
              </div>
              <div className="flex items-center gap-2">
                {hasSelection && (
                  <Button
                    variant="outline"
                    onClick={openBatchRevokeDialog}
                    className="text-red-600 border-red-200 hover:bg-red-50"
                  >
                    <Trash className="w-4 h-4 mr-2" />
                    {t('permissions.batch_delete', { count: selectedPermissions.size })}
                  </Button>
                )}
                <Button
                  variant="outline"
                  onClick={() => setBatchModifyDialogOpen(true)}
                  className="text-gray-600 border-gray-200 hover:bg-gray-50"
                >
                  <Settings2 className="w-4 h-4 mr-2" />
                  {t('permissions.batch_modify')}
                </Button>
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
            </div>

            <div className="space-y-4">
              {permissions.map(permission => (
                <PermissionCard
                  key={permission.id}
                  permission={permission}
                  onDelete={openRevokeDialog}
                  selected={selectedPermissions.has(permission.id)}
                  onSelectChange={selected => handlePermissionSelect(permission.id, selected)}
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

        {/* Batch Revoke Confirmation Dialog */}
        <AlertDialog open={batchRevokeDialogOpen} onOpenChange={setBatchRevokeDialogOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t('permissions.batch_remove_title')}</AlertDialogTitle>
              <AlertDialogDescription>
                {t('permissions.batch_remove_description', { count: selectedPermissions.size })}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={batchRevoking}>
                {t('common:actions.cancel')}
              </AlertDialogCancel>
              <AlertDialogAction
                onClick={handleBatchRevoke}
                disabled={batchRevoking}
                className="bg-red-600 hover:bg-red-700 text-white"
              >
                {batchRevoking ? t('common:actions.deleting') : t('common:actions.confirm')}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </Dialog>

      {/* Batch Modify Dialog */}
      <Dialog open={batchModifyDialogOpen} onOpenChange={setBatchModifyDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('permissions.batch_modify')}</DialogTitle>
            <DialogDescription>{t('permissions.batch_modify_description')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="batch-action">{t('permissions.operation_type')}</Label>
              <Select
                value={batchModifyAction}
                onValueChange={v => setBatchModifyAction(v as 'grant' | 'delete')}
              >
                <SelectTrigger id="batch-action">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="grant">{t('permissions.operations.grant')}</SelectItem>
                  <SelectItem value="delete">{t('permissions.operations.delete')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {batchModifyAction === 'grant' && (
              <div className="space-y-2">
                <Label htmlFor="batch-role">{t('permissions.role')}</Label>
                <Select value={batchModifyRole} onValueChange={setBatchModifyRole}>
                  <SelectTrigger id="batch-role">
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
            )}
            <div className="space-y-2">
              <Label htmlFor="batch-usernames">{t('permissions.usernames')} *</Label>
              <textarea
                id="batch-usernames"
                value={batchModifyUsernames}
                onChange={e => setBatchModifyUsernames(e.target.value)}
                placeholder={t('permissions.usernames_placeholder')}
                className="w-full min-h-[150px] px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#DF2029] focus:border-transparent resize-y"
              />
              <p className="text-xs text-gray-500">{t('permissions.usernames_hint')}</p>
            </div>
            {parsedUsernames.length > 0 && (
              <div className="text-sm text-gray-600">
                {t('permissions.usernames_count', { count: parsedUsernames.length })}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBatchModifyDialogOpen(false)}>
              {t('common:actions.cancel')}
            </Button>
            <Button
              variant="primary"
              onClick={handleBatchModify}
              disabled={batchModifying || parsedUsernames.length === 0}
            >
              {batchModifying
                ? t('permissions.processing')
                : batchModifyAction === 'grant'
                  ? t('common:actions.save')
                  : t('common:actions.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
