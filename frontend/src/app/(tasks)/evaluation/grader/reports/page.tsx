// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { ArrowLeft, Eye, RefreshCw, Send } from 'lucide-react'
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
import { EvaluationPageLayout } from '@wecode/components/evaluation/common/EvaluationPageLayout'
import {
  listGraderReports,
  getGraderTask,
  publishGraderTask,
  batchPublishGraderTasks,
} from '@wecode/api/evaluation'
import { GradingTaskStatus, type GradingTask, getStatusLabel } from '@wecode/types/evaluation'
import { useTranslation } from '@/hooks/useTranslation'

function GraderReportsContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { toast } = useToast()
  const { t } = useTranslation('evaluation')

  const initialStatus = searchParams.get('status')

  const [reports, setReports] = useState<GradingTask[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [selectedReports, setSelectedReports] = useState<Set<number>>(new Set())
  const [statusFilter, setStatusFilter] = useState<string>(initialStatus ?? 'all')
  const [page, setPage] = useState(1)
  const [publishing, setPublishing] = useState(false)

  // Report dialog state
  const [reportDialogOpen, setReportDialogOpen] = useState(false)
  const [selectedReport, setSelectedReport] = useState<GradingTask | null>(null)
  const [loadingReport, setLoadingReport] = useState(false)

  const loadReports = useCallback(async () => {
    setLoading(true)
    try {
      const params: { page: number; limit: number; status?: number } = {
        page,
        limit: 20,
      }
      // Only show completed and published reports by default
      if (statusFilter === 'all') {
        // Show both completed and published
      } else {
        params.status = parseInt(statusFilter)
      }
      const response = await listGraderReports(params)
      // Filter to only show completed and published reports
      const filteredItems =
        statusFilter === 'all'
          ? response.items.filter(
              r =>
                r.status === GradingTaskStatus.COMPLETED || r.status === GradingTaskStatus.PUBLISHED
            )
          : response.items
      setReports(filteredItems)
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
  }, [page, statusFilter, toast, t])

  useEffect(() => {
    loadReports()
  }, [loadReports])

  const handleSelectReport = (reportId: number, checked: boolean) => {
    const newSelected = new Set(selectedReports)
    if (checked) {
      newSelected.add(reportId)
    } else {
      newSelected.delete(reportId)
    }
    setSelectedReports(newSelected)
  }

  const handleSelectAll = (checked: boolean) => {
    if (checked) {
      // Only select completed reports (not yet published)
      const completedReports = reports.filter(r => r.status === GradingTaskStatus.COMPLETED)
      setSelectedReports(new Set(completedReports.map(r => r.id)))
    } else {
      setSelectedReports(new Set())
    }
  }

  const handlePublishSingle = async (reportId: number) => {
    setPublishing(true)
    try {
      await publishGraderTask(reportId)
      toast({
        title: t('grading.publish_success'),
        description: '',
      })
      loadReports()
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

  const handleBatchPublish = async () => {
    if (selectedReports.size === 0) return

    setPublishing(true)
    try {
      const result = await batchPublishGraderTasks(Array.from(selectedReports))
      toast({
        title: t('grading.publish_success'),
        description: `${result.published_count} reports published`,
      })
      setSelectedReports(new Set())
      loadReports()
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

  const handleViewReport = async (report: GradingTask) => {
    setLoadingReport(true)
    setReportDialogOpen(true)
    try {
      const fullReport = await getGraderTask(report.id)
      setSelectedReport(fullReport)
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

  // Calculate summary statistics
  const completedCount = reports.filter(r => r.status === GradingTaskStatus.COMPLETED).length
  const publishedCount = reports.filter(r => r.status === GradingTaskStatus.PUBLISHED).length

  if (loading && reports.length === 0) {
    return (
      <div className="container mx-auto max-w-6xl px-4 py-8">
        <Skeleton className="mb-6 h-10 w-32" />
        <Skeleton className="h-96 w-full" />
      </div>
    )
  }

  return (
    <div className="container mx-auto max-w-6xl px-4 py-8">
      {/* Header */}
      <div className="mb-6 flex items-center justify-between">
        <Button variant="ghost" onClick={() => router.push('/evaluation/grader')}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          {t('actions.back')}
        </Button>
        <Button variant="outline" onClick={loadReports}>
          <RefreshCw className="mr-2 h-4 w-4" />
          {t('actions.refresh')}
        </Button>
      </div>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>{t('grading.my_reports')}</CardTitle>
          <CardDescription>{t('grading.description')}</CardDescription>
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
                  <SelectItem value="all">{t('grader.all_reports')}</SelectItem>
                  <SelectItem value="2">{t('grading.status.completed')}</SelectItem>
                  <SelectItem value="4">{t('grading.status.published')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {selectedReports.size > 0 && (
              <div className="flex items-center gap-2">
                <span className="text-sm text-text-muted">{t('common.selected', { count: selectedReports.size })}</span>
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
          <div className="mb-4 grid grid-cols-2 gap-4 md:grid-cols-2">
            <div className="rounded-lg bg-surface p-3">
              <div className="text-sm text-text-muted">{t('grading.status.completed')}</div>
              <div className="text-xl font-semibold">{completedCount}</div>
            </div>
            <div className="rounded-lg bg-surface p-3">
              <div className="text-sm text-text-muted">{t('grading.status.published')}</div>
              <div className="text-xl font-semibold">{publishedCount}</div>
            </div>
          </div>

          {/* Reports table */}
          {reports.length === 0 ? (
            <div className="py-8 text-center">
              <p className="text-text-secondary">{t('grading.no_tasks')}</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-12">
                    <Checkbox
                      checked={
                        selectedReports.size ===
                          reports.filter(r => r.status === GradingTaskStatus.COMPLETED).length &&
                        reports.filter(r => r.status === GradingTaskStatus.COMPLETED).length > 0
                      }
                      onCheckedChange={handleSelectAll}
                    />
                  </TableHead>
                  <TableHead>{t('common.id')}</TableHead>
                  <TableHead>{t('questions.question_title')}</TableHead>
                  <TableHead>{t('permissions.user')}</TableHead>
                  <TableHead>{t('common.status')}</TableHead>
                  <TableHead>{t('answers.submitted_at')}</TableHead>
                  <TableHead className="text-right">{t('actions.view')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {reports.map(report => (
                  <TableRow key={report.id}>
                    <TableCell>
                      <Checkbox
                        checked={selectedReports.has(report.id)}
                        onCheckedChange={checked =>
                          handleSelectReport(report.id, checked as boolean)
                        }
                        disabled={report.status === GradingTaskStatus.PUBLISHED}
                      />
                    </TableCell>
                    <TableCell className="font-mono text-sm">{report.id}</TableCell>
                    <TableCell>
                      {report.question_title || `Question #${report.question_id}`}
                    </TableCell>
                    <TableCell>
                      {report.respondent_name || `User #${report.respondent_id}`}
                    </TableCell>
                    <TableCell>
                      <Badge variant={getStatusBadgeVariant(report.status)}>
                        {getStatusLabel(report.status, 'grading')}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {report.completed_at
                        ? new Date(report.completed_at).toLocaleDateString()
                        : '-'}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-2">
                        <Button variant="ghost" size="sm" onClick={() => handleViewReport(report)}>
                          <Eye className="h-4 w-4" />
                        </Button>
                        {report.status === GradingTaskStatus.COMPLETED && (
                          <Button
                            variant="primary"
                            size="sm"
                            onClick={() => handlePublishSingle(report.id)}
                            disabled={publishing}
                          >
                            <Send className="h-4 w-4" />
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() =>
                            router.push(`/evaluation/grader/answers/${report.answer_id}`)
                          }
                        >
                          {t('actions.view_details')}
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
              {selectedReport?.question_title || ''} - {selectedReport?.respondent_name || ''}
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-96 overflow-auto">
            {loadingReport ? (
              <Skeleton className="h-48 w-full" />
            ) : selectedReport?.report_data ? (
              <pre className="whitespace-pre-wrap rounded-lg bg-surface p-4 text-sm">
                {typeof selectedReport.report_data === 'string'
                  ? selectedReport.report_data
                  : JSON.stringify(selectedReport.report_data, null, 2)}
              </pre>
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
    <EvaluationPageLayout>
      <GraderReportsContent />
    </EvaluationPageLayout>
  )
}
