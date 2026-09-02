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

  it('renders full video chapters after all video segments without a citation index', () => {
    act(() => {
      registerExternalSourceOpener('wegent_video_segment', source => (
        <button type="button">segment-{source.document_id}</button>
      ))
      registerExternalSourceOpener('wegent_video_chapters', source => (
        <button type="button">chapters-{source.document_id}</button>
      ))
    })

    render(
      <SourceReferences
        sources={[
          {
            index: 3,
            title: 'all-chapters.video.md',
            source_type: 'wegent_video_chapters',
            document_id: 803,
          },
          {
            index: 1,
            title: 'first-segment.video.md',
            source_type: 'wegent_video_segment',
            document_id: 801,
            segments: [{ start_sec: 0, end_sec: 10 }],
          },
          {
            index: 2,
            title: 'second-segment.video.md',
            source_type: 'wegent_video_segment',
            document_id: 802,
            segments: [
              { start_sec: 10, end_sec: 20 },
              { start_sec: 20, end_sec: 30 },
            ],
          },
        ]}
      />
    )

    const labels = screen.getAllByRole('button').map(button => button.textContent)
    expect(labels).toEqual(['segment-802', 'segment-801', 'chapters-803'])
    expect(screen.queryByText('[3]')).not.toBeInTheDocument()
  })
})
