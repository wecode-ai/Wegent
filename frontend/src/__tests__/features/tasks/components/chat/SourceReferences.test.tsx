// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { render, screen } from '@testing-library/react'

import { SourceReferences } from '@/features/tasks/components/chat/SourceReferences'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      if (key === 'sourceReferences.footerSearchedNoReferences') {
        return `searched ${params?.searched}`
      }
      if (key === 'sourceReferences.footerSkipped') {
        return `skipped ${params?.count}`
      }
      return key
    },
  }),
}))

describe('SourceReferences', () => {
  it('does not fall back to ignored ids when detailed statuses have zero ignored sources', () => {
    render(
      <SourceReferences
        sources={[]}
        retrievalSummary={{
          searched_source_ids: ['legacy-searched'],
          ignored_source_ids: ['legacy-ignored'],
          source_statuses: [
            {
              provider: 'demo',
              source_id: 'kb-1',
              status: 'no_hit',
              record_count: 0,
              citation_count: 0,
            },
          ],
        }}
      />
    )

    expect(screen.getByText('searched 1')).toBeInTheDocument()
    expect(screen.queryByText('skipped 1')).not.toBeInTheDocument()
  })
})
