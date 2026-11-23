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
  it('opens a local source using its own KB and document IDs and preserves external URLs', () => {
    render(
      <SourceReferences
        sources={[
          { index: 1, title: 'same.md', kb_id: 42, document_id: 71 },
          { index: 2, title: 'same.md', kb_id: 42, document_id: 72 },
          {
            index: 3,
            title: 'External',
            kb_id: 42,
            document_id: 73,
            source_uri: 'https://example.com/citation',
          },
          { index: 4, title: 'Unresolved', kb_id: 42 },
          {
            index: 5,
            title: 'Provider reference',
            source_type: 'external_provider',
            kb_id: 42,
            document_id: 74,
          },
        ]}
      />
    )

    expect(screen.getAllByRole('link', { name: 'sourceReferences.openSource: same.md' })).toEqual([
      expect.objectContaining({
        href: expect.stringContaining('/knowledge/document/42?view=documents&documentId=71'),
      }),
      expect.objectContaining({
        href: expect.stringContaining('/knowledge/document/42?view=documents&documentId=72'),
      }),
    ])
    expect(
      screen.getByRole('link', { name: 'sourceReferences.openSource: External' })
    ).toHaveAttribute('href', 'https://example.com/citation')
    expect(
      screen.queryByRole('link', { name: /Unresolved|Provider reference/ })
    ).not.toBeInTheDocument()
  })

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
