// SPDX-FileCopyrightText: 2025 Bytedance Ltd. and/or its affiliates
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { Video } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'

export interface VideoConfigBadgeProps {
  config: {
    model?: string
    resolution?: string
    ratio?: string
    duration?: number
  }
}

/**
 * Badge component to display video generation configuration parameters.
 * Shows model name, aspect ratio, duration, and resolution in a compact format.
 *
 * Example output: 🎬 Video Generation doubao-seedance-1-5-pro-251215 | 16:9 | 10s | 1080p
 */
export function VideoConfigBadge({ config }: VideoConfigBadgeProps) {
  const { t } = useTranslation('chat')

  // Build parameter parts: model | ratio | duration | resolution
  const parts = [
    config.model,
    config.ratio,
    config.duration ? `${config.duration}s` : null,
    config.resolution,
  ].filter(Boolean)

  // Don't render if no parameters are available
  if (parts.length === 0) return null

  return (
    <div className="flex items-center gap-1.5 mt-2 text-xs">
      <Video className="h-3.5 w-3.5 text-text-muted flex-shrink-0" />
      <span className="font-medium text-text-secondary">
        {t('messages.video_generation') || 'Video Generation'}
      </span>
      <span className="text-text-muted">{parts.join(' | ')}</span>
    </div>
  )
}

export default VideoConfigBadge
