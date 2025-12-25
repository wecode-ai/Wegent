// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import React from 'react';
import { CheckCircle, AlertCircle, BarChart3, FileText, Sparkles } from 'lucide-react';
import { useTranslation } from '@/hooks/useTranslation';
import { cn } from '@/lib/utils';
import { CorrectionResponse } from '@/apis/correction';
import MarkdownEditor from '@uiw/react-markdown-editor';

interface CorrectionResultPanelProps {
  result: CorrectionResponse;
  isLoading?: boolean;
  className?: string;
}

function ScoreBar({ score, label }: { score: number; label: string }) {
  const getScoreColor = (score: number) => {
    if (score >= 8) return 'bg-green-500';
    if (score >= 6) return 'bg-yellow-500';
    if (score >= 4) return 'bg-orange-500';
    return 'bg-red-500';
  };

  return (
    <div className="flex items-center gap-3">
      <span className="text-sm text-text-secondary w-16 flex-shrink-0">{label}</span>
      <div className="flex-1 h-2 bg-border rounded-full overflow-hidden">
        <div
          className={cn('h-full rounded-full transition-all', getScoreColor(score))}
          style={{ width: `${score * 10}%` }}
        />
      </div>
      <span className="text-sm font-medium w-10 text-right">{score}/10</span>
    </div>
  );
}

export default function CorrectionResultPanel({
  result,
  isLoading = false,
  className,
}: CorrectionResultPanelProps) {
  const { t } = useTranslation('chat');

  if (isLoading) {
    return (
      <div className={cn('bg-surface rounded-lg border border-border p-4', className)}>
        <div className="flex items-center gap-2 mb-4">
          <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-primary"></div>
          <span className="text-sm text-text-secondary">{t('correction.evaluating')}</span>
        </div>
        <div className="space-y-3">
          {[1, 2, 3].map(i => (
            <div key={i} className="h-6 bg-border/50 rounded animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className={cn('bg-surface rounded-lg border border-border overflow-hidden', className)}>
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border bg-base/50">
        <CheckCircle className="h-5 w-5 text-primary" />
        <span className="font-semibold text-text-primary">{t('correction.result_title')}</span>
      </div>

      <div className="p-4 space-y-5">
        {/* Scores Section */}
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-sm font-medium text-text-primary">
            <BarChart3 className="h-4 w-4" />
            <span>{t('correction.scores')}</span>
          </div>
          <div className="space-y-2 pl-6">
            <ScoreBar score={result.scores.accuracy} label={t('correction.accuracy')} />
            <ScoreBar score={result.scores.logic} label={t('correction.logic')} />
            <ScoreBar score={result.scores.completeness} label={t('correction.completeness')} />
          </div>
        </div>

        {/* Corrections Section */}
        {result.corrections.length > 0 && (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-sm font-medium text-text-primary">
              <AlertCircle className="h-4 w-4 text-orange-500" />
              <span>{t('correction.issues_found')}</span>
            </div>
            <div className="space-y-2 pl-6">
              {result.corrections.map((correction, index) => (
                <div
                  key={index}
                  className="bg-orange-50 dark:bg-orange-950/20 rounded-lg p-3 text-sm"
                >
                  <div className="flex items-start gap-2">
                    <span className="text-orange-600 dark:text-orange-400 font-medium flex-shrink-0">
                      {index + 1}.
                    </span>
                    <div className="space-y-1">
                      <p className="text-text-primary">{correction.issue}</p>
                      <p className="text-text-secondary">
                        <span className="text-green-600 dark:text-green-400 font-medium">→ </span>
                        {correction.suggestion}
                      </p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* No Corrections Needed */}
        {result.is_correct && result.corrections.length === 0 && (
          <div className="flex items-center gap-2 p-3 bg-green-50 dark:bg-green-950/20 rounded-lg">
            <CheckCircle className="h-5 w-5 text-green-600 dark:text-green-400" />
            <span className="text-sm text-green-700 dark:text-green-300">
              {t('correction.no_corrections_needed')}
            </span>
          </div>
        )}

        {/* Summary Section */}
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-sm font-medium text-text-primary">
            <FileText className="h-4 w-4" />
            <span>{t('correction.summary')}</span>
          </div>
          <div className="pl-6 text-sm text-text-secondary">{result.summary}</div>
        </div>

        {/* Improved Answer Section */}
        {result.improved_answer && (
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-sm font-medium text-text-primary">
              <Sparkles className="h-4 w-4 text-primary" />
              <span>{t('correction.improved_answer')}</span>
            </div>
            <div className="pl-6 bg-primary/5 rounded-lg p-3 border border-primary/20">
              <MarkdownEditor.Markdown source={result.improved_answer} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
