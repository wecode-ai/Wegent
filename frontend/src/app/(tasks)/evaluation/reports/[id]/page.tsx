// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter, useParams } from 'next/navigation'
import { ArrowLeft, FileText, User, ClipboardList, Calendar, CheckCircle2, Link } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Separator } from '@/components/ui/separator'
import { useToast } from '@/hooks/use-toast'
import { EvaluationPageLayout } from '@/features/evaluation/components/common/EvaluationPageLayout'
import { viewReport } from '@wecode/api/evaluation-shared'
import { GradingTaskStatus, getStatusLabel, type GradingTask } from '@wecode/types/evaluation'
import { useTranslation } from '@/hooks/useTranslation'
import ReactMarkdown from 'react-markdown'

function SharedReportViewContent() {
  const router = useRouter()
  const params = useParams()
  const { toast } = useToast()
  const { t } = useTranslation('evaluation')
  const reportId = parseInt(params.id as string)

  const [report, setReport] = useState<GradingTask | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const loadReport = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await viewReport(reportId)
      // Only allow viewing published reports
      if (data.status !== GradingTaskStatus.PUBLISHED) {
        setError(t('grading.report_not_published'))
        return
      }
      setReport(data)
    } catch (_error) {
      const errorMessage = (_error as Error)?.message || ''
      if (errorMessage.includes('403') || errorMessage.includes('permission')) {
        setError(t('errors.permission_denied'))
      } else if (errorMessage.includes('404') || errorMessage.includes('not found')) {
        setError(t('grading.report_not_found'))
      } else {
        setError(t('errors.load_failed'))
      }
      toast({
        title: t('errors.load_failed'),
        description: '',
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
    }
  }, [reportId, toast, t])

  useEffect(() => {
    if (reportId) {
      loadReport()
    }
  }, [reportId, loadReport])

  const getStatusBadgeVariant = (
    status: number
  ): 'default' | 'success' | 'error' | 'info' | 'warning' | 'secondary' => {
    switch (status) {
      case GradingTaskStatus.PUBLISHED:
        return 'success'
      case GradingTaskStatus.COMPLETED:
        return 'default'
      default:
        return 'secondary'
    }
  }

  // Get report content - handle both string and object formats
  const getReportContent = (): string => {
    if (!report?.report_data) return ''

    if (typeof report.report_data === 'string') {
      return report.report_data
    }

    // Check common nested structures
    if (typeof report.report_data === 'object') {
      const data = report.report_data as Record<string, unknown>
      if (typeof data.content === 'string') {
        return data.content
      }
      if (typeof data.report === 'string') {
        return data.report
      }
      if (typeof data.markdown === 'string') {
        return data.markdown
      }
      // Fallback to JSON representation
      return JSON.stringify(report.report_data, null, 2)
    }

    return ''
  }

  if (loading) {
    return (
      <div className="container mx-auto max-w-4xl px-4 py-8">
        <Skeleton className="mb-6 h-10 w-32" />
        <Skeleton className="mb-4 h-8 w-1/2" />
        <Skeleton className="h-96 w-full" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="container mx-auto max-w-4xl px-4 py-8">
        <div className="mb-6">
          <Button variant="ghost" onClick={() => router.back()}>
            <ArrowLeft className="mr-2 h-4 w-4" />
            {t('actions.back')}
          </Button>
        </div>
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      </div>
    )
  }

  if (!report) {
    return null
  }

  const reportContent = getReportContent()

  return (
    <div className="container mx-auto max-w-4xl px-4 py-8">
      {/* Header */}
      <div className="mb-6">
        <Button variant="ghost" onClick={() => router.back()}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          {t('actions.back')}
        </Button>
      </div>

      {/* Report Info Card */}
      <Card className="mb-6">
        <CardHeader>
          <div className="flex items-start justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <FileText className="h-5 w-5" />
                {t('grading.report')}
              </CardTitle>
              <CardDescription>
                {report.question_title || `Question #${report.question_id}`}
              </CardDescription>
            </div>
            <Badge variant={getStatusBadgeVariant(report.status)}>
              {getStatusLabel(report.status, 'grading')}
            </Badge>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="flex items-center gap-3">
              <User className="h-4 w-4 text-text-muted" />
              <div>
                <p className="text-sm text-text-muted">{t('permissions.user')}</p>
                <p className="font-medium">{report.respondent_name || `User #${report.respondent_id}`}</p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <ClipboardList className="h-4 w-4 text-text-muted" />
              <div>
                <p className="text-sm text-text-muted">{t('questions.title')}</p>
                <p className="font-medium">{report.question_title || `#${report.question_id}`}</p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <Calendar className="h-4 w-4 text-text-muted" />
              <div>
                <p className="text-sm text-text-muted">{t('grading.completed_at')}</p>
                <p className="font-medium">
                  {report.completed_at
                    ? new Date(report.completed_at).toLocaleString()
                    : '-'}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <CheckCircle2 className="h-4 w-4 text-text-muted" />
              <div>
                <p className="text-sm text-text-muted">{t('grading.published_at')}</p>
                <p className="font-medium">
                  {report.published_at
                    ? new Date(report.published_at).toLocaleString()
                    : '-'}
                </p>
              </div>
            </div>
          </div>

          {report.question_version && (
            <>
              <Separator className="my-4" />
              <div className="flex items-center gap-2 text-sm text-text-muted">
                <Link className="h-4 w-4" />
                {t('answers.version')}: {report.question_version}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Report Content Card */}
      <Card>
        <CardHeader>
          <CardTitle>{t('grading.report_content')}</CardTitle>
        </CardHeader>
        <CardContent>
          {reportContent ? (
            <div className="prose prose-sm max-w-none dark:prose-invert">
              <ReactMarkdown>{reportContent}</ReactMarkdown>
            </div>
          ) : (
            <p className="text-text-secondary">{t('grading.no_report_data')}</p>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

export default function SharedReportViewPage() {
  return (
    <EvaluationPageLayout>
      <SharedReportViewContent />
    </EvaluationPageLayout>
  )
}
