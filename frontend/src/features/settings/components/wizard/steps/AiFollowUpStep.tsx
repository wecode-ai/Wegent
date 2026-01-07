// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useRef, useState } from 'react'
import { Bot, User, Loader2 } from 'lucide-react'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Checkbox } from '@/components/ui/checkbox'
import { useTranslation } from '@/hooks/useTranslation'
import type { FollowUpRound } from '../types'

interface AiFollowUpStepProps {
  rounds: FollowUpRound[]
  currentRound: number
  isComplete: boolean
  isLoading: boolean
  onAnswerChange: (questionKey: string, answer: string, roundIndex?: number) => void
  onAdditionalThoughtsChange: (thoughts: string, roundIndex?: number) => void
}

export default function AiFollowUpStep({
  rounds,
  currentRound: _currentRound,
  isComplete,
  isLoading,
  onAnswerChange,
  onAdditionalThoughtsChange,
}: AiFollowUpStepProps) {
  const { t } = useTranslation()
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const roundRefs = useRef<Map<number, HTMLDivElement>>(new Map())
  const [highlightedRound, setHighlightedRound] = useState<number | null>(null)
  const prevRoundsLengthRef = useRef(rounds.length)

  // Auto-scroll to bottom only when loading starts (to show "Thinking..." indicator)
  useEffect(() => {
    if (isLoading && scrollContainerRef.current) {
      // Use setTimeout to ensure DOM has updated
      setTimeout(() => {
        if (scrollContainerRef.current) {
          scrollContainerRef.current.scrollTo({
            top: scrollContainerRef.current.scrollHeight,
            behavior: 'smooth',
          })
        }
      }, 100)
    }
  }, [isLoading])

  // When new round is added, scroll to show the first question at the top and highlight it
  useEffect(() => {
    const prevLength = prevRoundsLengthRef.current
    const currentLength = rounds.length

    // Check if a new round was added (not the initial load)
    if (currentLength > prevLength && prevLength > 0) {
      const newRoundIndex = currentLength - 1

      // Highlight the new round
      setHighlightedRound(newRoundIndex)

      // Scroll to the new round's first question
      setTimeout(() => {
        const roundElement = roundRefs.current.get(newRoundIndex)
        if (roundElement && scrollContainerRef.current) {
          // Calculate the position to scroll to (element top relative to container)
          const containerRect = scrollContainerRef.current.getBoundingClientRect()
          const elementRect = roundElement.getBoundingClientRect()
          const scrollTop =
            scrollContainerRef.current.scrollTop + (elementRect.top - containerRect.top) - 16 // 16px padding from top

          scrollContainerRef.current.scrollTo({
            top: scrollTop,
            behavior: 'smooth',
          })
        }
      }, 100)

      // Remove highlight after animation completes
      setTimeout(() => {
        setHighlightedRound(null)
      }, 2000)
    }

    prevRoundsLengthRef.current = currentLength
  }, [rounds.length])

  if (rounds.length === 0 && isLoading) {
    return (
      <div className="flex flex-col items-center justify-center py-12">
        <Loader2 className="w-8 h-8 text-primary animate-spin" />
        <p className="mt-4 text-text-muted">{t('wizard:generating_questions')}</p>
      </div>
    )
  }

  if (rounds.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12">
        <p className="text-text-muted">{t('wizard:no_questions')}</p>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <p className="text-sm text-text-muted">{t('wizard:followup_description')}</p>

      {/* Chat-like display of Q&A history */}
      <div ref={scrollContainerRef} className="space-y-4 max-h-[400px] overflow-y-auto pr-2">
        {rounds.map((round, roundIndex) => (
          <div
            key={roundIndex}
            ref={el => {
              if (el) roundRefs.current.set(roundIndex, el)
            }}
            className={`space-y-4 transition-all duration-500 ${
              highlightedRound === roundIndex
                ? 'bg-primary/5 -mx-2 px-2 py-2 rounded-lg ring-2 ring-primary/30 animate-fade-in'
                : ''
            }`}
          >
            {/* Round header */}
            {rounds.length > 1 && (
              <div className="flex items-center gap-2 text-xs text-text-muted">
                <div className="flex-1 h-px bg-border" />
                <span>{t('wizard:round_n', { n: roundIndex + 1 })}</span>
                <div className="flex-1 h-px bg-border" />
              </div>
            )}

            {/* Questions and answers for this round */}
            {round.questions.map((question, qIndex) => {
              const questionKey = `${question.question.substring(0, 30)}`
              const answer = round.answers[questionKey] || ''

              return (
                <div key={`${roundIndex}-${qIndex}`} className="space-y-3">
                  {/* AI Question bubble */}
                  <div className="flex items-start gap-3">
                    <div
                      className={`flex-shrink-0 w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center ${
                        highlightedRound === roundIndex && qIndex === 0 ? 'animate-pulse' : ''
                      }`}
                    >
                      <Bot className="w-4 h-4 text-primary" />
                    </div>
                    <div
                      className={`flex-1 bg-surface border rounded-lg p-3 transition-all duration-300 ${
                        highlightedRound === roundIndex && qIndex === 0
                          ? 'border-primary/50 shadow-sm'
                          : 'border-border'
                      }`}
                    >
                      <p className="text-sm">{question.question}</p>
                    </div>
                  </div>

                  {/* User Answer - all rounds are editable */}
                  <div className="flex items-start gap-3 pl-11">
                    <div className="flex-1 rounded-lg p-3 bg-base border border-border">
                      <QuestionInput
                        question={question}
                        value={answer}
                        onChange={value => onAnswerChange(questionKey, value, roundIndex)}
                      />
                    </div>
                    <div className="flex-shrink-0 w-8 h-8 rounded-full bg-muted flex items-center justify-center">
                      <User className="w-4 h-4 text-text-muted" />
                    </div>
                  </div>
                </div>
              )
            })}

            {/* Additional thoughts input - all rounds are editable */}
            <div className="mt-4 pt-4 border-t border-border">
              <div className="flex items-start gap-3">
                <div className="flex-shrink-0 w-8 h-8 rounded-full bg-muted flex items-center justify-center">
                  <User className="w-4 h-4 text-text-muted" />
                </div>
                <div className="flex-1">
                  <label className="block text-sm font-medium text-text-secondary mb-2">
                    {t('wizard:additional_thoughts_label')}
                  </label>
                  <Textarea
                    value={round.additionalThoughts || ''}
                    onChange={e => onAdditionalThoughtsChange(e.target.value, roundIndex)}
                    placeholder={t('wizard:additional_thoughts_placeholder')}
                    className="min-h-[80px] text-sm"
                  />
                  <p className="mt-1 text-xs text-text-muted">
                    {t('wizard:additional_thoughts_hint')}
                  </p>
                </div>
              </div>
            </div>
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
                <Loader2 className="w-4 h-4 text-primary animate-spin" />
                <span className="text-sm text-text-muted">{t('wizard:thinking')}</span>
              </div>
            </div>
          </div>
        )}

        {/* Completion message - inside scroll container */}
        {isComplete && (
          <div className="flex items-start gap-3">
            <div className="flex-shrink-0 w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center">
              <Bot className="w-4 h-4 text-primary" />
            </div>
            <div className="flex-1 bg-success/10 border border-success/20 rounded-lg p-3">
              <p className="text-sm text-success">{t('wizard:followup_complete')}</p>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

interface QuestionInputProps {
  question: { question: string; input_type: string; options?: string[] }
  value: string
  onChange: (value: string) => void
}

function QuestionInput({ question, value, onChange }: QuestionInputProps) {
  const { t } = useTranslation()

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
      placeholder={t('wizard:answer_placeholder')}
      className="min-h-[60px] text-sm"
    />
  )
}
