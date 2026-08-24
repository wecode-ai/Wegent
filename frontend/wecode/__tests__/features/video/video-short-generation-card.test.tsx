// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { render, screen } from '@testing-library/react'
import VideoShortGenerationCard from '@wecode/features/video/aigc_video/VideoShortGenerationCard'
import type { CardBlock } from '@/features/tasks/components/message/thinking/types'

jest.mock('@/features/tasks/components/message/VideoPlayer', () => ({
  __esModule: true,
  default: ({ videoUrl, coverUrl }: { videoUrl: string; coverUrl?: string }) => (
    <div data-testid="mock-video-player" data-video-url={videoUrl} data-cover-url={coverUrl} />
  ),
}))

describe('VideoShortGenerationCard', () => {
  test('renders final video and cover URLs through the media proxy helpers', () => {
    const videoUrl = 'https://f.video.weibocdn.com/example.mp4'
    const coverUrl = 'https://wx1.sinaimg.cn/large/example.jpg'
    const card: CardBlock = {
      id: 'block-1',
      type: 'card',
      card_id: 'card-1',
      card_type: 'video_short_generation',
      card_status: 'populated',
      card_data: {
        video_url: videoUrl,
        cover_url: coverUrl,
        duration: 60,
      },
    }

    render(<VideoShortGenerationCard card={card} />)

    const player = screen.getByTestId('mock-video-player')
    expect(player).toHaveAttribute(
      'data-video-url',
      `/api/aigc-video/media/playback?video_url=${encodeURIComponent(videoUrl)}`
    )
    expect(player).toHaveAttribute(
      'data-cover-url',
      `/api/aigc-video/media/image?image_url=${encodeURIComponent(coverUrl)}`
    )
  })
})
