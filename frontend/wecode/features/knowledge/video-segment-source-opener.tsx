// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, Maximize, Minimize, Pause, Play } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useVideoPlayUrl } from '@/features/knowledge/multimodal/components/MultimodalVideoPreview'
import {
  registerExternalSourceOpener,
  type ExternalSourceOpener,
} from '@/features/tasks/components/chat/SourceReferences'
import { useTranslation } from '@/hooks/useTranslation'
import type { SourceReference } from '@/types/socket'

type VideoSegment = NonNullable<SourceReference['segments']>[number]

export interface VideoSegmentBounds {
  startSec: number
  endSec: number
  duration: number
}

function reinterpretShiftedMinuteSecond(seconds: number): number | null {
  if (!Number.isInteger(seconds) || seconds < 0 || seconds % 60 !== 0) return null
  const leading = Math.floor(seconds / 3600)
  const middle = Math.floor((seconds % 3600) / 60)
  if (leading > 59) return null
  return leading * 60 + middle
}

export function resolveVideoSegmentBounds(
  segment: Pick<VideoSegment, 'start_sec' | 'end_sec'>,
  mediaDuration?: number
): VideoSegmentBounds | null {
  if (segment.start_sec < 0 || segment.end_sec <= segment.start_sec) return null
  const hasMediaDuration =
    mediaDuration !== undefined && Number.isFinite(mediaDuration) && mediaDuration > 0
  if (hasMediaDuration && segment.end_sec > mediaDuration) {
    // Some multimodal models emit MM:SS:00 while claiming HH:MM:SS, e.g.
    // 04:59:00 for 4m59s. Correct only when the standard interpretation is
    // outside the real media duration and the conservative reinterpretation
    // produces a valid range within it.
    const shiftedStart = reinterpretShiftedMinuteSecond(segment.start_sec)
    const shiftedEnd = reinterpretShiftedMinuteSecond(segment.end_sec)
    if (
      shiftedStart !== null &&
      shiftedEnd !== null &&
      shiftedStart < shiftedEnd &&
      shiftedStart < mediaDuration &&
      shiftedEnd <= mediaDuration + 1
    ) {
      const endSec = Math.min(shiftedEnd, mediaDuration)
      return {
        startSec: shiftedStart,
        endSec,
        duration: endSec - shiftedStart,
      }
    }
  }
  if (hasMediaDuration && segment.start_sec >= mediaDuration) return null
  const endSec = hasMediaDuration ? Math.min(segment.end_sec, mediaDuration) : segment.end_sec
  if (endSec <= segment.start_sec) return null
  return {
    startSec: segment.start_sec,
    endSec,
    duration: endSec - segment.start_sec,
  }
}

function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60)
  const rest = Math.floor(seconds % 60)
  return `${minutes}:${String(rest).padStart(2, '0')}`
}

