// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useState, useRef, useCallback, useEffect } from 'react'
import { Play, Pause, Download, Maximize2 } from 'lucide-react'
import { createAttachmentDownloadUrl, downloadAttachment } from '@/apis/attachments'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/hooks/useTranslation'

export interface VideoPlayerProps {
  /** URL of the video to play */
  videoUrl: string
  /** Base64 encoded thumbnail image */
  thumbnail?: string
  /** Remote poster image URL */
  coverUrl?: string
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
  coverUrl,
  duration,
  attachmentId,
  className,
  isPlaceholder = false,
  progress = 0,
}: VideoPlayerProps) {
  const { t } = useTranslation('chat')
  const videoRef = useRef<HTMLVideoElement>(null)
  const feedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [showControls, setShowControls] = useState(false)
  const [playbackFeedback, setPlaybackFeedback] = useState<'play' | 'pause' | null>(null)
  const [resolvedVideoUrl, setResolvedVideoUrl] = useState(videoUrl)
  const playbackRefreshCountRef = useRef(0)

  const usesProtectedAttachmentUrl =
    Boolean(attachmentId) &&
    videoUrl.split(/[?#]/, 1)[0].endsWith(`/api/attachments/${attachmentId}/download`)

  const refreshAttachmentPlaybackUrl = useCallback(async () => {
    if (!attachmentId || !usesProtectedAttachmentUrl) {
      setResolvedVideoUrl(videoUrl)
      return
    }

    try {
      setResolvedVideoUrl(await createAttachmentDownloadUrl(attachmentId))
    } catch (error) {
      console.error('Failed to create generated video playback URL:', error)
      setResolvedVideoUrl('')
    }
  }, [attachmentId, usesProtectedAttachmentUrl, videoUrl])

  useEffect(() => {
    playbackRefreshCountRef.current = 0
    void refreshAttachmentPlaybackUrl()
  }, [refreshAttachmentPlaybackUrl])

  const showPlaybackFeedback = useCallback((feedback: 'play' | 'pause') => {
    if (feedbackTimerRef.current) {
      clearTimeout(feedbackTimerRef.current)
    }
    setPlaybackFeedback(feedback)
    feedbackTimerRef.current = setTimeout(() => {
      setPlaybackFeedback(null)
      feedbackTimerRef.current = null
    }, 450)
  }, [])

  const togglePlay = useCallback(() => {
    if (videoRef.current) {
      if (isPlaying) {
        videoRef.current.pause()
        showPlaybackFeedback('pause')
      } else {
        videoRef.current.play()
        showPlaybackFeedback('play')
      }
      setIsPlaying(!isPlaying)
    }
  }, [isPlaying, showPlaybackFeedback])

  const seekBy = useCallback(
    (seconds: number) => {
      const video = videoRef.current
      if (!video) return

      const maxTime =
        Number.isFinite(video.duration) && video.duration > 0 ? video.duration : duration
      const nextTime = video.currentTime + seconds
      video.currentTime = Math.max(0, maxTime ? Math.min(nextTime, maxTime) : nextTime)
    },
    [duration]
  )

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'ArrowLeft') {
        event.preventDefault()
        seekBy(-5)
      } else if (event.key === 'ArrowRight') {
        event.preventDefault()
        seekBy(5)
      }
    },
    [seekBy]
  )

  useEffect(
    () => () => {
      if (feedbackTimerRef.current) {
        clearTimeout(feedbackTimerRef.current)
      }
    },
    []
  )

  const handleDownload = useCallback(async () => {
    try {
      if (attachmentId) {
        await downloadAttachment(attachmentId, `video_${attachmentId}.mp4`)
        return
      }

      const link = document.createElement('a')
      link.href = videoUrl
      link.download = `video_${Date.now()}.mp4`
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
    } catch (error) {
      console.error('Failed to download generated video:', error)
    }
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
  const posterUrl = thumbnail ? `data:image/jpeg;base64,${thumbnail}` : coverUrl
  // Without a provider thumbnail, seek to the first decodable frame so the
  // browser paints a preview instead of leaving the player black.
  const playbackUrl =
    !posterUrl && resolvedVideoUrl && !resolvedVideoUrl.includes('#')
      ? `${resolvedVideoUrl}#t=0.001`
      : resolvedVideoUrl

  const handlePlaybackError = useCallback(() => {
    if (!usesProtectedAttachmentUrl || playbackRefreshCountRef.current >= 1) {
      return
    }
    playbackRefreshCountRef.current += 1
    void refreshAttachmentPlaybackUrl()
  }, [refreshAttachmentPlaybackUrl, usesProtectedAttachmentUrl])

  // Placeholder mode: show loading state with progress
  if (isPlaceholder) {
    return (
      <div
        data-testid="video-generation-placeholder"
        role="status"
        aria-label={`${t('video.generating')} ${progress}%`}
        className={cn(
          'video-generation-placeholder relative w-full max-w-md overflow-hidden rounded-xl border border-primary/15 shadow-sm',
          className
        )}
        style={{ aspectRatio: '16 / 9' }}
      >
        <div className="video-generation-placeholder__aurora" />

        <div className="video-generation-placeholder__stage" aria-hidden="true">
          <div className="video-generation-placeholder__frame video-generation-placeholder__frame--back" />
          <div className="video-generation-placeholder__frame video-generation-placeholder__frame--front">
            <Play className="video-generation-placeholder__play h-7 w-7" />
          </div>
          <div className="video-generation-placeholder__scanhead" />
          <div className="video-generation-placeholder__particle video-generation-placeholder__particle--one" />
          <div className="video-generation-placeholder__particle video-generation-placeholder__particle--two" />
        </div>

        <div className="absolute right-3 top-3 z-10 text-xs font-medium tabular-nums text-primary">
          {progress}%
        </div>
      </div>
    )
  }

  return (
    <div
      data-testid="generated-video-player"
      tabIndex={0}
      onKeyDown={handleKeyDown}
      className={cn(
        'relative max-w-md overflow-hidden rounded-lg bg-black focus:outline-none focus-visible:ring-2 focus-visible:ring-primary',
        className
      )}
      onMouseEnter={() => setShowControls(true)}
      onMouseLeave={() => setShowControls(false)}
      onTouchStart={() => setShowControls(true)}
    >
      <video
        ref={videoRef}
        src={playbackUrl}
        poster={posterUrl}
        className="w-full h-auto"
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
        onEnded={() => setIsPlaying(false)}
        onError={handlePlaybackError}
        controls={false}
        playsInline
        preload="metadata"
      />

      {/* The whole video toggles playback; the center icon is transient feedback only. */}
      <button
        type="button"
        data-testid="video-toggle-overlay"
        onClick={togglePlay}
        className="absolute inset-0 z-10 flex items-center justify-center bg-transparent"
        aria-label={isPlaying ? t('common:actions.cancel') : t('common:actions.start')}
      >
        {playbackFeedback && (
          <span
            data-testid="video-playback-feedback"
            className="video-player__feedback pointer-events-none text-white drop-shadow-lg"
          >
            {playbackFeedback === 'play' ? (
              <Play className="h-10 w-10 fill-current" />
            ) : (
              <Pause className="h-10 w-10 fill-current" />
            )}
          </span>
        )}
      </button>

      <div
        className={cn(
          'absolute right-2 top-2 z-20 overflow-hidden rounded-lg bg-black/55 shadow-sm backdrop-blur-md',
          'transition-opacity duration-200',
          showControls ? 'opacity-100' : 'opacity-100 sm:opacity-0'
        )}
      >
        <button
          type="button"
          onClick={handleDownload}
          className="flex h-11 w-11 items-center justify-center transition-colors hover:bg-white/15 sm:h-8 sm:w-8"
          title={t('video.download')}
          aria-label={t('video.download')}
          data-testid="generated-video-download"
        >
          <Download className="h-4 w-4 text-white" />
        </button>
      </div>

      {/* Control bar - shown on hover or when not playing */}
      <div
        className={cn(
          'absolute bottom-0 left-0 right-0 z-20 p-3 bg-gradient-to-t from-black/80 to-transparent',
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
