// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import {
  CheckCircle,
  Send,
  Eye,
  RotateCcw,
  Loader2,
  Play,
  FileText,
  ArrowRight,
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
import { GraderHeader, GraderStats } from '@wecode/components/evaluation/grader'
import {
  getGraderDashboard,
  type GraderDashboardStats,
  listGraderTasks,
  getGraderTask,
} from '@wecode/api/evaluation'
import { graderListTopics, type GraderTopicItem } from '@wecode/api/evaluation-grader'
import { fetchFileContent } from '@wecode/api/evaluation-shared'
import { GradingTaskStatus, type GradingTask, getStatusLabel } from '@wecode/types/evaluation'
import { useTranslation } from '@/hooks/useTranslation'
import { formatDateTime } from '@/utils/dateTime'
import { useGradingActions } from '@wecode/components/evaluation/grader/useGradingActions'

const TASKS_PER_PAGE = 20

function GraderDashboardContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { toast } = useToast()
  const { theme } = useTheme()
  const { t } = useTranslation('evaluation')

  // Get initial filters from URL
  const initialStatus = searchParams.get('status')
  const initialTopicId = searchParams.get('topic')

  const [stats, setStats] = useState<GraderDashboardStats | null>(null)
  const [topics, setTopics] = useState<GraderTopicItem[]>([])
  const [tasks, setTasks] = useState<GradingTask[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [selectedTasks, setSelectedTasks] = useState<Set<number>>(new Set())
  const [statusFilter, setStatusFilter] = useState<string>(initialStatus ?? 'all')
  const [topicFilter, setTopicFilter] = useState<string>(initialTopicId ?? 'all')
  const [page, setPage] = useState(1)
  const { executing, publishing, retryTask, publishTask, batchExecute, batchPublish } =
    useGradingActions({
      onSuccess: () => {
        loadTasks()
        loadDashboard()
        setSelectedTasks(new Set())
      },
    })

  // Report dialog state
  const [reportDialogOpen, setReportDialogOpen] = useState(false)
  const [selectedTask, setSelectedTask] = useState<GradingTask | null>(null)
  const [loadingReport, setLoadingReport] = useState(false)
  const [reportContent, setReportContent] = useState<string>('')

  // Load dashboard stats and topics list
  const loadDashboard = useCallback(async () => {
    setLoading(true)
    try {
      const [dashboardData, topicsData] = await Promise.all([
        getGraderDashboard(),
        graderListTopics({ page: 1, limit: 100 }),
      ])
      setStats(dashboardData)
      setTopics(topicsData.items)
    } catch (_error) {
      toast({
        title: t('errors.load_failed'),
        description: '',
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
    }
  }, [toast, t])

  // Load tasks with filters
  const loadTasks = useCallback(async () => {
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
      const response = await listGraderTasks(params)
      setTasks(response.items)
      setTotal(response.total)
    } catch (_error) {
      toast({
        title: t('errors.load_failed'),
        description: '',
        variant: 'destructive',
      })
    }
  }, [page, statusFilter, topicFilter, toast, t])

  useEffect(() => {
    loadDashboard()
  }, [loadDashboard])

  useEffect(() => {
    loadTasks()
  }, [loadTasks])

  // Update URL when filters change
  useEffect(() => {
    const params = new URLSearchParams()
    if (statusFilter !== 'all') params.set('status', statusFilter)
    if (topicFilter !== 'all') params.set('topic', topicFilter)
    const newUrl = params.toString() ? `?${params.toString()}` : '/evaluation/grader'
    router.replace(newUrl, { scroll: false })
  }, [statusFilter, topicFilter, router])

  const handleRetrySingle = useCallback(
    async (taskId: number) => {
      // Retry with topic's original config - graders cannot modify anything
      await retryTask(taskId)
    },
    [retryTask]
  )

  const handlePublishSingle = useCallback(
    (taskId: number) => {
      publishTask(taskId)
    },
    [publishTask]
  )

  const handleBatchExecute = useCallback(() => {
    batchExecute(Array.from(selectedTasks))
  }, [batchExecute, selectedTasks])

  const handleBatchPublish = useCallback(() => {
    batchPublish(Array.from(selectedTasks))
  }, [batchPublish, selectedTasks])

  const handleViewReport = useCallback(
    async (task: GradingTask) => {
      setLoadingReport(true)
      setReportContent('')
      setReportDialogOpen(true)
      try {
        const fullTask = await getGraderTask(task.id)
        setSelectedTask(fullTask)

        // Extract report content - priority: final > human > ai
        // And prefer S3 (full content) over inline (truncated)
        const reportData = fullTask.report_data || {}
        let content = ''

        // Helper to get S3 path and inline content from a report section
        const getReportSection = (section: unknown): { s3Path?: string; content?: string } => {
          if (!section || typeof section !== 'object') return {}
          const s = section as Record<string, unknown>
          return {
            s3Path: typeof s.s3_path === 'string' ? s.s3_path : undefined,
            content: typeof s.content === 'string' ? s.content : undefined,
          }
        }

        const finalReport = getReportSection(reportData.final_report)
        const humanReport = getReportSection(reportData.human_report)
        const aiReport = getReportSection(reportData.ai_report)

        // Try final report first (published content)
        if (finalReport.s3Path) {
          content = await fetchFileContent(finalReport.s3Path)
        }
        if (!content && finalReport.content) {
          content = finalReport.content
        }

        // Then human report (draft)
        if (!content && humanReport.s3Path) {
          content = await fetchFileContent(humanReport.s3Path)
        }
        if (!content && humanReport.content) {
          content = humanReport.content
        }

        // Finally AI report
        if (!content && aiReport.s3Path) {
          content = await fetchFileContent(aiReport.s3Path)
        }
        if (!content && aiReport.content) {
          content = aiReport.content
        }

        setReportContent(content || '')
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
    loadDashboard()
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
        render: (task: GradingTask) => {
          const reportData = task.report_data || {}
          const humanReport = reportData.human_report as
            | { content?: string; s3_path?: string }
            | undefined
          const hasHumanReport = !!(humanReport?.content || humanReport?.s3_path)
          const isDraft =
            hasHumanReport &&
            (task.status === GradingTaskStatus.PENDING || task.status === GradingTaskStatus.FAILED)

          if (isDraft) {
            return <Badge variant="warning">{t('grading.human_report_draft') || 'Draft'}</Badge>
          }

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
        render: (task: GradingTask) => {
          const reportData = task.report_data || {}
          const humanReport = reportData.human_report as
            | { content?: string; s3_path?: string }
            | undefined
          const hasHumanReport = !!(humanReport?.content || humanReport?.s3_path)
          const canPublish =
            task.status === GradingTaskStatus.COMPLETED ||
            ((task.status === GradingTaskStatus.PENDING ||
              task.status === GradingTaskStatus.FAILED) &&
              hasHumanReport)
          const showReport =
            task.status === GradingTaskStatus.COMPLETED ||
            task.status === GradingTaskStatus.PUBLISHED ||
            hasHumanReport

          return (
            <div className="flex items-center justify-end gap-2">
              {/* AI Grading Actions - Show retry for any status if grading is configured */}
              {task.grading_mode && (
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
              {showReport && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleViewReport(task)}
                  title={t('grading.view_report')}
                  className="h-8 w-8 p-0"
                >
                  <Eye className="h-4 w-4" />
                </Button>
              )}
              {canPublish && task.status !== GradingTaskStatus.PUBLISHED && (
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
          )
        },
      },
    ],
    [
      t,
      executing,
      publishing,
      handleRetrySingle,
      handlePublishSingle,
      handleViewReport,
      handleViewAnswer,
      router,
    ]
  )

  if (loading && !stats) {
    return (
      <div className="min-h-screen bg-[#fafbfc]">
        <GraderHeader title={t('roles.grader')} isLoading={true} />
        <main className="max-w-7xl mx-auto px-4 sm:px-8 py-8">
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4 mb-8">
            {[...Array(5)].map((_, i) => (
              <Skeleton key={i} className="h-20 rounded-2xl" />
            ))}
          </div>
          <Skeleton className="h-96 rounded-2xl" />
        </main>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-[#fafbfc]">
      {/* Header */}
      <GraderHeader
        title={t('roles.grader')}
        description={t('grader.tasks_description')}
        onRefresh={handleRefresh}
        isLoading={loading}
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => router.push('/evaluation/grader/tasks')}
              className="border-gray-200"
            >
              <FileText className="mr-1.5 h-4 w-4" />
              {t('grading.tasks')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => router.push('/evaluation/grader/reports')}
              className="border-gray-200"
            >
              <CheckCircle className="mr-1.5 h-4 w-4" />
              {t('grader.all_reports')}
            </Button>
          </div>
        }
      />

      {/* Main Content */}
      <main className="max-w-7xl mx-auto px-4 sm:px-8 py-8 space-y-6">
        {/* Statistics Cards */}
        <GraderStats
          stats={stats}
          activeFilter={statusFilter}
          onFilterChange={handleStatFilterChange}
        />

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
                <Select value={topicFilter} onValueChange={setTopicFilter}>
                  <SelectTrigger className="w-48 bg-white border-gray-200">
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
              loading={false}
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
              {selectedTask?.topic_name && `[${selectedTask.topic_name}] `}
              {selectedTask?.question_title || ''} - {selectedTask?.respondent_name || ''}
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-96 overflow-auto">
            {loadingReport ? (
              <Skeleton className="h-48 w-full" />
            ) : reportContent ? (
              <div className="rounded-xl bg-gray-50 p-4">
                <EnhancedMarkdown
                  source={reportContent}
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

export default function GraderDashboardPage() {
  return (
    <EvaluationPageLayout>
      <GraderDashboardContent />
    </EvaluationPageLayout>
  )
}
