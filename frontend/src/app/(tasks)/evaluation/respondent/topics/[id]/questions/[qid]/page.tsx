// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect, useCallback } from 'react'
import { useParams } from 'next/navigation'
import { Send, AlertCircle, File, Download } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Alert, AlertDescription } from '@/components/ui/alert'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { useToast } from '@/hooks/use-toast'
import { useTheme } from '@/features/theme/ThemeProvider'
import { EvaluationPageLayout } from '@wecode/components/evaluation/common/EvaluationPageLayout'
import { EvaluationFileUpload } from '@wecode/components/evaluation/common/EvaluationFileUpload'
import { EnhancedMarkdown } from '@/components/common/EnhancedMarkdown'
import {
  respondentGetQuestion,
  respondentSubmitAnswer,
  respondentGetTopic,
  respondentListAnswerHistory,
} from '@wecode/api/evaluation-respondent'
import { downloadEvaluationFile } from '@wecode/api/evaluation-shared'
import { ContentType, type Question, type Answer, type Topic, type EvalAttachment } from '@wecode/types/evaluation'
import { useTranslation } from '@/hooks/useTranslation'
import { formatFileSize } from '@/apis/attachments'

function RespondentQuestionDetailContent() {
  const params = useParams()
  const { toast } = useToast()
  const { theme } = useTheme()
  const { t } = useTranslation('evaluation')
  const topicId = parseInt(params.id as string)
  const questionId = parseInt(params.qid as string)

  const [_topic, setTopic] = useState<Topic | null>(null)
  const [question, setQuestion] = useState<Question | null>(null)
  const [myAnswers, setMyAnswers] = useState<Answer[]>([])
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [showConfirmDialog, setShowConfirmDialog] = useState(false)

  // Answer form state - always use MIXED mode (attachments + text)
  const [answerText, setAnswerText] = useState('')
  const [answerAttachments, setAnswerAttachments] = useState<EvalAttachment[]>([])

  const loadData = useCallback(async () => {
    setLoading(true)
    try {
      const [topicData, questionData, answersData] = await Promise.all([
        respondentGetTopic(topicId),
        respondentGetQuestion(questionId),
        respondentListAnswerHistory({ question_id: questionId, page: 1, limit: 20 }),
      ])
      setTopic(topicData) // Keep topic data for potential future use
      setQuestion(questionData)
      setMyAnswers(answersData.items)
    } catch (_error) {
      toast({
        title: t('errors.load_failed'),
        description: t('errors.permission_denied'),
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
    }
  }, [questionId, topicId, toast, t])

  useEffect(() => {
    if (questionId && topicId) {
      loadData()
    }
  }, [questionId, topicId, loadData])

  // Check if content is empty
  const isContentEmpty = () => {
    const hasText = answerText.trim().length > 0
    const hasAttachments = answerAttachments.length > 0
    return !hasText && !hasAttachments
  }

  // Handle submit button click - show confirmation if has previous answer
  const handleSubmitClick = () => {
    if (isContentEmpty()) {
      toast({
        title: t('errors.save_failed'),
        description: t('answers.content_required', 'Please enter your answer or upload attachments'),
        variant: 'destructive',
      })
      return
    }

    // If there are previous answers, show confirmation dialog
    if (myAnswers.length > 0) {
      setShowConfirmDialog(true)
    } else {
      // No previous answers, submit directly
      handleSubmitAnswer()
    }
  }

  const handleSubmitAnswer = async () => {
    setShowConfirmDialog(false)
    setSubmitting(true)
    try {
      // Always use MIXED content type
      const contentData: Record<string, unknown> = {}
      if (answerText.trim()) {
        contentData.text = answerText.trim()
      }
      if (answerAttachments.length > 0) {
        contentData.attachments = answerAttachments
      }

      await respondentSubmitAnswer(questionId, {
        content_type: ContentType.MIXED,
        content_data: contentData,
      })

      toast({
        title: t('answers.submit_success'),
        description: '',
      })
      setAnswerText('')
      setAnswerAttachments([])
      loadData()
    } catch (_error) {
      toast({
        title: t('errors.save_failed'),
        description: '',
        variant: 'destructive',
      })
    } finally {
      setSubmitting(false)
    }
  }

  const handleDownload = async (attachment: EvalAttachment) => {
    try {
      await downloadEvaluationFile(attachment.key, attachment.filename)
    } catch (error) {
      console.error('Download failed:', error)
    }
  }

  // Render attachment list
  const renderAttachmentList = (attachments: EvalAttachment[] | undefined) => {
    if (!attachments || attachments.length === 0) return null
    return (
      <div className="space-y-2">
        {attachments.map((attachment, index) => (
          <div
            key={attachment.key || index}
            className="flex items-center gap-3 rounded-lg border border-border bg-surface p-2"
          >
            <File className="h-4 w-4 text-text-secondary" />
            <span className="min-w-0 flex-1 truncate text-sm">{attachment.filename}</span>
            {attachment.file_size && (
              <span className="text-xs text-text-muted">{formatFileSize(attachment.file_size)}</span>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => handleDownload(attachment)}
            >
              <Download className="h-4 w-4" />
            </Button>
          </div>
        ))}
      </div>
    )
  }

  if (loading) {
    return (
      <div className="container mx-auto max-w-4xl px-4 py-8">
        <Skeleton className="mb-4 h-8 w-1/2" />
        <Skeleton className="mb-8 h-32 w-full" />
      </div>
    )
  }

  if (!question) {
    return null
  }

  return (
    <div className="container mx-auto max-w-4xl px-4 py-8">
      {/* Version Update Alert */}
      {question.has_new_version && (
        <Alert className="mb-6">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{t('answers.new_version_available')}</AlertDescription>
        </Alert>
      )}

      {/* Question Card - Markdown rendered, no back navigation */}
      <Card className="mb-8">
        <CardHeader>
          <CardTitle>{question.title}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {typeof question.content_data?.text === 'string' && question.content_data.text ? (
            <div className="rounded-lg border border-border bg-surface p-4">
              <EnhancedMarkdown
                source={question.content_data.text}
                theme={theme === 'dark' ? 'dark' : 'light'}
              />
            </div>
          ) : (
            <p className="text-text-muted">{t('questions.no_content')}</p>
          )}
          {/* NOTE: Grading criteria (criteria_data) is intentionally NOT displayed for respondents */}
        </CardContent>
      </Card>

      {/* Answer Submission Form - Fixed to MIXED mode (attachments first, then text) */}
      <Card className="mb-8">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Send className="h-5 w-5" />
            {t('answers.submit')}
          </CardTitle>
          <CardDescription>
            {t('answers.submit_hint', 'Upload attachments and/or enter your answer text below')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Attachments first */}
          <div className="space-y-2">
            <Label>{t('questions.attachments')}</Label>
            <EvaluationFileUpload
              topicId={topicId}
              questionId={questionId}
              fileType="answer_attachment"
              attachments={answerAttachments}
              onChange={setAnswerAttachments}
              maxFiles={10}
            />
          </div>

          {/* Text input second */}
          <div className="space-y-2">
            <Label htmlFor="answerText">{t('answers.content')}</Label>
            <Textarea
              id="answerText"
              value={answerText}
              onChange={e => setAnswerText(e.target.value)}
              placeholder={t('answers.content_placeholder')}
              rows={8}
            />
          </div>

          <div className="flex justify-end">
            <Button variant="primary" onClick={handleSubmitClick} disabled={submitting}>
              {submitting ? '...' : t('answers.submit')}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Confirmation Dialog */}
      <AlertDialog open={showConfirmDialog} onOpenChange={setShowConfirmDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('answers.confirm_submit_title', 'Confirm Submission')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('answers.confirm_submit_description', 'This will overwrite your previous submission. Are you sure you want to continue?')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={handleSubmitAnswer}>
              {t('actions.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* My Previous Answers */}
      {myAnswers.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>{t('answers.history')}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {myAnswers.map(answer => (
                <div key={answer.id} className="rounded-lg border p-4">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-sm text-text-secondary">
                      {t('answers.submitted_at')}: {new Date(answer.submitted_at).toLocaleString()}
                    </span>
                    <div className="flex gap-2">
                      {answer.is_latest && <Badge variant="success">{t('answers.latest')}</Badge>}
                      <Badge variant="info">
                        {t('answers.version')}: {answer.question_version}
                      </Badge>
                    </div>
                  </div>
                  {typeof answer.content_data?.text === 'string' && answer.content_data.text && (
                    <p className="whitespace-pre-wrap">{answer.content_data.text}</p>
                  )}
                  {renderAttachmentList(answer.content_data?.attachments as EvalAttachment[])}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

export default function RespondentQuestionDetailPage() {
  return (
    <EvaluationPageLayout>
      <RespondentQuestionDetailContent />
    </EvaluationPageLayout>
  )
}
