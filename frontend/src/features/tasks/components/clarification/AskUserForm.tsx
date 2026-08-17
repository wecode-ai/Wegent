// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect, useMemo } from 'react'
import { Send } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Checkbox } from '@/components/ui/checkbox'
import type {
  AskUserFormData,
  AskUserQuestion,
  AskUserOption,
  InteractiveFormAnswerPayload,
} from '@/types/api'
import { useTranslation } from '@/hooks/useTranslation'
import { useOptionalTaskSession } from '../../session/TaskSession'
import type { UnifiedMessage } from '@wegent/chat-core'

const EMPTY_MESSAGES = new Map<string, UnifiedMessage>()

interface AskUserFormProps {
  data: AskUserFormData
  taskId: number
  currentMessageIndex: number
  /** Block status from the tool block - unused in async mode, kept for API compatibility */
  blockStatus?: string
  /**
   * Callback when user submits the answer.
   * Receives the formatted message string ready to be sent as a new conversation.
   */
  onSubmit?: (
    toolUseId: string,
    formattedMessage: string,
    answer: InteractiveFormAnswerPayload
  ) => void
}

// ─── Single Question Widget ───────────────────────────────────────────────────

interface QuestionWidgetProps {
  question: AskUserQuestion
  value: string[]
  customText: string
  isReadOnly: boolean
  hasError: boolean
  onSingleChange: (qId: string, value: string) => void
  onMultiChange: (qId: string, value: string, checked: boolean) => void
  onCustomTextChange: (qId: string, value: string) => void
}

function QuestionWidget({
  question,
  value,
  customText,
  isReadOnly,
  hasError,
  onSingleChange,
  onMultiChange,
  onCustomTextChange,
}: QuestionWidgetProps) {
  const { t } = useTranslation('chat')

  // Text input type (not a choice question)
  if (question.input_type === 'text') {
    return (
      <Textarea
        value={customText}
        onChange={e => onCustomTextChange(question.id, e.target.value)}
        placeholder={
          question.placeholder || t('ask_user_question.text_placeholder') || 'Enter your answer...'
        }
        disabled={isReadOnly}
        rows={3}
        className={`w-full${hasError ? ' border-red-500 focus-visible:ring-red-500' : ''}`}
        data-testid={`ask-user-textarea-${question.id}`}
      />
    )
  }

  if (!question.options || question.options.length === 0) return null

  if (question.multi_select) {
    return (
      <div
        className={`flex flex-col gap-2${hasError ? ' rounded border border-red-500 p-2' : ''}`}
        data-testid={`ask-user-checkbox-${question.id}`}
      >
        {question.options.map((option: AskUserOption, index: number) => (
          <div key={option.value} className="flex items-center space-x-2">
            <Checkbox
              id={`ask-user-${question.id}-option-${index}`}
              checked={value.includes(option.value)}
              onCheckedChange={checked =>
                onMultiChange(question.id, option.value, checked as boolean)
              }
              disabled={isReadOnly}
              data-testid={`ask-user-option-${question.id}-${index}`}
            />
            <label
              htmlFor={`ask-user-${question.id}-option-${index}`}
              className="text-sm font-normal cursor-pointer"
            >
              {option.label}
              {option.recommended && (
                <span className="ml-2 text-xs text-primary">
                  ({t('ask_user_question.recommended') || 'Recommended'})
                </span>
              )}
            </label>
          </div>
        ))}
      </div>
    )
  }

  return (
    <RadioGroup
      value={value[0] || ''}
      onValueChange={v => onSingleChange(question.id, v)}
      disabled={isReadOnly}
      className={`flex flex-wrap items-start gap-x-6 gap-y-3${
        hasError ? ' rounded border border-red-500 p-2' : ''
      }`}
      data-testid={`ask-user-radio-${question.id}`}
    >
      {question.options.map((option: AskUserOption, index: number) => (
        <div key={option.value} className="flex min-w-fit items-center gap-2">
          <RadioGroupItem
            value={option.value}
            id={`ask-user-${question.id}-option-${index}`}
            disabled={isReadOnly}
            className="border-[#BDBDBD] text-[#FF8200] shadow-none data-[state=checked]:border-[#FF8200] [&>span>div]:bg-[#FF8200]"
            data-testid={`ask-user-option-${question.id}-${index}`}
          />
          <label
            htmlFor={`ask-user-${question.id}-option-${index}`}
            className="cursor-pointer text-sm font-normal text-[#636363]"
          >
            {option.label}
            {option.recommended && (
              <span className="ml-2 text-xs text-[#999999]">
                ({t('ask_user_question.recommended') || 'Recommended'})
              </span>
            )}
          </label>
        </div>
      ))}
    </RadioGroup>
  )
}

