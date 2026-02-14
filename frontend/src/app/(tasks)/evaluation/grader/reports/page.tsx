// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import {
  FileText,
  RefreshCw,
  ArrowLeft,
  Eye,
  Download,
  Calendar,
  User,
  BookOpen,
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
import { useTheme } from '@/features/theme/ThemeProvider'
import { EvaluationPageLayout } from '@wecode/components/evaluation/common/EvaluationPageLayout'
import { EnhancedMarkdown } from '@/components/common/EnhancedMarkdown'
import {
  graderListReports,
  graderGetTask,
  graderListTopics,
  graderGetReportDownloadUrl,
  type GraderTopicItem,
} from '@wecode/api/evaluation-grader'
import { GradingTaskStatus, type GradingTask } from '@wecode/types/evaluation'
import { useTranslation } from '@/hooks/useTranslation'

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
  const [loadingReports, setLoadingReports] = useState(false)
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
    setLoadingReports(true)
    try {
      const params: { page: number; limit: number; status: number; topic_id?: number } = {
        page,
        limit: 20,
        status: GradingTaskStatus.PUBLISHED, // Only show published reports
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
      setLoadingReports(false)
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
      const response = await graderGetReportDownloadUrl(taskId)
      // Open the download URL in a new tab
      window.open(response.download_url, '_blank')
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
  const filteredReports = searchQuery
    ? reports.filter(
        report =>
          report.question_title?.toLowerCase().includes(searchQuery.toLowerCase()) ||
          report.topic_name?.toLowerCase().includes(searchQuery.toLowerCase()) ||
          report.respondent_name?.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : reports

  if (loading) {
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
              <FileText className="h-5 w-5 text-primary" />
            </div>
            <div>
              <h1 className="text-xl font-semibold text-text-primary">
                {t('grader.all_reports')}
              </h1>
              <p className="text-sm text-text-secondary">
                {total} {t('grading.status.published').toLowerCase()}
              </p>
            </div>
          </div>
        </div>
        <Button variant="outline" onClick={handleRefresh}>
          <RefreshCw className="mr-2 h-4 w-4" />
          {t('actions.refresh')}
        </Button>
      </div>

      {/* Reports Card */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <BookOpen className="h-5 w-5" />
            {t('grading.my_reports')}
          </CardTitle>
          <CardDescription>{t('grader.publish_description')}</CardDescription>
        </CardHeader>
        <CardContent>
          {/* Filters */}
          <div className="mb-4 flex flex-wrap items-center gap-2">
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
              className="w-64"
            />
          </div>

          {/* Reports table */}
          {loadingReports ? (
            <div className="space-y-2">
              {[...Array(5)].map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : filteredReports.length === 0 ? (
            <div className="py-8 text-center">
              <FileText className="mx-auto mb-4 h-12 w-12 text-text-muted" />
              <p className="text-text-secondary">{t('grading.no_tasks')}</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('common.id')}</TableHead>
                  <TableHead>{t('topics.topic_name')}</TableHead>
                  <TableHead>{t('questions.question_title')}</TableHead>
                  <TableHead>{t('permissions.user')}</TableHead>
                  <TableHead>{t('grading.published_at')}</TableHead>
                  <TableHead className="text-right">{t('actions.view')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredReports.map(report => (
                  <TableRow key={report.id}>
                    <TableCell className="font-mono text-xs text-text-muted">
                      #{report.id}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <BookOpen className="h-4 w-4 text-text-muted" />
                        {report.topic_name || '-'}
                      </div>
                    </TableCell>
                    <TableCell>
                      {report.question_title || `Question #${report.question_id}`}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <User className="h-4 w-4 text-text-muted" />
                        {report.respondent_name || `User #${report.respondent_id}`}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2 text-sm text-text-secondary">
                        <Calendar className="h-4 w-4" />
                        {formatDate(report.published_at || '')}
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleViewReport(report)}
                          title={t('grading.view_report')}
                        >
                          <Eye className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleDownloadReport(report.id)}
                          disabled={downloading === report.id}
                          title={t('actions.download')}
                        >
                          <Download className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleViewAnswer(report.answer_id)}
                        >
                          {t('answers.view')}
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}

          {/* Pagination */}
          {total > 20 && (
            <div className="mt-6 flex justify-center gap-2">
              <Button variant="outline" disabled={page === 1} onClick={() => setPage(page - 1)}>
                {t('common.previous')}
              </Button>
              <span className="flex items-center px-4 text-sm text-text-secondary">
                {t('common.page')} {page} / {Math.ceil(total / 20)}
              </span>
              <Button
                variant="outline"
                disabled={page >= Math.ceil(total / 20)}
                onClick={() => setPage(page + 1)}
              >
                {t('common.next')}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Report Dialog */}
      <Dialog open={reportDialogOpen} onOpenChange={setReportDialogOpen}>
        <DialogContent className="max-w-2xl">
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
                <div className="rounded-lg bg-surface p-4">
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
