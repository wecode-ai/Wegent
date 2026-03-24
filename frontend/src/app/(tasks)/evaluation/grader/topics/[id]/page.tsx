// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { useRouter, useParams } from 'next/navigation'
import {
  FileText,
  CheckCircle,
  Send,
  Clock,
  Loader2,
  Play,
  Eye,
  RotateCcw,
  ArrowRight,
  BookOpen,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
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
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useToast } from '@/hooks/use-toast'
import { useTheme } from '@/features/theme/ThemeProvider'
import { EvaluationPageLayout } from '@wecode/components/evaluation/common/EvaluationPageLayout'
import { DataTable, type Column } from '@wecode/components/evaluation/common/DataTable'
import { EnhancedMarkdown } from '@/components/common/EnhancedMarkdown'
import { GraderHeader } from '@wecode/components/evaluation/grader'
import {
  graderGetTopic,
  graderGetTopicStatistics,
  graderListTasks,
  graderGetTask,
  graderExecuteTask,
  graderRetryTask,
  graderPublishTask,
  graderBatchExecuteTasks,
  graderBatchPublishTasks,
} from '@wecode/api/evaluation-grader'
import {
  GradingTaskStatus,
  type GradingTask,
  type Topic,
  type TopicStatistics,
  getStatusLabel,
} from '@wecode/types/evaluation'
import { useTranslation } from '@/hooks/useTranslation'
import { formatDateTime } from '@/utils/dateTime'

const TASKS_PER_PAGE = 20

