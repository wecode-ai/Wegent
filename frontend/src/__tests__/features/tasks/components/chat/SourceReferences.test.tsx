// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { act, render, screen } from '@testing-library/react'

import {
  registerExternalSourceOpener,
  SourceReferences,
} from '@/features/tasks/components/chat/SourceReferences'

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

  it('rerenders when an internal source opener registers asynchronously', () => {
    render(
      <SourceReferences
        sources={[
          {
            index: 1,
            title: '811.video.md',
            source_type: 'test_video_segment',
            document_id: 811,
            segments: [{ start_sec: 6, end_sec: 15 }],
          },
        ]}
      />
    )

    expect(screen.getByText('811.video.md')).toBeInTheDocument()

    act(() => {
      registerExternalSourceOpener('test_video_segment', source => (
        <button type="button">play-{source.segments?.[0].start_sec}</button>
      ))
    })

    expect(screen.getByRole('button', { name: 'play-6' })).toBeInTheDocument()
  })
})
