// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { KnowledgeBaseSummary } from '@/types/knowledge'

/** Preferred long summary: manual override takes priority over AI. */
export function getEffectiveKnowledgeBaseLongSummary(
  summary?: KnowledgeBaseSummary | null
): string | undefined {
  return summary?.manual_long_summary || summary?.long_summary || undefined
}

/** Short preview text: manual override takes priority over AI short_summary. */
export function getKnowledgeBasePreviewSummary(
  summary?: KnowledgeBaseSummary | null
): string | undefined {
  return summary?.manual_long_summary || summary?.short_summary || undefined
}

/** Whether a manual summary override is active. Derived from manual_long_summary presence. */
export function hasManualSummaryOverride(summary?: KnowledgeBaseSummary | null): boolean {
  return !!summary?.manual_long_summary
}

/**
 * Whether the summary section should be visible.
 *
 * Hides the section only when AI generation failed and no manual override exists.
 * In all other states (pending, generating, completed, or failed-with-manual),
 * the summary content is shown.
 */
export function shouldShowSummaryContent(summary?: KnowledgeBaseSummary | null): boolean {
  const effectiveLongSummary = getEffectiveKnowledgeBaseLongSummary(summary)
  const shortSummary = summary?.short_summary
  const isFailed = summary?.status === 'failed'
  const hasManual = hasManualSummaryOverride(summary)

  return !!((effectiveLongSummary || shortSummary) && (!isFailed || hasManual))
}

/** Whether the retry button should be displayed. */
export function shouldShowRetryButton(
  summary?: KnowledgeBaseSummary | null,
  summaryEnabled?: boolean
): boolean {
  return !!summaryEnabled && summary?.status === 'failed'
}
