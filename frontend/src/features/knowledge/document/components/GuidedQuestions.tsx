// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

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
 */
export function GuidedQuestions({ questions, onQuestionClick }: GuidedQuestionsProps) {
  const { t } = useTranslation()

  if (!questions || questions.length === 0) {
    return null
  }

  return (
    <div className="w-full max-w-3xl mx-auto mb-4" data-testid="guided-questions-container">
      <p className="text-xs text-text-muted mb-2">{t('knowledge:chatPage.guidedQuestions.hint')}</p>
      <div className="flex flex-col gap-2">
        {questions.map((question, index) => (
          <button
            key={index}
            type="button"
            onClick={() => onQuestionClick(question)}
            className="flex items-start gap-2 p-3 rounded-lg border border-border bg-surface/50
                       text-left text-sm text-text-secondary hover:text-text-primary
                       hover:bg-hover hover:border-primary/30 transition-colors
                       min-h-[44px]"
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
