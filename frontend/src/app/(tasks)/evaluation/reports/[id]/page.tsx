// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter, useParams } from 'next/navigation'
import {
  ArrowLeft,
  FileText,
  User,
  ClipboardList,
  Calendar,
  CheckCircle2,
  Link,
  Copy,
  Check,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { useToast } from '@/hooks/use-toast'
import { useTheme } from '@/features/theme/ThemeProvider'
import { EvaluationPageLayout } from '@wecode/components/evaluation/common/EvaluationPageLayout'
import { EnhancedMarkdown } from '@/components/common/EnhancedMarkdown'
import { viewReport, fetchFileContent } from '@wecode/api/evaluation-shared'
import { GradingTaskStatus, getStatusLabel, type GradingTask } from '@wecode/types/evaluation'
import { useTranslation } from '@/hooks/useTranslation'

function SharedReportViewContent() {
  const router = useRouter()
  const params = useParams()
  const { toast } = useToast()
  const { theme } = useTheme()
  const { t } = useTranslation('evaluation')
  const reportId = parseInt(params.id as string)

  const [report, setReport] = useState<GradingTask | null>(null)
  const [reportContent, setReportContent] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    if (!reportContent) return
    try {
      await navigator.clipboard.writeText(reportContent)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      console.error('Failed to copy:', err)
    }
  }

  // Get report S3 path from report_data
  const getFinalReportS3Path = (reportData: Record<string, unknown>): string | null => {
    if (!reportData) return null
    const finalReport = reportData.final_report as Record<string, unknown> | undefined
    if (finalReport && typeof finalReport.s3_path === 'string') {
      return finalReport.s3_path
    }
    return null
  }

  // Get inline report content (may be truncated)
  const getInlineReportContent = (reportData: Record<string, unknown> | string | null): string => {
    if (!reportData) return ''

    if (typeof reportData === 'string') {
      return reportData
    }

    // Check final_report first (for published reports)
    const finalReport = reportData.final_report as Record<string, unknown> | undefined
    if (finalReport && typeof finalReport.content === 'string') {
      return finalReport.content
    }

    // Check common nested structures
    if (typeof reportData.content === 'string') {
      return reportData.content
    }
    if (typeof reportData.report === 'string') {
      return reportData.report
    }
    if (typeof reportData.markdown === 'string') {
      return reportData.markdown
    }

    return ''
  }

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

      // Load report content - prefer S3 (full content) over inline (truncated)
      if (data.report_data) {
        const s3Path = getFinalReportS3Path(data.report_data as Record<string, unknown>)
        if (s3Path) {
          const content = await fetchFileContent(s3Path)
          setReportContent(
            content || getInlineReportContent(data.report_data as Record<string, unknown>)
          )
        } else {
          setReportContent(getInlineReportContent(data.report_data as Record<string, unknown>))
        }
      }
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

  const getStatusBadgeVariant = (status: number): 'default' | 'secondary' | 'error' | 'info' => {
    switch (status) {
      case GradingTaskStatus.PUBLISHED:
        return 'default'
      case GradingTaskStatus.COMPLETED:
        return 'secondary'
      case GradingTaskStatus.FAILED:
        return 'error'
      default:
        return 'info'
    }
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
              {getStatusLabel(report.status, 'grading', t)}
            </Badge>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="flex items-center gap-3">
              <User className="h-4 w-4 text-text-muted" />
              <div>
                <p className="text-sm text-text-muted">{t('permissions.user')}</p>
                <p className="font-medium">
                  {report.respondent_name || `User #${report.respondent_id}`}
                </p>
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
                  {report.completed_at ? new Date(report.completed_at).toLocaleString() : '-'}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <CheckCircle2 className="h-4 w-4 text-text-muted" />
              <div>
                <p className="text-sm text-text-muted">{t('grading.published_at')}</p>
                <p className="font-medium">
                  {report.published_at ? new Date(report.published_at).toLocaleString() : '-'}
                </p>
              </div>
            </div>
          </div>

          {report.question_version && (
            <>
              <div className="my-4 border-t border-border" />
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
            <>
              <div className="prose prose-sm max-w-none dark:prose-invert">
                <EnhancedMarkdown
                  source={reportContent}
                  theme={theme === 'dark' ? 'dark' : 'light'}
                />
              </div>
              <div className="flex justify-end mt-4 pt-4 border-t border-border">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleCopy}
                  className="h-8 px-2"
                  title={t('common:actions.copy') || 'Copy'}
                >
                  {copied ? (
                    <Check className="h-4 w-4 text-green-500" />
                  ) : (
                    <Copy className="h-4 w-4 text-gray-500" />
                  )}
                </Button>
              </div>
            </>
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
