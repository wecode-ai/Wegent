// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'

type SharedFilmstripProps = {
  videoUrl: string
  posterUrl?: string
  duration: number
  clipId?: number
  fallback: React.ReactNode
  frameCount?: number
  squareFrames?: boolean
}

interface VideoFilmstripProps extends SharedFilmstripProps {
  className?: string
}

interface VideoFilmstripSelectorProps extends SharedFilmstripProps {
  className?: string
  selectedTime?: number | null
  onSelectTime?: (time: number, previewUrl?: string) => void
}

function waitForVideoSeek(video: HTMLVideoElement): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      video.removeEventListener('seeked', handleSeeked)
      video.removeEventListener('error', handleError)
    }
    const handleSeeked = () => {
      cleanup()
      resolve()
    }
    const handleError = () => {
      cleanup()
      reject(new Error('Failed to seek timeline filmstrip video'))
    }

    video.addEventListener('seeked', handleSeeked, { once: true })
    video.addEventListener('error', handleError, { once: true })
  })
}

async function seekVideoFrame(video: HTMLVideoElement, time: number): Promise<void> {
  if (Math.abs(video.currentTime - time) <= 0.05) return

  const seekPromise = waitForVideoSeek(video)
  video.currentTime = time
  await seekPromise
}

function clampTime(time: number, duration: number): number {
  if (!Number.isFinite(duration) || duration <= 0) return 0
  return Math.min(Math.max(time, 0), duration)
}

function useFilmstripFrames({
  videoUrl,
  posterUrl,
  duration,
  clipId,
  fallback,
  frameCount,
  squareFrames,
}: SharedFilmstripProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRefs = useRef<(HTMLCanvasElement | null)[]>([])
  const generationRef = useRef(0)
  const [framesReady, setFramesReady] = useState(false)
  const [captureFailed, setCaptureFailed] = useState(false)
  const playbackUrl = videoUrl
  const playbackFailed = false
  const handlePlaybackError = () => setCaptureFailed(true)

  const resolvedFrameCount = Math.max(frameCount ?? Math.ceil(duration), 1)
  const widthPercent = 100 / resolvedFrameCount
  const placeholderStrip = useMemo(
    () => (
      <div className="flex h-full w-full">
        {Array.from({ length: resolvedFrameCount }, (_, i) => (
          <div
            key={i}
            className="h-full flex-shrink-0 overflow-hidden bg-white"
            style={{ width: `${widthPercent}%`, minWidth: '2px' }}
          >
            {posterUrl ? (
              <img
                src={posterUrl}
                alt=""
                className="h-full w-full object-cover"
                draggable={false}
              />
            ) : (
              fallback
            )}
          </div>
        ))}
      </div>
    ),
    [fallback, posterUrl, resolvedFrameCount, widthPercent]
  )

  useEffect(() => {
    generationRef.current += 1
    setFramesReady(false)
    setCaptureFailed(false)
  }, [duration, playbackUrl, videoUrl])

  const handleLoadedData = useCallback(async () => {
    const currentGeneration = generationRef.current
    const video = videoRef.current
    if (!video || !playbackUrl || playbackFailed) return

    const effectiveDuration =
      Number.isFinite(duration) && duration > 0
        ? duration
        : Number.isFinite(video.duration) && video.duration > 0
          ? video.duration
          : resolvedFrameCount

    try {
      for (let i = 0; i < resolvedFrameCount; i++) {
        if (generationRef.current !== currentGeneration) return

        const canvas = canvasRefs.current[i]
        if (!canvas) continue

        const context = canvas.getContext('2d')
        if (!context) continue

        const captureTime =
          resolvedFrameCount <= 1
            ? Math.min(0.05, Math.max(effectiveDuration - 0.05, 0))
            : Math.min(
                effectiveDuration - 0.05,
                (i / Math.max(resolvedFrameCount - 1, 1)) * effectiveDuration
              )

        await seekVideoFrame(video, Math.max(captureTime, 0))

        if (generationRef.current !== currentGeneration) return

        canvas.width = squareFrames ? 192 : 160
        canvas.height = squareFrames ? 192 : 90
        context.clearRect(0, 0, canvas.width, canvas.height)

        if (squareFrames && video.videoWidth && video.videoHeight) {
          const cropSize = Math.min(video.videoWidth, video.videoHeight)
          const sx = (video.videoWidth - cropSize) / 2
          const sy = (video.videoHeight - cropSize) / 2
          context.drawImage(video, sx, sy, cropSize, cropSize, 0, 0, canvas.width, canvas.height)
        } else {
          context.drawImage(video, 0, 0, canvas.width, canvas.height)
        }
      }

      if (generationRef.current === currentGeneration) {
        setFramesReady(true)
        setCaptureFailed(false)
      }
    } catch (error) {
      console.warn('Failed to generate filmstrip frames:', error)
      if (generationRef.current === currentGeneration) {
        setCaptureFailed(true)
      }
    }
  }, [duration, playbackFailed, playbackUrl, resolvedFrameCount])

  return {
    videoRef,
    canvasRefs,
    playbackUrl,
    handleLoadedData,
    handlePlaybackError,
    framesReady,
    captureFailed,
    placeholderStrip,
    widthPercent,
    resolvedFrameCount,
    clipId,
  }
}

