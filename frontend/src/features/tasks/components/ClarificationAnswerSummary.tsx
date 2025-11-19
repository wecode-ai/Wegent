// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import type { ClarificationAnswerPayload } from '@/types/api';
import { useTranslation } from '@/hooks/useTranslation';

interface ClarificationAnswerSummaryProps {
  data: ClarificationAnswerPayload;
}

export default function ClarificationAnswerSummary({ data }: ClarificationAnswerSummaryProps) {
  const { t } = useTranslation('chat');

  if (!data.answers || data.answers.length === 0) {
    return (
      <div className="text-sm text-text-secondary">
        <div className="mb-2">✓ {t('clarification.answers_submitted') || 'Answers submitted'}</div>
        <div className="text-xs text-text-tertiary">
          {t('clarification.waiting_response') || 'Waiting for response...'}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="text-sm font-medium text-text-primary flex items-center gap-2">
        <span>✓</span>
        <span>{t('clarification.my_answers') || 'My Answers'}</span>
      </div>

      <div className="space-y-2">
        {data.answers.map((answer, idx) => (
          <div
            key={answer.question_id}
            className="p-2 rounded bg-surface/30 border border-border/50"
          >
            <div className="flex items-start gap-2">
              <div className="text-xs text-text-tertiary font-medium min-w-[60px]">
                {t('clarification.question') || 'Q'}{idx + 1}:
              </div>
              <div className="flex-1">
                {answer.answer_type === 'custom' ? (
                  <div className="text-sm text-text-secondary">
                    <span className="text-xs text-text-tertiary mr-1">
                      ({t('clarification.custom_answer') || 'Custom'}):
                    </span>
                    <span className="text-text-primary">{answer.value as string}</span>
                  </div>
                ) : (
                  <div className="text-sm text-text-primary">
                    {Array.isArray(answer.value)
                      ? answer.value.join(', ')
                      : answer.value}
                  </div>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="text-xs text-text-tertiary italic">
        {t('clarification.waiting_response') || 'Waiting for response...'}
      </div>
    </div>
  );
}
