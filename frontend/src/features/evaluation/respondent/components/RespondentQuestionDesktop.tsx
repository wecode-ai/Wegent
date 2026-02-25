'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
import { RespondentProgressHeader } from './RespondentProgressHeader'
import { QuestionPanel } from './QuestionPanel'
import { AnswerPanel } from './AnswerPanel'
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

  const [question, setQuestion] = useState<Question | null>(null)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [showConfirmDialog, setShowConfirmDialog] = useState(false)

  const { draft, lastSaved, saveDraft, clearDraft } = useQuestionDraft(questionId)
  const [answerText, setAnswerText] = useState('')
  const [attachments, setAttachments] = useState<EvalAttachment[]>([])

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
    <div className="flex h-screen flex-col">
      <RespondentProgressHeader
        topicName={topic.name}
        currentQuestion={currentQuestionIndex + 1}
        totalQuestions={totalQuestions}
        formattedTime={formattedTime}
        onPrevious={handlePrevious}
        onNext={handleNext}
        hasPrevious={currentQuestionIndex > 0}
        hasNext={currentQuestionIndex < totalQuestions - 1}
      />

      <PanelGroup direction="horizontal" className="flex-1">
        <Panel defaultSize={45} minSize={30} maxSize={60}>
          <QuestionPanel question={question} topic={topic} />
        </Panel>

        <PanelResizeHandle className="w-1 bg-border hover:bg-primary/30" />

        <Panel defaultSize={55} minSize={40} maxSize={70}>
          <AnswerPanel
            topicId={topic.id}
            questionId={questionId}
            answerText={answerText}
            setAnswerText={setAnswerText}
            attachments={attachments}
            setAttachments={setAttachments}
            onSubmit={handleSubmitClick}
            isSubmitting={submitting}
            lastSaved={lastSaved}
          />
        </Panel>
      </PanelGroup>

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
