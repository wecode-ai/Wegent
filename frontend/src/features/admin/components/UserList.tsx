// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useEffect, useState, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Tag } from '@/components/ui/tag'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  UserIcon,
  PencilIcon,
  TrashIcon,
  KeyIcon,
  NoSymbolIcon,
  CheckCircleIcon,
} from '@heroicons/react/24/outline'
import { ChevronLeftIcon, ChevronRightIcon } from '@heroicons/react/24/solid'
import { Loader2 } from 'lucide-react'
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { adminApis, AdminUser, AdminUserCreate, AdminUserUpdate, UserRole } from '@/apis/admin'
import UnifiedAddButton from '@/components/common/UnifiedAddButton'

const UserList: React.FC = () => {
  const { t } = useTranslation()
  const { toast } = useToast()
  const [users, setUsers] = useState<AdminUser[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [includeInactive, setIncludeInactive] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const pageSize = 20

  // Debounce search input
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(searchQuery)
      setPage(1) // Reset to first page when search changes
    }, 300)
    return () => clearTimeout(timer)
  }, [searchQuery])

  // Dialog states
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false)
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false)
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false)
  const [isResetPasswordDialogOpen, setIsResetPasswordDialogOpen] = useState(false)
  const [selectedUser, setSelectedUser] = useState<AdminUser | null>(null)

  // Form states
  const [formData, setFormData] = useState<AdminUserCreate>({
    user_name: '',
    password: '',
    email: '',
    role: 'user',
    auth_source: 'password',
  })
  const [newPassword, setNewPassword] = useState('')
  const [saving, setSaving] = useState(false)

  const fetchUsers = useCallback(async () => {
    setLoading(true)
    try {
      const response = await adminApis.getUsers(
        page,
        pageSize,
        includeInactive,
        debouncedSearch || undefined
      )
      setUsers(response.items)
      setTotal(response.total)
    } catch (_error) {
      toast({
        variant: 'destructive',
        title: t('admin:users.errors.load_failed'),
      })
    } finally {
      setLoading(false)
    }
  }, [page, pageSize, includeInactive, debouncedSearch, toast, t])

  useEffect(() => {
    fetchUsers()
  }, [fetchUsers])

  const handleCreateUser = async () => {
    if (!formData.user_name.trim()) {
      toast({
        variant: 'destructive',
        title: t('admin:users.errors.username_required'),
      })
      return
    }

    if (
      formData.auth_source === 'password' &&
      (!formData.password || formData.password.length < 6)
    ) {
      toast({
        variant: 'destructive',
        title: t('admin:users.errors.password_min_length'),
      })
      return
    }

    setSaving(true)
    try {
      await adminApis.createUser(formData)
      toast({ title: t('admin:users.success.created') })
      setIsCreateDialogOpen(false)
      resetForm()
      fetchUsers()
    } catch (error) {
      toast({
        variant: 'destructive',
        title: t('admin:users.errors.create_failed'),
        description: (error as Error).message,
      })
    } finally {
      setSaving(false)
    }
  }

  const handleUpdateUser = async () => {
    if (!selectedUser) return

    setSaving(true)
    try {
      const updateData: AdminUserUpdate = {}
      if (formData.user_name !== selectedUser.user_name) {
        updateData.user_name = formData.user_name
      }
      if (formData.email !== selectedUser.email) {
        updateData.email = formData.email || undefined
      }
      if (formData.role !== selectedUser.role) {
        updateData.role = formData.role as UserRole
      }

      await adminApis.updateUser(selectedUser.id, updateData)
      toast({ title: t('admin:users.success.updated') })
      setIsEditDialogOpen(false)
      resetForm()
      fetchUsers()
    } catch (error) {
      toast({
        variant: 'destructive',
        title: t('admin:users.errors.update_failed'),
        description: (error as Error).message,
      })
    } finally {
      setSaving(false)
    }
  }

  const handleDeleteUser = async () => {
    if (!selectedUser) return

    setSaving(true)
    try {
      await adminApis.deleteUser(selectedUser.id)
      toast({ title: t('admin:users.success.deleted') })
      setIsDeleteDialogOpen(false)
      setSelectedUser(null)
      fetchUsers()
    } catch (error) {
      toast({
        variant: 'destructive',
        title: t('admin:users.errors.delete_failed'),
        description: (error as Error).message,
      })
    } finally {
      setSaving(false)
    }
  }

  const handleResetPassword = async () => {
    if (!selectedUser || newPassword.length < 6) {
      toast({
        variant: 'destructive',
        title: t('admin:users.errors.password_min_length'),
      })
      return
    }

    setSaving(true)
    try {
      await adminApis.resetPassword(selectedUser.id, { new_password: newPassword })
      toast({ title: t('admin:users.success.password_reset') })
      setIsResetPasswordDialogOpen(false)
      setNewPassword('')
      setSelectedUser(null)
    } catch (error) {
      toast({
        variant: 'destructive',
        title: t('admin:users.errors.reset_password_failed'),
        description: (error as Error).message,
      })
    } finally {
      setSaving(false)
    }
  }

  const handleToggleStatus = async (user: AdminUser) => {
    try {
      await adminApis.toggleUserStatus(user.id)
      toast({ title: t('admin:users.success.status_toggled') })
      fetchUsers()
    } catch (error) {
      toast({
        variant: 'destructive',
        title: t('admin:users.errors.toggle_status_failed'),
        description: (error as Error).message,
      })
    }
  }

  const resetForm = () => {
    setFormData({
      user_name: '',
      password: '',
      email: '',
      role: 'user',
      auth_source: 'password',
    })
    setSelectedUser(null)
  }

  const openEditDialog = (user: AdminUser) => {
    setSelectedUser(user)
    setFormData({
      user_name: user.user_name,
      email: user.email || '',
      role: user.role,
      auth_source:
        user.auth_source === 'unknown' ? 'password' : (user.auth_source as 'password' | 'oidc'),
    })
    setIsEditDialogOpen(true)
  }

  const getRoleTag = (role: string) => {
    if (role === 'admin') {
      return <Tag variant="info">{t('admin:users.roles.admin')}</Tag>
    }
    return <Tag variant="default">{t('admin:users.roles.user')}</Tag>
  }

  const getStatusTag = (isActive: boolean) => {
    if (isActive) {
      return <Tag variant="success">{t('admin:users.status.active')}</Tag>
    }
    return <Tag variant="error">{t('admin:users.status.inactive')}</Tag>
  }

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold text-text-primary mb-1">{t('admin:users.title')}</h2>
          <p className="text-sm text-text-muted">{t('admin:users.description')}</p>
        </div>
        <div className="flex items-center gap-4">
          {/* Search Input */}
          <div className="relative">
            <Input
              type="text"
              placeholder={t('admin:users.search_placeholder')}
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="w-64 h-9 pl-3 pr-8"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-primary"
              >
                ×
              </button>
            )}
          </div>
          <label className="flex items-center gap-2 text-sm text-text-muted">
            <input
              type="checkbox"
              checked={includeInactive}
              onChange={e => setIncludeInactive(e.target.checked)}
              className="rounded border-border"
            />
            {t('admin:users.show_inactive')}
          </label>
        </div>
      </div>

      {/* Content Container */}
      <div className="bg-base border border-border rounded-md p-2 w-full max-h-[70vh] flex flex-col overflow-y-auto">
        {/* Loading State */}
        {loading && (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-6 h-6 animate-spin text-text-muted" />
          </div>
        )}

        {/* Empty State */}
        {!loading && users.length === 0 && (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <UserIcon className="w-12 h-12 text-text-muted mb-4" />
            <p className="text-text-muted">{t('admin:users.no_users')}</p>
          </div>
        )}

        {/* User List */}
        {!loading && users.length > 0 && (
          <div className="flex-1 overflow-y-auto space-y-3 p-1">
            {users.map(user => (
              <Card
                key={user.id}
                className={`p-4 bg-base hover:bg-hover transition-colors ${!user.is_active ? 'opacity-60' : ''}`}
              >
                <div className="flex items-center justify-between min-w-0">
                  <div className="flex items-center space-x-3 min-w-0 flex-1">
                    <UserIcon className="w-5 h-5 text-primary flex-shrink-0" />
                    <div className="flex flex-col justify-center min-w-0 flex-1">
                      <div className="flex items-center space-x-2 min-w-0">
                        <h3 className="text-base font-medium text-text-primary truncate">
                          {user.user_name}
                        </h3>
                        {getRoleTag(user.role)}
                        {getStatusTag(user.is_active)}
                      </div>
                      <div className="flex items-center gap-2 mt-1 text-xs text-text-muted">
                        <span>ID: {user.id}</span>
                        <span>•</span>
                        <span>{user.email || t('admin:users.no_email')}</span>
                        <span>•</span>
                        <span>{t(`admin:users.auth_sources.${user.auth_source}`)}</span>
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0 ml-3">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => openEditDialog(user)}
                      title={t('admin:users.edit_user')}
                    >
                      <PencilIcon className="w-4 h-4" />
                    </Button>
                    {user.auth_source !== 'oidc' && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => {
                          setSelectedUser(user)
                          setIsResetPasswordDialogOpen(true)
                        }}
                        title={t('admin:users.reset_password')}
                      >
                        <KeyIcon className="w-4 h-4" />
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => handleToggleStatus(user)}
                      title={t('admin:users.toggle_status')}
                    >
                      {user.is_active ? (
                        <NoSymbolIcon className="w-4 h-4" />
                      ) : (
                        <CheckCircleIcon className="w-4 h-4" />
                      )}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 hover:text-error"
                      onClick={() => {
                        setSelectedUser(user)
                        setIsDeleteDialogOpen(true)
                      }}
                      title={t('admin:users.delete_user')}
                    >
                      <TrashIcon className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )}

        {/* Pagination and Add Button */}
        {!loading && (
          <div className="border-t border-border pt-3 mt-3 bg-base">
            {/* Pagination */}
            {total > pageSize && (
              <div className="flex items-center justify-center gap-4 mb-3">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage(p => Math.max(1, p - 1))}
                  disabled={page === 1}
                  className="h-8 px-3"
                >
                  <ChevronLeftIcon className="w-4 h-4 mr-1" />
                  {t('common:common.previous')}
                </Button>
                <span className="text-sm text-text-muted">
                  {t('common:common.page_info', {
                    current: page,
                    total: Math.ceil(total / pageSize),
                  })}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage(p => Math.min(Math.ceil(total / pageSize), p + 1))}
                  disabled={page >= Math.ceil(total / pageSize)}
                  className="h-8 px-3"
                >
                  {t('common:common.next')}
                  <ChevronRightIcon className="w-4 h-4 ml-1" />
                </Button>
              </div>
            )}
            {/* Add Button */}
            <div className="flex justify-center">
              <UnifiedAddButton onClick={() => setIsCreateDialogOpen(true)}>
                {t('admin:users.create_user')}
              </UnifiedAddButton>
            </div>
          </div>
        )}
      </div>

      {/* Create User Dialog */}
      <Dialog open={isCreateDialogOpen} onOpenChange={setIsCreateDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('admin:users.create_user')}</DialogTitle>
            <DialogDescription>{t('admin:users.description')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="username">{t('admin:users.form.username')} *</Label>
              <Input
                id="username"
                value={formData.user_name}
                onChange={e => setFormData({ ...formData, user_name: e.target.value })}
                placeholder={t('admin:users.form.username_placeholder')}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="auth_source">{t('admin:users.form.auth_source')}</Label>
              <Select
                value={formData.auth_source}
                onValueChange={value =>
                  setFormData({ ...formData, auth_source: value as 'password' | 'oidc' })
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder={t('admin:users.form.auth_source_select')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="password">{t('admin:users.auth_sources.password')}</SelectItem>
                  <SelectItem value="oidc">{t('admin:users.auth_sources.oidc')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {formData.auth_source === 'password' && (
              <div className="space-y-2">
                <Label htmlFor="password">{t('admin:users.form.password')} *</Label>
                <Input
                  id="password"
                  type="password"
                  value={formData.password}
                  onChange={e => setFormData({ ...formData, password: e.target.value })}
                  placeholder={t('admin:users.form.password_placeholder')}
                />
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="email">{t('admin:users.form.email')}</Label>
              <Input
                id="email"
                type="email"
                value={formData.email}
                onChange={e => setFormData({ ...formData, email: e.target.value })}
                placeholder={t('admin:users.form.email_placeholder')}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="role">{t('admin:users.form.role')}</Label>
              <Select
                value={formData.role}
                onValueChange={value => setFormData({ ...formData, role: value as UserRole })}
              >
                <SelectTrigger>
                  <SelectValue placeholder={t('admin:users.form.role_select')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="user">{t('admin:users.roles.user')}</SelectItem>
                  <SelectItem value="admin">{t('admin:users.roles.admin')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsCreateDialogOpen(false)}>
              {t('admin:common.cancel')}
            </Button>
            <Button onClick={handleCreateUser} disabled={saving}>
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('admin:common.create')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit User Dialog */}
      <Dialog open={isEditDialogOpen} onOpenChange={setIsEditDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('admin:users.edit_user')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="edit-username">{t('admin:users.form.username')}</Label>
              <Input
                id="edit-username"
                value={formData.user_name}
                onChange={e => setFormData({ ...formData, user_name: e.target.value })}
                placeholder={t('admin:users.form.username_placeholder')}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-email">{t('admin:users.form.email')}</Label>
              <Input
                id="edit-email"
                type="email"
                value={formData.email}
                onChange={e => setFormData({ ...formData, email: e.target.value })}
                placeholder={t('admin:users.form.email_placeholder')}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-role">{t('admin:users.form.role')}</Label>
              <Select
                value={formData.role}
                onValueChange={value => setFormData({ ...formData, role: value as UserRole })}
              >
                <SelectTrigger>
                  <SelectValue placeholder={t('admin:users.form.role_select')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="user">{t('admin:users.roles.user')}</SelectItem>
                  <SelectItem value="admin">{t('admin:users.roles.admin')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsEditDialogOpen(false)}>
              {t('common:actions.cancel')}
            </Button>
            <Button onClick={handleUpdateUser} disabled={saving}>
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('common:actions.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reset Password Dialog */}
      <Dialog open={isResetPasswordDialogOpen} onOpenChange={setIsResetPasswordDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('admin:users.confirm.reset_password_title')}</DialogTitle>
            <DialogDescription>
              {t('admin:users.confirm.reset_password_message', { name: selectedUser?.user_name })}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="new-password">{t('admin:users.form.new_password')}</Label>
              <Input
                id="new-password"
                type="password"
                value={newPassword}
                onChange={e => setNewPassword(e.target.value)}
                placeholder={t('admin:users.form.new_password_placeholder')}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsResetPasswordDialogOpen(false)}>
              {t('common:actions.cancel')}
            </Button>
            <Button onClick={handleResetPassword} disabled={saving}>
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('common:actions.reset')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('admin:users.confirm.delete_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('admin:users.confirm.delete_message', { name: selectedUser?.user_name })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={handleDeleteUser} className="bg-error hover:bg-error/90">
              {t('common:actions.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

export default UserList
