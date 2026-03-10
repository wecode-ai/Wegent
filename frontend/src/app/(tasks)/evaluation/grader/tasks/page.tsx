// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import {
  ClipboardList,
  CheckCircle,
  XCircle,
  Send,
  Clock,
  RefreshCw,
  Loader2,
  Play,
  Eye,
  RotateCcw,
  ArrowLeft,
  Filter,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Input } from '@/components/ui/input'
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
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useToast } from '@/hooks/use-toast'
import { useTheme } from '@/features/theme/ThemeProvider'
import { EvaluationPageLayout } from '@wecode/components/evaluation/common/EvaluationPageLayout'
import { DataTable, type Column } from '@wecode/components/evaluation/common/DataTable'
import { EnhancedMarkdown } from '@/components/common/EnhancedMarkdown'
import {
  graderListTasks,
  graderGetTask,
  graderExecuteTask,
  graderRetryTask,
  graderPublishTask,
  graderBatchExecuteTasks,
  graderBatchPublishTasks,
  graderListTopics,
  type GraderTopicItem,
} from '@wecode/api/evaluation-grader'
import { GradingTaskStatus, type GradingTask, getStatusLabel } from '@wecode/types/evaluation'
import { useTranslation } from '@/hooks/useTranslation'
import { formatDateTime } from '@/utils/dateTime'

const TASKS_PER_PAGE = 20

function GraderTasksContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { toast } = useToast()
  const { theme } = useTheme()
  const { t } = useTranslation('evaluation')

  // Get initial filters from URL
  const initialStatus = searchParams.get('status')
  const initialTopicId = searchParams.get('topic')
  const initialSearch = searchParams.get('search')

  const [topics, setTopics] = useState<GraderTopicItem[]>([])
  const [tasks, setTasks] = useState<GradingTask[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [selectedTasks, setSelectedTasks] = useState<Set<number>>(new Set())
  const [statusFilter, setStatusFilter] = useState<string>(initialStatus ?? 'all')
  const [topicFilter, setTopicFilter] = useState<string>(initialTopicId ?? 'all')
  const [searchQuery, setSearchQuery] = useState<string>(initialSearch ?? '')
  const [page, setPage] = useState(1)
  const [executing, setExecuting] = useState(false)
  const [publishing, setPublishing] = useState(false)

  // Report dialog state
  const [reportDialogOpen, setReportDialogOpen] = useState(false)
  const [selectedTask, setSelectedTask] = useState<GradingTask | null>(null)
  const [loadingReport, setLoadingReport] = useState(false)

  // Load topics list
  const loadTopics = useCallback(async () => {
    try {
      const topicsData = await graderListTopics({ page: 1, limit: 100 })
      setTopics(topicsData.items)
    } catch (_error) {
      // Silent fail for topics list
    }
  }, [])

  // Load tasks with filters
  const loadTasks = useCallback(async () => {
    setLoading(true)
    try {
      const params: { page: number; limit: number; status?: number; topic_id?: number } = {
        page,
        limit: TASKS_PER_PAGE,
      }
      if (statusFilter !== 'all') {
        params.status = parseInt(statusFilter)
      }
      if (topicFilter !== 'all') {
        params.topic_id = parseInt(topicFilter)
      }
      const response = await graderListTasks(params)
      setTasks(response.items)
      setTotal(response.total)
    } catch (_error) {
      toast({
        title: t('errors.load_failed'),
        description: '',
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
    }
  }, [page, statusFilter, topicFilter, toast, t])

  useEffect(() => {
    loadTopics()
  }, [loadTopics])

  useEffect(() => {
    loadTasks()
  }, [loadTasks])

  // Update URL when filters change
  useEffect(() => {
    const params = new URLSearchParams()
    if (statusFilter !== 'all') params.set('status', statusFilter)
    if (topicFilter !== 'all') params.set('topic', topicFilter)
    if (searchQuery) params.set('search', searchQuery)
    const newUrl = params.toString() ? `?${params.toString()}` : '/evaluation/grader/tasks'
    router.replace(newUrl, { scroll: false })
  }, [statusFilter, topicFilter, searchQuery, router])

  const handleExecuteSingle = async (taskId: number) => {
    setExecuting(true)
    try {
      await graderExecuteTask(taskId)
      toast({
        title: t('grading.execute_success'),
        description: '',
      })
      loadTasks()
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

  const handleRetrySingle = async (taskId: number) => {
    setExecuting(true)
    try {
      await graderRetryTask(taskId)
      toast({
        title: t('grading.execute_success'),
        description: '',
      })
      loadTasks()
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
      await graderPublishTask(taskId)
      toast({
        title: t('grading.publish_success'),
        description: '',
      })
      loadTasks()
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
      const result = await graderBatchExecuteTasks(Array.from(selectedTasks))
      toast({
        title: t('grading.execute_success'),
        description: `${result.executed_count} ${t('grading.tasks').toLowerCase()}`,
      })
      setSelectedTasks(new Set())
      loadTasks()
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
      const result = await graderBatchPublishTasks(Array.from(selectedTasks))
      toast({
        title: t('grading.publish_success'),
        description: `${result.published_count} ${t('grading.tasks').toLowerCase()}`,
      })
      setSelectedTasks(new Set())
      loadTasks()
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
      const fullTask = await graderGetTask(task.id)
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

  const handleViewAnswer = (answerId: number) => {
    router.push(`/evaluation/grader/answers/${answerId}`)
  }

  const getStatusBadgeVariant = (
    status: number
  ): 'default' | 'success' | 'error' | 'info' | 'warning' | 'secondary' => {
    switch (status) {
      case GradingTaskStatus.PENDING:
        return 'secondary'
      case GradingTaskStatus.RUNNING:
        return 'info'
      case GradingTaskStatus.COMPLETED:
        return 'default'
      case GradingTaskStatus.FAILED:
        return 'error'
      case GradingTaskStatus.PUBLISHED:
        return 'success'
      default:
        return 'secondary'
    }
  }

  const getStatusIcon = (status: number) => {
    switch (status) {
      case GradingTaskStatus.PENDING:
        return <Clock className="h-4 w-4" />
      case GradingTaskStatus.RUNNING:
        return <Loader2 className="h-4 w-4 animate-spin" />
      case GradingTaskStatus.COMPLETED:
        return <CheckCircle className="h-4 w-4" />
      case GradingTaskStatus.FAILED:
        return <XCircle className="h-4 w-4" />
      case GradingTaskStatus.PUBLISHED:
        return <Send className="h-4 w-4" />
      default:
        return <Clock className="h-4 w-4" />
    }
  }

  const handleRefresh = () => {
    loadTasks()
  }

  // Define table columns
  const columns: Column<GradingTask>[] = useMemo(
    () => [
      {
        key: 'id',
        title: t('common.id'),
        className: 'font-mono text-xs text-text-muted',
        render: (task: GradingTask) => `#${task.id}`,
      },
      {
        key: 'topic',
        title: t('topics.topic_name'),
        render: (task: GradingTask) => (
          <span className="text-text-secondary">{task.topic_name || '-'}</span>
        ),
      },
      {
        key: 'question',
        title: t('questions.question_title'),
        render: (task: GradingTask) => task.question_title || `Question #${task.question_id}`,
      },
      {
        key: 'user',
        title: t('permissions.user'),
        render: (task: GradingTask) => task.respondent_name || `User #${task.respondent_id}`,
      },
      {
        key: 'status',
        title: t('common.status'),
        render: (task: GradingTask) => (
          <Badge
            variant={getStatusBadgeVariant(task.status)}
            className="flex w-fit items-center gap-1"
          >
            {getStatusIcon(task.status)}
            {getStatusLabel(task.status, 'grading', t)}
          </Badge>
        ),
      },
      {
        key: 'submitted_at',
        title: t('answers.submitted_at'),
        render: (task: GradingTask) => (
          <span className="text-text-secondary">
            {task.submitted_at ? formatDateTime(new Date(task.submitted_at).getTime()) : '-'}
          </span>
        ),
      },
      {
        key: 'actions',
        title: t('common:actions.view'),
        className: 'text-right',
        render: (task: GradingTask) => (
          <div className="flex items-center justify-end gap-2">
            {/* AI Grading Actions */}
            {task.team_id > 0 && task.status === GradingTaskStatus.PENDING && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleExecuteSingle(task.id)}
                disabled={executing}
                title={t('grading.execute')}
              >
                <Play className="h-4 w-4" />
              </Button>
            )}
            {task.team_id > 0 &&
              (task.status === GradingTaskStatus.FAILED ||
                task.status === GradingTaskStatus.RUNNING ||
                task.status === GradingTaskStatus.COMPLETED) && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleRetrySingle(task.id)}
                  disabled={executing}
                  title={t('grading.retry')}
                >
                  <RotateCcw className="h-4 w-4" />
                </Button>
              )}
            {(task.status === GradingTaskStatus.COMPLETED ||
              task.status === GradingTaskStatus.PUBLISHED) && (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleViewReport(task)}
                  title={t('grading.view_report')}
                >
                  <Eye className="h-4 w-4" />
                </Button>
                {task.status === GradingTaskStatus.COMPLETED && (
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => handlePublishSingle(task.id)}
                    disabled={publishing}
                    title={t('grading.publish')}
                  >
                    <Send className="h-4 w-4" />
                  </Button>
                )}
              </>
            )}
            <Button variant="ghost" size="sm" onClick={() => handleViewAnswer(task.answer_id)}>
              {t('answers.view')}
            </Button>
          </div>
        ),
      },
    ],
    [t, executing, publishing]
  )

  if (loading && tasks.length === 0) {
    return (
      <div className="container mx-auto max-w-6xl px-4 py-8">
        <Skeleton className="mb-6 h-10 w-64" />
        <Skeleton className="h-96 w-full" />
      </div>
    )
  }

  return (
    <div className="container mx-auto max-w-6xl px-4 py-8">
      {/* Header */}
      <div className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="sm" onClick={() => router.push('/evaluation/grader')}>
            <ArrowLeft className="mr-2 h-4 w-4" />
            {t('actions.back')}
          </Button>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
              <ClipboardList className="h-5 w-5 text-primary" />
            </div>
            <div>
              <h1 className="text-xl font-semibold text-text-primary">{t('grading.tasks')}</h1>
              <p className="text-sm text-text-secondary">
                {total} {t('grading.tasks').toLowerCase()}
              </p>
            </div>
          </div>
        </div>
        <Button variant="outline" onClick={handleRefresh}>
          <RefreshCw className="mr-2 h-4 w-4" />
          {t('common:actions.refresh')}
        </Button>
      </div>

      {/* Tasks Card */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Filter className="h-5 w-5" />
            {t('grading.tasks')}
          </CardTitle>
          <CardDescription>{t('grader.tasks_description')}</CardDescription>
        </CardHeader>
        <CardContent>
          {/* Filters and batch actions */}
          <div className="mb-4 flex flex-wrap items-center justify-between gap-4">
            <div className="flex flex-wrap items-center gap-2">
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t('common.all_status')}</SelectItem>
                  <SelectItem value="0">{t('grading.status.pending')}</SelectItem>
                  <SelectItem value="1">{t('grading.status.running')}</SelectItem>
                  <SelectItem value="2">{t('grading.status.completed')}</SelectItem>
                  <SelectItem value="3">{t('grading.status.failed')}</SelectItem>
                  <SelectItem value="4">{t('grading.status.published')}</SelectItem>
                </SelectContent>
              </Select>
              <Select value={topicFilter} onValueChange={setTopicFilter}>
                <SelectTrigger className="w-48">
                  <SelectValue placeholder={t('topics.all_topics')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t('topics.all_topics')}</SelectItem>
                  {topics.map(topic => (
                    <SelectItem key={topic.id} value={topic.id.toString()}>
                      {topic.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                placeholder={t('topics.search_placeholder')}
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                className="w-48"
              />
            </div>
            {selectedTasks.size > 0 && (
              <div className="flex items-center gap-2">
                <span className="text-sm text-text-muted">
                  {t('common.selected', { count: selectedTasks.size })}
                </span>
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

          {/* Tasks table */}
          <DataTable
            columns={columns}
            data={tasks}
            total={total}
            page={page}
            pageSize={TASKS_PER_PAGE}
            loading={loading}
            emptyMessage={t('grading.no_tasks')}
            emptyIcon={<ClipboardList className="mx-auto mb-4 h-12 w-12 text-text-muted" />}
            onPageChange={setPage}
            previousText={t('common.previous')}
            nextText={t('common.next')}
            pageText={t('common.page')}
            rowKey={(task: GradingTask) => task.id}
            selectable={true}
            selectedIds={selectedTasks}
            onSelectionChange={setSelectedTasks}
            selectAllText={t('common.select_all')}
          />
        </CardContent>
      </Card>

      {/* Report Dialog */}
      <Dialog open={reportDialogOpen} onOpenChange={setReportDialogOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t('grading.report')}</DialogTitle>
            <DialogDescription>
              {selectedTask?.topic_name && `[${selectedTask.topic_name}] `}
              {selectedTask?.question_title || ''} - {selectedTask?.respondent_name || ''}
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-96 overflow-auto">
            {loadingReport ? (
              <Skeleton className="h-48 w-full" />
            ) : selectedTask?.report_data && Object.keys(selectedTask.report_data).length > 0 ? (
              <div className="rounded-lg bg-surface p-4">
                <EnhancedMarkdown
                  source={
                    typeof selectedTask.report_data === 'string'
                      ? selectedTask.report_data
                      : typeof selectedTask.report_data.content === 'string'
                        ? selectedTask.report_data.content
                        : JSON.stringify(selectedTask.report_data, null, 2)
                  }
                  theme={theme === 'dark' ? 'dark' : 'light'}
                />
              </div>
            ) : (
              <p className="text-text-secondary">{t('grading.no_report_data')}</p>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

export default function GraderTasksPage() {
  return (
    <EvaluationPageLayout title="Grading Tasks">
      <GraderTasksContent />
    </EvaluationPageLayout>
  )
}
