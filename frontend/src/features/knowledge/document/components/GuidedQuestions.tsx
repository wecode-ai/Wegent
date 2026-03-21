// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect } from 'react'
import { MessageSquare } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'

interface GuidedQuestionsProps {
  /** Guided questions list */
  questions: string[]
  /** Handler when a question is clicked */
  onQuestionClick: (question: string) => void
}

/**
 * GuidedQuestions component displays a list of guided questions
 * that users can click to quickly fill in the chat input.
 * Only shown when there are no messages in the conversation.
 * Features a staggered fade-in animation when questions appear.
 */
export function GuidedQuestions({ questions, onQuestionClick }: GuidedQuestionsProps) {
  const { t } = useTranslation()
  const [isVisible, setIsVisible] = useState(false)

  // Trigger animation after mount
  useEffect(() => {
    // Small delay to ensure smooth animation
    const timer = setTimeout(() => {
      setIsVisible(true)
    }, 100)
    return () => clearTimeout(timer)
  }, [])

  if (!questions || questions.length === 0) {
    return null
  }

  return (
    <div
      className={`w-full max-w-3xl mx-auto transition-opacity duration-300 ${
        isVisible ? 'opacity-100' : 'opacity-0'
      }`}
      data-testid="guided-questions-container"
    >
      <p className="text-xs text-text-muted mb-2">{t('knowledge:chatPage.guidedQuestions.hint')}</p>
      <div className="flex flex-col gap-2">
        {questions.map((question, index) => (
          <button
            key={index}
            type="button"
            onClick={() => onQuestionClick(question)}
            className={`flex items-start gap-2 p-3 rounded-lg border border-border bg-surface/50
                       text-left text-sm text-text-secondary hover:text-text-primary
                       hover:bg-hover hover:border-primary/30 transition-all duration-300
                       min-h-[44px] transform ${
                         isVisible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2'
                       }`}
            style={{
              transitionDelay: isVisible ? `${index * 100}ms` : '0ms',
            }}
            data-testid={`guided-question-${index}`}
          >
            <MessageSquare className="w-4 h-4 mt-0.5 flex-shrink-0 text-primary/60" />
            <span className="flex-1">{question}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
