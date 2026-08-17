// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useCallback, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { AlertCircle, ChevronDown, ChevronUp, Maximize, Minimize, Pause, Play } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useVideoPlayUrl } from '@wecode/features/knowledge/document-video-preview'
import { useTranslation } from '@/hooks/useTranslation'
import type { SourceReference } from '@/types/socket'
import { activatePlayer, getActivePlayerId, subscribeActivePlayer } from './active-video-store'
import { resolveVideoSegmentBounds } from './video-segment-bounds'
import { formatVideoTime } from './video-time'
import { useVideoSegmentPlayback } from './use-video-segment-playback'

function VideoChaptersCard({ source }: { source: SourceReference }) {
  const { t } = useTranslation('chat')
  const segments = useMemo(() => source.segments ?? [], [source.segments])
  const documentId = source.document_id ?? 0
  const reactId = useId()
  const playerId = `${source.index}:${source.kb_id ?? 0}:${documentId}:${reactId}`

  const activePlayerId = useSyncExternalStore(
    subscribeActivePlayer,
    getActivePlayerId,
    getActivePlayerId
  )
  const isExpanded = activePlayerId === playerId

  const { playUrl, mimeType, isLoading, notReady, hasError, retry } = useVideoPlayUrl(
    documentId,
    isExpanded && documentId > 0
  )

  const cardRef = useRef<HTMLElement>(null)
  const [activeSeg, setActiveSeg] = useState(0)

  const currentSeg = useMemo(() => segments[activeSeg], [segments, activeSeg])
  const {
    videoRef,
    bounds: currentBounds,
    mediaDuration,
    position,
    isPlaying,
    videoError,
    handleLoadedMetadata,
    handleTimeUpdate,
    handlePause,
    handleEnded,
    handleError,
    togglePlayback,
    seekAbsolute,
    playFrom,
    clearVideoError,
  } = useVideoSegmentPlayback({
    segment: currentSeg ?? null,
    active: isExpanded,
    positionMode: 'absolute',
  })
  const fullscreenAvailable = typeof document !== 'undefined' && document.fullscreenEnabled

  const handleToggle = useCallback(() => {
    activatePlayer(isExpanded ? null : playerId)
  }, [isExpanded, playerId])

  const handleRetry = useCallback(() => {
    clearVideoError()
    retry()
  }, [clearVideoError, retry])

  const playSegment = useCallback(
    (idx: number) => {
      const target = segments[idx]
      if (!target) return
      const targetBounds = resolveVideoSegmentBounds(target, mediaDuration)
      if (!targetBounds) return
      setActiveSeg(idx)
      playFrom(targetBounds.startSec)
    },
    [mediaDuration, playFrom, segments]
  )

  const findSegmentAtTime = useCallback(
    (time: number): number => {
      for (let idx = 0; idx < segments.length; idx += 1) {
        const bounds = resolveVideoSegmentBounds(segments[idx], mediaDuration)
        if (bounds && time >= bounds.startSec && time < bounds.endSec) {
          return idx
        }
      }
      return -1
    },
    [mediaDuration, segments]
  )

  const handleTimelineSeek = useCallback(
    (time: number) => {
      if (mediaDuration === undefined) return
      const clamped = Math.min(Math.max(time, 0), mediaDuration)
      seekAbsolute(clamped)
      const idx = findSegmentAtTime(clamped)
      if (idx >= 0 && idx !== activeSeg) {
        setActiveSeg(idx)
      }
    },
    [activeSeg, findSegmentAtTime, mediaDuration, seekAbsolute]
  )

  // Fullscreen tracking
  const fullscreenElement = useSyncExternalStore(
    (cb: () => void) => {
      if (typeof document === 'undefined') return () => {}
      document.addEventListener('fullscreenchange', cb)
      return () => document.removeEventListener('fullscreenchange', cb)
    },
    () => (typeof document !== 'undefined' ? document.fullscreenElement : null),
    () => null
  )
  const isFullscreen = fullscreenElement === cardRef.current

  const toggleFullscreen = useCallback(async () => {
    if (!cardRef.current || !fullscreenAvailable) return
    try {
      if (document.fullscreenElement === cardRef.current) {
        await document.exitFullscreen()
      } else {
        await cardRef.current.requestFullscreen()
      }
    } catch {
      // Browser may reject
    }
  }, [fullscreenAvailable])

  // Collapsed: pure button, zero network
  if (!isExpanded) {
    return (
      <button
        type="button"
        onClick={handleToggle}
        className="flex w-full max-w-md items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-xs text-text-secondary hover:bg-surface/80 transition-colors"
        data-testid={`video-chapters-toggle-${source.index}`}
      >
        <Play className="h-4 w-4 shrink-0 text-primary" />
        <span className="flex-1 truncate text-left">{source.title}</span>
        <span className="text-text-muted">
          {t('sourceReferences.videoChaptersCount', { count: segments.length })}
        </span>
        <ChevronDown className="h-4 w-4 shrink-0" />
      </button>
    )
  }

  // Expanded: single player + chapter list
  return (
    <article
      ref={cardRef}
      className={`w-full overflow-hidden border border-border bg-surface ${
        isFullscreen
          ? 'flex h-screen max-w-none flex-col justify-center rounded-none bg-black'
          : 'max-w-2xl rounded-lg'
      }`}
      data-testid={`video-chapters-card-${source.index}`}
    >
      <div className={`relative bg-black ${isFullscreen ? 'flex min-h-0 flex-1' : ''}`}>
        {isLoading && (
          <div className="flex h-48 items-center justify-center">
            <Spinner />
          </div>
        )}
        {notReady && (
          <div className="flex h-48 flex-col items-center justify-center gap-2 text-sm text-white">
            <AlertCircle className="h-5 w-5" />
            {t('sourceReferences.videoNotReady')}
            <Button
              variant="outline"
              size="sm"
              onClick={handleRetry}
              data-testid={`video-chapters-retry-${source.index}`}
            >
              {t('common:actions.retry')}
            </Button>
          </div>
        )}
        {(hasError || videoError) && !isLoading && !notReady && (
          <div className="flex h-48 flex-col items-center justify-center gap-2 text-sm text-white">
            <AlertCircle className="h-5 w-5" />
            {t('sourceReferences.videoLoadFailed')}
            <Button
              variant="outline"
              size="sm"
              onClick={handleRetry}
              data-testid={`video-chapters-error-retry-${source.index}`}
            >
              {t('common:actions.retry')}
            </Button>
          </div>
        )}
        {mediaDuration !== undefined &&
          !currentBounds &&
          !isLoading &&
          !videoError &&
          !hasError &&
          !notReady && (
            <div className="flex h-48 items-center justify-center gap-2 px-4 text-sm text-white">
              <AlertCircle className="h-5 w-5" />
              {t('sourceReferences.invalidVideoSegmentRange')}
            </div>
          )}
        {playUrl && !hasError && !videoError && !notReady && (
          <>
            <video
              ref={videoRef}
              preload="none"
              playsInline
              onLoadedMetadata={handleLoadedMetadata}
              onTimeUpdate={handleTimeUpdate}
              onPause={handlePause}
              onEnded={handleEnded}
              onError={handleError}
              className={`${isFullscreen ? 'h-full min-h-0' : 'aspect-video'} w-full object-contain`}
              data-testid={`video-chapters-player-${source.index}`}
            >
              <source src={playUrl} type={mimeType} />
            </video>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="absolute inset-0 m-auto h-11 w-11 rounded-full bg-black/60 text-white hover:bg-black/75"
              onClick={togglePlayback}
              disabled={!currentBounds}
              data-testid={`video-chapters-overlay-toggle-${source.index}`}
              aria-label={t(
                isPlaying
                  ? 'sourceReferences.pauseVideoSegment'
                  : 'sourceReferences.playVideoSegment'
              )}
            >
              {isPlaying ? <Pause className="h-5 w-5" /> : <Play className="h-5 w-5" />}
            </Button>
            {fullscreenAvailable && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="absolute right-2 top-2 h-9 w-9 rounded-full bg-black/60 text-white hover:bg-black/75"
                onClick={toggleFullscreen}
                aria-label={t('sourceReferences.maximizeVideoSegment')}
                data-testid={`video-chapters-maximize-${source.index}`}
              >
                {isFullscreen ? <Minimize className="h-4 w-4" /> : <Maximize className="h-4 w-4" />}
              </Button>
            )}
          </>
        )}
      </div>

      {/* Playback timeline */}
      {playUrl && !hasError && !videoError && !notReady && (
        <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-xs text-text-muted">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-11 w-11 shrink-0 rounded-full text-text-secondary hover:text-primary"
            onClick={togglePlayback}
            disabled={!currentBounds}
            aria-label={t(
              isPlaying ? 'sourceReferences.pauseVideoSegment' : 'sourceReferences.playVideoSegment'
            )}
            data-testid={`video-chapters-control-toggle-${source.index}`}
          >
            {isPlaying ? <Pause className="h-5 w-5" /> : <Play className="h-5 w-5" />}
          </Button>
          <span className="shrink-0 font-mono">{formatVideoTime(position)}</span>
          <input
            type="range"
            min={0}
            max={mediaDuration ?? currentBounds?.endSec ?? 0}
            step={0.1}
            value={Math.min(position, mediaDuration ?? currentBounds?.endSec ?? 0)}
            onChange={event => handleTimelineSeek(Number(event.target.value))}
            disabled={!currentBounds}
            className="h-1 flex-1 cursor-pointer accent-primary"
            aria-label={t('sourceReferences.videoChaptersProgress')}
            data-testid={`video-chapters-progress-${source.index}`}
          />
          <span className="shrink-0 font-mono">
            {formatVideoTime(mediaDuration ?? currentBounds?.endSec ?? 0)}
          </span>
        </div>
      )}

      {/* Chapter list */}
      <div className="max-h-60 overflow-y-auto p-2">
        <div className="mb-1 flex items-center justify-between px-1">
          <span className="text-xs font-medium text-text-secondary">
            {t('sourceReferences.videoChapters')}
          </span>
          <button
            type="button"
            onClick={handleToggle}
            className="flex items-center gap-1 text-xs text-text-muted hover:text-text-primary"
            data-testid={`video-chapters-collapse-${source.index}`}
          >
            {t('common:actions.collapse')}
            <ChevronUp className="h-3 w-3" />
          </button>
        </div>
        {segments.map((seg, idx) => (
          <button
            key={seg.id ?? `${seg.start_sec}-${seg.end_sec}`}
            type="button"
            onClick={() => playSegment(idx)}
            disabled={!resolveVideoSegmentBounds(seg, mediaDuration)}
            className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs transition-colors ${
              idx === activeSeg
                ? 'bg-primary/10 text-primary'
                : 'text-text-secondary hover:bg-surface'
            }`}
            data-testid={`video-chapter-item-${source.index}-${idx}`}
          >
            <span className="shrink-0 font-mono text-text-muted">
              {formatVideoTime(seg.start_sec)}–{formatVideoTime(seg.end_sec)}
            </span>
            <span className="flex-1 truncate">
              {seg.title || t('sourceReferences.videoSegment')}
            </span>
          </button>
        ))}
        {source.segments_truncated && (
          <p className="px-2 py-1 text-xs text-text-muted">
            {t('sourceReferences.videoChaptersTruncated')}
          </p>
        )}
      </div>
    </article>
  )
}

const videoChaptersOpener = (source: SourceReference) => <VideoChaptersCard source={source} />

export { videoChaptersOpener, VideoChaptersCard }
