// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState } from 'react'
import { Code, FileText } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { ClarificationAnswerPayload } from '@/types/api'
import { useTranslation } from '@/hooks/useTranslation'

interface ClarificationAnswerSummaryProps {
  data: ClarificationAnswerPayload
  /** Raw markdown content for display when toggling to raw view */
  rawContent?: string
}

export default function ClarificationAnswerSummary({
  data,
  rawContent,
}: ClarificationAnswerSummaryProps) {
  const { t } = useTranslation()
  const [showRawContent, setShowRawContent] = useState(false)

  if (!data.answers || data.answers.length === 0) {
    return (
      <div className="text-sm text-text-secondary">
        <div>✓ {t('chat:clarification.answers_submitted') || 'Answers submitted'}</div>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium text-text-primary flex items-center gap-2">
          <span>✓</span>
          <span>{t('chat:clarification.my_answers') || 'My Answers'}</span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setShowRawContent(!showRawContent)}
          className="text-xs text-text-secondary hover:text-text-primary h-7 px-2"
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
        <div className="p-3 rounded bg-surface/30 border border-border/50">
          <pre className="text-xs text-text-secondary overflow-auto max-h-96 whitespace-pre-wrap break-words font-mono">
            {rawContent || JSON.stringify(data, null, 2)}
          </pre>
        </div>
      ) : (
        <div className="space-y-2">
          {data.answers.map((answer, idx) => (
            <div
              key={answer.question_id}
              className="p-3 rounded bg-surface/30 border border-border/50"
            >
              {/* Question Text */}
              <div className="mb-2 text-sm font-medium text-text-secondary">
                <span className="text-text-tertiary mr-1">
                  {t('chat:clarification.question') || 'Q'}
                  {idx + 1}:
                </span>
                <span>{answer.question_text}</span>
              </div>

              {/* Answer */}
              <div className="pl-4 border-l-2 border-primary/30">
                {answer.answer_type === 'custom' ? (
                  <div className="text-sm">
                    <span className="text-xs text-text-tertiary mr-1">
                      ({t('chat:clarification.custom_answer') || 'Custom'}):
                    </span>
                    <span className="text-text-primary">{answer.value as string}</span>
                  </div>
                ) : (
                  <div className="text-sm text-text-primary">
                    {answer.selected_labels
                      ? Array.isArray(answer.selected_labels)
                        ? answer.selected_labels.join(', ')
                        : answer.selected_labels
                      : Array.isArray(answer.value)
                        ? answer.value.join(', ')
                        : answer.value}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