function VideoSegmentCard({
  segment,
  playUrl,
  mimeType,
  fallbackTitle,
}: {
  segment: VideoSegment
  playUrl: string
  mimeType: string
  fallbackTitle: string
}) {
  const { t } = useTranslation('chat')
  const cardRef = useRef<HTMLElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const [mediaDuration, setMediaDuration] = useState<number>()
  const bounds = useMemo(
    () => resolveVideoSegmentBounds(segment, mediaDuration),
    [mediaDuration, segment]
  )
  const duration = bounds?.duration ?? 0
  const [position, setPosition] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [videoError, setVideoError] = useState(false)
  const fullscreenAvailable = typeof document !== 'undefined' && document.fullscreenEnabled

  const seekToSegmentStart = useCallback(() => {
    const video = videoRef.current
    if (!video || !bounds) return
    video.currentTime = bounds.startSec
    setPosition(0)
  }, [bounds])

  useEffect(() => {
    seekToSegmentStart()
  }, [playUrl, seekToSegmentStart])

  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(document.fullscreenElement === cardRef.current)
    }
    document.addEventListener('fullscreenchange', handleFullscreenChange)
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange)
  }, [])

  const handleTimeUpdate = () => {
    const video = videoRef.current
    if (!video || !bounds) return
    if (video.currentTime < bounds.startSec) {
      video.currentTime = bounds.startSec
      return
    }
    if (video.currentTime >= bounds.endSec) {
      video.pause()
      video.currentTime = bounds.endSec
      setPosition(duration)
      setIsPlaying(false)
      return
    }
    setPosition(Math.max(0, video.currentTime - bounds.startSec))
  }

  const togglePlayback = async () => {
    const video = videoRef.current
    if (!video || !bounds) return
    if (!video.paused) {
      video.pause()
      setIsPlaying(false)
      return
    }
    if (video.currentTime < bounds.startSec || video.currentTime >= bounds.endSec) {
      seekToSegmentStart()
    }
    try {
      await video.play()
      setIsPlaying(true)
    } catch {
      setIsPlaying(false)
    }
  }

  const seekWithinSegment = (nextPosition: number) => {
    const video = videoRef.current
    if (!video || !bounds) return
    const boundedPosition = Math.min(Math.max(nextPosition, 0), duration)
    video.currentTime = bounds.startSec + boundedPosition
    setPosition(boundedPosition)
  }

  const toggleFullscreen = async () => {
    if (!cardRef.current || !fullscreenAvailable) return
    try {
      if (document.fullscreenElement === cardRef.current) {
        await document.exitFullscreen()
      } else {
        await cardRef.current.requestFullscreen()
      }
    } catch {
      // The browser may reject fullscreen when blocked by user settings.
    }
  }

  const handleLoadedMetadata = () => {
    const video = videoRef.current
    if (!video) return
    if (Number.isFinite(video.duration) && video.duration > 0) {
      setMediaDuration(video.duration)
    }
    // Seek to segment start on first metadata load. bounds may still be null
    // at this point (it derives from mediaDuration which we just set), so use
    // the raw segment value directly. resolveVideoSegmentBounds will clamp on
    // the next render if needed.
    if (segment.start_sec >= 0 && segment.start_sec < video.duration) {
      video.currentTime = segment.start_sec
      setPosition(0)
    }
  }

  return (
    <article
      ref={cardRef}
      className={`w-full overflow-hidden border border-border bg-surface ${
        isFullscreen
          ? 'flex h-screen max-w-none flex-col justify-center rounded-none bg-black'
          : 'max-w-md rounded-lg'
      }`}
      data-testid={`video-segment-card-${segment.start_sec}`}
    >
      <div className={`relative bg-black ${isFullscreen ? 'flex min-h-0 flex-1' : ''}`}>
        <video
          ref={videoRef}
          preload="metadata"
          playsInline
          onLoadedMetadata={handleLoadedMetadata}
          onTimeUpdate={handleTimeUpdate}
          onPause={() => setIsPlaying(false)}
          onEnded={() => setIsPlaying(false)}
          onError={() => setVideoError(true)}
          className={`${isFullscreen ? 'h-full min-h-0' : 'aspect-video'} w-full object-contain`}
          data-testid={`video-segment-player-${segment.start_sec}`}
        >
          <source src={playUrl} type={mimeType} />
        </video>
        {videoError && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/80 px-4 text-sm text-white">
            <AlertCircle className="h-5 w-5 shrink-0" />
            {t('sourceReferences.videoLoadFailed')}
          </div>
        )}
        {!bounds && mediaDuration !== undefined && (
          <div className="absolute inset-0 flex items-center justify-center gap-2 bg-black/80 px-4 text-sm text-white">
            <AlertCircle className="h-5 w-5 shrink-0" />
            {t('sourceReferences.invalidVideoSegmentRange')}
          </div>
        )}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="absolute inset-0 m-auto h-11 w-11 rounded-full bg-black/60 text-white hover:bg-black/75"
          onClick={togglePlayback}
          disabled={!bounds}
          aria-label={t(
            isPlaying ? 'sourceReferences.pauseVideoSegment' : 'sourceReferences.playVideoSegment'
          )}
          data-testid={`video-segment-toggle-${segment.start_sec}`}
        >
          {isPlaying ? <Pause className="h-5 w-5" /> : <Play className="h-5 w-5" />}
        </Button>
        {fullscreenAvailable && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="absolute right-2 top-2 h-11 w-11 rounded-full bg-black/60 text-white hover:bg-black/75"
            onClick={toggleFullscreen}
            aria-label={t(
              isFullscreen
                ? 'sourceReferences.exitVideoSegmentFullscreen'
                : 'sourceReferences.maximizeVideoSegment'
            )}
            title={t(
              isFullscreen
                ? 'sourceReferences.exitVideoSegmentFullscreen'
                : 'sourceReferences.maximizeVideoSegment'
            )}
            data-testid={`video-segment-maximize-${segment.start_sec}`}
          >
            {isFullscreen ? <Minimize className="h-4 w-4" /> : <Maximize className="h-4 w-4" />}
          </Button>
        )}
      </div>
      <div className="space-y-2 p-3">
        <div className="text-sm text-text-primary">
          <span className="font-medium text-text-secondary">
            {t('sourceReferences.videoSegmentTitle')}：
          </span>
          <span className="font-medium">{segment.title || fallbackTitle}</span>
        </div>
        {segment.description && (
          <p className="line-clamp-2 text-xs leading-5 text-text-secondary">
            <span className="font-medium">{t('sourceReferences.videoSegmentSummary')}：</span>
            {segment.description}
          </p>
        )}
        <div className="flex items-center gap-2 text-xs text-text-muted">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-11 w-11 shrink-0 rounded-full text-text-secondary hover:text-primary"
            onClick={togglePlayback}
            disabled={!bounds}
            aria-label={t(
              isPlaying ? 'sourceReferences.pauseVideoSegment' : 'sourceReferences.playVideoSegment'
            )}
            title={t(
              isPlaying ? 'sourceReferences.pauseVideoSegment' : 'sourceReferences.playVideoSegment'
            )}
            data-testid={`video-segment-control-toggle-${segment.start_sec}`}
          >
            {isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
          </Button>
          <span>{formatDuration(position)}</span>
          <input
            type="range"
            min={0}
            max={duration}
            step={0.1}
            value={Math.min(position, duration)}
            onChange={event => seekWithinSegment(Number(event.target.value))}
            disabled={!bounds}
            className="h-1 flex-1 cursor-pointer accent-primary"
            aria-label="Video segment progress"
            data-testid={`video-segment-progress-${segment.start_sec}`}
          />
          <span>{formatDuration(duration)}</span>
        </div>
      </div>
    </article>
  )
}