// ─── Main AskUserForm Component ───────────────────────────────────────────────

export default function AskUserForm({
  data,
  taskId,
  currentMessageIndex,
  blockStatus: _blockStatus,
  onSubmit,
}: AskUserFormProps) {
  const { t } = useTranslation('chat')

  const taskSession = useOptionalTaskSession()
  const messagesMap =
    taskSession?.taskState?.taskId === taskId ? taskSession.messages : EMPTY_MESSAGES

  const normalizedQuestions: AskUserQuestion[] = useMemo(() => data.questions, [data.questions])
  const isMultiQuestion = normalizedQuestions.length > 1

  // Per-question selected values (choice): { [qId]: string[] }
  const [selectedValues, setSelectedValues] = useState<Record<string, string[]>>(() => {
    const init: Record<string, string[]> = {}
    normalizedQuestions.forEach(q => {
      init[q.id] = q.default ?? []
    })
    return init
  })

  // Per-question text input: { [qId]: string }
  const [customTexts, setCustomTexts] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {}
    normalizedQuestions.forEach(q => {
      init[q.id] = ''
    })
    return init
  })

  const [hasUserInteracted, setHasUserInteracted] = useState(false)
  const [localSubmitted, setLocalSubmitted] = useState(false)
  // Track which question IDs have validation errors
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})

  // Convert messages Map to sorted array for checking submission status
  const messages = useMemo(() => {
    if (messagesMap.size === 0) return []
    return Array.from(messagesMap.values())
      .sort((a, b) => {
        const aId = typeof a.id === 'string' ? parseInt(a.id, 10) : a.id
        const bId = typeof b.id === 'string' ? parseInt(b.id, 10) : b.id
        return aId - bId
      })
      .map(msg => ({ type: msg.type, status: msg.status }))
  }, [messagesMap])

  // Check if this question has been answered.
  const isSubmitted = useMemo(() => {
    if (localSubmitted) return true
    if (messages.length === 0) return false
    const messagesAfter = messages.slice(currentMessageIndex + 1)
    return messagesAfter.some(msg => msg.type === 'user')
  }, [localSubmitted, messages, currentMessageIndex])

  // Disable form while the AI message containing this tool call is still streaming.
  // The form becomes interactive only after the message completes (task enters ready state).
  const isCurrentMessageStreaming = useMemo(() => {
    if (messages.length === 0) return false
    return messages[currentMessageIndex]?.status === 'streaming'
  }, [messages, currentMessageIndex])

  // Combined read-only state: either streaming (task not done yet) or already submitted
  const isReadOnly = isCurrentMessageStreaming || isSubmitted

  // Initialize default values (auto-select recommended options)
  useEffect(() => {
    if (hasUserInteracted) return
    const init: Record<string, string[]> = {}
    normalizedQuestions.forEach(q => {
      if (q.default && q.default.length > 0) {
        init[q.id] = q.default
      } else if (q.options && q.input_type === 'choice') {
        const recommended = q.options.filter(opt => opt.recommended)
        if (recommended.length > 0) {
          init[q.id] = recommended.map(opt => opt.value)
        }
      }
    })
    if (Object.keys(init).length > 0) {
      setSelectedValues(prev => ({ ...prev, ...init }))
    }
  }, [normalizedQuestions, hasUserInteracted])

  const clearFieldError = (qId: string) => {
    setFieldErrors(prev => {
      if (!prev[qId]) return prev
      const next = { ...prev }
      delete next[qId]
      return next
    })
  }

  const handleSingleChange = (qId: string, value: string) => {
    if (isReadOnly) return
    setHasUserInteracted(true)
    setSelectedValues(prev => ({ ...prev, [qId]: [value] }))
    clearFieldError(qId)
  }

  const handleMultiChange = (qId: string, value: string, checked: boolean) => {
    if (isReadOnly) return
    setHasUserInteracted(true)
    setSelectedValues(prev => ({
      ...prev,
      [qId]: checked ? [...(prev[qId] ?? []), value] : (prev[qId] ?? []).filter(v => v !== value),
    }))
    clearFieldError(qId)
  }

  const handleCustomTextChange = (qId: string, value: string) => {
    if (isReadOnly) return
    setHasUserInteracted(true)
    setCustomTexts(prev => ({ ...prev, [qId]: value }))
    clearFieldError(qId)
  }

  const handleSubmit = () => {
    const errors: Record<string, string> = {}
    for (const q of normalizedQuestions) {
      if (!q.required) continue
      if (q.input_type === 'text') {
        if (!customTexts[q.id]?.trim()) {
          errors[q.id] = t('ask_user_question.required_field') || 'This field is required'
        }
      } else if (!q.multi_select) {
        if (!selectedValues[q.id] || selectedValues[q.id].length === 0) {
          errors[q.id] = t('ask_user_question.required_field') || 'Please select an option'
        }
      }
      // multi_select: no minimum selection required
    }

    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors)
      return
    }

    setFieldErrors({})

    // Build structured answer message — same format as ClarificationForm so
    // MessageBubble can parse it and render ClarificationAnswerSummary
    let formattedMessage = '## 📝 我的回答 (My Answers)\n\n'

    const answers: Record<string, string | string[]> = {}

    normalizedQuestions.forEach(q => {
      const qId = q.id.toUpperCase()
      formattedMessage += `### ${qId}: ${q.question}\n`
      formattedMessage += '**Answer**: '

      if (q.input_type === 'text') {
        const value = customTexts[q.id] ?? ''
        answers[q.id] = value
        formattedMessage += `${value}\n\n`
      } else {
        const vals = selectedValues[q.id] ?? []
        answers[q.id] = q.multi_select ? vals : (vals[0] ?? '')
        if (vals.length > 1) {
          formattedMessage += '\n'
          vals.forEach(v => {
            const label = q.options?.find(opt => opt.value === v)?.label ?? v
            formattedMessage += `- \`${v}\` - ${label}\n`
          })
          formattedMessage += '\n'
        } else {
          const v = vals[0] ?? ''
          const label = q.options?.find(opt => opt.value === v)?.label ?? v
          formattedMessage += `\`${v}\` - ${label}\n\n`
        }
      }
    })

    setLocalSubmitted(true)

    if (onSubmit) {
      onSubmit(data.tool_use_id, formattedMessage, {
        type: 'interactive_form_question',
        tool_use_id: data.tool_use_id,
        task_id: data.task_id,
        subtask_id: data.subtask_id,
        success: true,
        status: 'answered',
        answers,
        message: formattedMessage,
      })
    }
  }

  return (
    <div
      className="space-y-4 p-4 rounded-lg border border-primary/30 bg-primary/5"
      data-testid="ask-user-form"
    >
      {/* Header */}
      <div className="flex items-center gap-2 mb-4">
        <span className="text-lg">💬</span>
        <h3 className="text-base font-semibold text-primary">
          {t('ask_user_question.title') || 'Question'}
        </h3>
      </div>

      {/* Question list */}
      <div className={isMultiQuestion ? 'space-y-4' : 'space-y-2'}>
        {normalizedQuestions.map((q, index) => {
          return (
            <div
              key={q.id}
              className={
                isMultiQuestion ? 'p-3 rounded bg-surface/50 border border-border' : 'space-y-2'
              }
            >
              <div className="text-sm font-medium text-text-primary">
                {isMultiQuestion ? `${index + 1}. ` : ''}
                {q.question}
                {q.required && (
                  <span className="ml-1 text-[#F08A00]" aria-hidden="true">
                    *
                  </span>
                )}
              </div>

              {/* Input widget */}
              <div
                className={isMultiQuestion ? '' : 'p-3 rounded bg-surface/50 border border-border'}
              >
                <QuestionWidget
                  question={q}
                  value={selectedValues[q.id] ?? []}
                  customText={customTexts[q.id] ?? ''}
                  isReadOnly={isReadOnly}
                  hasError={Boolean(fieldErrors[q.id])}
                  onSingleChange={handleSingleChange}
                  onMultiChange={handleMultiChange}
                  onCustomTextChange={handleCustomTextChange}
                />
              </div>

              {/* Inline error message */}
              {fieldErrors[q.id] && (
                <p
                  className="mt-1 text-xs text-red-500"
                  role="alert"
                  data-testid={`ask-user-error-${q.id}`}
                >
                  {fieldErrors[q.id]}
                </p>
              )}
            </div>
          )
        })}
      </div>

      {/* Submit button - hidden after submitted, disabled while streaming */}
      {!isSubmitted && (
        <div className="flex justify-end pt-2">
          <Button
            variant="secondary"
            onClick={handleSubmit}
            size="lg"
            disabled={isCurrentMessageStreaming}
            data-testid="ask-user-submit"
          >
            <Send className="w-4 h-4 mr-2" />
            {t('ask_user_question.submit') || 'Submit Answer'}
          </Button>
        </div>
      )}
    </div>
  )
}
