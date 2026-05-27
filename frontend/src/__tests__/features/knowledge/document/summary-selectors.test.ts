// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import {
  getEffectiveKnowledgeBaseLongSummary,
  getKnowledgeBasePreviewSummary,
  hasManualSummaryOverride,
  shouldShowSummaryContent,
  shouldShowRetryButton,
} from '@/features/knowledge/document/utils/summarySelectors'

describe('summarySelectors', () => {
  describe('getEffectiveKnowledgeBaseLongSummary', () => {
    it('prefers manual long summary', () => {
      expect(
        getEffectiveKnowledgeBaseLongSummary({
          manual_long_summary: 'Manual long',
          long_summary: 'AI long',
          short_summary: 'AI short',
        })
      ).toBe('Manual long')
    })

    it('falls back to AI long summary', () => {
      expect(
        getEffectiveKnowledgeBaseLongSummary({
          long_summary: 'AI long',
          short_summary: 'AI short',
        })
      ).toBe('AI long')
    })
  })

  describe('getKnowledgeBasePreviewSummary', () => {
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

  describe('hasManualSummaryOverride', () => {
    it('returns true when manual_long_summary exists', () => {
      expect(hasManualSummaryOverride({ manual_long_summary: 'Manual' })).toBe(true)
    })

    it('returns false when manual_long_summary is absent', () => {
      expect(hasManualSummaryOverride({ long_summary: 'AI' })).toBe(false)
    })

    it('returns false for null/undefined summary', () => {
      expect(hasManualSummaryOverride(null)).toBe(false)
      expect(hasManualSummaryOverride(undefined)).toBe(false)
    })
  })

  describe('shouldShowSummaryContent', () => {
    it('shows when completed with AI summary', () => {
      expect(shouldShowSummaryContent({ status: 'completed', long_summary: 'AI' })).toBe(true)
    })

    it('shows when failed but manual summary exists', () => {
      expect(
        shouldShowSummaryContent({
          status: 'failed',
          manual_long_summary: 'Manual',
          long_summary: 'AI',
        })
      ).toBe(true)
    })

    it('hides when failed and no manual summary', () => {
      expect(shouldShowSummaryContent({ status: 'failed', long_summary: 'AI' })).toBe(false)
    })

    it('hides when no summary content at all', () => {
      expect(shouldShowSummaryContent({ status: 'pending' })).toBe(false)
    })

    it('shows when generating with old AI summary', () => {
      expect(shouldShowSummaryContent({ status: 'generating', long_summary: 'Old AI' })).toBe(true)
    })
  })

  describe('shouldShowRetryButton', () => {
    it('shows when summaryEnabled and failed', () => {
      expect(shouldShowRetryButton({ status: 'failed' }, true)).toBe(true)
    })

    it('hides when not failed', () => {
      expect(shouldShowRetryButton({ status: 'completed' }, true)).toBe(false)
    })

    it('hides when summaryEnabled is false', () => {
      expect(shouldShowRetryButton({ status: 'failed' }, false)).toBe(false)
    })
  })
})
