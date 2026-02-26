'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { ChevronLeft, ChevronRight, Clock, Info, History, Download } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardTitle } from '@/components/ui/card'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import EnhancedMarkdown from '@/components/common/EnhancedMarkdown'
import { EvaluationFileUpload } from '@wecode/components/evaluation/common/EvaluationFileUpload'
import { useTheme } from '@/features/theme/ThemeProvider'
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'
import { useQuestionDraft } from '../hooks/useQuestionDraft'
import { useAnswerTimer } from '../hooks/useAnswerTimer'
import { MAX_BATCH_FILES } from '@/hooks/useBatchAttachment'
import {
  respondentGetQuestion,
  respondentSubmitAnswer,
  respondentListAnswerHistory,
} from '@wecode/api/evaluation-respondent'
import { ContentType } from '@wecode/types/evaluation'
import type { Question, Topic, EvalAttachment, Answer } from '@wecode/types/evaluation'
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
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { formatFileSize } from '@/apis/attachments'
import { File } from 'lucide-react'

interface RespondentQuestionMobileProps {
  topic: Topic
  questionId: number
  currentQuestionIndex: number
  totalQuestions: number
  questionIds: number[]
}

export function RespondentQuestionMobile({
  topic,
  questionId,
  currentQuestionIndex,
  totalQuestions,
  questionIds,
}: RespondentQuestionMobileProps) {
  const router = useRouter()
  const { theme } = useTheme()
  const { toast } = useToast()
  const { t } = useTranslation('evaluation')
  const { formattedTime } = useAnswerTimer()

  const [question, setQuestion] = useState<Question | null>(null)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [showConfirmDialog, setShowConfirmDialog] = useState(false)
  const [showInstructions, setShowInstructions] = useState(true)

  const { draft, saveDraft, clearDraft } = useQuestionDraft(questionId)
  const [answerText, setAnswerText] = useState('')
  const [attachments, setAttachments] = useState<EvalAttachment[]>([])
  const [showTextInput, setShowTextInput] = useState(false)

  // Last submitted answer
  const [lastSubmittedAnswer, setLastSubmittedAnswer] = useState<Answer | null>(null)
  const [showLastSubmitted, setShowLastSubmitted] = useState(false)

  useEffect(() => {
    if (draft) {
      setAnswerText(draft.text)
      setAttachments(draft.attachments)
    }
  }, [draft])

  // Load last submitted answer
  const loadLastSubmittedAnswer = useCallback(async () => {
    try {
      const response = await respondentListAnswerHistory({
        question_id: questionId,
        latest_only: true,
        limit: 1,
      })
      if (response.items.length > 0) {
        setLastSubmittedAnswer(response.items[0])
      }
    } catch {
      // Silently fail - last submitted answer is not critical
    }
  }, [questionId])

  useEffect(() => {
    loadLastSubmittedAnswer()
  }, [loadLastSubmittedAnswer])

  useEffect(() => {
    const timeout = setTimeout(() => {
      if (answerText.trim() || attachments.length > 0) {
        saveDraft(answerText, attachments)
      }
    }, 3000)
    return () => clearTimeout(timeout)
  }, [answerText, attachments, saveDraft])

  const loadQuestion = useCallback(async () => {
    setLoading(true)
    try {
      const questionData = await respondentGetQuestion(questionId)
      setQuestion(questionData)
    } catch {
      toast({
        title: t('errors.load_failed'),
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
    }
  }, [questionId, toast, t])

  useEffect(() => {
    loadQuestion()
  }, [loadQuestion])

  const handlePrevious = () => {
    if (currentQuestionIndex > 0) {
      const prevId = questionIds[currentQuestionIndex - 1]
      router.push(`/evaluation/respondent/topics/${topic.id}/questions/${prevId}`)
    }
  }

  const handleNext = () => {
    if (currentQuestionIndex < totalQuestions - 1) {
      const nextId = questionIds[currentQuestionIndex + 1]
      router.push(`/evaluation/respondent/topics/${topic.id}/questions/${nextId}`)
    }
  }

  const handleSubmit = async () => {
    setSubmitting(true)
    try {
      const contentData: Record<string, unknown> = {}
      if (answerText.trim()) {
        contentData.text = answerText.trim()
      }
      if (attachments.length > 0) {
        contentData.attachments = attachments
      }

      const newAnswer = await respondentSubmitAnswer(questionId, {
        content_type: ContentType.MIXED,
        content_data: contentData,
      })

      clearDraft()
      setLastSubmittedAnswer(newAnswer)
      toast({
        title: t('answers.submit_success'),
      })

      // Reset form for potential re-submission
      setAnswerText('')
      setAttachments([])
    } catch {
      toast({
        title: t('errors.save_failed'),
        variant: 'destructive',
      })
    } finally {
      setSubmitting(false)
      setShowConfirmDialog(false)
    }
  }

  const handleSubmitClick = () => {
    const isEmpty = answerText.trim().length === 0 && attachments.length === 0
    if (isEmpty) {
      toast({
        title: t('errors.save_failed'),
        description: t('answers.content_required'),
        variant: 'destructive',
      })
      return
    }
    setShowConfirmDialog(true)
  }

  const instructions =
    (question?.content_data?.instructions as string)?.trim() ||
    (topic.extra_data?.instructions as string)?.trim()

  const progress = Math.round(((currentQuestionIndex + 1) / totalQuestions) * 100)

  const lastSubmittedAttachments = lastSubmittedAnswer?.content_data?.attachments as
    | Array<{ key: string; filename: string; file_size?: number }>
    | undefined

  if (loading || !question) {
    return (
      <div className="flex h-screen flex-col">
        <div className="h-14 border-b border-border bg-surface" />
        <div className="flex flex-1 items-center justify-center">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-screen flex-col bg-base">
      {/* Mobile Header */}
      <div className="flex h-14 items-center justify-between border-b border-border bg-surface px-4">
        <span className="text-sm font-medium text-text-primary">{topic.name}</span>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1">
            <span className="text-xs text-text-muted">{t('ui.progress')}</span>
            <div className="h-2 w-16 overflow-hidden rounded-full bg-border">
              <div className="h-full bg-primary" style={{ width: `${progress}%` }} />
            </div>
          </div>
          <div className="flex items-center gap-1 text-sm text-text-secondary">
            <Clock className="h-4 w-4" />
            <span className="text-xs text-text-muted">{t('ui.time_spent')}</span>
            <span className="tabular-nums">{formattedTime}</span>
          </div>
        </div>
      </div>

      {/* Mobile Navigation */}
      <div className="flex items-center justify-between border-b border-border bg-surface px-4 py-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={handlePrevious}
          disabled={currentQuestionIndex === 0}
          className="h-9"
        >
          <ChevronLeft className="mr-1 h-4 w-4" />
          {t('actions.previous')}
        </Button>
        <span className="text-sm text-text-secondary">
          {currentQuestionIndex + 1} / {totalQuestions}
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={handleNext}
          disabled={currentQuestionIndex === totalQuestions - 1}
          className="h-9"
        >
          {t('actions.next')}
          <ChevronRight className="ml-1 h-4 w-4" />
        </Button>
      </div>

      {/* Mobile Content */}
      <div className="flex-1 overflow-y-auto">
        {/* Question Section */}
        <div className="border-b border-border p-4">
          <h1 className="text-lg font-semibold text-text-primary">{question.title}</h1>
          <Badge variant="secondary" className="mt-2 text-xs">
            v{question.current_version || '-'}
          </Badge>
        </div>

        {/* Instructions - Collapsible */}
        {instructions && (
          <Card className="m-4 border-amber-200 bg-amber-50/50">
            <Collapsible open={showInstructions} onOpenChange={setShowInstructions}>
              <CollapsibleTrigger asChild>
                <button className="flex w-full items-center justify-between p-3 text-left">
                  <div className="flex items-center gap-2">
                    <Info className="h-4 w-4 text-amber-600" />
                    <span className="text-sm font-medium text-amber-900">
                      {t('answers.instructions.title')}
                    </span>
                  </div>
                  <div className="flex items-center gap-1">
                    <span className="text-sm text-amber-700">
                      {showInstructions ? t('actions.collapse') : t('actions.expand')}
                    </span>
                    {showInstructions ? (
                      <ChevronUp className="h-4 w-4 text-amber-700" />
                    ) : (
                      <ChevronDown className="h-4 w-4 text-amber-700" />
                    )}
                  </div>
                </button>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <CardContent className="pt-0 pb-3 px-3">
                  <div className="rounded-lg bg-white/50 p-3">
                    <EnhancedMarkdown
                      source={instructions}
                      theme={theme === 'dark' ? 'dark' : 'light'}
                    />
                  </div>
                </CardContent>
              </CollapsibleContent>
            </Collapsible>
          </Card>
        )}

        {/* Question Content */}
        <div className="p-4">
          {typeof question.content_data?.text === 'string' && question.content_data.text ? (
            <EnhancedMarkdown
              source={question.content_data.text}
              theme={theme === 'dark' ? 'dark' : 'light'}
            />
          ) : (
            <p className="py-4 text-center text-text-muted">{t('questions.no_content')}</p>
          )}
        </div>

        {/* Answer Section */}
        <div className="border-t border-border bg-surface p-4">
          {/* Last Submitted Answer */}
          {lastSubmittedAnswer && (
            <Card className="mb-4 border-blue-200 bg-blue-50/50">
              <Collapsible open={showLastSubmitted} onOpenChange={setShowLastSubmitted}>
                <CollapsibleTrigger asChild>
                  <button className="flex w-full items-center justify-between p-3 text-left">
                    <CardTitle className="text-sm font-semibold flex items-center gap-2 text-blue-900">
                      <History className="h-4 w-4" />
                      {t('ui.last_submitted')}
                      <span className="text-xs font-normal text-blue-600">
                        (
                        {new Date(lastSubmittedAnswer.submitted_at).toLocaleString('zh-CN', {
                          month: 'short',
                          day: 'numeric',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                        )
                      </span>
                    </CardTitle>
                    <div className="flex items-center gap-1">
                      <span className="text-sm text-blue-600">
                        {showLastSubmitted ? t('actions.collapse') : t('actions.expand')}
                      </span>
                      {showLastSubmitted ? (
                        <ChevronUp className="h-4 w-4 text-blue-600" />
                      ) : (
                        <ChevronDown className="h-4 w-4 text-blue-600" />
                      )}
                    </div>
                  </button>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <CardContent className="pt-0 pb-3 px-3 space-y-3">
                    {typeof lastSubmittedAnswer.content_data?.text === 'string' && (
                      <div className="rounded-lg bg-white border border-blue-100 p-3">
                        <p className="text-sm text-text-secondary mb-1">{t('ui.text_answer')}：</p>
                        <p className="text-sm text-text-primary whitespace-pre-wrap">
                          {lastSubmittedAnswer.content_data.text}
                        </p>
                      </div>
                    )}
                    {lastSubmittedAttachments && lastSubmittedAttachments.length > 0 && (
                      <div className="space-y-2">
                        <p className="text-sm text-text-secondary">
                          {t('ui.attachments')} ({lastSubmittedAttachments.length})：
                        </p>
                        <div className="space-y-2">
                          {lastSubmittedAttachments.map((attachment, index) => (
                            <a
                              key={attachment.key || index}
                              href={`/api/evaluation/respondent/files/${attachment.key}?filename=${encodeURIComponent(attachment.filename)}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="flex items-center gap-2 rounded-lg border border-blue-100 bg-white p-2"
                            >
                              <File className="h-4 w-4 text-blue-600" />
                              <span className="min-w-0 flex-1 truncate text-sm">
                                {attachment.filename}
                              </span>
                              {attachment.file_size && (
                                <span className="text-xs text-text-muted">
                                  {formatFileSize(attachment.file_size)}
                                </span>
                              )}
                              <Download className="h-4 w-4 text-blue-600" />
                            </a>
                          ))}
                        </div>
                      </div>
                    )}
                  </CardContent>
                </CollapsibleContent>
              </Collapsible>
            </Card>
          )}

          <h2 className="mb-3 text-base font-medium">
            {lastSubmittedAnswer ? t('ui.resubmit') : t('ui.submit_answer')}
          </h2>

          {/* Upload Area */}
          <Card className="mb-4 border-dashed">
            <CardContent className="p-4">
              <div className="flex flex-col items-center gap-2 text-center">
                <EvaluationFileUpload
                  topicId={topic.id}
                  questionId={questionId}
                  fileType="answer_attachment"
                  attachments={attachments}
                  onChange={setAttachments}
                  maxFiles={MAX_BATCH_FILES}
                />
              </div>
            </CardContent>
          </Card>

          {/* Text Input Toggle */}
          <button
            onClick={() => setShowTextInput(!showTextInput)}
            className="mb-2 flex w-full items-center justify-between rounded-lg border border-border px-3 py-2"
          >
            <span className="text-sm text-text-secondary">{t('answers.text_supplement')}</span>
            <span className="text-sm text-text-muted">
              {showTextInput ? t('actions.collapse') : t('actions.expand')}
            </span>
          </button>

          {showTextInput && (
            <Textarea
              value={answerText}
              onChange={e => setAnswerText(e.target.value)}
              placeholder={t('answers.content_placeholder')}
              className="mb-4 min-h-[100px]"
            />
          )}

          {/* Submit Button */}
          <Button
            variant="primary"
            onClick={handleSubmitClick}
            disabled={submitting || (answerText.trim().length === 0 && attachments.length === 0)}
            className="h-11 w-full"
          >
            {submitting ? t('actions.submitting') : t('answers.submit')}
          </Button>
        </div>
      </div>

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
            <AlertDialogAction onClick={handleSubmit}>{t('actions.confirm')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