export function VideoSegmentSource({ source }: { source: SourceReference }) {
  const { t } = useTranslation('chat')
  const segments = source.segments ?? []
  const documentId = source.document_id ?? 0
  const { playUrl, mimeType, isLoading, notReady, hasError, retry } = useVideoPlayUrl(
    documentId,
    documentId > 0 && segments.length > 0
  )

  if (!documentId || segments.length === 0) return null
  if (isLoading) {
    return (
      <div className="flex h-36 w-full max-w-md items-center justify-center rounded-lg bg-surface">
        <Spinner />
      </div>
    )
  }
  if (!playUrl) {
    return (
      <div className="flex min-h-24 w-full max-w-md flex-col items-center justify-center gap-2 rounded-lg border border-border bg-surface p-3 text-xs text-text-muted">
        <AlertCircle className="h-4 w-4" />
        {notReady ? t('sourceReferences.videoNotReady') : t('sourceReferences.videoUnavailable')}
        {(notReady || hasError) && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={retry}
            data-testid="video-segment-retry"
          >
            {t('common:actions.retry')}
          </Button>
        )}
      </div>
    )
  }

  return (
    <div className="grid w-full grid-cols-1 gap-3 lg:grid-cols-2">
      {segments.map(segment => (
        <VideoSegmentCard
          key={segment.id ?? `${segment.start_sec}-${segment.end_sec}`}
          segment={segment}
          playUrl={playUrl}
          mimeType={mimeType}
          fallbackTitle={t('sourceReferences.videoSegment')}
        />
      ))}
    </div>
  )
}

const videoSegmentSourceOpener: ExternalSourceOpener = source => (
  <VideoSegmentSource source={source} />
)

registerExternalSourceOpener('wegent_video_segment', videoSegmentSourceOpener)
