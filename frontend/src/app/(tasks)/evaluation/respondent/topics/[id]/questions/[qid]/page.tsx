// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect, useCallback } from 'react'
import { useParams, useRouter } from 'next/navigation'
import {
  Send,
  AlertCircle,
  File,
  Download,
  Info,
  FileText,
  Upload,
  ChevronDown,
  ChevronUp,
  Clock,
  ArrowLeft,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
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
import EnhancedMarkdown from '@/components/common/EnhancedMarkdown'
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
import { MAX_BATCH_FILES } from '@/hooks/useBatchAttachment'

function RespondentQuestionDetailContent() {
  const params = useParams()
  const router = useRouter()
  const { toast } = useToast()
  const { theme } = useTheme()
  const { t } = useTranslation('evaluation')
  const topicId = parseInt(params.id as string)
  const questionId = parseInt(params.qid as string)

  const [topic, setTopic] = useState<Topic | null>(null)
  const [question, setQuestion] = useState<Question | null>(null)
  const [myAnswers, setMyAnswers] = useState<Answer[]>([])
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [showConfirmDialog, setShowConfirmDialog] = useState(false)
  const [activeTab, setActiveTab] = useState('question')

  // Answer form state
  const [answerText, setAnswerText] = useState('')
  const [answerAttachments, setAnswerAttachments] = useState<EvalAttachment[]>([])
  const [showTextInput, setShowTextInput] = useState(false)

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
    } finally {
      setLoading(false)
    }
  }, [questionId, topicId, toast, t])

  useEffect(() => {
    if (questionId && topicId) {
      loadData()
    }
  }, [questionId, topicId, loadData])

  // Get effective instructions: question-level overrides topic-level
  const getInstructions = (): string | null => {
    const questionInstructions = question?.content_data?.instructions as string | undefined
    if (questionInstructions?.trim()) return questionInstructions

    const topicInstructions = topic?.extra_data?.instructions as string | undefined
    if (topicInstructions?.trim()) return topicInstructions

    return null
  }

  const isContentEmpty = () => {
    return answerText.trim().length === 0 && answerAttachments.length === 0
  }

  const handleSubmitClick = () => {
    if (isContentEmpty()) {
      toast({
        title: t('errors.save_failed'),
        description: t('answers.content_required'),
        variant: 'destructive',
      })
      return
    }

    if (myAnswers.length > 0) {
      setShowConfirmDialog(true)
    } else {
      handleSubmitAnswer()
    }
  }

  const handleSubmitAnswer = async () => {
    setShowConfirmDialog(false)
    setSubmitting(true)
    try {
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
      setShowTextInput(false)
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

  const renderAttachmentList = (attachments: EvalAttachment[] | undefined) => {
    if (!attachments || attachments.length === 0) return null
    return (
      <div className="space-y-1.5">
        {attachments.map((attachment, index) => (
          <div
            key={attachment.key || index}
            className="flex items-center gap-3 rounded-lg border border-border bg-surface/50 px-3 py-2"
          >
            <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded bg-primary/10">
              <File className="h-4 w-4 text-primary" />
            </div>
            <span className="min-w-0 flex-1 truncate text-sm">{attachment.filename}</span>
            {attachment.file_size && (
              <span className="flex-shrink-0 text-xs text-text-muted">
                {formatFileSize(attachment.file_size)}
              </span>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 flex-shrink-0"
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
      <div className="container mx-auto max-w-3xl px-4 py-8">
        <Skeleton className="mb-6 h-8 w-48" />
        <Skeleton className="mb-4 h-6 w-full" />
        <Skeleton className="mb-8 h-64 w-full" />
      </div>
    )
  }

  if (!question) {
    return null
  }

  const instructions = getInstructions()
  const tabCount = instructions ? 3 : 2
  const gridCols = tabCount === 3 ? 'grid-cols-3' : 'grid-cols-2'

  return (
    <div className="container mx-auto max-w-3xl px-4 py-8">
      {/* Back navigation */}
      <Button
        variant="ghost"
        className="mb-4"
        onClick={() => router.push(`/evaluation/respondent/topics/${topicId}`)}
      >
        <ArrowLeft className="mr-2 h-4 w-4" />
        {t('actions.back')}
      </Button>

      {/* Version update alert */}
      {question.has_new_version && (
        <Alert className="mb-6 border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30">
          <AlertCircle className="h-4 w-4 text-amber-600" />
          <AlertDescription className="text-amber-800 dark:text-amber-200">
            {t('answers.new_version_available')}
          </AlertDescription>
        </Alert>
      )}

      {/* Question header */}
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-text-primary">{question.title}</h1>
        <div className="mt-2 flex items-center gap-2 text-sm text-text-muted">
          <Badge variant="info" className="text-xs">
            v{question.current_version || '-'}
          </Badge>
          {topic && <span>{topic.name}</span>}
        </div>
      </div>

      {/* Main tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-6">
        <TabsList className={`grid w-full ${gridCols} bg-surface`}>
          {instructions && (
            <TabsTrigger value="instructions" className="flex items-center gap-1.5 text-sm">
              <Info className="h-3.5 w-3.5" />
              {t('answers.tabs.instructions')}
            </TabsTrigger>
          )}
          <TabsTrigger value="question" className="flex items-center gap-1.5 text-sm">
            <FileText className="h-3.5 w-3.5" />
            {t('answers.tabs.question')}
          </TabsTrigger>
          <TabsTrigger value="answer" className="flex items-center gap-1.5 text-sm">
            <Upload className="h-3.5 w-3.5" />
            {t('answers.tabs.answer')}
          </TabsTrigger>
        </TabsList>

        {/* Tab: Instructions (only if available) */}
        {instructions && (
          <TabsContent value="instructions" className="space-y-4">
            <Card className="border-primary/10">
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Info className="h-4 w-4 text-primary" />
                  {t('answers.instructions.title')}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-sm text-text-secondary">
                  {t('answers.instructions.description')}
                </p>

                {/* Rendered Markdown instructions */}
                <div className="rounded-lg border border-border bg-base p-4">
                  <EnhancedMarkdown
                    source={instructions}
                    theme={theme === 'dark' ? 'dark' : 'light'}
                  />
                </div>

                {/* Standard notices */}
                <div className="space-y-2 pt-2">
                  <div className="flex items-center justify-between rounded-lg border border-border bg-surface/50 px-3 py-2.5">
                    <span className="text-sm text-text-secondary">
                      {t('answers.instructions.time_limit')}
                    </span>
                    <Badge variant="info" className="text-xs">
                      {t('answers.instructions.no_limit')}
                    </Badge>
                  </div>
                  <div className="flex items-center justify-between rounded-lg border border-border bg-surface/50 px-3 py-2.5">
                    <span className="text-sm text-text-secondary">
                      {t('answers.instructions.attempts')}
                    </span>
                    <Badge variant="info" className="text-xs">
                      {t('answers.instructions.unlimited')}
                    </Badge>
                  </div>
                </div>

                <div className="rounded-lg border border-primary/20 bg-primary/5 px-3 py-2.5">
                  <p className="text-sm text-text-primary">
                    {t('answers.instructions.submission_notice')}
                  </p>
                </div>
              </CardContent>
            </Card>
          </TabsContent>
        )}

        {/* Tab: Question content */}
        <TabsContent value="question" className="space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <FileText className="h-4 w-4" />
                {t('questions.content')}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {typeof question.content_data?.text === 'string' && question.content_data.text ? (
                <div className="rounded-lg border border-border bg-base p-4">
                  <EnhancedMarkdown
                    source={question.content_data.text as string}
                    theme={theme === 'dark' ? 'dark' : 'light'}
                  />
                </div>
              ) : (
                <p className="py-4 text-center text-text-muted">{t('questions.no_content')}</p>
              )}

              {/* Question attachments */}
              {question.content_data?.attachments &&
                (question.content_data.attachments as EvalAttachment[]).length > 0 && (
                  <div className="space-y-2 pt-2">
                    <Label className="text-text-secondary">
                      {t('questions.content_attachments')}
                    </Label>
                    {renderAttachmentList(question.content_data.attachments as EvalAttachment[])}
                  </div>
                )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Tab: Answer submission */}
        <TabsContent value="answer" className="space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <Send className="h-4 w-4" />
                {t('answers.submit')}
              </CardTitle>
              <p className="mt-1 text-sm text-text-muted">{t('answers.submit_hint')}</p>
            </CardHeader>
            <CardContent className="space-y-5">
              {/* Primary: File upload area */}
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Upload className="h-4 w-4 text-primary" />
                  <Label className="font-medium">{t('questions.attachments')}</Label>
                  <Badge variant="info" className="text-xs">
                    {t('answers.upload_recommended')}
                  </Badge>
                </div>
                <EvaluationFileUpload
                  topicId={topicId}
                  questionId={questionId}
                  fileType="answer_attachment"
                  attachments={answerAttachments}
                  onChange={setAnswerAttachments}
                  maxFiles={MAX_BATCH_FILES}
                />
              </div>

              {/* Secondary: Text input toggle */}
              <div className="border-t border-border pt-4">
                <button
                  type="button"
                  onClick={() => setShowTextInput(!showTextInput)}
                  className="flex w-full items-center justify-between rounded-lg border border-dashed border-border px-4 py-2.5 text-left text-sm text-text-secondary transition-colors hover:border-primary/50 hover:bg-surface/50"
                >
                  <span>
                    {showTextInput
                      ? t('answers.hide_text_input')
                      : t('answers.show_text_input')}
                  </span>
                  {showTextInput ? (
                    <ChevronUp className="h-4 w-4" />
                  ) : (
                    <ChevronDown className="h-4 w-4" />
                  )}
                </button>
                {!showTextInput && (
                  <p className="mt-1.5 text-xs text-text-muted">
                    {t('answers.show_text_input_hint')}
                  </p>
                )}
              </div>

              {/* Collapsible text area */}
              {showTextInput && (
                <div className="space-y-2">
                  <Label htmlFor="answerText" className="text-text-secondary">
                    {t('answers.content')}
                  </Label>
                  <Textarea
                    id="answerText"
                    value={answerText}
                    onChange={e => setAnswerText(e.target.value)}
                    placeholder={t('answers.content_placeholder')}
                    rows={6}
                    className="font-mono text-sm"
                  />
                </div>
              )}

              {/* Submit row */}
              <div className="flex items-center justify-between border-t border-border pt-4">
                <div className="text-xs text-text-muted">
                  {answerAttachments.length > 0 && (
                    <span>
                      {answerAttachments.length} {t('questions.attachments').toLowerCase()}
                    </span>
                  )}
                  {answerAttachments.length > 0 && answerText.trim() && <span> · </span>}
                  {answerText.trim() && <span>{t('answers.content')}</span>}
                </div>
                <Button
                  variant="primary"
                  onClick={handleSubmitClick}
                  disabled={submitting || isContentEmpty()}
                  className="min-w-[120px]"
                >
                  <Send className="mr-2 h-4 w-4" />
                  {submitting ? '...' : t('answers.submit')}
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* Previous answers */}
          {myAnswers.length > 0 && (
            <Card className="border-border/60">
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-base text-text-secondary">
                  <Clock className="h-4 w-4" />
                  {t('answers.history')} ({myAnswers.length})
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  {myAnswers.map(answer => (
                    <div
                      key={answer.id}
                      className="rounded-lg border border-border/60 bg-surface/30 p-3"
                    >
                      <div className="mb-2 flex items-center justify-between">
                        <span className="text-xs text-text-muted">
                          {new Date(answer.submitted_at).toLocaleString()}
                        </span>
                        <div className="flex gap-1.5">
                          {answer.is_latest && (
                            <Badge variant="success" className="text-xs">
                              {t('answers.latest')}
                            </Badge>
                          )}
                          <Badge variant="info" className="text-xs">
                            v{answer.question_version}
                          </Badge>
                        </div>
                      </div>
                      {typeof answer.content_data?.text === 'string' &&
                        answer.content_data.text && (
                          <p className="mb-2 line-clamp-3 whitespace-pre-wrap text-sm text-text-secondary">
                            {answer.content_data.text as string}
                          </p>
                        )}
                      {renderAttachmentList(
                        answer.content_data?.attachments as EvalAttachment[]
                      )}
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </TabsContent>
      </Tabs>

      {/* Confirmation dialog */}
      <AlertDialog open={showConfirmDialog} onOpenChange={setShowConfirmDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('answers.confirm_submit_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('answers.confirm_submit_description')}
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
