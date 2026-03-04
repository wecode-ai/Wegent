// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { useRouter, useParams } from 'next/navigation'
import { ArrowLeft, Plus, Trash2, UserPlus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
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
import { EvaluationPageLayout } from '@wecode/components/evaluation/common/EvaluationPageLayout'
import { DataTable, type Column } from '@wecode/components/evaluation/common/DataTable'
import { UserSearchSelect } from '@/components/common/UserSearchSelect'
import {
  getAuthorTopic,
  listAuthorPermissions,
  grantAuthorPermission,
  revokeAuthorPermission,
} from '@wecode/api/evaluation-author'
import { PermissionRole, type Topic, type Permission, getRoleLabel } from '@wecode/types/evaluation'
import { useTranslation } from '@/hooks/useTranslation'
import type { SearchUser } from '@/types/api'

const PERMISSIONS_PER_PAGE = 20

function PermissionsContent() {
  const router = useRouter()
  const params = useParams()
  const { toast } = useToast()
  const { t } = useTranslation('evaluation')
  const topicId = parseInt(params.id as string)

  const [topic, setTopic] = useState<Topic | null>(null)
  const [permissions, setPermissions] = useState<Permission[]>([])
  const [loading, setLoading] = useState(true)
  const [addDialogOpen, setAddDialogOpen] = useState(false)

  // Pagination state
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)

  // Add form state - use user search instead of manual ID input
  const [selectedUsers, setSelectedUsers] = useState<SearchUser[]>([])
  const [newRole, setNewRole] = useState<string>(PermissionRole.RESPONDENT)
  const [adding, setAdding] = useState(false)

  // Revoke dialog state
  const [revokeDialogOpen, setRevokeDialogOpen] = useState(false)
  const [permissionToRevoke, setPermissionToRevoke] = useState<Permission | null>(null)

  const loadData = useCallback(async () => {
    setLoading(true)
    try {
      const [topicData, permissionsData] = await Promise.all([
        getAuthorTopic(topicId),
        listAuthorPermissions(topicId, { page, limit: PERMISSIONS_PER_PAGE }),
      ])

      setTopic(topicData)
      setPermissions(permissionsData.items)
      setTotal(permissionsData.total)
    } catch (_error) {
      toast({
        title: t('errors.load_failed'),
        description: t('errors.not_found'),
        variant: 'destructive',
      })
      router.push('/evaluation/author')
    } finally {
      setLoading(false)
    }
  }, [topicId, page, toast, router, t])

  useEffect(() => {
    if (topicId) {
      loadData()
    }
  }, [topicId, loadData])

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
      loadData()
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
      loadData()
    } catch (_error) {
      toast({
        title: t('errors.delete_failed'),
        description: '',
        variant: 'destructive',
      })
    }
  }

  const openRevokeDialog = (permission: Permission) => {
    setPermissionToRevoke(permission)
    setRevokeDialogOpen(true)
  }

  // Define table columns
  const columns: Column<Permission>[] = useMemo(
    () => [
      {
        key: 'user',
        title: t('permissions.user'),
        render: (permission: Permission) => (
          <div>
            <div className="font-medium">
              {permission.user_name || `User #${permission.user_id}`}
            </div>
            {permission.user_email && (
              <div className="text-sm text-text-muted">{permission.user_email}</div>
            )}
          </div>
        ),
      },
      {
        key: 'role',
        title: t('permissions.role'),
        render: (permission: Permission) => (
          <Badge
            variant={
              permission.role === PermissionRole.GRADER ||
              permission.role === PermissionRole.QUESTION_CREATOR
                ? 'default'
                : 'secondary'
            }
          >
            {t(`permissions.roles.${permission.role}`) || getRoleLabel(permission.role)}
          </Badge>
        ),
      },
      {
        key: 'granted_at',
        title: t('permissions.granted_at'),
        render: (permission: Permission) => new Date(permission.granted_at).toLocaleDateString(),
      },
      {
        key: 'actions',
        title: t('actions.delete'),
        className: 'text-right',
        render: (permission: Permission) => (
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive"
            onClick={() => openRevokeDialog(permission)}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        ),
      },
    ],
    [t]
  )

  // Empty state action
  const emptyAction = (
    <Button variant="outline" onClick={() => setAddDialogOpen(true)}>
      <Plus className="mr-2 h-4 w-4" />
      {t('permissions.add')}
    </Button>
  )

  if (loading && !topic) {
    return (
      <div className="container mx-auto max-w-4xl px-4 py-8">
        <Skeleton className="mb-6 h-10 w-32" />
        <Skeleton className="h-96 w-full" />
      </div>
    )
  }

  if (!topic) {
    return null
  }

  return (
    <div className="container mx-auto max-w-4xl px-4 py-8">
      {/* Header */}
      <div className="mb-6 flex items-center justify-between">
        <Button variant="ghost" onClick={() => router.push(`/evaluation/author/topics/${topicId}`)}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          {t('actions.back')}
        </Button>
        <Dialog open={addDialogOpen} onOpenChange={setAddDialogOpen}>
          <DialogTrigger asChild>
            <Button variant="primary">
              <UserPlus className="mr-2 h-4 w-4" />
              {t('permissions.add')}
            </Button>
          </DialogTrigger>
          <DialogContent>
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
                    <SelectItem value="respondent">{t('permissions.roles.respondent')}</SelectItem>
                    <SelectItem value="grader">{t('permissions.roles.grader')}</SelectItem>
                    <SelectItem value="question_creator">
                      {t('permissions.roles.question_creator')}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setAddDialogOpen(false)}>
                {t('actions.cancel')}
              </Button>
              <Button variant="primary" onClick={handleGrantPermission} disabled={adding}>
                {adding ? '...' : t('actions.save')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t('permissions.title')}</CardTitle>
          <CardDescription>
            {t('permissions.description')} - {topic.name}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <DataTable
            columns={columns}
            data={permissions}
            total={total}
            page={page}
            pageSize={PERMISSIONS_PER_PAGE}
            loading={loading}
            emptyMessage={t('permissions.no_permissions')}
            emptyAction={emptyAction}
            onPageChange={setPage}
            previousText={t('common:previous', 'Previous')}
            nextText={t('common:next', 'Next')}
            pageText={t('common:page', 'Page')}
            rowKey={(permission: Permission) => permission.id}
          />
        </CardContent>
      </Card>

      {/* Revoke Confirmation Dialog */}
      <AlertDialog open={revokeDialogOpen} onOpenChange={setRevokeDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('permissions.remove')}</AlertDialogTitle>
            <AlertDialogDescription>{t('permissions.remove_description')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleRevokePermission}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t('actions.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

export default function PermissionsPage() {
  return (
    <EvaluationPageLayout>
      <PermissionsContent />
    </EvaluationPageLayout>
  )
}
