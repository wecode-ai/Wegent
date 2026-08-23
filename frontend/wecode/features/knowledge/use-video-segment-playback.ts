// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared UI-less playback state for video citation players.
 *
 * Owns the <video> element lifecycle: metadata loading, bounded seek,
 * play/pause state, segment-end auto pause, resume positions, and media
 * error state. Layout, URL fetching, chapter lists, and the global
 * active-player store stay in the consuming components.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { resolveVideoSegmentBounds, type VideoSegmentBounds } from './video-segment-bounds'

export interface PlaybackSegment {
  start_sec: number
  end_sec: number
}

export interface UseVideoSegmentPlaybackOptions {
  /** Current segment to play; null disables bounds until one is set. */
  segment: PlaybackSegment | null
  /** Whether this player currently owns the mounted <video> element. */
  active: boolean
  /** 'relative' shows progress within the segment; 'absolute' within the video. */
  positionMode?: 'absolute' | 'relative'
  /** Keep and restore the last playback position across deactivation. */
  resumeOnReactivate?: boolean
}

export interface VideoSegmentPlayback {
  videoRef: React.RefObject<HTMLVideoElement | null>
  bounds: VideoSegmentBounds | null
  mediaDuration: number | undefined
  position: number
  isPlaying: boolean
  videoError: boolean
  handleLoadedMetadata: () => void
  handleTimeUpdate: () => void
  handlePause: () => void
  handleEnded: () => void
  handleError: () => void
  togglePlayback: () => Promise<void>
  /** Seek to an absolute video time within the current bounds. */
  seekTo: (timeSec: number) => void
  /** Seek to an absolute video time without bounds clamping (timeline seeks
   *  may cross chapter boundaries; the next timeupdate applies new bounds). */
  seekAbsolute: (timeSec: number) => void
  /** Seek now (or once metadata is ready) and start playback. Not clamped to
   *  the current bounds so callers can cross chapter boundaries; the next
   *  timeupdate applies the new bounds. */
  playFrom: (timeSec: number) => void
  /** Start playback as soon as the media element is ready (retry flows). */
  requestPlayWhenReady: () => void
  clearVideoError: () => void
}

export function useVideoSegmentPlayback(
  options: UseVideoSegmentPlaybackOptions
): VideoSegmentPlayback {
  const { segment, active, positionMode = 'relative', resumeOnReactivate = false } = options

  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [mediaDuration, setMediaDuration] = useState<number>()
  const [position, setPosition] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [videoError, setVideoError] = useState(false)
  // Absolute time to seek to once metadata is (re)loaded.
  const pendingSeekRef = useRef<number | null>(null)
  const playWhenReadyRef = useRef(false)
  const resumeTimeRef = useRef<number | null>(null)

  const bounds =
    segment && mediaDuration !== undefined
      ? resolveVideoSegmentBounds(segment, mediaDuration)
      : segment
        ? resolveVideoSegmentBounds(segment)
        : null

  const toDisplayPosition = useCallback(
    (absolute: number) =>
      positionMode === 'relative' && bounds ? Math.max(0, absolute - bounds.startSec) : absolute,
    [bounds, positionMode]
  )

  // Deactivation unmounts the media element; reset playback state but keep
  // the resume point when the component opted into resume.
  useEffect(() => {
    if (active) return
    playWhenReadyRef.current = false
    pendingSeekRef.current = null
    setMediaDuration(undefined)
    setPosition(0)
    setIsPlaying(false)
    setVideoError(false)
    if (!resumeOnReactivate) {
      resumeTimeRef.current = null
    }
  }, [active, resumeOnReactivate])

  const handleLoadedMetadata = useCallback(() => {
    const video = videoRef.current
    if (!video) return
    setVideoError(false)
    const duration =
      Number.isFinite(video.duration) && video.duration > 0 ? video.duration : undefined
    setMediaDuration(duration)
    const nextBounds = segment ? resolveVideoSegmentBounds(segment, duration) : null
    if (!nextBounds) return
    const resumeTime = resumeOnReactivate ? resumeTimeRef.current : null
    const startTime =
      pendingSeekRef.current ??
      (resumeTime !== null && resumeTime >= nextBounds.startSec && resumeTime < nextBounds.endSec
        ? resumeTime
        : nextBounds.startSec)
    video.currentTime = startTime
    resumeTimeRef.current = startTime
    setPosition(toDisplayPosition(startTime))
    pendingSeekRef.current = null
    if (playWhenReadyRef.current) {
      playWhenReadyRef.current = false
      void Promise.resolve(video.play()).then(
        () => setIsPlaying(true),
        () => setIsPlaying(false)
      )
    }
  }, [resumeOnReactivate, segment, toDisplayPosition])

  const handleTimeUpdate = useCallback(() => {
    const video = videoRef.current
    if (!video || !bounds) return
    resumeTimeRef.current = video.currentTime
    if (video.currentTime < bounds.startSec) {
      video.currentTime = bounds.startSec
      return
    }
    if (video.currentTime >= bounds.endSec) {
      video.pause()
      video.currentTime = bounds.endSec
      setPosition(toDisplayPosition(bounds.endSec))
      setIsPlaying(false)
      return
    }
    setPosition(toDisplayPosition(video.currentTime))
  }, [bounds, toDisplayPosition])

  const seekTo = useCallback(
    (timeSec: number) => {
      const video = videoRef.current
      if (!video || !bounds) return
      const clamped = Math.min(Math.max(timeSec, bounds.startSec), bounds.endSec)
      video.currentTime = clamped
      resumeTimeRef.current = clamped
      setPosition(toDisplayPosition(clamped))
    },
    [bounds, toDisplayPosition]
  )

  const togglePlayback = useCallback(async () => {
    const video = videoRef.current
    if (!video || !bounds) return
    if (!video.paused) {
      video.pause()
      setIsPlaying(false)
      return
    }
    if (video.currentTime < bounds.startSec || video.currentTime >= bounds.endSec) {
      video.currentTime = bounds.startSec
      resumeTimeRef.current = bounds.startSec
      setPosition(toDisplayPosition(bounds.startSec))
    }
    try {
      await video.play()
      setIsPlaying(true)
    } catch {
      setIsPlaying(false)
    }
  }, [bounds, toDisplayPosition])

  const seekAbsolute = useCallback(
    (timeSec: number) => {
      const video = videoRef.current
      if (!video) return
      video.currentTime = timeSec
      resumeTimeRef.current = timeSec
      setPosition(toDisplayPosition(timeSec))
    },
    [toDisplayPosition]
  )

  const playFrom = useCallback(
    (timeSec: number) => {
      const video = videoRef.current
      if (!video) return
      if (video.readyState >= 1) {
        seekAbsolute(timeSec)
      } else {
        pendingSeekRef.current = timeSec
      }
      void Promise.resolve(video.play()).then(
        () => setIsPlaying(true),
        () => setIsPlaying(false)
      )
    },
    [seekAbsolute]
  )

  return {
    videoRef,
    bounds,
    mediaDuration,
    position,
    isPlaying,
    videoError,
    handleLoadedMetadata,
    handleTimeUpdate,
    handlePause: useCallback(() => setIsPlaying(false), []),
    handleEnded: useCallback(() => setIsPlaying(false), []),
    handleError: useCallback(() => setVideoError(true), []),
    togglePlayback,
    seekTo,
    seekAbsolute,
    playFrom,
    requestPlayWhenReady: useCallback(() => {
      playWhenReadyRef.current = true
    }, []),
    clearVideoError: useCallback(() => setVideoError(false), []),
  }
}
