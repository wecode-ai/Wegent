// SPDX-FileCopyrightText: 2025 Bytedance Ltd. and/or its affiliates
//
// SPDX-License-Identifier: Apache-2.0

'use client'

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
 * Shows model name, aspect ratio, duration, and resolution as plain text below the message.
 *
 * Example output: 视频生成 SeeDance2.0 | 16:9 | 5S | 1080P
 */
export function VideoConfigBadge({ config }: VideoConfigBadgeProps) {
  const { t } = useTranslation('chat')

  // Build parameter parts: model | ratio | duration | resolution
  const parts = [
    config.model,
    config.ratio,
    config.duration ? `${config.duration}S` : null,
    config.resolution?.toUpperCase(),
  ].filter(Boolean)

  // Don't render if no parameters are available
  if (parts.length === 0) return null

  return (
    <div className="mt-2 text-sm text-text-muted">
      {t('messages.video_generation') || '视频生成'} {parts.join(' | ')}
    </div>
  )
}

export default VideoConfigBadge
