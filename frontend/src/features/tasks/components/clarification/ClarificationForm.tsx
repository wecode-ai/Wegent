// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect, useMemo, useContext } from 'react'
import { Send, Code, FileText } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import type { ClarificationData, ClarificationAnswer } from '@/types/api'
import ClarificationQuestion from './ClarificationQuestion'
import { useTranslation } from '@/hooks/useTranslation'
import { TaskContext } from '../../contexts/taskContext'
import { ChatStreamContext } from '../../contexts/chatStreamContext'
import { useToast } from '@/hooks/use-toast'

interface ClarificationFormProps {
  data: ClarificationData
  taskId: number
  currentMessageIndex: number
  /** Raw markdown content for display when toggling to raw view */
  rawContent?: string
  /** Callback when user submits the clarification form, passes the formatted markdown answer */
  onSubmit?: (formattedAnswer: string) => void
}

export default function ClarificationForm({
  data,
  taskId,
  currentMessageIndex,
  rawContent,
  onSubmit,
}: ClarificationFormProps) {
  const { t } = useTranslation()
  const { toast } = useToast()

  // Use context directly - it will be undefined if not within TaskContextProvider (e.g., shared task page)
  const taskContext = useContext(TaskContext)
  const selectedTaskDetail = taskContext?.selectedTaskDetail ?? null

  // Get isTaskStreaming from ChatStreamContext to check if task is currently streaming
  // Use useContext directly to avoid throwing error when outside ChatStreamProvider
  const chatStreamContext = useContext(ChatStreamContext)
  const isTaskStreaming = chatStreamContext?.isTaskStreaming ?? null

  const [answers, setAnswers] = useState<
    Map<string, { answer_type: 'choice' | 'custom'; value: string | string[] }>
  >(new Map())
  // Track if user has interacted with the form to prevent re-initialization
  const [hasUserInteracted, setHasUserInteracted] = useState(false)
  // Track validation errors for each question
  const [validationErrors, setValidationErrors] = useState<Set<string>>(new Set())
  // Track additional input value (fixed custom input box)
  const [additionalInput, setAdditionalInput] = useState('')
  // Toggle raw content view
  const [showRawContent, setShowRawContent] = useState(false)

  // Check if this clarification has been answered
  // Check if there's a USER message after this clarification's message index
  const isSubmitted = useMemo(() => {
    if (!selectedTaskDetail?.subtasks || selectedTaskDetail.subtasks.length === 0) return false

    console.log('[ClarificationForm] Checking submission status:', {
      currentMessageIndex,
      totalMessages: selectedTaskDetail.subtasks.length,
      questionIds: data.questions.map(q => q.question_id),
    })

    // Check if there's any USER message after the current message index
    const subtasksAfter = selectedTaskDetail.subtasks.slice(currentMessageIndex + 1)
    console.log(
      '[ClarificationForm] Subtasks after current message:',
      subtasksAfter.map((s: { id: number; role: string }) => ({ id: s.id, role: s.role }))
    )

    const hasUserMessageAfter = subtasksAfter.some((sub: { role: string }) => sub.role === 'USER')
    console.log('[ClarificationForm] Has USER message after:', hasUserMessageAfter)

    return hasUserMessageAfter
  }, [selectedTaskDetail?.subtasks, currentMessageIndex, data.questions])

  // Initialize default answers for questions with recommended options
  useEffect(() => {
    // Only initialize if user hasn't interacted yet
    if (hasUserInteracted) return

    const initialAnswers = new Map<
      string,
      { answer_type: 'choice' | 'custom'; value: string | string[] }
    >()

    data.questions.forEach(question => {
      if (question.question_type === 'single_choice') {
        const recommendedOption = question.options?.find(opt => opt.recommended)
        if (recommendedOption) {
          initialAnswers.set(question.question_id, {
            answer_type: 'choice',
            value: recommendedOption.value,
          })
        }
      } else if (question.question_type === 'multiple_choice') {
        const recommendedOptions = question.options?.filter(opt => opt.recommended) || []
        if (recommendedOptions.length > 0) {
          initialAnswers.set(question.question_id, {
            answer_type: 'choice',
            value: recommendedOptions.map(opt => opt.value),
          })
        }
      }
    })

    setAnswers(initialAnswers)
  }, [data.questions, hasUserInteracted])

  const handleAnswerChange = (
    questionId: string,
    answer: { answer_type: 'choice' | 'custom'; value: string | string[] }
  ) => {
    if (isSubmitted) return

    // Mark that user has interacted with the form
    setHasUserInteracted(true)

    setAnswers(prev => {
      const newAnswers = new Map(prev)
      newAnswers.set(questionId, answer)
      return newAnswers
    })

    // Clear validation error for this question when user provides an answer
    setValidationErrors(prev => {
      const newErrors = new Set(prev)
      newErrors.delete(questionId)
      return newErrors
    })
  }

  const handleSubmit = async () => {
    // Validate all questions are answered
    const unansweredQuestions = data.questions.filter(q => {
      const answer = answers.get(q.question_id)
      if (!answer) return true

      // For custom answers (text_input type), allow empty values - no validation required
      if (answer.answer_type === 'custom') {
        return false
      }

      // For choice answers (both single and multiple)
      // Multiple choice: allow empty array (user chose not to select any)
      // Single choice: must have a value
      if (Array.isArray(answer.value)) {
        // For multiple choice, empty array is valid (no selection is a valid choice)
        return false
      }

      // For single choice, must have a non-empty value
      return !answer.value || (typeof answer.value === 'string' && answer.value.trim() === '')
    })
    if (unansweredQuestions.length > 0) {
      // Mark unanswered questions with validation errors
      const errorQuestionIds = new Set(unansweredQuestions.map(q => q.question_id))
      setValidationErrors(errorQuestionIds)

      // Show detailed warning message
      const questionTitles = unansweredQuestions.map(q => `"${q.question_text}"`).join('、')

      toast({
        title:
          t('chat:clarification.please_answer_all') ||
          'Please answer all questions before submitting',
        description: questionTitles,
      })

      console.log(
        'Unanswered questions:',
        unansweredQuestions.map(q => q.question_id)
      )
      return
    }

    // Clear all validation errors before submitting
    setValidationErrors(new Set())

    // Build answer payload with question text and labels
    const answerPayload: ClarificationAnswer[] = Array.from(answers.entries()).map(
      ([question_id, answer]) => {
        const question = data.questions.find(q => q.question_id === question_id)

        const payload: ClarificationAnswer = {
          question_id,
          question_text: question?.question_text || '',
          answer_type: answer.answer_type,
          value: answer.value,
        }

        // For choice answers, include the selected labels
        if (answer.answer_type === 'choice' && question?.options) {
          if (Array.isArray(answer.value)) {
            // Multiple choice: find labels for all selected values
            payload.selected_labels = answer.value
              .map(val => question.options?.find(opt => opt.value === val)?.label)
              .filter(Boolean) as string[]
          } else {
            // Single choice: find label for the selected value
            const selectedOption = question.options.find(opt => opt.value === answer.value)
            payload.selected_labels = selectedOption?.label || answer.value
          }
        }

        return payload
      }
    )

    // Add additional input if it has content
    if (additionalInput && additionalInput.trim() !== '') {
      answerPayload.push({
        question_id: 'additional_input',
        question_text:
          t('chat:clarification.additional_thoughts') || 'Additional Thoughts or Remarks',
        answer_type: 'custom',
        value: additionalInput.trim(),
      })
    }

    // Build Markdown formatted answer
    let markdownAnswer = '## 📝 我的回答 (My Answers)\n\n'

    answerPayload.forEach(answer => {
      markdownAnswer += `### ${answer.question_id.toUpperCase()}: ${answer.question_text}\n`
      markdownAnswer += '**Answer**: '

      if (answer.answer_type === 'custom') {
        // Custom text input
        markdownAnswer += `${answer.value as string}\n\n`
      } else {
        // Choice answers
        if (Array.isArray(answer.value) && Array.isArray(answer.selected_labels)) {
          // Multiple choice
          markdownAnswer += '\n'
          answer.value.forEach((val, idx) => {
            const label = answer.selected_labels?.[idx] || val
            markdownAnswer += `- \`${val}\` - ${label}\n`
          })
          markdownAnswer += '\n'
        } else {
          // Single choice
          const label = answer.selected_labels || answer.value
          markdownAnswer += `\`${answer.value}\` - ${label}\n\n`
        }
      }
    })

    // Call the onSubmit callback with the formatted markdown answer
    // The parent component (ChatArea) will handle the actual sending logic
    // This ensures all chat options (web search, clarification mode, model, etc.) are properly included
    if (onSubmit) {
      onSubmit(markdownAnswer)
    } else {
      // Fallback: show a warning if no onSubmit callback is provided
      toast({
        variant: 'destructive',
        title: t('chat:clarification.submit_failed') || 'Failed to submit answers',
        description: 'No submit handler provided',
      })
    }
  }

  return (
    <div className="space-y-4 p-4 rounded-lg border border-primary/30 bg-primary/5">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <span className="text-lg">💬</span>
          <h3 className="text-base font-semibold text-primary">
            {t('chat:clarification.title') || 'Spec Clarification'}
          </h3>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setShowRawContent(!showRawContent)}
          className="text-xs text-text-secondary hover:text-text-primary"
        >
          {showRawContent ? (
            <>
              <FileText className="w-3.5 h-3.5 mr-1.5" />
              {t('chat:clarification.show_form') || 'Show Form'}
            </>
          ) : (
            <>
              <Code className="w-3.5 h-3.5 mr-1.5" />
              {t('chat:clarification.show_raw') || 'Show Raw'}
            </>
          )}
        </Button>
      </div>

      {showRawContent ? (
        <div className="p-3 rounded bg-surface/50 border border-border">
          <pre className="text-xs text-text-secondary overflow-auto max-h-96 whitespace-pre-wrap break-words font-mono">
            {rawContent || JSON.stringify(data, null, 2)}
          </pre>
        </div>
      ) : (
        <>
          <div className="space-y-4">
            {data.questions.map(question => {
              const hasError = validationErrors.has(question.question_id)
              return (
                <div
                  key={question.question_id}
                  className={`p-3 rounded bg-surface/50 border transition-colors ${
                    hasError ? 'border-red-500 bg-red-500/5 animate-pulse' : 'border-border'
                  }`}
                >
                  {hasError && (
                    <div className="mb-2 text-xs text-red-400 flex items-center gap-1">
                      <span>⚠️</span>
                      <span>{t('chat:clarification.required_field') || '此问题必须回答'}</span>
                    </div>
                  )}
                  <ClarificationQuestion
                    question={question}
                    answer={answers.get(question.question_id) || null}
                    onChange={answer => handleAnswerChange(question.question_id, answer)}
                    readonly={isSubmitted}
                  />
                </div>
              )
            })}

            {/* Fixed additional input box */}
            <div className="p-3 rounded bg-surface/50 border border-border">
              <div className="space-y-3">
                <div className="text-sm font-medium text-text-primary">
                  {t('chat:clarification.additional_thoughts') || '其他想法或补充说明'}
                </div>
                <Textarea
                  value={additionalInput}
                  onChange={e => setAdditionalInput(e.target.value)}
                  placeholder={
                    t('chat:clarification.additional_placeholder') ||
                    '在此输入其他想法、补充需求或特殊说明...'
                  }
                  disabled={isSubmitted}
                  rows={3}
                  className="w-full"
                />
              </div>
            </div>
          </div>

          {!isSubmitted && !(isTaskStreaming && isTaskStreaming(taskId)) && (
            <div className="flex justify-end pt-2">
              <Button variant="secondary" onClick={handleSubmit} size="lg">
                <Send className="w-4 h-4 mr-2" />
                {t('chat:clarification.submit_answers') || 'Submit Answers'}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