function TopicGradingContent() {
  const router = useRouter()
  const params = useParams()
  const { toast } = useToast()
  const { theme } = useTheme()
  const { t } = useTranslation('evaluation')
  const topicId = parseInt(params.id as string)

  const [topic, setTopic] = useState<Topic | null>(null)
  const [statistics, setStatistics] = useState<TopicStatistics | null>(null)
  const [tasks, setTasks] = useState<GradingTask[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [selectedTasks, setSelectedTasks] = useState<Set<number>>(new Set())
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [page, setPage] = useState(1)
  const [executing, setExecuting] = useState(false)
  const [publishing, setPublishing] = useState(false)

  // Report dialog state
  const [reportDialogOpen, setReportDialogOpen] = useState(false)
  const [selectedTask, setSelectedTask] = useState<GradingTask | null>(null)
  const [loadingReport, setLoadingReport] = useState(false)

  // Load topic info
  const loadTopic = useCallback(async () => {
    setLoading(true)
    try {
      const [topicData, statsData] = await Promise.all([
        graderGetTopic(topicId),
        graderGetTopicStatistics(topicId),
      ])
      setTopic(topicData)
      setStatistics(statsData)
    } catch (_error) {
      toast({
        title: t('errors.load_failed'),
        description: '',
        variant: 'destructive',
      })
      router.push('/evaluation/grader')
    } finally {
      setLoading(false)
    }
  }, [topicId, toast, router, t])

  // Load tasks with filters
  const loadTasks = useCallback(async () => {
    try {
      const params: { page: number; limit: number; status?: number; topic_id: number } = {
        page,
        limit: TASKS_PER_PAGE,
        topic_id: topicId,
      }
      if (statusFilter !== 'all') {
        params.status = parseInt(statusFilter)
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
    }
  }, [page, statusFilter, topicId, toast, t])

  useEffect(() => {
    loadTopic()
  }, [loadTopic])

  useEffect(() => {
    if (topic) {
      loadTasks()
    }
  }, [topic, loadTasks])

  const handleExecuteSingle = useCallback(
    async (taskId: number) => {
      setExecuting(true)
      try {
        await graderExecuteTask(taskId)
        toast({
          title: t('grading.execute_success'),
          description: '',
        })
        loadTasks()
        loadTopic()
      } catch (_error) {
        toast({
          title: t('errors.execute_failed'),
          description: '',
          variant: 'destructive',
        })
      } finally {
        setExecuting(false)
      }
    },
    [toast, t, loadTasks, loadTopic]
  )

  const handleRetrySingle = useCallback(
    async (taskId: number) => {
      setExecuting(true)
      try {
        await graderRetryTask(taskId)
        toast({
          title: t('grading.execute_success'),
          description: '',
        })
        loadTasks()
        loadTopic()
      } catch (_error) {
        toast({
          title: t('errors.retry_failed'),
          description: '',
          variant: 'destructive',
        })
      } finally {
        setExecuting(false)
      }
    },
    [toast, t, loadTasks, loadTopic]
  )

  const handlePublishSingle = useCallback(
    async (taskId: number) => {
      setPublishing(true)
      try {
        await graderPublishTask(taskId)
        toast({
          title: t('grading.publish_success'),
          description: '',
        })
        loadTasks()
        loadTopic()
      } catch (_error) {
        toast({
          title: t('errors.publish_failed'),
          description: '',
          variant: 'destructive',
        })
      } finally {
        setPublishing(false)
      }
    },
    [toast, t, loadTasks, loadTopic]
  )

  const handleBatchExecute = useCallback(async () => {
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
      loadTopic()
    } catch (_error) {
      toast({
        title: t('errors.execute_failed'),
        description: '',
        variant: 'destructive',
      })
    } finally {
      setExecuting(false)
    }
  }, [selectedTasks, toast, t, loadTasks, loadTopic])

  const handleBatchPublish = useCallback(async () => {
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
      loadTopic()
    } catch (_error) {
      toast({
        title: t('errors.publish_failed'),
        description: '',
        variant: 'destructive',
      })
    } finally {
      setPublishing(false)
    }
  }, [selectedTasks, toast, t, loadTasks, loadTopic])

  const handleViewReport = useCallback(
    async (task: GradingTask) => {
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
    },
    [toast, t]
  )

  const handleViewAnswer = useCallback(
    (answerId: number) => {
      router.push(`/evaluation/grader/answers/${answerId}`)
    },
    [router]
  )

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

  const handleRefresh = () => {
    loadTopic()
    loadTasks()
  }

  const handleStatFilterChange = (filter: string) => {
    setStatusFilter(filter)
    setPage(1)
  }

  // Define table columns
  const columns: Column<GradingTask>[] = useMemo(
    () => [
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
        render: (task: GradingTask) => {
          const isRunning = task.status === GradingTaskStatus.RUNNING
          const statusLabel = getStatusLabel(task.status, 'grading', t)

          if (isRunning && task.task_id) {
            return (
              <Button
                variant="ghost"
                size="sm"
                className="h-auto px-2 py-1 text-xs"
                onClick={() => router.push(`/chat?taskId=${task.task_id}`)}
                title={t('grading.view_chat') || '点击查看聊天任务'}
              >
                <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                {statusLabel}
              </Button>
            )
          }

          return <Badge variant={getStatusBadgeVariant(task.status)}>{statusLabel}</Badge>
        },
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
            {task.grading_mode && task.status === GradingTaskStatus.PENDING && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleExecuteSingle(task.id)}
                disabled={executing}
                title={t('grading.execute')}
                className="h-8 w-8 p-0"
              >
                <Play className="h-4 w-4" />
              </Button>
            )}
            {task.grading_mode &&
              (task.status === GradingTaskStatus.FAILED ||
                task.status === GradingTaskStatus.RUNNING ||
                task.status === GradingTaskStatus.COMPLETED) && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleRetrySingle(task.id)}
                  disabled={executing}
                  title={t('grading.retry')}
                  className="h-8 w-8 p-0"
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
                  className="h-8 w-8 p-0"
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
                    className="h-8 px-3"
                  >
                    <Send className="mr-1 h-3 w-3" />
                    {t('grading.publish')}
                  </Button>
                )}
              </>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => handleViewAnswer(task.answer_id)}
              className="text-primary hover:text-primary/80"
            >
              {t('answers.view')}
              <ArrowRight className="ml-1 h-3 w-3" />
            </Button>
          </div>
        ),
      },
    ],
    [
      t,
      executing,
      publishing,
      handleExecuteSingle,
      handleRetrySingle,
      handlePublishSingle,
      handleViewReport,
      handleViewAnswer,
      router,
    ]
  )

  if (loading) {
    return (
      <div className="min-h-screen bg-[#fafbfc]">
        <GraderHeader title={t('grading.topic_tasks')} isLoading={true} />
        <main className="max-w-7xl mx-auto px-4 sm:px-8 py-8">
          <Skeleton className="h-8 w-1/2 mb-4" />
          <Skeleton className="h-4 w-3/4 mb-8" />
          <Skeleton className="h-96 rounded-2xl" />
        </main>
      </div>
    )
  }

  if (!topic) {
    return null
  }

  return (
    <div className="min-h-screen bg-[#fafbfc]">
      {/* Header */}
      <GraderHeader
        title={topic.name}
        description={topic.description}
        backHref="/evaluation/grader"
        onRefresh={handleRefresh}
        isLoading={loading}
      />

      {/* Main Content */}
      <main className="max-w-7xl mx-auto px-4 sm:px-8 py-8 space-y-6">
        {/* Statistics */}
        {statistics && (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
            <div
              onClick={() => handleStatFilterChange(statusFilter === '0' ? 'all' : '0')}
              className={`bg-white rounded-2xl border border-gray-100 p-4 transition-all duration-200 hover:shadow-md hover:-translate-y-[2px] cursor-pointer ${statusFilter === '0' ? 'ring-2 ring-primary shadow-md' : 'shadow-sm'}`}
            >
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-xl bg-amber-50 flex items-center justify-center">
                  <Clock className="h-5 w-5 text-amber-600" />
                </div>
                <div>
                  <div className="text-xs text-gray-500 font-medium">
                    {t('grading.status.pending')}
                  </div>
                  <div className="text-xl font-bold text-gray-900">
                    {statistics.grading_pending}
                  </div>
                </div>
              </div>
            </div>
            <div
              onClick={() => handleStatFilterChange(statusFilter === '2' ? 'all' : '2')}
              className={`bg-white rounded-2xl border border-gray-100 p-4 transition-all duration-200 hover:shadow-md hover:-translate-y-[2px] cursor-pointer ${statusFilter === '2' ? 'ring-2 ring-primary shadow-md' : 'shadow-sm'}`}
            >
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-xl bg-emerald-50 flex items-center justify-center">
                  <CheckCircle className="h-5 w-5 text-emerald-600" />
                </div>
                <div>
                  <div className="text-xs text-gray-500 font-medium">
                    {t('grading.status.completed')}
                  </div>
                  <div className="text-xl font-bold text-gray-900">
                    {statistics.grading_completed}
                  </div>
                </div>
              </div>
            </div>
            <div
              onClick={() => handleStatFilterChange(statusFilter === '4' ? 'all' : '4')}
              className={`bg-white rounded-2xl border border-gray-100 p-4 transition-all duration-200 hover:shadow-md hover:-translate-y-[2px] cursor-pointer ${statusFilter === '4' ? 'ring-2 ring-primary shadow-md' : 'shadow-sm'}`}
            >
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-xl bg-teal-50 flex items-center justify-center">
                  <Send className="h-5 w-5 text-teal-600" />
                </div>
                <div>
                  <div className="text-xs text-gray-500 font-medium">
                    {t('grading.status.published')}
                  </div>
                  <div className="text-xl font-bold text-gray-900">
                    {statistics.grading_published}
                  </div>
                </div>
              </div>
            </div>
            <div className="bg-white rounded-2xl border border-gray-100 p-4 shadow-sm">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-xl bg-blue-50 flex items-center justify-center">
                  <FileText className="h-5 w-5 text-blue-600" />
                </div>
                <div>
                  <div className="text-xs text-gray-500 font-medium">{t('answers.title')}</div>
                  <div className="text-xl font-bold text-gray-900">{statistics.total_answers}</div>
                </div>
              </div>
            </div>
            <div className="bg-white rounded-2xl border border-gray-100 p-4 shadow-sm">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-xl bg-purple-50 flex items-center justify-center">
                  <BookOpen className="h-5 w-5 text-purple-600" />
                </div>
                <div>
                  <div className="text-xs text-gray-500 font-medium">{t('questions.title')}</div>
                  <div className="text-xl font-bold text-gray-900">
                    {statistics.total_questions}
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Tasks Card */}
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-100">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-lg font-bold text-gray-900">{t('grading.tasks')}</h2>
                <p className="text-sm text-gray-500">
                  {total} {t('grading.tasks').toLowerCase()}
                </p>
              </div>
            </div>
          </div>

          <div className="p-6">
            {/* Filters and batch actions */}
            <div className="mb-4 flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-center gap-2">
                <Select value={statusFilter} onValueChange={setStatusFilter}>
                  <SelectTrigger className="w-40 bg-white border-gray-200">
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
              emptyIcon={<FileText className="mx-auto mb-4 h-12 w-12 text-gray-300" />}
              onPageChange={setPage}
              previousText={t('common.previous')}
              nextText={t('common.next')}
              pageText={t('common.page')}
              rowKey={(task: GradingTask) => task.id}
              selectable={true}
              selectedIds={selectedTasks}
              onSelectionChange={setSelectedTasks}
              selectAllText={t('grader.select_all')}
            />
          </div>
        </div>
      </main>

      {/* Report Dialog */}
      <Dialog open={reportDialogOpen} onOpenChange={setReportDialogOpen}>
        <DialogContent className="max-w-2xl bg-white rounded-2xl">
          <DialogHeader>
            <DialogTitle>{t('grading.report')}</DialogTitle>
            <DialogDescription>
              {selectedTask?.question_title || ''} - {selectedTask?.respondent_name || ''}
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-96 overflow-auto">
            {loadingReport ? (
              <Skeleton className="h-48 w-full" />
            ) : selectedTask?.report_data && Object.keys(selectedTask.report_data).length > 0 ? (
              <div className="rounded-xl bg-gray-50 p-4">
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

export default function TopicGradingPage() {
  return (
    <EvaluationPageLayout>
      <TopicGradingContent />
    </EvaluationPageLayout>
  )
}
