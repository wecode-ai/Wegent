// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { KnowledgeBaseSummary } from '@/types/knowledge'

export function getEffectiveKnowledgeBaseLongSummary(
  summary?: KnowledgeBaseSummary | null
): string | undefined {
  return summary?.manual_long_summary || summary?.long_summary || undefined
}

export function getKnowledgeBasePreviewSummary(
  summary?: KnowledgeBaseSummary | null
): string | undefined {
  return summary?.manual_long_summary || summary?.short_summary || undefined
}
