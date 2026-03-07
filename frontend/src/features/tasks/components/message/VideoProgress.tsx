// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React from 'react'
import { Video, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/hooks/useTranslation'
import { Progress } from '@/components/ui/progress'

export interface VideoProgressProps {
  /** Progress percentage (0-100) */
  progress: number
  /** Optional message to display */
  message?: string
  /** Optional callback when cancel button is clicked */
  onCancel?: () => void
  /** Additional CSS classes */
  className?: string
}

/**
 * VideoProgress component displays a progress bar for video generation.
 * Shows an animated video icon, progress message, and optional cancel button.
 */
export function VideoProgress({ progress, message, onCancel, className }: VideoProgressProps) {
  const { t } = useTranslation('chat')

  return (
    <div className={cn('flex flex-col gap-3 p-4 rounded-lg bg-surface', className)}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Video className="h-5 w-5 text-primary animate-pulse" />
          <span className="text-sm font-medium">{message || t('video.generating')}</span>
        </div>
        {onCancel && (
          <button
            onClick={onCancel}
            className="p-2 min-w-[44px] min-h-[44px] flex items-center justify-center rounded-full hover:bg-hover transition-colors"
            title={t('common:actions.cancel')}
          >
            <X className="h-4 w-4 text-text-muted" />
          </button>
        )}
      </div>

      <div className="flex items-center gap-3">
        <Progress value={progress} className="flex-1 h-2" />
        <span className="text-xs text-text-muted min-w-[40px] text-right">{progress}%</span>
      </div>
    </div>
  )
}

export default VideoProgress
