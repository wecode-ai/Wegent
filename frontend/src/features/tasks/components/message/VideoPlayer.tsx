// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useState, useRef, useCallback } from 'react'
import { Play, Pause, Download, Maximize2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/hooks/useTranslation'

export interface VideoPlayerProps {
  /** URL of the video to play */
  videoUrl: string
  /** Base64 encoded thumbnail image */
  thumbnail?: string
  /** Video duration in seconds */
  duration?: number
  /** Attachment ID for download filename */
  attachmentId?: number
  /** Additional CSS classes */
  className?: string
  /** Whether this is a placeholder video (still being generated) */
  isPlaceholder?: boolean
  /** Video generation progress (0-100) when in placeholder mode */
  progress?: number
}

/**
 * VideoPlayer component provides a custom video player with:
 * - Play/pause controls
 * - Thumbnail poster support
 * - Download functionality
 * - Fullscreen support
 * - Duration display
 * - Hover-to-show controls
 * - Responsive design with max-width limit
 * - Touch-friendly controls (44px minimum touch targets)
 */
export function VideoPlayer({
  videoUrl,
  thumbnail,
  duration,
  attachmentId,
  className,
  isPlaceholder = false,
  progress = 0,
}: VideoPlayerProps) {
  const { t } = useTranslation('chat')
  const videoRef = useRef<HTMLVideoElement>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [showControls, setShowControls] = useState(false)

  const togglePlay = useCallback(() => {
    if (videoRef.current) {
      if (isPlaying) {
        videoRef.current.pause()
      } else {
        videoRef.current.play()
      }
      setIsPlaying(!isPlaying)
    }
  }, [isPlaying])

  const handleDownload = useCallback(() => {
    const link = document.createElement('a')
    link.href = videoUrl
    link.download = `video_${attachmentId || Date.now()}.mp4`
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
  }, [videoUrl, attachmentId])

  const handleFullscreen = useCallback(() => {
    if (videoRef.current) {
      if (videoRef.current.requestFullscreen) {
        videoRef.current.requestFullscreen()
      } else if (
        (videoRef.current as HTMLVideoElement & { webkitRequestFullscreen?: () => void })
          .webkitRequestFullscreen
      ) {
        // Safari support
        ;(
          videoRef.current as HTMLVideoElement & { webkitRequestFullscreen: () => void }
        ).webkitRequestFullscreen()
      }
    }
  }, [])

  const formatDuration = (seconds?: number) => {
    if (!seconds) return ''
    const mins = Math.floor(seconds / 60)
    const secs = Math.floor(seconds % 60)
    return `${mins}:${secs.toString().padStart(2, '0')}`
  }

  // Generate poster URL from base64 thumbnail
  const posterUrl = thumbnail ? `data:image/jpeg;base64,${thumbnail}` : undefined

  // Placeholder mode: show loading state with progress
  if (isPlaceholder) {
    return (
      <div
        className={cn(
          'relative rounded-lg overflow-hidden bg-gradient-to-br from-gray-800 to-gray-900 max-w-md',
          className
        )}
      >
        {/* Placeholder video frame with aspect ratio */}
        <div className="aspect-video w-full flex flex-col items-center justify-center p-6">
          {/* Animated loading indicator */}
          <div className="relative mb-4">
            <div className="w-16 h-16 rounded-full border-4 border-gray-600 border-t-primary animate-spin" />
            <div className="absolute inset-0 flex items-center justify-center">
              <Play className="h-6 w-6 text-gray-400" />
            </div>
          </div>

          {/* Progress text */}
          <div className="text-center">
            <p className="text-white/90 text-sm font-medium mb-2">
              {t('video.generating') || '视频生成中...'}
            </p>
            <p className="text-white/60 text-xs">
              {progress > 0 ? `${progress}%` : t('video.preparing') || '准备中...'}
            </p>
          </div>

          {/* Progress bar */}
          <div className="w-full max-w-[200px] mt-4">
            <div className="h-1.5 bg-gray-700 rounded-full overflow-hidden">
              <div
                className="h-full bg-primary rounded-full transition-all duration-500 ease-out"
                style={{ width: `${Math.max(progress, 3)}%` }}
              />
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div
      className={cn('relative rounded-lg overflow-hidden bg-black max-w-md', className)}
      onMouseEnter={() => setShowControls(true)}
      onMouseLeave={() => setShowControls(false)}
      onTouchStart={() => setShowControls(true)}
    >
      <video
        ref={videoRef}
        src={videoUrl}
        poster={posterUrl}
        className="w-full h-auto"
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
        onEnded={() => setIsPlaying(false)}
        controls={false}
        playsInline
        preload="metadata"
      />

      {/* Play button overlay - shown when not playing */}
      {!isPlaying && (
        <button
          onClick={togglePlay}
          className="absolute inset-0 flex items-center justify-center bg-black/30 hover:bg-black/40 transition-colors"
          aria-label={t('common:actions.start')}
        >
          <div className="w-16 h-16 rounded-full bg-white/90 flex items-center justify-center shadow-lg">
            <Play className="h-8 w-8 text-black ml-1" />
          </div>
        </button>
      )}

      {/* Control bar - shown on hover or when not playing */}
      <div
        className={cn(
          'absolute bottom-0 left-0 right-0 p-3 bg-gradient-to-t from-black/80 to-transparent',
          'flex items-center justify-between transition-opacity duration-200',
          showControls || !isPlaying ? 'opacity-100' : 'opacity-0'
        )}
      >
        <div className="flex items-center gap-2">
          {/* Play/Pause button */}
          <button
            onClick={togglePlay}
            className="p-2 min-w-[44px] min-h-[44px] flex items-center justify-center rounded-full hover:bg-white/20 transition-colors"
            aria-label={isPlaying ? t('common:actions.cancel') : t('common:actions.start')}
          >
            {isPlaying ? (
              <Pause className="h-5 w-5 text-white" />
            ) : (
              <Play className="h-5 w-5 text-white" />
            )}
          </button>
          {/* Duration display */}
          {duration && <span className="text-sm text-white/80">{formatDuration(duration)}</span>}
        </div>

        <div className="flex items-center gap-1">
          {/* Download button */}
          <button
            onClick={handleDownload}
            className="p-2 min-w-[44px] min-h-[44px] flex items-center justify-center rounded-full hover:bg-white/20 transition-colors"
            title={t('video.download')}
            aria-label={t('video.download')}
          >
            <Download className="h-5 w-5 text-white" />
          </button>
          {/* Fullscreen button */}
          <button
            onClick={handleFullscreen}
            className="p-2 min-w-[44px] min-h-[44px] flex items-center justify-center rounded-full hover:bg-white/20 transition-colors"
            title={t('common:actions.view')}
            aria-label={t('common:actions.view')}
          >
            <Maximize2 className="h-5 w-5 text-white" />
          </button>
        </div>
      </div>
    </div>
  )
}

export default VideoPlayer
