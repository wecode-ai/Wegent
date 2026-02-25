'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { ChevronLeft, ChevronRight, Clock, FileText, Upload, Send } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { useQuestionDraft } from '../hooks/useQuestionDraft'
import { useAnswerTimer } from '../hooks/useAnswerTimer'
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'
import { respondentGetQuestion, respondentSubmitAnswer } from '@wecode/api/evaluation-respondent'
import { ContentType } from '@wecode/types/evaluation'
import type { Question, Topic, EvalAttachment } from '@wecode/types/evaluation'
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
import EnhancedMarkdown from '@/components/common/EnhancedMarkdown'
import { useTheme } from '@/features/theme/ThemeProvider'
import { EvaluationFileUpload } from '@wecode/components/evaluation/common/EvaluationFileUpload'
import { Textarea } from '@/components/ui/textarea'
import { MAX_BATCH_FILES } from '@/hooks/useBatchAttachment'
import { formatFileSize } from '@/apis/attachments'
import { File, X } from 'lucide-react'

interface RespondentQuestionDesktopProps {
  topic: Topic
  questionId: number
  currentQuestionIndex: number
  totalQuestions: number
  questionIds: number[]
}

export function RespondentQuestionDesktop({
  topic,
  questionId,
  currentQuestionIndex,
  totalQuestions,
  questionIds,
}: RespondentQuestionDesktopProps) {
  const router = useRouter()
  const { toast } = useToast()
  const { t } = useTranslation('evaluation')
  const { formattedTime } = useAnswerTimer()
  const { theme } = useTheme()

  const [question, setQuestion] = useState<Question | null>(null)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [showConfirmDialog, setShowConfirmDialog] = useState(false)

  const { draft, lastSaved, saveDraft, clearDraft } = useQuestionDraft(questionId)
  const [answerText, setAnswerText] = useState('')
  const [attachments, setAttachments] = useState<EvalAttachment[]>([])
  const [showTextInput, setShowTextInput] = useState(false)

  // Load draft on mount
  useEffect(() => {
    if (draft) {
      setAnswerText(draft.text)
      setAttachments(draft.attachments)
    }
  }, [draft])

  // Auto-save draft
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

      await respondentSubmitAnswer(questionId, {
        content_type: ContentType.MIXED,
        content_data: contentData,
      })

      clearDraft()
      toast({
        title: t('answers.submit_success'),
      })

      // Navigate to next question or back to topic
      if (currentQuestionIndex < totalQuestions - 1) {
        handleNext()
      } else {
        router.push(`/evaluation/respondent/topics/${topic.id}`)
      }
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

  const handleRemoveAttachment = (index: number) => {
    const newAttachments = [...attachments]
    newAttachments.splice(index, 1)
    setAttachments(newAttachments)
  }

  const progress = Math.round(((currentQuestionIndex + 1) / totalQuestions) * 100)

  if (loading || !question) {
    return (
      <div className="flex h-screen flex-col bg-surface">
        <div className="h-16 border-b border-border bg-white" />
        <div className="flex flex-1 items-center justify-center">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        </div>
      </div>
    )
  }

  const instructions =
    (question.content_data?.instructions as string)?.trim() ||
    (topic.extra_data?.instructions as string)?.trim()
  const questionAttachments = question.content_data?.attachments as
    | Array<{ key: string; filename: string; file_size?: number }>
    | undefined

  return (
    <div className="flex h-screen flex-col bg-surface">
      {/* Header */}
      <header className="h-16 border-b border-border bg-white px-6 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-4">
          <h1 className="font-semibold text-text-primary truncate max-w-[300px]">{topic.name}</h1>
          <Badge variant="secondary" className="text-xs">
            {currentQuestionIndex + 1} / {totalQuestions}
          </Badge>
        </div>

        <div className="flex items-center gap-6">
          {/* Progress Bar */}
          <div className="flex items-center gap-3">
            <div className="w-32 h-2 bg-border rounded-full overflow-hidden">
              <div
                className="h-full bg-primary transition-all duration-300"
                style={{ width: `${progress}%` }}
              />
            </div>
            <span className="text-sm text-text-secondary">{progress}%</span>
          </div>

          {/* Timer */}
          <div className="flex items-center gap-2 text-text-secondary bg-surface px-3 py-1.5 rounded-lg">
            <Clock className="h-4 w-4" />
            <span className="text-sm font-medium tabular-nums">{formattedTime}</span>
          </div>

          {/* Navigation */}
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handlePrevious}
              disabled={currentQuestionIndex === 0}
              className="h-9 px-4"
            >
              <ChevronLeft className="h-4 w-4 mr-1" />
              {t('actions.previous')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleNext}
              disabled={currentQuestionIndex === totalQuestions - 1}
              className="h-9 px-4"
            >
              {t('actions.next')}
              <ChevronRight className="h-4 w-4 ml-1" />
            </Button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <div className="flex-1 grid grid-cols-2 gap-0 overflow-hidden">
        {/* Left: Question Panel */}
        <div className="overflow-y-auto bg-white border-r border-border">
          <div className="max-w-2xl mx-auto p-8">
            {/* Instructions */}
            {instructions && (
              <Card className="mb-6 border-amber-200 bg-amber-50/50">
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm font-medium text-amber-900 flex items-center gap-2">
                    <FileText className="h-4 w-4" />
                    {t('answers.instructions.title')}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="prose prose-sm max-w-none text-amber-800">
                    <EnhancedMarkdown
                      source={instructions}
                      theme={theme === 'dark' ? 'dark' : 'light'}
                    />
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Question Title */}
            <div className="mb-6">
              <h2 className="text-xl font-semibold text-text-primary leading-relaxed">
                {question.title}
              </h2>
            </div>

            {/* Question Content */}
            <Card className="border-0 shadow-none bg-transparent">
              <CardContent className="p-0">
                {typeof question.content_data?.text === 'string' && question.content_data.text ? (
                  <div className="prose prose-base max-w-none text-text-primary">
                    <EnhancedMarkdown
                      source={question.content_data.text}
                      theme={theme === 'dark' ? 'dark' : 'light'}
                    />
                  </div>
                ) : (
                  <p className="text-text-muted py-8 text-center">{t('questions.no_content')}</p>
                )}

                {/* Question Attachments */}
                {questionAttachments && questionAttachments.length > 0 && (
                  <div className="mt-8 pt-6 border-t border-border">
                    <h3 className="text-sm font-medium text-text-secondary mb-4 flex items-center gap-2">
                      <File className="h-4 w-4" />
                      {t('questions.content_attachments')}
                    </h3>
                    <div className="space-y-2">
                      {questionAttachments.map((attachment, index) => (
                        <a
                          key={attachment.key || index}
                          href={`/api/evaluation/respondent/files/${attachment.key}?filename=${encodeURIComponent(attachment.filename)}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center gap-3 p-3 rounded-lg border border-border bg-surface/50 hover:bg-surface hover:border-primary/30 transition-colors"
                        >
                          <File className="h-5 w-5 text-primary flex-shrink-0" />
                          <span className="text-sm text-text-primary truncate flex-1">
                            {attachment.filename}
                          </span>
                          {attachment.file_size && (
                            <span className="text-xs text-text-muted flex-shrink-0">
                              {formatFileSize(attachment.file_size)}
                            </span>
                          )}
                        </a>
                      ))}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </div>

        {/* Right: Answer Panel */}
        <div className="overflow-y-auto bg-surface">
          <div className="max-w-2xl mx-auto p-8">
            <Card className="border-0 shadow-sm">
              <CardHeader className="pb-4">
                <CardTitle className="text-lg font-semibold flex items-center gap-2">
                  <Upload className="h-5 w-5 text-primary" />
                  提交作答
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-6">
                {/* File Upload */}
                <div className="space-y-3">
                  <div className="border-2 border-dashed border-border rounded-xl p-8 text-center hover:border-primary/50 transition-colors bg-white">
                    <div className="flex flex-col items-center gap-3">
                      <div className="h-12 w-12 rounded-full bg-primary/10 flex items-center justify-center">
                        <Upload className="h-6 w-6 text-primary" />
                      </div>
                      <div>
                        <p className="text-sm font-medium text-text-primary">
                          {t('answers.upload_drag_hint')}
                        </p>
                        <p className="text-xs text-text-muted mt-1">
                          {t('answers.upload_format_hint')}
                        </p>
                      </div>
                      <EvaluationFileUpload
                        topicId={topic.id}
                        questionId={questionId}
                        fileType="answer_attachment"
                        attachments={attachments}
                        onChange={setAttachments}
                        maxFiles={MAX_BATCH_FILES}
                      />
                    </div>
                  </div>
                </div>

                {/* Uploaded Files */}
                {attachments.length > 0 && (
                  <div className="space-y-3">
                    <h3 className="text-sm font-medium text-text-secondary">
                      {t('answers.uploaded_files')} ({attachments.length})
                    </h3>
                    <div className="space-y-2">
                      {attachments.map((attachment, index) => (
                        <div
                          key={attachment.key || index}
                          className="flex items-center gap-3 p-3 rounded-lg border border-border bg-white group"
                        >
                          <File className="h-5 w-5 text-primary flex-shrink-0" />
                          <div className="flex-1 min-w-0">
                            <p className="text-sm text-text-primary truncate">
                              {attachment.filename}
                            </p>
                            {attachment.file_size && (
                              <p className="text-xs text-text-muted">
                                {formatFileSize(attachment.file_size)}
                              </p>
                            )}
                          </div>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 opacity-0 group-hover:opacity-100 transition-opacity"
                            onClick={() => handleRemoveAttachment(index)}
                          >
                            <X className="h-4 w-4" />
                          </Button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="h-px bg-border" />

                {/* Text Input Toggle */}
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-text-secondary">
                      {t('answers.text_supplement')}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setShowTextInput(!showTextInput)}
                    >
                      {showTextInput ? '收起' : '展开'}
                    </Button>
                  </div>
                  {showTextInput && (
                    <Textarea
                      value={answerText}
                      onChange={e => setAnswerText(e.target.value)}
                      placeholder={t('answers.content_placeholder')}
                      className="min-h-[150px] resize-y"
                    />
                  )}
                </div>

                {/* Submit Button */}
                <div className="flex items-center justify-between pt-4">
                  <div className="text-xs text-text-muted">
                    {lastSaved && (
                      <span>
                        {t('answers.auto_saved')}{' '}
                        {new Date(lastSaved).toLocaleTimeString('zh-CN', {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </span>
                    )}
                  </div>
                  <Button
                    variant="primary"
                    onClick={handleSubmitClick}
                    disabled={
                      submitting || (answerText.trim().length === 0 && attachments.length === 0)
                    }
                    className="h-11 px-8"
                  >
                    <Send className="h-4 w-4 mr-2" />
                    {submitting ? '提交中...' : t('answers.submit')}
                  </Button>
                </div>
              </CardContent>
            </Card>
          </div>
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
