'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'
import {
  respondentGetQuestion,
  respondentSubmitAnswer,
  respondentListAnswerHistory,
} from '@wecode/api/evaluation-respondent'
import { ContentType } from '@wecode/types/evaluation'
import type { Question, Topic, EvalAttachment, Answer } from '@wecode/types/evaluation'
import { useQuestionDraft } from './useQuestionDraft'

interface UseRespondentQuestionOptions {
  topic: Topic
  questionId: number
  currentQuestionIndex: number
  totalQuestions: number
  questionIds: number[]
}

interface UseRespondentQuestionReturn {
  question: Question | null
  loading: boolean
  answerText: string
  attachments: EvalAttachment[]
  lastSubmittedAnswer: Answer | null
  submitting: boolean
  showConfirmDialog: boolean
  showTextInput: boolean
  showLastSubmitted: boolean
  showInstructions: boolean
  progress: number
  instructions: string | undefined
  lastSaved: Date | null
  isEmpty: boolean
  setAnswerText: (text: string) => void
  setAttachments: (attachments: EvalAttachment[]) => void
  setShowTextInput: (show: boolean) => void
  setShowLastSubmitted: (show: boolean) => void
  setShowInstructions: (show: boolean) => void
  setShowConfirmDialog: (show: boolean) => void
  handlePrevious: () => void
  handleNext: () => void
  handleSubmitClick: () => void
  handleSubmit: () => Promise<void>
}

export function useRespondentQuestion(
  options: UseRespondentQuestionOptions
): UseRespondentQuestionReturn {
  const { topic, questionId, currentQuestionIndex, totalQuestions, questionIds } = options
  const router = useRouter()
  const { toast } = useToast()
  const { t } = useTranslation('evaluation')

  const [question, setQuestion] = useState<Question | null>(null)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [showConfirmDialog, setShowConfirmDialog] = useState(false)
  const [showTextInput, setShowTextInput] = useState(false)
  const [showLastSubmitted, setShowLastSubmitted] = useState(false)
  const [showInstructions, setShowInstructions] = useState(true)

  const { draft, lastSaved, saveDraft, clearDraft } = useQuestionDraft(questionId)
  const [answerText, setAnswerText] = useState('')
  const [attachments, setAttachments] = useState<EvalAttachment[]>([])
  const [lastSubmittedAnswer, setLastSubmittedAnswer] = useState<Answer | null>(null)

  useEffect(() => {
    if (draft) {
      setAnswerText(draft.text)
      setAttachments(draft.attachments)
    }
  }, [draft])

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
      // Silently fail
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

  const handlePrevious = useCallback(() => {
    if (currentQuestionIndex > 0) {
      const prevId = questionIds[currentQuestionIndex - 1]
      router.push(`/evaluation/respondent/topics/${topic.id}/questions/${prevId}`)
    }
  }, [currentQuestionIndex, questionIds, router, topic.id])

  const handleNext = useCallback(() => {
    if (currentQuestionIndex < totalQuestions - 1) {
      const nextId = questionIds[currentQuestionIndex + 1]
      router.push(`/evaluation/respondent/topics/${topic.id}/questions/${nextId}`)
    }
  }, [currentQuestionIndex, totalQuestions, questionIds, router, topic.id])

  const handleSubmit = useCallback(async () => {
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
  }, [answerText, attachments, questionId, clearDraft, toast, t])

  const handleSubmitClick = useCallback(() => {
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
  }, [answerText, attachments, toast, t])

  const progress = useMemo(
    () => Math.round(((currentQuestionIndex + 1) / totalQuestions) * 100),
    [currentQuestionIndex, totalQuestions]
  )

  const instructions = useMemo(
    () =>
      (question?.content_data?.instructions as string)?.trim() ||
      (topic.extra_data?.instructions as string)?.trim(),
    [question, topic]
  )

  const isEmpty = useMemo(
    () => answerText.trim().length === 0 && attachments.length === 0,
    [answerText, attachments]
  )

  return {
    question,
    loading,
    answerText,
    attachments,
    lastSubmittedAnswer,
    submitting,
    showConfirmDialog,
    showTextInput,
    showLastSubmitted,
    showInstructions,
    progress,
    instructions,
    lastSaved,
    isEmpty,
    setAnswerText,
    setAttachments,
    setShowTextInput,
    setShowLastSubmitted,
    setShowInstructions,
    setShowConfirmDialog,
    handlePrevious,
    handleNext,
    handleSubmitClick,
    handleSubmit,
  }
}
