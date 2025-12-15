// SPDX-FileCopyrightText: 2025 WeCode, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { Bot, User } from 'lucide-react'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Checkbox } from '@/components/ui/checkbox'
import { Spinner } from '@/components/ui/spinner'
import { useTranslation } from '@/hooks/useTranslation'
import type { FollowUpRound } from '../types'
import { cn } from '@/lib/utils'

interface AiFollowUpStepProps {
  rounds: FollowUpRound[]
  currentRound: number
  isComplete: boolean
  isLoading: boolean
  onAnswerChange: (questionKey: string, answer: string) => void
}

export default function AiFollowUpStep({
  rounds,
  currentRound,
  isComplete,
  isLoading,
  onAnswerChange,
}: AiFollowUpStepProps) {
  const { t } = useTranslation('common')

  if (rounds.length === 0 && isLoading) {
    return (
      <div className="flex flex-col items-center justify-center py-12">
        <Spinner className="w-8 h-8 text-primary" />
        <p className="mt-4 text-text-muted">{t('wizard.generating_questions')}</p>
      </div>
    )
  }

  if (rounds.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12">
        <p className="text-text-muted">{t('wizard.no_questions')}</p>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <p className="text-sm text-text-muted">{t('wizard.followup_description')}</p>

      {/* Chat-like display of Q&A history */}
      <div className="space-y-4 max-h-[400px] overflow-y-auto pr-2">
        {rounds.map((round, roundIndex) => (
          <div key={roundIndex} className="space-y-4">
            {/* Round header */}
            {rounds.length > 1 && (
              <div className="flex items-center gap-2 text-xs text-text-muted">
                <div className="flex-1 h-px bg-border" />
                <span>{t('wizard.round_n', { n: roundIndex + 1 })}</span>
                <div className="flex-1 h-px bg-border" />
              </div>
            )}

            {/* Questions and answers for this round */}
            {round.questions.map((question, qIndex) => {
              const questionKey = `${question.question.substring(0, 30)}`
              const answer = round.answers[questionKey] || ''
              const isCurrentRound = roundIndex === currentRound - 1

              return (
                <div key={`${roundIndex}-${qIndex}`} className="space-y-3">
                  {/* AI Question bubble */}
                  <div className="flex items-start gap-3">
                    <div className="flex-shrink-0 w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center">
                      <Bot className="w-4 h-4 text-primary" />
                    </div>
                    <div className="flex-1 bg-surface border border-border rounded-lg p-3">
                      <p className="text-sm">{question.question}</p>
                    </div>
                  </div>

                  {/* User Answer */}
                  <div className="flex items-start gap-3 pl-11">
                    <div
                      className={cn(
                        'flex-1 rounded-lg p-3',
                        isCurrentRound
                          ? 'bg-base border border-border'
                          : 'bg-muted/50'
                      )}
                    >
                      {isCurrentRound ? (
                        <QuestionInput
                          question={question}
                          value={answer}
                          onChange={value => onAnswerChange(questionKey, value)}
                        />
                      ) : (
                        <p className="text-sm text-text-secondary">
                          {answer || t('wizard.not_answered')}
                        </p>
                      )}
                    </div>
                    <div className="flex-shrink-0 w-8 h-8 rounded-full bg-muted flex items-center justify-center">
                      <User className="w-4 h-4 text-text-muted" />
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        ))}

        {/* Loading indicator for next round */}
        {isLoading && (
          <div className="flex items-start gap-3">
            <div className="flex-shrink-0 w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center">
              <Bot className="w-4 h-4 text-primary" />
            </div>
            <div className="flex-1 bg-surface border border-border rounded-lg p-3">
              <div className="flex items-center gap-2">
                <Spinner className="w-4 h-4" />
                <span className="text-sm text-text-muted">{t('wizard.thinking')}</span>
              </div>
            </div>
          </div>
        )}
      </div>

      {isComplete && (
        <div className="p-4 bg-success/10 border border-success/20 rounded-lg">
          <p className="text-sm text-success">{t('wizard.followup_complete')}</p>
        </div>
      )}
    </div>
  )
}

interface QuestionInputProps {
  question: { question: string; input_type: string; options?: string[] }
  value: string
  onChange: (value: string) => void
}

function QuestionInput({ question, value, onChange }: QuestionInputProps) {
  const { t } = useTranslation('common')

  if (question.input_type === 'single_choice' && question.options) {
    return (
      <RadioGroup value={value} onValueChange={onChange} className="space-y-2">
        {question.options.map(option => (
          <div key={option} className="flex items-center space-x-2">
            <RadioGroupItem value={option} id={`opt-${option}`} />
            <Label htmlFor={`opt-${option}`} className="font-normal cursor-pointer text-sm">
              {option}
            </Label>
          </div>
        ))}
      </RadioGroup>
    )
  }

  if (question.input_type === 'multiple_choice' && question.options) {
    const selected = value ? value.split(',').filter(Boolean) : []
    return (
      <div className="space-y-2">
        {question.options.map(option => {
          const isChecked = selected.includes(option)
          return (
            <div key={option} className="flex items-center space-x-2">
              <Checkbox
                id={`mc-${option}`}
                checked={isChecked}
                onCheckedChange={checked => {
                  const newSelected = checked
                    ? [...selected, option]
                    : selected.filter(s => s !== option)
                  onChange(newSelected.join(','))
                }}
              />
              <Label htmlFor={`mc-${option}`} className="font-normal cursor-pointer text-sm">
                {option}
              </Label>
            </div>
          )
        })}
      </div>
    )
  }

  // Default: text input
  return (
    <Textarea
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={t('wizard.answer_placeholder')}
      className="min-h-[60px] text-sm"
    />
  )
}
