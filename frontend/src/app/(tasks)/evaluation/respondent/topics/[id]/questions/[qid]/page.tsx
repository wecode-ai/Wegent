// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter, useParams } from 'next/navigation'
import { ArrowLeft, Send, AlertCircle, File, Download } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { useToast } from '@/hooks/use-toast'
import { EvaluationPageLayout } from '@/features/evaluation/components/common/EvaluationPageLayout'
import { EvaluationFileUpload } from '@/features/evaluation/components/common/EvaluationFileUpload'
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
  const router = useRouter()
  const params = useParams()
  const { toast } = useToast()
  const { t } = useTranslation('evaluation')
  const topicId = parseInt(params.id as string)
  const questionId = parseInt(params.qid as string)

  const [topic, setTopic] = useState<Topic | null>(null)
  const [question, setQuestion] = useState<Question | null>(null)
  const [myAnswers, setMyAnswers] = useState<Answer[]>([])
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)

  // Answer form state
  const [answerType, setAnswerType] = useState<string>(ContentType.TEXT)
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
      setTopic(topicData)
      setQuestion(questionData)
      setMyAnswers(answersData.items)
    } catch (_error) {
      toast({
        title: t('errors.load_failed'),
        description: t('errors.permission_denied'),
        variant: 'destructive',
      })
      router.push(`/evaluation/respondent/topics/${topicId}`)
    } finally {
      setLoading(false)
    }
  }, [questionId, topicId, toast, router, t])

  useEffect(() => {
    if (questionId && topicId) {
      loadData()
    }
  }, [questionId, topicId, loadData])

  const handleSubmitAnswer = async () => {
    // Validate content based on answer type
    const hasText = answerText.trim().length > 0
    const hasAttachments = answerAttachments.length > 0

    if (answerType === ContentType.TEXT && !hasText) {
      toast({
        title: t('errors.save_failed'),
        description: `${t('answers.content')} is required`,
        variant: 'destructive',
      })
      return
    }

    if (answerType === ContentType.ATTACHMENT && !hasAttachments) {
      toast({
        title: t('errors.save_failed'),
        description: `${t('questions.attachments')} is required`,
        variant: 'destructive',
      })
      return
    }

    setSubmitting(true)
    try {
      const contentData: Record<string, unknown> = {}
      if (answerType === ContentType.TEXT || answerType === ContentType.MIXED) {
        if (hasText) {
          contentData.text = answerText.trim()
        }
      }
      if ((answerType === ContentType.ATTACHMENT || answerType === ContentType.MIXED) && hasAttachments) {
        contentData.attachments = answerAttachments
      }

      await respondentSubmitAnswer(questionId, {
        content_type: answerType,
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

  // Check if answer type should show attachment upload
  const showAnswerAttachment =
    answerType === ContentType.ATTACHMENT || answerType === ContentType.MIXED

  if (loading) {
    return (
      <div className="container mx-auto max-w-4xl px-4 py-8">
        <Skeleton className="mb-6 h-10 w-32" />
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
      {/* Header */}
      <div className="mb-6">
        <Button
          variant="ghost"
          onClick={() => router.push(`/evaluation/respondent/topics/${topicId}`)}
        >
          <ArrowLeft className="mr-2 h-4 w-4" />
          {t('actions.back')}
        </Button>
      </div>

      {/* Version Update Alert */}
      {question.has_new_version && (
        <Alert className="mb-6">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{t('answers.new_version_available')}</AlertDescription>
        </Alert>
      )}

      {/* Question Card - No grading criteria shown */}
      <Card className="mb-8">
        <CardHeader>
          <CardTitle>{question.title}</CardTitle>
          <CardDescription>
            {t('questions.content_type')}: {t(`questions.content_types.${question.content_type}`)}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {typeof question.content_data?.text === 'string' && question.content_data.text && (
            <div>
              <h3 className="mb-2 font-medium">{t('questions.content')}</h3>
              <p className="whitespace-pre-wrap text-text-secondary">
                {question.content_data.text}
              </p>
            </div>
          )}
          {typeof question.content_data?.url === 'string' && question.content_data.url && (
            <div>
              <h3 className="mb-2 font-medium">URL</h3>
              <a
                href={question.content_data.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline"
              >
                {question.content_data.url}
              </a>
            </div>
          )}
          {(question.content_data?.attachments as EvalAttachment[])?.length > 0 && (
            <div>
              <h3 className="mb-2 font-medium">{t('questions.attachments')}</h3>
              {renderAttachmentList(question.content_data?.attachments as EvalAttachment[])}
            </div>
          )}
          {/* NOTE: Grading criteria (criteria_data) is intentionally NOT displayed for respondents */}
        </CardContent>
      </Card>

      {/* Answer Submission Form */}
      <Card className="mb-8">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Send className="h-5 w-5" />
            {t('answers.submit')}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="answerType">{t('questions.content_type')}</Label>
            <Select value={answerType} onValueChange={setAnswerType}>
              <SelectTrigger id="answerType">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="text">{t('questions.content_types.text')}</SelectItem>
                <SelectItem value="attachment">{t('questions.content_types.attachment')}</SelectItem>
                <SelectItem value="mixed">{t('questions.content_types.mixed')}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {(answerType === ContentType.TEXT || answerType === ContentType.MIXED) && (
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
          )}

          {showAnswerAttachment && (
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
          )}

          <div className="flex justify-end">
            <Button variant="primary" onClick={handleSubmitAnswer} disabled={submitting}>
              {submitting ? '...' : t('answers.submit')}
            </Button>
          </div>
        </CardContent>
      </Card>

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
