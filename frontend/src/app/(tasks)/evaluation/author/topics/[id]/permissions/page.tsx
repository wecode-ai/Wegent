// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect, useCallback } from 'react'
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
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { useToast } from '@/hooks/use-toast'
import { EvaluationPageLayout } from '@wecode/components/evaluation/common/EvaluationPageLayout'
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

  // Add form state - use user search instead of manual ID input
  const [selectedUsers, setSelectedUsers] = useState<SearchUser[]>([])
  const [newRole, setNewRole] = useState<string>(PermissionRole.RESPONDENT)
  const [adding, setAdding] = useState(false)

  const loadData = useCallback(async () => {
    setLoading(true)
    try {
      const [topicData, permissionsData] = await Promise.all([
        getAuthorTopic(topicId),
        listAuthorPermissions(topicId, { limit: 100 }),
      ])

      setTopic(topicData)
      setPermissions(permissionsData.items)
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
  }, [topicId, toast, router, t])

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

  const handleRevokePermission = async (userId: number) => {
    try {
      await revokeAuthorPermission(topicId, userId)
      toast({
        title: t('permissions.revoked_success'),
        description: '',
      })
      loadData()
    } catch (_error) {
      toast({
        title: t('errors.delete_failed'),
        description: '',
        variant: 'destructive',
      })
    }
  }

  if (loading) {
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
                    <SelectItem value="question_creator">{t('permissions.roles.question_creator')}</SelectItem>
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
          {permissions.length === 0 ? (
            <div className="py-8 text-center">
              <p className="text-text-secondary">{t('permissions.no_permissions')}</p>
              <Button variant="outline" className="mt-4" onClick={() => setAddDialogOpen(true)}>
                <Plus className="mr-2 h-4 w-4" />
                {t('permissions.add')}
              </Button>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('permissions.user')}</TableHead>
                  <TableHead>{t('permissions.role')}</TableHead>
                  <TableHead>{t('permissions.granted_at')}</TableHead>
                  <TableHead className="text-right">{t('actions.delete')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {permissions.map(permission => (
                  <TableRow key={permission.id}>
                    <TableCell>
                      <div>
                        <div className="font-medium">
                          {permission.user_name || `User #${permission.user_id}`}
                        </div>
                        {permission.user_email && (
                          <div className="text-sm text-text-muted">{permission.user_email}</div>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
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
                    </TableCell>
                    <TableCell>{new Date(permission.granted_at).toLocaleDateString()}</TableCell>
                    <TableCell className="text-right">
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button variant="ghost" size="sm" className="text-destructive">
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>{t('permissions.remove')}</AlertDialogTitle>
                            <AlertDialogDescription>
                              {t('permissions.remove_description')}
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>{t('actions.cancel')}</AlertDialogCancel>
                            <AlertDialogAction
                              onClick={() => handleRevokePermission(permission.user_id)}
                              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                            >
                              {t('actions.confirm')}
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
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
