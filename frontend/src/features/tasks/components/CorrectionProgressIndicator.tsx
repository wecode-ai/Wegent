// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React from 'react'
import { Search, Brain, Sparkles, Loader2 } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import type { CorrectionStage } from '@/types/socket'
import EnhancedMarkdown from '@/components/common/EnhancedMarkdown'
import { useTheme } from '@/features/theme/ThemeProvider'

/** Streaming content for correction fields */
export interface CorrectionStreamingContent {
  summary: string
  improved_answer: string
}

interface CorrectionProgressIndicatorProps {
  stage: CorrectionStage | 'starting'
  toolName?: string
  className?: string
  /** Streaming content to display during generation */
  streamingContent?: CorrectionStreamingContent
}

/**
 * Configuration for each correction stage
 */
const stageConfig: Record<
  CorrectionStage | 'starting',
  {
    icon: typeof Loader2
    i18nKey: string
    animate: boolean
  }
> = {
  starting: {
    icon: Loader2,
    i18nKey: 'correction.progress.starting',
    animate: true,
  },
  verifying_facts: {
    icon: Search,
    i18nKey: 'correction.progress.verifying_facts',
    animate: false,
  },
  evaluating: {
    icon: Brain,
    i18nKey: 'correction.progress.evaluating',
    animate: false,
  },
  generating_improvement: {
    icon: Sparkles,
    i18nKey: 'correction.progress.generating_improvement',
    animate: false,
  },
}

/**
 * CorrectionProgressIndicator Component
 *
 * Displays the current stage of the cross-validation (correction) process
 * with animated icons and localized text. Optionally shows streaming content
 * during the generation phase.
 *
 * Stages:
 * - starting: Initial state when correction begins
 * - verifying_facts: Using search tools to verify facts
 * - evaluating: Evaluating the AI response quality
 * - generating_improvement: Generating improved answer
 */
export default function CorrectionProgressIndicator({
  stage,
  toolName,
  className,
  streamingContent,
}: CorrectionProgressIndicatorProps) {
  const { t } = useTranslation('chat')
  const { theme } = useTheme()

  const config = stageConfig[stage] || stageConfig.evaluating
  const Icon = config.icon

  // Check if we have streaming content to display
  const hasStreamingContent = streamingContent && streamingContent.improved_answer

  return (
    <div
      className={cn(
        'flex flex-col gap-2 text-sm text-text-secondary py-2 px-3 rounded-lg bg-surface/50',
        className
      )}
    >
      {/* Progress header */}
      <div className="flex items-center gap-2">
        {/* Animated icon */}
        <div className={cn('flex-shrink-0', config.animate && 'animate-spin')}>
          <Icon className="h-4 w-4 text-primary" />
        </div>

        {/* Progress text with pulse animation */}
        <span className="animate-pulse">
          {t(config.i18nKey)}
          {toolName && stage === 'verifying_facts' && <span className="text-text-muted ml-1" />}
        </span>

        {/* Loading dots */}
        <span className="flex gap-0.5 ml-1">
          <span
            className="w-1 h-1 bg-primary rounded-full animate-bounce"
            style={{ animationDelay: '0ms' }}
          />
          <span
            className="w-1 h-1 bg-primary rounded-full animate-bounce"
            style={{ animationDelay: '150ms' }}
          />
          <span
            className="w-1 h-1 bg-primary rounded-full animate-bounce"
            style={{ animationDelay: '300ms' }}
          />
        </span>
      </div>

      {/* Streaming content display - only show improved_answer, summary is in collapsible */}
      {hasStreamingContent && stage === 'generating_improvement' && (
        <div className="mt-2 text-text-primary">
          {/* Improved answer streaming - use EnhancedMarkdown for consistent rendering */}
          <div className="border-l-2 border-primary/50 pl-3">
            <div className="text-xs text-text-muted mb-1">
              {t('correction.streaming.improved_answer')}
            </div>
            <div className="text-sm max-h-60 overflow-y-auto relative">
              <EnhancedMarkdown
                source={streamingContent.improved_answer}
                theme={theme as 'light' | 'dark'}
              />
              {/* Streaming cursor indicator */}
              <span className="inline-block w-0.5 h-4 bg-primary animate-pulse ml-0.5 align-middle" />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
