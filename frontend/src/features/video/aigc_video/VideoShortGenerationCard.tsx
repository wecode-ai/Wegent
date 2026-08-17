// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import type { AsyncCardComponentProps } from '@/features/cards/types'
import VideoPlayer from '@/features/tasks/components/message/VideoPlayer'
import { getAigcVideoImageUrl, getAigcVideoPlaybackUrl, parseAigcVideoCardData } from './types'

function progressValue(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.max(0, Math.min(100, parsed)) : 0
}

export default function VideoShortGenerationCard({ card }: AsyncCardComponentProps) {
  const data = parseAigcVideoCardData(card.card_data || {})
  const preview = card.card_preview_data || {}
  const pending = card.card_status === 'pending' || card.card_status === 'partial_ready'

  return (
    <div data-testid={`aigc-video-final-card-${card.card_id}`}>
      <VideoPlayer
        videoUrl={data.video_url ? getAigcVideoPlaybackUrl(data.video_url) : ''}
        coverUrl={getAigcVideoImageUrl(data.cover_url)}
        duration={data.duration}
        isPlaceholder={pending}
        progress={progressValue(preview.progress)}
        className="max-w-sm"
      />
    </div>
  )
}
