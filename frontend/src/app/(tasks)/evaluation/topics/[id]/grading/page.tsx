// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter, useParams } from 'next/navigation'
import { ArrowLeft, Play, Send, Eye, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Checkbox } from '@/components/ui/checkbox'
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useToast } from '@/hooks/use-toast'
import { useIsMobile } from '@/features/layout/hooks/useMediaQuery'
import {
  TaskSidebar,
  ResizableSidebar,
  CollapsedSidebarButtons,
} from '@/features/tasks/components/sidebar'
import TopNavigation from '@/features/layout/TopNavigation'
import {
  getTopic,
  listGradingTasks,
  executeGradingTask,
  publishGradingTask,
  batchExecuteGradingTasks,
  batchPublishGradingTasks,
  getMyRole,
  getGradingTask,
} from '@wecode/api/evaluation'
import {
  GradingTaskStatus,
  type Topic,
  type GradingTask,
  type UserRole,
  getStatusLabel,
} from '@wecode/types/evaluation'
import { useTranslation } from '@/hooks/useTranslation'
import '@/app/tasks/tasks.css'
import '@/features/common/scrollbar.css'

function GradingContent() {
  const router = useRouter()
  const params = useParams()
  const { toast } = useToast()
  const { t } = useTranslation('evaluation')
  const topicId = parseInt(params.id as string)

  const [topic, setTopic] = useState<Topic | null>(null)
  const [tasks, setTasks] = useState<GradingTask[]>([])
  const [userRole, setUserRole] = useState<UserRole | null>(null)
  const [loading, setLoading] = useState(true)
  const [selectedTasks, setSelectedTasks] = useState<Set<number>>(new Set())
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [executing, setExecuting] = useState(false)
  const [publishing, setPublishing] = useState(false)

  // Report dialog state
  const [reportDialogOpen, setReportDialogOpen] = useState(false)
  const [selectedTask, setSelectedTask] = useState<GradingTask | null>(null)
  const [loadingReport, setLoadingReport] = useState(false)

  const loadData = useCallback(async () => {
    setLoading(true)
    try {
      const [topicData, roleData] = await Promise.all([getTopic(topicId), getMyRole(topicId)])

      if (!roleData.can_grade) {
        toast({
          title: t('errors.permission_denied'),
          description: '',
          variant: 'destructive',
        })
        router.push(`/evaluation/topics/${topicId}`)
        return
      }

      setTopic(topicData)
      setUserRole(roleData)

      // Load grading tasks
      const params: { limit: number; status?: number } = { limit: 100 }
      if (statusFilter !== 'all') {
        params.status = parseInt(statusFilter)
      }
      const tasksData = await listGradingTasks(topicId, params)
      setTasks(tasksData.items)
    } catch (_error) {
      toast({
        title: t('errors.load_failed'),
        description: t('errors.not_found'),
        variant: 'destructive',
      })
      router.push('/evaluation/topics')
    } finally {
      setLoading(false)
    }
  }, [topicId, statusFilter, toast, router, t])

  useEffect(() => {
    if (topicId) {
      loadData()
    }
  }, [topicId, loadData])

  const handleSelectTask = (taskId: number, checked: boolean) => {
    const newSelected = new Set(selectedTasks)
    if (checked) {
      newSelected.add(taskId)
    } else {
      newSelected.delete(taskId)
    }
    setSelectedTasks(newSelected)
  }

  const handleSelectAll = (checked: boolean) => {
    if (checked) {
      setSelectedTasks(new Set(tasks.map(task => task.id)))
    } else {
      setSelectedTasks(new Set())
    }
  }

  const handleExecuteSingle = async (taskId: number) => {
    setExecuting(true)
    try {
      await executeGradingTask(taskId)
      toast({
        title: t('grading.execute_success'),
        description: '',
      })
      loadData()
    } catch (_error) {
      toast({
        title: t('errors.save_failed'),
        description: '',
        variant: 'destructive',
      })
    } finally {
      setExecuting(false)
    }
  }

  const handlePublishSingle = async (taskId: number) => {
    setPublishing(true)
    try {
      await publishGradingTask(taskId)
      toast({
        title: t('grading.publish_success'),
        description: '',
      })
      loadData()
    } catch (_error) {
      toast({
        title: t('errors.save_failed'),
        description: '',
        variant: 'destructive',
      })
    } finally {
      setPublishing(false)
    }
  }

  const handleBatchExecute = async () => {
    if (selectedTasks.size === 0) return

    setExecuting(true)
    try {
      const result = await batchExecuteGradingTasks(topicId, Array.from(selectedTasks))
      toast({
        title: t('grading.execute_success'),
        description: `${result.executed_count} tasks started`,
      })
      setSelectedTasks(new Set())
      loadData()
    } catch (_error) {
      toast({
        title: t('errors.save_failed'),
        description: '',
        variant: 'destructive',
      })
    } finally {
      setExecuting(false)
    }
  }

  const handleBatchPublish = async () => {
    if (selectedTasks.size === 0) return

    setPublishing(true)
    try {
      const result = await batchPublishGradingTasks(topicId, Array.from(selectedTasks))
      toast({
        title: t('grading.publish_success'),
        description: `${result.published_count} reports published`,
      })
      setSelectedTasks(new Set())
      loadData()
    } catch (_error) {
      toast({
        title: t('errors.save_failed'),
        description: '',
        variant: 'destructive',
      })
    } finally {
      setPublishing(false)
    }
  }

  const handleViewReport = async (task: GradingTask) => {
    setLoadingReport(true)
    setReportDialogOpen(true)
    try {
      const fullTask = await getGradingTask(task.id)
      setSelectedTask(fullTask)
    } catch (_error) {
      toast({
        title: t('errors.load_failed'),
        description: '',
        variant: 'destructive',
      })
    } finally {
      setLoadingReport(false)
    }
  }

  const getStatusBadgeVariant = (status: number) => {
    switch (status) {
      case GradingTaskStatus.PENDING:
        return 'secondary'
      case GradingTaskStatus.RUNNING:
        return 'info'
      case GradingTaskStatus.COMPLETED:
        return 'default'
      case GradingTaskStatus.FAILED:
        return 'destructive'
      case GradingTaskStatus.PUBLISHED:
        return 'success'
      default:
        return 'secondary'
    }
  }

  if (loading) {
    return (
      <div className="container mx-auto max-w-6xl px-4 py-8">
        <Skeleton className="mb-6 h-10 w-32" />
        <Skeleton className="h-96 w-full" />
      </div>
    )
  }

  if (!topic || !userRole?.can_grade) {
    return null
  }

  const pendingTasks = tasks.filter(t => t.status === GradingTaskStatus.PENDING)
  const completedTasks = tasks.filter(t => t.status === GradingTaskStatus.COMPLETED)

  return (
    <div className="container mx-auto max-w-6xl px-4 py-8">
      {/* Header */}
      <div className="mb-6 flex items-center justify-between">
        <Button variant="ghost" onClick={() => router.push(`/evaluation/topics/${topicId}`)}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          {t('actions.back')}
        </Button>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={loadData}>
            <RefreshCw className="mr-2 h-4 w-4" />
            {t('actions.refresh')}
          </Button>
        </div>
      </div>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>{t('grading.tasks')}</CardTitle>
          <CardDescription>
            {topic.name} - {tasks.length} {t('grading.tasks').toLowerCase()}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {/* Filters and batch actions */}
          <div className="mb-4 flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-2">
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Status</SelectItem>
                  <SelectItem value="0">{t('grading.status.pending')}</SelectItem>
                  <SelectItem value="1">{t('grading.status.running')}</SelectItem>
                  <SelectItem value="2">{t('grading.status.completed')}</SelectItem>
                  <SelectItem value="3">{t('grading.status.failed')}</SelectItem>
                  <SelectItem value="4">{t('grading.status.published')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {selectedTasks.size > 0 && (
              <div className="flex items-center gap-2">
                <span className="text-sm text-text-muted">{selectedTasks.size} selected</span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleBatchExecute}
                  disabled={executing}
                >
                  <Play className="mr-2 h-4 w-4" />
                  {t('grading.batch_execute')}
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={handleBatchPublish}
                  disabled={publishing}
                >
                  <Send className="mr-2 h-4 w-4" />
                  {t('grading.batch_publish')}
                </Button>
              </div>
            )}
          </div>

          {/* Summary */}
          <div className="mb-4 grid grid-cols-2 gap-4 md:grid-cols-5">
            <div className="rounded-lg bg-surface p-3">
              <div className="text-sm text-text-muted">{t('grading.status.pending')}</div>
              <div className="text-xl font-semibold">{pendingTasks.length}</div>
            </div>
            <div className="rounded-lg bg-surface p-3">
              <div className="text-sm text-text-muted">{t('grading.status.running')}</div>
              <div className="text-xl font-semibold">
                {tasks.filter(t => t.status === GradingTaskStatus.RUNNING).length}
              </div>
            </div>
            <div className="rounded-lg bg-surface p-3">
              <div className="text-sm text-text-muted">{t('grading.status.completed')}</div>
              <div className="text-xl font-semibold">{completedTasks.length}</div>
            </div>
            <div className="rounded-lg bg-surface p-3">
              <div className="text-sm text-text-muted">{t('grading.status.failed')}</div>
              <div className="text-xl font-semibold">
                {tasks.filter(t => t.status === GradingTaskStatus.FAILED).length}
              </div>
            </div>
            <div className="rounded-lg bg-surface p-3">
              <div className="text-sm text-text-muted">{t('grading.status.published')}</div>
              <div className="text-xl font-semibold">
                {tasks.filter(t => t.status === GradingTaskStatus.PUBLISHED).length}
              </div>
            </div>
          </div>

          {/* Tasks table */}
          {tasks.length === 0 ? (
            <div className="py-8 text-center">
              <p className="text-text-secondary">{t('grading.no_tasks')}</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-12">
                    <Checkbox
                      checked={selectedTasks.size === tasks.length && tasks.length > 0}
                      onCheckedChange={handleSelectAll}
                    />
                  </TableHead>
                  <TableHead>ID</TableHead>
                  <TableHead>{t('questions.question_title')}</TableHead>
                  <TableHead>{t('permissions.user')}</TableHead>
                  <TableHead>{t('grading.status.pending')}</TableHead>
                  <TableHead className="text-right">{t('actions.view')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tasks.map(task => (
                  <TableRow key={task.id}>
                    <TableCell>
                      <Checkbox
                        checked={selectedTasks.has(task.id)}
                        onCheckedChange={checked => handleSelectTask(task.id, checked as boolean)}
                      />
                    </TableCell>
                    <TableCell className="font-mono text-sm">{task.id}</TableCell>
                    <TableCell>{task.question_title || `Question #${task.question_id}`}</TableCell>
                    <TableCell>{task.respondent_name || `User #${task.respondent_id}`}</TableCell>
                    <TableCell>
                      <Badge variant={getStatusBadgeVariant(task.status)}>
                        {getStatusLabel(task.status, 'grading')}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-2">
                        {task.status === GradingTaskStatus.PENDING && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleExecuteSingle(task.id)}
                            disabled={executing}
                          >
                            <Play className="h-4 w-4" />
                          </Button>
                        )}
                        {(task.status === GradingTaskStatus.COMPLETED ||
                          task.status === GradingTaskStatus.PUBLISHED) && (
                          <>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => handleViewReport(task)}
                            >
                              <Eye className="h-4 w-4" />
                            </Button>
                            {task.status === GradingTaskStatus.COMPLETED && (
                              <Button
                                variant="primary"
                                size="sm"
                                onClick={() => handlePublishSingle(task.id)}
                                disabled={publishing}
                              >
                                <Send className="h-4 w-4" />
                              </Button>
                            )}
                          </>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Report Dialog */}
      <Dialog open={reportDialogOpen} onOpenChange={setReportDialogOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t('grading.report')}</DialogTitle>
            <DialogDescription>
              {selectedTask?.question_title || ''} - {selectedTask?.respondent_name || ''}
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-96 overflow-auto">
            {loadingReport ? (
              <Skeleton className="h-48 w-full" />
            ) : selectedTask?.report_data ? (
              <pre className="whitespace-pre-wrap rounded-lg bg-surface p-4 text-sm">
                {typeof selectedTask.report_data === 'string'
                  ? selectedTask.report_data
                  : JSON.stringify(selectedTask.report_data, null, 2)}
              </pre>
            ) : (
              <p className="text-text-secondary">No report data available</p>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

export default function GradingPage() {
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
        <GradingContent />
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
          <GradingContent />
        </main>
      </div>
    </div>
  )
}
