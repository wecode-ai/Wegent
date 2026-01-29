// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Permission management dialog for knowledge bases.
 * Allows managing user permissions for a knowledge base.
 */

'use client'

import { Loader2, Search, Trash2, UserPlus, Users } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

import {
  addKnowledgePermissions,
  deleteKnowledgePermission,
  getKnowledgePermissions,
  updateKnowledgePermission,
} from '@/apis/knowledge'
import { userApis } from '@/apis/user'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useTranslation } from '@/hooks/useTranslation'
import { useToast } from '@/hooks/use-toast'
import type { PermissionResponse, PermissionType } from '@/types/knowledge'

interface PermissionManagementDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  kbId: number
  kbName: string
}

interface UserSearchResult {
  id: number
  user_name: string
  display_name?: string
}

export function PermissionManagementDialog({
  open,
  onOpenChange,
  kbId,
  kbName,
}: PermissionManagementDialogProps) {
  const { t } = useTranslation('knowledge')
  const { toast } = useToast()

  // Permission list state
  const [permissions, setPermissions] = useState<PermissionResponse[]>([])
  const [isLoading, setIsLoading] = useState(false)

  // Add user state
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<UserSearchResult[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const [selectedUsers, setSelectedUsers] = useState<UserSearchResult[]>([])
  const [newPermissionType, setNewPermissionType] = useState<PermissionType>('read')
  const [isAdding, setIsAdding] = useState(false)

  // Load permissions
  const loadPermissions = useCallback(async () => {
    setIsLoading(true)
    try {
      const response = await getKnowledgePermissions(kbId)
      setPermissions(response.items)
    } catch (error) {
      console.error('Failed to load permissions:', error)
      toast({
        variant: 'destructive',
        description: t('permission.messages.load_failed'),
      })
    } finally {
      setIsLoading(false)
    }
  }, [kbId, t, toast])

  useEffect(() => {
    if (open) {
      loadPermissions()
      // Reset add user state
      setSearchQuery('')
      setSearchResults([])
      setSelectedUsers([])
    }
  }, [open, loadPermissions])

  // Search users
  const handleSearch = useCallback(async (query: string) => {
    setSearchQuery(query)
    if (query.length < 2) {
      setSearchResults([])
      return
    }

    setIsSearching(true)
    try {
      const results = await userApis.searchUsers(query)
      // Filter out users who already have permissions
      const existingUserIds = new Set(permissions.map((p) => p.user_id))
      const selectedUserIds = new Set(selectedUsers.map((u) => u.id))
      const filteredResults = results.users.filter(
        (u) => !existingUserIds.has(u.id) && !selectedUserIds.has(u.id)
      )
      setSearchResults(filteredResults.map((u) => ({
        id: u.id,
        user_name: u.user_name,
        display_name: u.email,
      })))
    } catch (error) {
      console.error('Failed to search users:', error)
    } finally {
      setIsSearching(false)
    }
  }, [permissions, selectedUsers])

  // Select user from search results
  const handleSelectUser = (user: UserSearchResult) => {
    setSelectedUsers([...selectedUsers, user])
    setSearchResults(searchResults.filter((u) => u.id !== user.id))
    setSearchQuery('')
  }

  // Remove selected user
  const handleRemoveSelectedUser = (userId: number) => {
    setSelectedUsers(selectedUsers.filter((u) => u.id !== userId))
  }

  // Add permissions
  const handleAddPermissions = async () => {
    if (selectedUsers.length === 0) return

    setIsAdding(true)
    try {
      const result = await addKnowledgePermissions(kbId, {
        user_ids: selectedUsers.map((u) => u.id),
        permission_type: newPermissionType,
      })

      toast({
        description: t('permission.messages.permission_added', {
          success: result.success_count,
          skipped: result.skipped_count,
        }),
      })

      setSelectedUsers([])
      await loadPermissions()
    } catch (error) {
      console.error('Failed to add permissions:', error)
      toast({
        variant: 'destructive',
        description: t('permission.messages.add_failed'),
      })
    } finally {
      setIsAdding(false)
    }
  }

  // Update permission type
  const handleUpdatePermission = async (userId: number, permissionType: PermissionType) => {
    try {
      await updateKnowledgePermission(kbId, userId, { permission_type: permissionType })
      toast({
        description: t('permission.messages.permission_updated'),
      })
      await loadPermissions()
    } catch (error) {
      console.error('Failed to update permission:', error)
      toast({
        variant: 'destructive',
        description: t('permission.messages.update_failed'),
      })
    }
  }

  // Revoke permission
  const handleRevokePermission = async (userId: number) => {
    try {
      await deleteKnowledgePermission(kbId, userId)
      toast({
        description: t('permission.messages.permission_revoked'),
      })
      await loadPermissions()
    } catch (error) {
      console.error('Failed to revoke permission:', error)
      toast({
        variant: 'destructive',
        description: t('permission.messages.revoke_failed'),
      })
    }
  }

  const permissionTypes: PermissionType[] = ['read', 'download', 'write', 'manage']

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('permission.title')}</DialogTitle>
          <DialogDescription>{kbName}</DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="users" className="w-full">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="users" className="flex items-center gap-2">
              <Users className="h-4 w-4" />
              {t('permission.tabs.users')}
            </TabsTrigger>
            <TabsTrigger value="add" className="flex items-center gap-2">
              <UserPlus className="h-4 w-4" />
              {t('permission.tabs.add')}
            </TabsTrigger>
          </TabsList>

          {/* Users with permissions */}
          <TabsContent value="users" className="space-y-4">
            {isLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : permissions.length === 0 ? (
              <div className="py-8 text-center text-muted-foreground">
                {t('permission.no_users')}
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('permission.columns.user')}</TableHead>
                    <TableHead>{t('permission.columns.permission')}</TableHead>
                    <TableHead>{t('permission.columns.granted_by')}</TableHead>
                    <TableHead className="w-[100px]">{t('permission.columns.actions')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {permissions.map((permission) => (
                    <TableRow key={permission.id}>
                      <TableCell className="font-medium">{permission.username}</TableCell>
                      <TableCell>
                        <Select
                          value={permission.permission_type}
                          onValueChange={(value: PermissionType) =>
                            handleUpdatePermission(permission.user_id, value)
                          }
                        >
                          <SelectTrigger className="w-[120px]">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {permissionTypes.map((type) => (
                              <SelectItem key={type} value={type}>
                                {t(`permission.type.${type}`)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {permission.granted_by_username}
                      </TableCell>
                      <TableCell>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => handleRevokePermission(permission.user_id)}
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </TabsContent>

          {/* Add new users */}
          <TabsContent value="add" className="space-y-4">
            {/* Search input */}
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={searchQuery}
                onChange={(e) => handleSearch(e.target.value)}
                placeholder={t('permission.add_users.search_placeholder')}
                className="pl-10"
              />
              {isSearching && (
                <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground" />
              )}
            </div>

            {/* Search results */}
            {searchResults.length > 0 && (
              <div className="max-h-40 overflow-y-auto rounded-md border">
                {searchResults.map((user) => (
                  <button
                    key={user.id}
                    onClick={() => handleSelectUser(user)}
                    className="w-full px-4 py-2 text-left hover:bg-muted"
                  >
                    <span className="font-medium">{user.user_name}</span>
                    {user.display_name && (
                      <span className="ml-2 text-muted-foreground">{user.display_name}</span>
                    )}
                  </button>
                ))}
              </div>
            )}

            {/* Selected users */}
            {selectedUsers.length > 0 && (
              <div className="space-y-2">
                <div className="text-sm text-muted-foreground">
                  {t('permission.add_users.selected', { count: selectedUsers.length })}
                </div>
                <div className="flex flex-wrap gap-2">
                  {selectedUsers.map((user) => (
                    <div
                      key={user.id}
                      className="flex items-center gap-1 rounded-full bg-muted px-3 py-1 text-sm"
                    >
                      <span>{user.user_name}</span>
                      <button
                        onClick={() => handleRemoveSelectedUser(user.id)}
                        className="ml-1 text-muted-foreground hover:text-foreground"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Permission type selection */}
            <div className="flex items-center gap-4">
              <span className="text-sm text-muted-foreground">
                {t('permission.add_users.select_permission')}
              </span>
              <Select
                value={newPermissionType}
                onValueChange={(value: PermissionType) => setNewPermissionType(value)}
              >
                <SelectTrigger className="w-[150px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {permissionTypes.map((type) => (
                    <SelectItem key={type} value={type}>
                      {t(`permission.type.${type}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Add button */}
            <Button
              onClick={handleAddPermissions}
              disabled={selectedUsers.length === 0 || isAdding}
              className="w-full"
            >
              {isAdding && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('permission.add_users.add')}
            </Button>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}
