// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import { AlertCircle, Maximize, Minimize, Pause, Play } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useVideoPlayUrl } from './document-video-preview'
import {
  registerExternalSourceOpener,
  type ExternalSourceOpener,
} from '@/features/tasks/components/chat/SourceReferences'
import { useTranslation } from '@/hooks/useTranslation'
import type { SourceReference } from '@/types/socket'
import { resolveVideoSegmentBounds, type VideoSegmentBounds } from './video-segment-bounds'
import { formatVideoTime } from './video-time'
import { activatePlayer, getActivePlayerId, subscribeActivePlayer } from './active-video-store'
import { useVideoSegmentPlayback } from './use-video-segment-playback'

type VideoSegment = NonNullable<SourceReference['segments']>[number]

export { resolveVideoSegmentBounds }
export type { VideoSegmentBounds }

function VideoSegmentCard({
  segment,
  playUrl,
  mimeType,
  fallbackTitle,
  isActive,
  isLoading,
  notReady,
  hasUrlError,
  onActivate,
  onRetry,
}: {
  segment: VideoSegment
  playUrl: string
  mimeType: string
  fallbackTitle: string
  isActive: boolean
  isLoading: boolean
  notReady: boolean
  hasUrlError: boolean
  onActivate: () => void
  onRetry: () => void
}) {
  const { t } = useTranslation('chat')
  const cardRef = useRef<HTMLElement>(null)
  const playback = useVideoSegmentPlayback({
    segment,
    active: isActive,
    positionMode: 'relative',
    resumeOnReactivate: true,
  })
  const {
    videoRef,
    bounds,
    mediaDuration,
    position,
    isPlaying,
    videoError,
    handleLoadedMetadata,
    handleTimeUpdate,
    handlePause,
    handleEnded,
    handleError,
    seekTo,
    requestPlayWhenReady,
    clearVideoError,
  } = playback
  const duration = bounds?.duration ?? 0
  const [isFullscreen, setIsFullscreen] = useState(false)
  const fullscreenAvailable = typeof document !== 'undefined' && document.fullscreenEnabled

  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(document.fullscreenElement === cardRef.current)
    }
    document.addEventListener('fullscreenchange', handleFullscreenChange)
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange)
  }, [])

  const togglePlayback = async () => {
    if (!isActive) {
      requestPlayWhenReady()
      onActivate()
      return
    }
    await playback.togglePlayback()
  }

  const seekWithinSegment = (nextPosition: number) => {
    if (!bounds) return
    const boundedPosition = Math.min(Math.max(nextPosition, 0), duration)
    seekTo(bounds.startSec + boundedPosition)
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
        {isActive && playUrl ? (
          <video
            ref={videoRef}
            preload="metadata"
            playsInline
            onLoadedMetadata={handleLoadedMetadata}
            onTimeUpdate={handleTimeUpdate}
            onPause={handlePause}
            onEnded={handleEnded}
            onError={handleError}
            className={`${isFullscreen ? 'h-full min-h-0' : 'aspect-video'} w-full object-contain`}
            data-testid={`video-segment-player-${segment.start_sec}`}
          >
            <source src={playUrl} type={mimeType} />
          </video>
        ) : (
          <div className={`${isFullscreen ? 'h-full min-h-0' : 'aspect-video'} w-full bg-black`} />
        )}
        {isActive && isLoading && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/70">
            <Spinner />
          </div>
        )}
        {isActive && (videoError || hasUrlError || notReady) && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/80 px-4 text-sm text-white">
            <AlertCircle className="h-5 w-5 shrink-0" />
            {notReady ? t('sourceReferences.videoNotReady') : t('sourceReferences.videoLoadFailed')}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                clearVideoError()
                requestPlayWhenReady()
                onRetry()
              }}
              data-testid={`video-segment-card-retry-${segment.start_sec}`}
            >
              {t('common:actions.retry')}
            </Button>
          </div>
        )}
        {!bounds && mediaDuration !== undefined && (
          <div className="absolute inset-0 flex items-center justify-center gap-2 bg-black/80 px-4 text-sm text-white">
            <AlertCircle className="h-5 w-5 shrink-0" />
            {t('sourceReferences.invalidVideoSegmentRange')}
          </div>
        )}
        {(!isActive || (!isLoading && !videoError && !hasUrlError && !notReady)) && (
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
        )}
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
          <span>{formatVideoTime(position)}</span>
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
          <span>{formatVideoTime(duration)}</span>
        </div>
      </div>
    </article>
  )
}

export function VideoSegmentSource({ source }: { source: SourceReference }) {
  const { t } = useTranslation('chat')
  const segments = source.segments ?? []
  const documentId = source.document_id ?? 0
  const reactId = useId()
  // Scope this source instance so the same video cited in multiple messages
  // does not conflict, while the global store guarantees a single player.
  const playerPrefix = `segment:${source.index}:${source.kb_id ?? 0}:${documentId}:${reactId}`
  const activePlayerId = useSyncExternalStore(
    subscribeActivePlayer,
    getActivePlayerId,
    getActivePlayerId
  )
  const activeSegmentKey =
    activePlayerId !== null && activePlayerId.startsWith(`${playerPrefix}:`)
      ? activePlayerId.slice(playerPrefix.length + 1)
      : null
  const { playUrl, mimeType, isLoading, notReady, hasError, retry } = useVideoPlayUrl(
    documentId,
    documentId > 0 && segments.length > 0 && activeSegmentKey !== null
  )

  if (!documentId || segments.length === 0) return null

  return (
    <div className="grid w-full grid-cols-1 gap-3 lg:grid-cols-2">
      {segments.map(segment => {
        const segmentKey = segment.id ?? `${segment.start_sec}-${segment.end_sec}`
        return (
          <VideoSegmentCard
            key={segmentKey}
            segment={segment}
            playUrl={playUrl ?? ''}
            mimeType={mimeType}
            fallbackTitle={t('sourceReferences.videoSegment')}
            isActive={activeSegmentKey === segmentKey}
            isLoading={isLoading}
            notReady={notReady}
            hasUrlError={hasError}
            onActivate={() => activatePlayer(`${playerPrefix}:${segmentKey}`)}
            onRetry={retry}
          />
        )
      })}
    </div>
  )
}

const videoSegmentSourceOpener: ExternalSourceOpener = source => (
  <VideoSegmentSource source={source} />
)

registerExternalSourceOpener('wegent_video_segment', videoSegmentSourceOpener)
