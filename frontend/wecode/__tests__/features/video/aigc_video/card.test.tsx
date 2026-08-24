// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen } from '@testing-library/react'
import type { CardBlock } from '@wegent/chat-core'
import AigcVideoCard from '@/../wecode/features/video/aigc_video/AigcVideoCard'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

jest.mock('@/features/theme/ThemeProvider', () => ({
  useTheme: () => ({ theme: 'light' }),
}))

jest.mock('@/../wecode/features/video/aigc_video/AigcVideoPanel', () => ({
  AigcVideoPanel: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div data-testid="aigc-video-panel">{children}</div> : null,
}))

function buildCard(overrides: Partial<CardBlock> = {}): CardBlock {
  return {
    id: 'card-1',
    type: 'card',
    status: 'done',
    card_id: 'card-1',
    card_type: 'video_director_generation',
    card_status: 'populated',
    card_data: {},
    card_preview_data: {},
    card_error: null,
    ...overrides,
  }
}

describe('AigcVideoCard', () => {
  it('keeps the public card media and error states', () => {
    const { rerender } = render(
      <AigcVideoCard
        block={buildCard({
          card_data: {
            title: '一分钟成片',
            video_url: 'https://cdn.example.com/video.mp4',
            cover_url: 'https://cdn.example.com/cover.jpg',
          },
        })}
      />
    )

    expect(screen.getByTestId('card-video-director-player')).toHaveAttribute(
      'src',
      'https://cdn.example.com/video.mp4'
    )
    expect(screen.getByTestId('card-video-director-player')).toHaveAttribute(
      'poster',
      'https://cdn.example.com/cover.jpg'
    )

    rerender(
      <AigcVideoCard
        block={buildCard({
          status: 'error',
          card_status: 'error',
          card_error: '生成失败',
        })}
      />
    )

    expect(screen.getByTestId('card-video-director-error')).toHaveTextContent('生成失败')
  })

  it('opens the internal panel only for a validated workflow URL', () => {
    const { rerender } = render(
      <AigcVideoCard
        block={buildCard({
          card_data: {
            link: 'https://workflow.example.com/tasks/1',
          },
        })}
      />
    )

    fireEvent.click(screen.getByTestId('card-video-director-detail'))
    expect(screen.getByTestId('aigc-video-panel')).toBeInTheDocument()

    rerender(
      <AigcVideoCard
        block={buildCard({
          card_data: {
            link: 'javascript:alert(1)',
          },
        })}
      />
    )

    expect(screen.queryByTestId('card-video-director-detail')).not.toBeInTheDocument()
  })
})