export function VideoFilmstrip({
  videoUrl,
  posterUrl,
  duration,
  clipId,
  fallback,
  frameCount,
  squareFrames,
  className = '',
}: VideoFilmstripProps) {
  const {
    videoRef,
    canvasRefs,
    playbackUrl,
    handleLoadedData,
    handlePlaybackError,
    framesReady,
    captureFailed,
    placeholderStrip,
    widthPercent,
    resolvedFrameCount,
  } = useFilmstripFrames({
    videoUrl,
    posterUrl,
    duration,
    clipId,
    fallback,
    frameCount,
    squareFrames,
  })

  const canvasClassName = squareFrames
    ? 'h-full flex-shrink-0'
    : 'h-full flex-shrink-0 object-cover'

  return (
    <div className={`relative h-full w-full overflow-hidden ${className}`}>
      <video
        ref={videoRef}
        data-testid={clipId == null ? undefined : `timeline-storyboard-video-source-${clipId}`}
        src={playbackUrl}
        poster={posterUrl}
        className="pointer-events-none absolute h-px w-px opacity-0"
        muted
        playsInline
        preload="auto"
        onLoadedData={handleLoadedData}
        onError={handlePlaybackError}
        draggable={false}
      />
      <div className={`flex h-full w-full ${framesReady && !captureFailed ? '' : 'opacity-0'}`}>
        {Array.from({ length: resolvedFrameCount }, (_, i) => (
          <canvas
            key={i}
            ref={node => {
              canvasRefs.current[i] = node
            }}
            data-testid={clipId == null ? undefined : `video-filmstrip-frame-${clipId}`}
            className={canvasClassName}
            style={{ width: `${widthPercent}%`, minWidth: '2px' }}
          />
        ))}
      </div>
      {(!framesReady || captureFailed) && (
        <div className="absolute inset-0">{placeholderStrip}</div>
      )}
    </div>
  )
}

export function VideoFilmstripSelector({
  videoUrl,
  posterUrl,
  duration,
  clipId,
  fallback,
  frameCount = 8,
  squareFrames,
  className = '',
  selectedTime,
  onSelectTime,
}: VideoFilmstripSelectorProps) {
  const containerRef = useRef<HTMLButtonElement>(null)
  const {
    videoRef,
    canvasRefs,
    playbackUrl,
    handleLoadedData,
    handlePlaybackError,
    framesReady,
    captureFailed,
    placeholderStrip,
    widthPercent,
    resolvedFrameCount,
  } = useFilmstripFrames({
    videoUrl,
    posterUrl,
    duration,
    clipId,
    fallback,
    frameCount,
    squareFrames,
  })

  const canvasClassName = squareFrames
    ? 'h-full flex-shrink-0'
    : 'h-full flex-shrink-0 object-cover'

  const markerLeft =
    typeof selectedTime === 'number' && Number.isFinite(selectedTime) && duration > 0
      ? `${(clampTime(selectedTime, duration) / duration) * 100}%`
      : null

  const handleClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      if (!onSelectTime || !containerRef.current || duration <= 0) return
      const rect = containerRef.current.getBoundingClientRect()
      const relativeX = Math.min(Math.max(event.clientX - rect.left, 0), rect.width)
      const ratio = rect.width > 0 ? relativeX / rect.width : 0
      const nextTime = clampTime(ratio * duration, duration)
      const frameIndex = Math.min(
        Math.max(Math.round(ratio * Math.max(resolvedFrameCount - 1, 0)), 0),
        Math.max(resolvedFrameCount - 1, 0)
      )
      const selectedCanvas = canvasRefs.current[frameIndex]
      let previewUrl = posterUrl || undefined
      if (selectedCanvas) {
        try {
          previewUrl = selectedCanvas.toDataURL('image/png') || posterUrl || undefined
        } catch {
          // Canvas is tainted by cross-origin video, fallback to posterUrl
        }
      }
      onSelectTime(nextTime, previewUrl)
    },
    [canvasRefs, duration, onSelectTime, posterUrl, resolvedFrameCount]
  )

  return (
    <button
      ref={containerRef}
      type="button"
      className={`relative h-full w-full overflow-hidden rounded-md border border-border/70 bg-white text-left ${className}`}
      onClick={handleClick}
    >
      <video
        ref={videoRef}
        data-testid={clipId == null ? undefined : `timeline-storyboard-video-source-${clipId}`}
        src={playbackUrl}
        poster={posterUrl}
        className="pointer-events-none absolute h-px w-px opacity-0"
        muted
        playsInline
        preload="auto"
        onLoadedData={handleLoadedData}
        onError={handlePlaybackError}
        draggable={false}
      />
      <div className={`flex h-full w-full ${framesReady && !captureFailed ? '' : 'opacity-0'}`}>
        {Array.from({ length: resolvedFrameCount }, (_, i) => (
          <canvas
            key={i}
            ref={node => {
              canvasRefs.current[i] = node
            }}
            data-testid={clipId == null ? undefined : `video-filmstrip-frame-${clipId}`}
            className={canvasClassName}
            style={{ width: `${widthPercent}%`, minWidth: '24px' }}
          />
        ))}
      </div>
      {(!framesReady || captureFailed) && (
        <div className="absolute inset-0">{placeholderStrip}</div>
      )}
      {markerLeft ? (
        <div className="pointer-events-none absolute inset-y-0 z-10" style={{ left: markerLeft }}>
          <div className="absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 bg-primary" />
          <div className="absolute left-1/2 top-1.5 h-2.5 w-2.5 -translate-x-1/2 rounded-full border border-white bg-primary shadow-sm" />
        </div>
      ) : null}
    </button>
  )
}
