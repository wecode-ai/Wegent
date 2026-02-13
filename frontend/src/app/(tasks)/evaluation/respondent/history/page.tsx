// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowLeft, FileText, Clock, Link, Paperclip, Download } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { useToast } from '@/hooks/use-toast'
import { EvaluationPageLayout } from '@wecode/components/evaluation/common/EvaluationPageLayout'
import { respondentListAnswerHistory, getDownloadUrl } from '@wecode/api/evaluation'
import type { Answer, ContentAttachment } from '@wecode/types/evaluation'
import { useTranslation } from '@/hooks/useTranslation'

/**
 * Respondent Answer History Page
 *
 * Shows only the user's submitted answers.
 * NOTE: Respondents CANNOT view any grading status or results.
 * This is a business security requirement to ensure evaluation fairness.
 */
function RespondentHistoryContent() {
  const router = useRouter()
  const { toast } = useToast()
  const { t } = useTranslation('evaluation')

  const [answers, setAnswers] = useState<Answer[]>([])
  const [answersTotal, setAnswersTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [answersPage, setAnswersPage] = useState(1)
  const [downloading, setDownloading] = useState<string | null>(null)

  const loadAnswers = useCallback(async () => {
    setLoading(true)
    try {
      const response = await respondentListAnswerHistory({
        page: answersPage,
        limit: 20,
        latest_only: true,
      })
      setAnswers(response.items)
      setAnswersTotal(response.total)
    } catch (_error) {
      toast({
        title: t('errors.load_failed'),
        description: '',
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
    }
  }, [answersPage, toast, t])

  useEffect(() => {
    loadAnswers()
  }, [loadAnswers])

  const handleDownloadFile = async (s3Path: string, _filename: string) => {
    setDownloading(s3Path)
    try {
      const response = await getDownloadUrl(s3Path)
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

  const renderAttachments = (attachments: ContentAttachment[] | undefined) => {
    if (!attachments || attachments.length === 0) return null

    return (
      <div className="mt-2 space-y-1">
        {attachments.map((attachment, index) => (
          <div
            key={`${attachment.s3_key}-${index}`}
            className="flex items-center justify-between rounded-lg bg-surface px-3 py-2"
          >
            <div className="flex items-center gap-2 min-w-0 flex-1">
              <Paperclip className="h-4 w-4 flex-shrink-0 text-text-muted" />
              <span className="truncate text-sm text-text-secondary">{attachment.filename}</span>
              {attachment.size && (
                <span className="flex-shrink-0 text-xs text-text-muted">
                  ({Math.round(attachment.size / 1024)}KB)
                </span>
              )}
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => handleDownloadFile(attachment.s3_key, attachment.filename)}
              disabled={downloading === attachment.s3_key}
              className="flex-shrink-0"
            >
              <Download className="h-4 w-4" />
            </Button>
          </div>
        ))}
      </div>
    )
  }

  return (
    <div className="container mx-auto max-w-6xl px-4 py-8">
      {/* Header */}
      <div className="mb-8 flex items-center justify-between">
        <div>
          <Button variant="ghost" onClick={() => router.push('/evaluation/respondent')}>
            <ArrowLeft className="mr-2 h-4 w-4" />
            {t('actions.back')}
          </Button>
        </div>
      </div>

      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-text-primary">{t('answers.history')}</h1>
        <p className="text-sm text-text-secondary">{t('respondent.my_answers_description')}</p>
      </div>

      <div className="mb-4">
        <h2 className="flex items-center gap-2 text-lg font-medium text-text-primary">
          <FileText className="h-5 w-5" />
          {t('answers.my_answers')} ({answersTotal})
        </h2>
      </div>

      {loading ? (
        <div className="space-y-4">
          {[...Array(3)].map((_, i) => (
            <Card key={i}>
              <CardContent className="p-4">
                <Skeleton className="mb-2 h-6 w-1/2" />
                <Skeleton className="h-4 w-3/4" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : answers.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <FileText className="mx-auto mb-4 h-12 w-12 text-text-muted" />
            <h3 className="mb-2 text-lg font-medium">{t('answers.no_answers')}</h3>
            <p className="mb-4 text-sm text-text-secondary">{t('topics.browse_description')}</p>
            <Button variant="primary" onClick={() => router.push('/evaluation/respondent')}>
              {t('topics.browse')}
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {answers.map(answer => (
            <Card key={answer.id} className="transition-shadow hover:shadow-md">
              <CardContent className="p-4">
                <div className="mb-2 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Clock className="h-4 w-4 text-text-muted" />
                    <span className="text-sm text-text-secondary">
                      {new Date(answer.submitted_at).toLocaleString()}
                    </span>
                  </div>
                  <div className="flex gap-2">
                    {answer.is_latest && <Badge variant="success">{t('answers.latest')}</Badge>}
                    <Badge variant="info">
                      {t('answers.version')}: {answer.question_version}
                    </Badge>
                  </div>
                </div>
                {typeof answer.content_data?.text === 'string' && answer.content_data.text && (
                  <p className="line-clamp-3 whitespace-pre-wrap text-text-primary">
                    {answer.content_data.text}
                  </p>
                )}
                {typeof answer.content_data?.url === 'string' && answer.content_data.url && (
                  <div className="mt-2 flex items-center gap-2">
                    <Link className="h-4 w-4 text-primary" />
                    <a
                      href={answer.content_data.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="line-clamp-1 text-primary hover:underline"
                    >
                      {answer.content_data.url}
                    </a>
                  </div>
                )}
                {renderAttachments(answer.content_data?.attachments)}
              </CardContent>
            </Card>
          ))}

          {/* Pagination */}
          {answersTotal > 20 && (
            <div className="mt-6 flex justify-center gap-2">
              <Button
                variant="outline"
                disabled={answersPage === 1}
                onClick={() => setAnswersPage(answersPage - 1)}
              >
                {t('common:previous')}
              </Button>
              <span className="flex items-center px-4 text-sm text-text-secondary">
                {t('common:page')} {answersPage} / {Math.ceil(answersTotal / 20)}
              </span>
              <Button
                variant="outline"
                disabled={answersPage >= Math.ceil(answersTotal / 20)}
                onClick={() => setAnswersPage(answersPage + 1)}
              >
                {t('common:next')}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default function RespondentHistoryPage() {
  return (
    <EvaluationPageLayout>
      <RespondentHistoryContent />
    </EvaluationPageLayout>
  )
}
