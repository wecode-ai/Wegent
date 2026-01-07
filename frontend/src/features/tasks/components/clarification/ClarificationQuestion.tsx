// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Checkbox } from '@/components/ui/checkbox'
import type { ClarificationQuestion as ClarificationQuestionType } from '@/types/api'
import { useTranslation } from '@/hooks/useTranslation'
import { FiEdit3 } from 'react-icons/fi'

interface ClarificationQuestionProps {
  question: ClarificationQuestionType
  answer: {
    answer_type: 'choice' | 'custom'
    value: string | string[]
  } | null
  onChange: (answer: { answer_type: 'choice' | 'custom'; value: string | string[] }) => void
  readonly?: boolean
}

export default function ClarificationQuestion({
  question,
  answer,
  onChange,
  readonly = false,
}: ClarificationQuestionProps) {
  const { t } = useTranslation()
  const [isCustomMode, setIsCustomMode] = useState(answer?.answer_type === 'custom')

  const handleToggleCustomMode = () => {
    if (readonly) return
    const newCustomMode = !isCustomMode
    setIsCustomMode(newCustomMode)

    if (newCustomMode) {
      // Switch to custom mode, clear current selection
      onChange({ answer_type: 'custom', value: '' })
    } else {
      // Switch back to choice mode, set default selected option
      const defaultOption = question.options?.find(opt => opt.recommended)
      if (defaultOption) {
        onChange({
          answer_type: 'choice',
          value:
            question.question_type === 'multiple_choice'
              ? [defaultOption.value]
              : defaultOption.value,
        })
      } else {
        onChange({
          answer_type: 'choice',
          value: question.question_type === 'multiple_choice' ? [] : '',
        })
      }
    }
  }

  const renderChoices = () => {
    if (question.question_type === 'single_choice') {
      return (
        <RadioGroup
          value={answer?.answer_type === 'choice' ? (answer.value as string) : ''}
          onValueChange={value => onChange({ answer_type: 'choice', value })}
          disabled={readonly}
          className="flex flex-col gap-2"
        >
          {question.options?.map((option, index) => (
            <div key={option.value} className="flex items-center space-x-2">
              <RadioGroupItem
                value={option.value}
                id={`question-${question.question_text}-option-${index}`}
                disabled={readonly}
              />
              <label
                htmlFor={`question-${question.question_text}-option-${index}`}
                className="text-sm font-normal cursor-pointer"
              >
                {option.label}
                {option.recommended && (
                  <span className="ml-2 text-xs text-primary">
                    ({t('chat:clarification.recommended') || 'Recommended'})
                  </span>
                )}
              </label>
            </div>
          ))}
        </RadioGroup>
      )
    }

    if (question.question_type === 'multiple_choice') {
      const selectedValues =
        answer?.answer_type === 'choice' && Array.isArray(answer.value) ? answer.value : []

      const handleCheckboxChange = (optionValue: string, checked: boolean) => {
        const newValues = checked
          ? [...selectedValues, optionValue]
          : selectedValues.filter(v => v !== optionValue)
        onChange({ answer_type: 'choice', value: newValues })
      }

      return (
        <div className="flex flex-col gap-2">
          {question.options?.map((option, index) => (
            <div key={option.value} className="flex items-center space-x-2">
              <Checkbox
                id={`question-${question.question_text}-option-${index}`}
                checked={selectedValues.includes(option.value)}
                onCheckedChange={checked => handleCheckboxChange(option.value, checked as boolean)}
                disabled={readonly}
              />
              <label
                htmlFor={`question-${question.question_text}-option-${index}`}
                className="text-sm font-normal cursor-pointer"
              >
                {option.label}
                {option.recommended && (
                  <span className="ml-2 text-xs text-primary">
                    ({t('chat:clarification.recommended') || 'Recommended'})
                  </span>
                )}
              </label>
            </div>
          ))}
        </div>
      )
    }

    return null
  }

  const renderCustomInput = () => {
    return (
      <Textarea
        value={answer?.answer_type === 'custom' ? (answer.value as string) : ''}
        onChange={e => onChange({ answer_type: 'custom', value: e.target.value })}
        placeholder={
          t('chat:clarification.custom_input_placeholder') || 'Enter your custom input...'
        }
        disabled={readonly}
        rows={3}
        className="w-full"
      />
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between">
        <div className="text-sm font-medium text-text-primary">{question.question_text}</div>
        {question.question_type !== 'text_input' && !readonly && (
          <Button
            variant="ghost"
            size="sm"
            onClick={handleToggleCustomMode}
            className="text-xs text-text-muted hover:text-text-primary"
          >
            <FiEdit3 className="w-3 h-3" />
            {isCustomMode
              ? t('chat:clarification.back_to_choices') || 'Back to Choices'
              : t('chat:clarification.custom_input') || 'Custom Input'}
          </Button>
        )}
      </div>

      {question.question_type === 'text_input'
        ? renderCustomInput()
        : isCustomMode
          ? renderCustomInput()
          : renderChoices()}

      {readonly && answer && (
        <div className="text-xs text-text-tertiary italic">
          {answer.answer_type === 'custom'
            ? `${t('chat:clarification.custom_answer') || 'Custom'}: ${answer.value}`
            : `${t('chat:clarification.selected') || 'Selected'}: ${
                Array.isArray(answer.value)
                  ? answer.value
                      .map(v => question.options?.find(opt => opt.value === v)?.label || v)
                      .join(', ')
                  : question.options?.find(opt => opt.value === answer.value)?.label || answer.value
              }`}
        </div>
      )}
    </div>
  )
}
