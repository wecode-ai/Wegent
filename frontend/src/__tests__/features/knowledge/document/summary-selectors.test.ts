// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import {
  getEffectiveKnowledgeBaseLongSummary,
  getKnowledgeBasePreviewSummary,
} from '@/features/knowledge/document/utils/summarySelectors'

describe('summarySelectors', () => {
  it('prefers manual long summary for long summary display', () => {
    expect(
      getEffectiveKnowledgeBaseLongSummary({
        manual_long_summary: 'Manual long',
        long_summary: 'AI long',
        short_summary: 'AI short',
      })
    ).toBe('Manual long')
  })

  it('falls back to AI long summary for long summary display', () => {
    expect(
      getEffectiveKnowledgeBaseLongSummary({
        long_summary: 'AI long',
        short_summary: 'AI short',
      })
    ).toBe('AI long')
  })

  it('prefers manual long summary for card preview', () => {
    expect(
      getKnowledgeBasePreviewSummary({
        manual_long_summary: 'Manual preview',
        short_summary: 'AI short',
      })
    ).toBe('Manual preview')
  })

  it('falls back to AI short summary for card preview', () => {
    expect(
      getKnowledgeBasePreviewSummary({
        short_summary: 'AI short',
      })
    ).toBe('AI short')
  })
})
