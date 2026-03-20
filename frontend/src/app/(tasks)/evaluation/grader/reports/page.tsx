// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { FileText, Eye, Download, Calendar, User, BookOpen, ArrowRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
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
import { GraderHeader } from '@wecode/components/evaluation/grader'
import {
  graderListReports,
  graderGetTask,
  graderListTopics,
  graderDownloadReportFile,
  type GraderTopicItem,
} from '@wecode/api/evaluation-grader'
import { GradingTaskStatus, type GradingTask } from '@wecode/types/evaluation'
import { useTranslation } from '@/hooks/useTranslation'

const REPORTS_PER_PAGE = 20

function GraderReportsContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { toast } = useToast()
  const { theme } = useTheme()
  const { t } = useTranslation('evaluation')

  // Get initial filters from URL
  const initialTopicId = searchParams.get('topic')
  const initialSearch = searchParams.get('search')

  const [topics, setTopics] = useState<GraderTopicItem[]>([])
  const [reports, setReports] = useState<GradingTask[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [topicFilter, setTopicFilter] = useState<string>(initialTopicId ?? 'all')
  const [searchQuery, setSearchQuery] = useState<string>(initialSearch ?? '')
  const [page, setPage] = useState(1)

  // Report dialog state
  const [reportDialogOpen, setReportDialogOpen] = useState(false)
  const [selectedReport, setSelectedReport] = useState<GradingTask | null>(null)
  const [loadingReport, setLoadingReport] = useState(false)
  const [downloading, setDownloading] = useState<number | null>(null)

  // Load topics list
  const loadTopics = useCallback(async () => {
    try {
      const topicsData = await graderListTopics({ page: 1, limit: 100 })
      setTopics(topicsData.items)
    } catch (_error) {
      // Silent fail for topics list
    }
  }, [])

  // Load published reports
  const loadReports = useCallback(async () => {
    setLoading(true)
    try {
      const params: { page: number; limit: number; status: number; topic_id?: number } = {
        page,
        limit: REPORTS_PER_PAGE,
        status: GradingTaskStatus.PUBLISHED,
      }
      if (topicFilter !== 'all') {
        params.topic_id = parseInt(topicFilter)
      }
      const response = await graderListReports(params)
      setReports(response.items)
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
  }, [page, topicFilter, toast, t])

  useEffect(() => {
    loadTopics()
  }, [loadTopics])

  useEffect(() => {
    loadReports()
  }, [loadReports])

  // Update URL when filters change
  useEffect(() => {
    const params = new URLSearchParams()
    if (topicFilter !== 'all') params.set('topic', topicFilter)
    if (searchQuery) params.set('search', searchQuery)
    const newUrl = params.toString() ? `?${params.toString()}` : '/evaluation/grader/reports'
    router.replace(newUrl, { scroll: false })
  }, [topicFilter, searchQuery, router])

  const handleViewReport = async (report: GradingTask) => {
    setLoadingReport(true)
    setReportDialogOpen(true)
    try {
      const fullTask = await graderGetTask(report.id)
      setSelectedReport(fullTask)
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

  const handleDownloadReport = async (taskId: number) => {
    setDownloading(taskId)
    try {
      await graderDownloadReportFile(taskId)
    } catch (_error) {
      toast({
        title: t('errors.download_failed'),
        description: '',
        variant: 'destructive',
      })
    } finally {
      setDownloading(null)
    }
  }

  const handleViewAnswer = (answerId: number) => {
    router.push(`/evaluation/grader/answers/${answerId}`)
  }

  const handleRefresh = () => {
    loadReports()
  }

  const formatDate = (dateString: string) => {
    if (!dateString || dateString === '1970-01-01T00:00:00') return '-'
    try {
      return new Date(dateString).toLocaleString()
    } catch {
      return dateString
    }
  }

  // Filter reports by search query (client-side for now)
  const filteredReports = useMemo(() => {
    if (!searchQuery) return reports
    return reports.filter(
      report =>
        report.question_title?.toLowerCase().includes(searchQuery.toLowerCase()) ||
        report.topic_name?.toLowerCase().includes(searchQuery.toLowerCase()) ||
        report.respondent_name?.toLowerCase().includes(searchQuery.toLowerCase())
    )
  }, [reports, searchQuery])

  // Define table columns
  const columns: Column<GradingTask>[] = useMemo(
    () => [
      {
        key: 'id',
        title: t('common.id'),
        className: 'font-mono text-xs text-text-muted',
        render: (report: GradingTask) => `#${report.id}`,
      },
      {
        key: 'topic',
        title: t('topics.topic_name'),
        render: (report: GradingTask) => (
          <div className="flex items-center gap-2">
            <BookOpen className="h-4 w-4 text-text-muted" />
            {report.topic_name || '-'}
          </div>
        ),
      },
      {
        key: 'question',
        title: t('questions.question_title'),
        render: (report: GradingTask) => report.question_title || `Question #${report.question_id}`,
      },
      {
        key: 'user',
        title: t('permissions.user'),
        render: (report: GradingTask) => (
          <div className="flex items-center gap-2">
            <User className="h-4 w-4 text-text-muted" />
            {report.respondent_name || `User #${report.respondent_id}`}
          </div>
        ),
      },
      {
        key: 'published_at',
        title: t('grading.published_at'),
        render: (report: GradingTask) => (
          <div className="flex items-center gap-2 text-sm text-text-secondary">
            <Calendar className="h-4 w-4" />
            {formatDate(report.published_at || '')}
          </div>
        ),
      },
      {
        key: 'actions',
        title: t('common:actions.view'),
        className: 'text-right',
        render: (report: GradingTask) => (
          <div className="flex items-center justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => handleViewReport(report)}
              title={t('grading.view_report')}
              className="h-8 w-8 p-0"
            >
              <Eye className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => handleDownloadReport(report.id)}
              disabled={downloading === report.id}
              title={t('common:actions.download')}
              className="h-8 w-8 p-0"
            >
              <Download className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => handleViewAnswer(report.answer_id)}
              className="text-primary hover:text-primary/80"
            >
              {t('answers.view')}
              <ArrowRight className="ml-1 h-3 w-3" />
            </Button>
          </div>
        ),
      },
    ],
    [t, downloading]
  )

  if (loading && reports.length === 0) {
    return (
      <div className="min-h-screen bg-[#fafbfc]">
        <GraderHeader
          title={t('grader.all_reports')}
          backHref="/evaluation/grader"
          isLoading={true}
        />
        <main className="max-w-7xl mx-auto px-4 sm:px-8 py-8">
          <Skeleton className="h-96 rounded-2xl" />
        </main>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-[#fafbfc]">
      {/* Header */}
      <GraderHeader
        title={t('grader.all_reports')}
        description={`${total} ${t('grading.status.published').toLowerCase()}`}
        backHref="/evaluation/grader"
        onRefresh={handleRefresh}
        isLoading={loading}
      />

      {/* Main Content */}
      <main className="max-w-7xl mx-auto px-4 sm:px-8 py-8">
        {/* Reports Card */}
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-100">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-lg font-bold text-gray-900">{t('grading.my_reports')}</h2>
                <p className="text-sm text-gray-500">{t('grader.publish_description')}</p>
              </div>
            </div>
          </div>

          <div className="p-6">
            {/* Filters */}
            <div className="mb-4 flex flex-wrap items-center gap-2">
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
              <Input
                placeholder={t('topics.search_placeholder')}
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                className="w-64 bg-white border-gray-200"
              />
            </div>

            {/* Reports table */}
            <DataTable
              columns={columns}
              data={filteredReports}
              total={searchQuery ? filteredReports.length : total}
              page={page}
              pageSize={REPORTS_PER_PAGE}
              loading={loading}
              emptyMessage={t('grading.no_tasks')}
              emptyIcon={<FileText className="mx-auto mb-4 h-12 w-12 text-gray-300" />}
              onPageChange={setPage}
              previousText={t('common.previous')}
              nextText={t('common.next')}
              pageText={t('common.page')}
              rowKey={(report: GradingTask) => report.id}
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
              {selectedReport?.topic_name && `[${selectedReport.topic_name}] `}
              {selectedReport?.question_title || ''} - {selectedReport?.respondent_name || ''}
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-96 overflow-auto">
            {loadingReport ? (
              <Skeleton className="h-48 w-full" />
            ) : selectedReport?.report_data &&
              Object.keys(selectedReport.report_data).length > 0 ? (
              <div className="space-y-4">
                {/* Report metadata */}
                <div className="flex flex-wrap gap-4 text-sm text-text-secondary">
                  <Badge variant="success">{t('grading.status.published')}</Badge>
                  {selectedReport.published_at && (
                    <span className="flex items-center gap-1">
                      <Calendar className="h-4 w-4" />
                      {formatDate(selectedReport.published_at)}
                    </span>
                  )}
                </div>
                {/* Report content */}
                <div className="rounded-xl bg-gray-50 p-4">
                  <EnhancedMarkdown
                    source={
                      typeof selectedReport.report_data === 'string'
                        ? selectedReport.report_data
                        : typeof selectedReport.report_data.content === 'string'
                          ? selectedReport.report_data.content
                          : JSON.stringify(selectedReport.report_data, null, 2)
                    }
                    theme={theme === 'dark' ? 'dark' : 'light'}
                  />
                </div>
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

export default function GraderReportsPage() {
  return (
    <EvaluationPageLayout title="Published Reports">
      <GraderReportsContent />
    </EvaluationPageLayout>
  )
}
