// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect, useMemo } from 'react'
import { Send } from 'lucide-react'
import { FiEdit3 } from 'react-icons/fi'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Checkbox } from '@/components/ui/checkbox'
import type { AskUserFormData, AskUserQuestion, AskUserOption } from '@/types/api'
import { useTranslation } from '@/hooks/useTranslation'
import { useTaskStateMachine } from '../../hooks/useTaskStateMachine'

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
  onSubmit?: (askId: string, formattedMessage: string) => void
}

// ─── Single Question Widget ───────────────────────────────────────────────────

interface QuestionWidgetProps {
  question: AskUserQuestion
  value: string[]
  customText: string
  isCustomMode: boolean
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
  isCustomMode,
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

  // Custom text mode: replace choices with a textarea
  if (isCustomMode) {
    return (
      <Textarea
        value={customText}
        onChange={e => onCustomTextChange(question.id, e.target.value)}
        placeholder={t('ask_user_question.custom_placeholder') || 'Enter custom input...'}
        disabled={isReadOnly}
        rows={3}
        className={`w-full${hasError ? ' border-red-500 focus-visible:ring-red-500' : ''}`}
        data-testid={`ask-user-custom-textarea-${question.id}`}
        autoFocus
      />
    )
  }

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
      className={`flex flex-col gap-2${hasError ? ' rounded border border-red-500 p-2' : ''}`}
      data-testid={`ask-user-radio-${question.id}`}
    >
      {question.options.map((option: AskUserOption, index: number) => (
        <div key={option.value} className="flex items-center space-x-2">
          <RadioGroupItem
            value={option.value}
            id={`ask-user-${question.id}-option-${index}`}
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

  // Use reactive hook to get messages from TaskStateMachine (same as ClarificationForm)
  const { messages: messagesMap } = useTaskStateMachine(taskId)

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

  // Per-question custom text (text input or custom mode): { [qId]: string }
  const [customTexts, setCustomTexts] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {}
    normalizedQuestions.forEach(q => {
      init[q.id] = ''
    })
    return init
  })

  // Per-question custom mode toggle (for choice questions): { [qId]: boolean }
  const [customModes, setCustomModes] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = {}
    normalizedQuestions.forEach(q => {
      init[q.id] = false
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

  const handleToggleCustom = (qId: string) => {
    if (isReadOnly) return
    setHasUserInteracted(true)
    setCustomModes(prev => {
      const next = !prev[qId]
      if (!next) {
        // Switching back to choices: clear the custom text
        setCustomTexts(t => ({ ...t, [qId]: '' }))
      }
      return { ...prev, [qId]: next }
    })
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
      } else if (customModes[q.id]) {
        // Custom mode: require non-empty text
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

    normalizedQuestions.forEach(q => {
      const qId = q.id.toUpperCase()
      formattedMessage += `### ${qId}: ${q.question}\n`
      formattedMessage += '**Answer**: '

      if (q.input_type === 'text' || customModes[q.id]) {
        formattedMessage += `${customTexts[q.id] ?? ''}\n\n`
      } else {
        const vals = selectedValues[q.id] ?? []
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
      onSubmit(data.ask_id, formattedMessage)
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
        {normalizedQuestions.map(q => {
          const isChoiceQuestion = q.input_type === 'choice' && q.options && q.options.length > 0
          const isInCustomMode = customModes[q.id] ?? false

          return (
            <div
              key={q.id}
              className={
                isMultiQuestion ? 'p-3 rounded bg-surface/50 border border-border' : 'space-y-2'
              }
            >
              <div className="flex items-start justify-between">
                <div className="text-sm font-medium text-text-primary">
                  {q.question}
                  {q.required && (
                    <span className="ml-1 text-red-500" aria-hidden="true">
                      *
                    </span>
                  )}
                </div>
                {isChoiceQuestion && !isReadOnly && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => handleToggleCustom(q.id)}
                    className="text-xs text-text-muted hover:text-text-primary shrink-0"
                    data-testid={`ask-user-toggle-custom-${q.id}`}
                  >
                    <FiEdit3 className="w-3 h-3" />
                    {isInCustomMode
                      ? t('clarification.back_to_choices') || 'Back to choices'
                      : t('ask_user_question.custom_input') || 'Custom Input'}
                  </Button>
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
                  isCustomMode={isInCustomMode}
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
