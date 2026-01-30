// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect } from 'react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useTranslation } from '@/hooks/useTranslation'
import { Spinner } from '@/components/ui/spinner'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { toast } from '@/hooks/use-toast'
import {
  Check,
  X,
  MoreVertical,
  Trash2,
  Shield,
  Eye,
  Edit,
} from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

type PermissionLevel = 'view' | 'edit' | 'manage'
type ApprovalStatus = 'pending' | 'approved' | 'rejected'

interface Permission {
  id: number
  user_id: number
  user_name: string | null
  user_email: string | null
  permission_level: PermissionLevel
  approval_status: ApprovalStatus
  requested_by: number
  requested_by_name: string | null
  approved_by: number | null
  approved_by_name: string | null
  created_at: string
  updated_at: string
}

interface PermissionsManagementProps {
  knowledgeBaseId: number
  isOwner: boolean
}

export function PermissionsManagement({
  knowledgeBaseId,
  isOwner,
}: PermissionsManagementProps) {
  const { t } = useTranslation('knowledge')
  const [activeTab, setActiveTab] = useState<'pending' | 'approved'>('pending')
  const [pendingPermissions, setPendingPermissions] = useState<Permission[]>([])
  const [approvedPermissions, setApprovedPermissions] = useState<Permission[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [actionLoading, setActionLoading] = useState<number | null>(null)

  useEffect(() => {
    async function fetchPermissions() {
      setLoading(true)
      setError(null)

      try {
        const [pendingRes, approvedRes] = await Promise.all([
          fetch(`/api/knowledge/${knowledgeBaseId}/permissions?status=pending`),
          fetch(`/api/knowledge/${knowledgeBaseId}/permissions?status=approved`),
        ])

        if (!pendingRes.ok || !approvedRes.ok) {
          setError(t('permissions.fetch_error'))
          return
        }

        const pendingData = await pendingRes.json()
        const approvedData = await approvedRes.json()

        setPendingPermissions(pendingData.items || [])
        setApprovedPermissions(approvedData.items || [])
      } catch (err) {
        setError(t('permissions.fetch_error'))
      } finally {
        setLoading(false)
      }
    }

    if (isOwner) {
      fetchPermissions()
    }
  }, [knowledgeBaseId, isOwner, t])

  const handleApprove = async (permissionId: number, permissionLevel: PermissionLevel) => {
    setActionLoading(permissionId)
    try {
      const response = await fetch(
        `/api/knowledge/${knowledgeBaseId}/permissions/${permissionId}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'approve',
            permission_level: permissionLevel,
          }),
        }
      )

      if (!response.ok) {
        const data = await response.json()
        toast({
          variant: 'destructive',
          description: data.detail || t('permissions.approve_error'),
        })
        return
      }

      toast({
        description: t('permissions.approve_success'),
      })

      // Refresh permissions
      const pendingRes = await fetch(
        `/api/knowledge/${knowledgeBaseId}/permissions?status=pending`
      )
      const approvedRes = await fetch(
        `/api/knowledge/${knowledgeBaseId}/permissions?status=approved`
      )

      if (pendingRes.ok && approvedRes.ok) {
        const pendingData = await pendingRes.json()
        const approvedData = await approvedRes.json()
        setPendingPermissions(pendingData.items || [])
        setApprovedPermissions(approvedData.items || [])
      }
    } catch (err) {
      toast({
        variant: 'destructive',
        description: t('permissions.approve_error'),
      })
    } finally {
      setActionLoading(null)
    }
  }

  const handleReject = async (permissionId: number) => {
    setActionLoading(permissionId)
    try {
      const response = await fetch(
        `/api/knowledge/${knowledgeBaseId}/permissions/${permissionId}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'reject' }),
        }
      )

      if (!response.ok) {
        const data = await response.json()
        toast({
          variant: 'destructive',
          description: data.detail || t('permissions.reject_error'),
        })
        return
      }

      toast({
        description: t('permissions.reject_success'),
      })

      // Refresh pending permissions
      const pendingRes = await fetch(
        `/api/knowledge/${knowledgeBaseId}/permissions?status=pending`
      )
      if (pendingRes.ok) {
        const pendingData = await pendingRes.json()
        setPendingPermissions(pendingData.items || [])
      }
    } catch (err) {
      toast({
        variant: 'destructive',
        description: t('permissions.reject_error'),
      })
    } finally {
      setActionLoading(null)
    }
  }

  const handleRemove = async (permissionId: number) => {
    setActionLoading(permissionId)
    try {
      const response = await fetch(
        `/api/knowledge/${knowledgeBaseId}/permissions/${permissionId}`,
        { method: 'DELETE' }
      )

      if (!response.ok) {
        const data = await response.json()
        toast({
          variant: 'destructive',
          description: data.detail || t('permissions.remove_error'),
        })
        return
      }

      toast({
        description: t('permissions.remove_success'),
      })

      // Refresh approved permissions
      const approvedRes = await fetch(
        `/api/knowledge/${knowledgeBaseId}/permissions?status=approved`
      )
      if (approvedRes.ok) {
        const approvedData = await approvedRes.json()
        setApprovedPermissions(approvedData.items || [])
      }
    } catch (err) {
      toast({
        variant: 'destructive',
        description: t('permissions.remove_error'),
      })
    } finally {
      setActionLoading(null)
    }
  }

  const handleUpdatePermission = async (
    permissionId: number,
    newLevel: PermissionLevel
  ) => {
    setActionLoading(permissionId)
    try {
      const response = await fetch(
        `/api/knowledge/${knowledgeBaseId}/permissions/${permissionId}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ permission_level: newLevel }),
        }
      )

      if (!response.ok) {
        const data = await response.json()
        toast({
          variant: 'destructive',
          description: data.detail || t('permissions.update_error'),
        })
        return
      }

      toast({
        description: t('permissions.update_success'),
      })

      // Refresh approved permissions
      const approvedRes = await fetch(
        `/api/knowledge/${knowledgeBaseId}/permissions?status=approved`
      )
      if (approvedRes.ok) {
        const approvedData = await approvedRes.json()
        setApprovedPermissions(approvedData.items || [])
      }
    } catch (err) {
      toast({
        variant: 'destructive',
        description: t('permissions.update_error'),
      })
    } finally {
      setActionLoading(null)
    }
  }

  const getPermissionIcon = (level: PermissionLevel) => {
    switch (level) {
      case 'view':
        return <Eye className="w-4 h-4" />
      case 'edit':
        return <Edit className="w-4 h-4" />
      case 'manage':
        return <Shield className="w-4 h-4" />
    }
  }

  const getPermissionBadgeVariant = (level: PermissionLevel) => {
    switch (level) {
      case 'view':
        return 'secondary'
      case 'edit':
        return 'default'
      case 'manage':
        return 'primary'
    }
  }

  if (!isOwner) {
    return null
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Spinner />
      </div>
    )
  }

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    )
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Shield className="w-5 h-5" />
            {t('permissions.title')}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as 'pending' | 'approved')}>
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="pending">
                {t('permissions.pending_requests')}
                {pendingPermissions.length > 0 && (
                  <Badge variant="secondary" className="ml-2">
                    {pendingPermissions.length}
                  </Badge>
                )}
              </TabsTrigger>
              <TabsTrigger value="approved">
                {t('permissions.approved_users')}
                {approvedPermissions.length > 0 && (
                  <Badge variant="secondary" className="ml-2">
                    {approvedPermissions.length}
                  </Badge>
                )}
              </TabsTrigger>
            </TabsList>

            <TabsContent value="pending" className="mt-4">
              {pendingPermissions.length === 0 ? (
                <div className="text-center py-8 text-text-muted">
                  {t('permissions.no_pending_requests')}
                </div>
              ) : (
                <div className="space-y-3">
                  {pendingPermissions.map((permission) => (
                    <div
                      key={permission.id}
                      className="flex items-center justify-between p-3 rounded-lg bg-surface border border-border"
                    >
                      <div className="flex items-center gap-3">
                        <Avatar className="w-10 h-10">
                          <AvatarFallback>
                            {permission.user_name?.[0]?.toUpperCase() || 'U'}
                          </AvatarFallback>
                        </Avatar>
                        <div>
                          <div className="font-medium text-sm">
                            {permission.user_name || t('permissions.unknown_user')}
                          </div>
                          <div className="text-xs text-text-muted">
                            {permission.user_email || ''}
                          </div>
                          <div className="flex items-center gap-1 mt-1">
                            {getPermissionIcon(permission.permission_level)}
                            <span className="text-xs text-text-muted">
                              {t(`permissions.level_${permission.permission_level}`)}
                            </span>
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Select
                          defaultValue="view"
                          onValueChange={(v) =>
                            handleApprove(permission.id, v as PermissionLevel)
                          }
                          disabled={actionLoading === permission.id}
                        >
                          <SelectTrigger className="w-32">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="view">
                              {t('permissions.level_view')}
                            </SelectItem>
                            <SelectItem value="edit">
                              {t('permissions.level_edit')}
                            </SelectItem>
                            <SelectItem value="manage">
                              {t('permissions.level_manage')}
                            </SelectItem>
                          </SelectContent>
                        </Select>
                        <Button
                          variant="outline"
                          size="icon"
                          onClick={() => handleReject(permission.id)}
                          disabled={actionLoading === permission.id}
                        >
                          {actionLoading === permission.id ? (
                            <Spinner className="w-4 h-4" />
                          ) : (
                            <X className="w-4 h-4" />
                          )}
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </TabsContent>

            <TabsContent value="approved" className="mt-4">
              {approvedPermissions.length === 0 ? (
                <div className="text-center py-8 text-text-muted">
                  {t('permissions.no_approved_users')}
                </div>
              ) : (
                <div className="space-y-3">
                  {approvedPermissions.map((permission) => (
                    <div
                      key={permission.id}
                      className="flex items-center justify-between p-3 rounded-lg bg-surface border border-border"
                    >
                      <div className="flex items-center gap-3">
                        <Avatar className="w-10 h-10">
                          <AvatarFallback>
                            {permission.user_name?.[0]?.toUpperCase() || 'U'}
                          </AvatarFallback>
                        </Avatar>
                        <div>
                          <div className="font-medium text-sm">
                            {permission.user_name || t('permissions.unknown_user')}
                          </div>
                          <div className="text-xs text-text-muted">
                            {permission.user_email || ''}
                          </div>
                          <Badge
                            variant={getPermissionBadgeVariant(permission.permission_level)}
                            className="mt-1"
                          >
                            {t(`permissions.level_${permission.permission_level}`)}
                          </Badge>
                        </div>
                      </div>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon">
                            {actionLoading === permission.id ? (
                              <Spinner className="w-4 h-4" />
                            ) : (
                              <MoreVertical className="w-4 h-4" />
                            )}
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <Select
                            onValueChange={(v) =>
                              handleUpdatePermission(permission.id, v as PermissionLevel)
                            }
                          >
                            <SelectTrigger className="w-full">
                              <SelectValue
                                placeholder={t('permissions.change_level')}
                              />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="view">
                                {t('permissions.level_view')}
                              </SelectItem>
                              <SelectItem value="edit">
                                {t('permissions.level_edit')}
                              </SelectItem>
                              <SelectItem value="manage">
                                {t('permissions.level_manage')}
                              </SelectItem>
                            </SelectContent>
                          </Select>
                          <DropdownMenuItem
                            onClick={() => handleRemove(permission.id)}
                            className="text-destructive focus:text-destructive"
                          >
                            <Trash2 className="w-4 h-4 mr-2" />
                            {t('permissions.remove_access')}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  ))}
                </div>
              )}
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </div>
  )
}