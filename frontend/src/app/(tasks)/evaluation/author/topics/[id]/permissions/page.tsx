// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter, useParams } from 'next/navigation'
import { ArrowLeft, Plus, Trash2, UserPlus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
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
import { useIsMobile } from '@/features/layout/hooks/useMediaQuery'
import {
  TaskSidebar,
  ResizableSidebar,
  CollapsedSidebarButtons,
} from '@/features/tasks/components/sidebar'
import TopNavigation from '@/features/layout/TopNavigation'
import {
  getAuthorTopic,
  listAuthorPermissions,
  grantAuthorPermission,
  revokeAuthorPermission,
} from '@wecode/api/evaluation-author'
import { PermissionRole, type Topic, type Permission, getRoleLabel } from '@wecode/types/evaluation'
import { useTranslation } from '@/hooks/useTranslation'
import '@/app/tasks/tasks.css'
import '@/features/common/scrollbar.css'

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

  // Add form state
  const [newUserId, setNewUserId] = useState('')
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
    if (!newUserId.trim()) {
      toast({
        title: t('errors.save_failed'),
        description: t('permissions.user') + ' ID is required',
        variant: 'destructive',
      })
      return
    }

    const userId = parseInt(newUserId.trim())
    if (isNaN(userId)) {
      toast({
        title: t('errors.save_failed'),
        description: 'Invalid user ID',
        variant: 'destructive',
      })
      return
    }

    setAdding(true)
    try {
      await grantAuthorPermission(topicId, {
        user_id: userId,
        role: newRole,
      })

      toast({
        title: t('permissions.granted_success', 'Permission granted successfully'),
        description: '',
      })
      setAddDialogOpen(false)
      setNewUserId('')
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
        title: t('permissions.revoked_success', 'Permission revoked successfully'),
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
          {t('actions.back', 'Back')}
        </Button>
        <Dialog open={addDialogOpen} onOpenChange={setAddDialogOpen}>
          <DialogTrigger asChild>
            <Button variant="primary">
              <UserPlus className="mr-2 h-4 w-4" />
              {t('permissions.add', 'Add Permission')}
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t('permissions.add', 'Add Permission')}</DialogTitle>
              <DialogDescription>
                {t('permissions.description', 'Grant access to this topic')}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label htmlFor="userId">{t('permissions.user', 'User')} ID *</Label>
                <Input
                  id="userId"
                  type="number"
                  value={newUserId}
                  onChange={e => setNewUserId(e.target.value)}
                  placeholder="Enter user ID"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="role">{t('permissions.role', 'Role')}</Label>
                <Select value={newRole} onValueChange={setNewRole}>
                  <SelectTrigger id="role">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="respondent">
                      {t('permissions.roles.respondent', 'Respondent')}
                    </SelectItem>
                    <SelectItem value="grader">
                      {t('permissions.roles.grader', 'Grader')}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setAddDialogOpen(false)}>
                {t('actions.cancel', 'Cancel')}
              </Button>
              <Button variant="primary" onClick={handleGrantPermission} disabled={adding}>
                {adding ? '...' : t('actions.save', 'Save')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t('permissions.title', 'Permissions')}</CardTitle>
          <CardDescription>
            {t('permissions.description', 'Manage access to this topic')} - {topic.name}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {permissions.length === 0 ? (
            <div className="py-8 text-center">
              <p className="text-text-secondary">
                {t('permissions.no_permissions', 'No permissions yet')}
              </p>
              <Button variant="outline" className="mt-4" onClick={() => setAddDialogOpen(true)}>
                <Plus className="mr-2 h-4 w-4" />
                {t('permissions.add', 'Add Permission')}
              </Button>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('permissions.user', 'User')}</TableHead>
                  <TableHead>{t('permissions.role', 'Role')}</TableHead>
                  <TableHead>{t('permissions.granted_at', 'Granted At')}</TableHead>
                  <TableHead className="text-right">{t('actions.delete', 'Delete')}</TableHead>
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
                          permission.role === PermissionRole.GRADER ? 'default' : 'secondary'
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
                            <AlertDialogTitle>
                              {t('permissions.remove', 'Remove Permission')}
                            </AlertDialogTitle>
                            <AlertDialogDescription>
                              {t(
                                'permissions.remove_description',
                                'Are you sure you want to revoke this permission?'
                              )}
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>{t('actions.cancel', 'Cancel')}</AlertDialogCancel>
                            <AlertDialogAction
                              onClick={() => handleRevokePermission(permission.user_id)}
                              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                            >
                              {t('actions.confirm', 'Confirm')}
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
  const isMobile = useIsMobile()
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false)
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false)

  if (isMobile) {
    return (
      <div className="flex h-dvh flex-col">
        <TaskSidebar
          isMobileSidebarOpen={isMobileSidebarOpen}
          setIsMobileSidebarOpen={setIsMobileSidebarOpen}
          pageType="evaluation"
        />
        <PermissionsContent />
      </div>
    )
  }

  return (
    <div className="flex h-dvh overflow-hidden">
      {isSidebarCollapsed ? (
        <CollapsedSidebarButtons
          onExpand={() => setIsSidebarCollapsed(false)}
          onNewTask={() => {}}
        />
      ) : (
        <ResizableSidebar
          minWidth={220}
          maxWidth={400}
          defaultWidth={280}
          storageKey="evaluation-sidebar-width"
        >
          <TaskSidebar
            isMobileSidebarOpen={isMobileSidebarOpen}
            setIsMobileSidebarOpen={setIsMobileSidebarOpen}
            pageType="evaluation"
            isCollapsed={isSidebarCollapsed}
            onToggleCollapsed={() => setIsSidebarCollapsed(!isSidebarCollapsed)}
          />
        </ResizableSidebar>
      )}
      <div className="flex flex-1 flex-col overflow-hidden">
        <TopNavigation activePage="evaluation" />
        <main className="flex-1 overflow-auto">
          <PermissionsContent />
        </main>
      </div>
    </div>
  )
}
