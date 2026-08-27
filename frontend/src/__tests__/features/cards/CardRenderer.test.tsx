// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { act, fireEvent, render, screen } from '@testing-library/react'
import type { CardBlock } from '@wegent/chat-core'
import { CardRenderer } from '@/features/cards/CardRenderer'
import { getCardComponent } from '@/features/cards/registry'
import { safeCardUrl } from '@/features/cards/VideoDirectorGenerationCard'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

function buildCard(overrides: Partial<CardBlock> = {}): CardBlock {
  return {
    id: 'card-1',
    type: 'card',
    status: 'pending',
    card_id: 'card-1',
    card_type: 'video_director_generation',
    card_status: 'pending',
    card_data: {},
    card_preview_data: {
      progress: 25,
      progress_text: 'test-progress',
    },
    card_error: null,
    ...overrides,
  }
}

describe('CardRenderer', () => {
  it('dispatches registered cards and ignores unknown card types', () => {
    expect(getCardComponent('video_director_generation')).not.toBeNull()
    expect(getCardComponent('unknown')).toBeNull()

    const { container } = render(<CardRenderer block={buildCard({ card_type: 'unknown' })} />)
    expect(container).toBeEmptyDOMElement()
  })

  it.each(['pending', 'partial_ready'] as const)(
    'renders incremental progress for %s',
    cardStatus => {
      render(
        <CardRenderer
          block={buildCard({
            card_status: cardStatus,
            card_preview_data: {
              progress: cardStatus === 'pending' ? 25 : 68,
              progress_text: 'test-progress-partial',
            },
          })}
        />
      )

      expect(screen.getByTestId('card-video-director-progress')).toHaveTextContent(
        cardStatus === 'pending' ? '25%' : '68%'
      )
      expect(screen.getByText('test-progress-partial')).toBeInTheDocument()
    }
  )

  it('uses localized defaults when preview text is empty', () => {
    render(
      <CardRenderer
        block={buildCard({
          card_preview_data: {
            title: '',
            progress: 25,
            progress_text: '',
          },
        })}
      />
    )

    expect(screen.getByText('cards.video_director.title')).toBeInTheDocument()
    expect(screen.getByText('cards.video_director.processing')).toBeInTheDocument()
  })

  it('renders populated video, cover, and workflow detail link', () => {
    render(
      <CardRenderer
        block={buildCard({
          status: 'done',
          card_status: 'populated',
          card_data: {
            title: 'test-card-title',
            video_url: 'https://cdn.example.com/video.mp4',
            cover_url: 'https://cdn.example.com/cover.jpg',
            link: 'https://workflow.example.com/tasks/1',
          },
          card_preview_data: {},
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
    expect(screen.getByTestId('card-video-director-generation')).toHaveClass('max-w-[359px]')
    expect(screen.getByTestId('card-video-director-detail')).toHaveAttribute(
      'href',
      'https://workflow.example.com/tasks/1'
    )
  })

  it('does not reuse the pending preview title after completion', () => {
    render(
      <CardRenderer
        block={buildCard({
          status: 'done',
          card_status: 'populated',
          card_data: {
            video_url: 'https://cdn.example.com/video.mp4',
          },
          card_preview_data: {
            title: 'test-preview-title',
            progress: 100,
            progress_text: 'test-progress-finalizing',
          },
        })}
      />
    )

    expect(screen.getByText('cards.video_director.completed')).toBeInTheDocument()
    expect(screen.queryByText('test-preview-title')).not.toBeInTheDocument()
  })

  it('renders errors and rejects non-HTTP links', () => {
    render(
      <CardRenderer
        block={buildCard({
          status: 'error',
          card_status: 'error',
          card_data: {
            link: 'javascript:alert(1)',
          },
          card_error: 'test-error',
        })}
      />
    )

    expect(screen.getByTestId('card-video-director-error')).toHaveTextContent('test-error')
    expect(screen.queryByTestId('card-video-director-detail')).not.toBeInTheDocument()
    expect(safeCardUrl('javascript:alert(1)')).toBeNull()
  })

  it('keeps the workflow detail link when another public link button exists', () => {
    render(
      <CardRenderer
        block={buildCard({
          status: 'done',
          card_status: 'populated',
          card_data: {
            link: 'https://workflow.example.com/tasks/1',
            buttons: [
              {
                button_id: 'download',
                button_name: '下载',
                button_type: 'link',
                url: 'https://cdn.example.com/video.mp4',
              },
            ],
          },
          card_preview_data: {},
        })}
      />
    )

    expect(screen.getByTestId('card-video-director-button-0')).toHaveAttribute(
      'href',
      'https://cdn.example.com/video.mp4'
    )
    expect(screen.getByTestId('card-video-director-detail')).toHaveAttribute(
      'href',
      'https://workflow.example.com/tasks/1'
    )
  })

  it('sends chat button names through the card action callback', async () => {
    const onChatButtonClick = jest.fn().mockResolvedValue(undefined)
    render(
      <CardRenderer
        block={buildCard({
          status: 'done',
          card_status: 'populated',
          card_data: {
            buttons: [
              {
                button_id: 'generate-entities',
                button_name: 'test-chat-action',
                button_type: 'chat',
              },
            ],
          },
          card_preview_data: {},
        })}
        onChatButtonClick={onChatButtonClick}
      />
    )

    await act(async () => {
      fireEvent.click(screen.getByTestId('card-video-director-chat-button-0'))
    })

    expect(onChatButtonClick).toHaveBeenCalledWith('test-chat-action')
  })
})
