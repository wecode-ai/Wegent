'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { Loader2, Maximize, Minimize, Pause, Play } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { useIsMobile } from '@/features/layout/hooks/useMediaQuery'
import { getAigcVideoImageUrl, getAigcVideoPlaybackUrl } from '../aigc_video/mediaUrls'
import type { Storyboard } from './types'

interface StoryboardVideoPreviewProps {
  storyboard: Storyboard
  isVideoGenerating: boolean
  isPendingVideoGeneration?: boolean
  onPlayClick: () => void
  imageWidth?: number
  imageHeight?: number
  trimStart?: number | null
  trimEnd?: number | null
}

export function StoryboardVideoPreview({
  storyboard,
  isVideoGenerating,
  isPendingVideoGeneration = false,
  onPlayClick,
  imageWidth = 668,
  imageHeight = 375,
  trimStart,
  trimEnd,
}: StoryboardVideoPreviewProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [showControls, setShowControls] = useState(false)
  const [videoReady, setVideoReady] = useState(false)
  const [hasStartedPlayback, setHasStartedPlayback] = useState(false)
  const hideTimerRef = useRef<number | null>(null)
  const { t } = useTranslation('video')
  const isMobile = useIsMobile()

  const hasVideo =
    storyboard.video_clip?.generation_status === 3 && storyboard.video_clip?.model_video_url
  const hasVideoFailed = storyboard.video_clip?.generation_status === 9
  const firstImage = getAigcVideoImageUrl(storyboard.image_urls[0])
  const videoCoverUrl = getAigcVideoImageUrl(storyboard.video_clip?.video_cover_url)
  const videoSource = getAigcVideoPlaybackUrl(storyboard.video_clip?.model_video_url || '')
  const posterImage = videoCoverUrl || firstImage || ''

  const effectiveTrimStart = trimStart && trimStart > 0 ? trimStart : 0
  const effectiveTrimEnd = trimEnd && trimEnd > effectiveTrimStart ? trimEnd : null

  // Reset state when storyboard changes
  useEffect(() => {
    setIsPlaying(false)
    setHasStartedPlayback(false)
    setCurrentTime(effectiveTrimStart > 0 ? effectiveTrimStart : 0)
    setDuration(0)
    setVideoReady(false)
  }, [storyboard.id, storyboard.video_clip?.id, videoSource, effectiveTrimStart])

  // When video metadata loads, seek to trim_start and record duration
  const handleLoadedMetadata = useCallback(() => {
    const video = videoRef.current
    if (!video) return
    setDuration(video.duration)
    if (effectiveTrimStart > 0) {
      video.currentTime = effectiveTrimStart
      setCurrentTime(effectiveTrimStart)
    } else {
      // No seek needed, mark ready immediately to show video
      setVideoReady(true)
    }
  }, [effectiveTrimStart])

  // After seeking completes (both initial seek and during playback), mark as ready
  const handleSeeked = useCallback(() => {
    setVideoReady(true)
  }, [])

  const handleTimeUpdate = useCallback(() => {
    const video = videoRef.current
    if (!video) return
    if (effectiveTrimEnd != null && video.currentTime >= effectiveTrimEnd) {
      video.pause()
      video.currentTime = effectiveTrimEnd
      setCurrentTime(effectiveTrimEnd)
      setIsPlaying(false)
      return
    }
    setCurrentTime(video.currentTime)
  }, [effectiveTrimEnd])

  const handleVideoEnded = useCallback(() => {
    setIsPlaying(false)
    if (effectiveTrimStart > 0) {
      setCurrentTime(effectiveTrimStart)
    } else {
      setCurrentTime(0)
    }
  }, [effectiveTrimStart])

  const handlePlayClick = useCallback(() => {
    if (!hasVideo) {
      onPlayClick()
      return
    }
    const video = videoRef.current
    if (!video) return
    // Seek to trim_start before playing (handles replay after ended)
    if (effectiveTrimStart > 0 && (video.ended || video.currentTime < effectiveTrimStart)) {
      video.currentTime = effectiveTrimStart
    }
    setHasStartedPlayback(true)
    video.play()
    setIsPlaying(true)
  }, [hasVideo, onPlayClick, effectiveTrimStart])

  const togglePlay = useCallback(() => {
    const video = videoRef.current
    if (!video) return
    if (video.paused) {
      if (effectiveTrimStart > 0 && (video.ended || video.currentTime < effectiveTrimStart)) {
        video.currentTime = effectiveTrimStart
      }
      setHasStartedPlayback(true)
      video.play()
      setIsPlaying(true)
    } else {
      video.pause()
      setIsPlaying(false)
    }
  }, [effectiveTrimStart])

  const effectiveDuration =
    effectiveTrimEnd != null ? effectiveTrimEnd - effectiveTrimStart : duration - effectiveTrimStart

  const handleSeekClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const video = videoRef.current
      if (!video || !duration) return
      const rect = e.currentTarget.getBoundingClientRect()
      const clickX = e.clientX - rect.left
      const percent = Math.max(0, Math.min(1, clickX / rect.width))
      const seekTarget = effectiveTrimStart + percent * effectiveDuration
      video.currentTime = seekTarget
      setCurrentTime(seekTarget)
    },
    [duration, effectiveTrimStart, effectiveDuration]
  )

  const progressPercent =
    effectiveDuration > 0 ? ((currentTime - effectiveTrimStart) / effectiveDuration) * 100 : 0
  const shouldShowVideoFrame = videoReady && hasStartedPlayback

  const containerStyle = isMobile
    ? { width: '100%', height: '100%' }
    : { width: imageWidth, height: imageHeight }

  // Fullscreen
  useEffect(() => {
    const handleChange = () => setIsFullscreen(Boolean(document.fullscreenElement))
    document.addEventListener('fullscreenchange', handleChange)
    return () => document.removeEventListener('fullscreenchange', handleChange)
  }, [])

  const handleFullscreenToggle = useCallback(() => {
    const container = containerRef.current
    if (!container) return
    if (document.fullscreenElement) {
      document.exitFullscreen?.()
    } else if (container.requestFullscreen) {
      container.requestFullscreen()
    } else if (
      (container as HTMLDivElement & { webkitRequestFullscreen?: () => void })
        .webkitRequestFullscreen
    ) {
      ;(
        container as HTMLDivElement & { webkitRequestFullscreen?: () => void }
      ).webkitRequestFullscreen?.()
    }
  }, [])

  // Auto-hide controls
  const showControlsAndScheduleHide = useCallback(() => {
    if (isMobile) return
    setShowControls(true)
    if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current)
    hideTimerRef.current = window.setTimeout(() => setShowControls(false), 3000)
  }, [isMobile])

  const handleMouseEnter = useCallback(
    () => showControlsAndScheduleHide(),
    [showControlsAndScheduleHide]
  )
  const handleMouseMove = useCallback(
    () => showControlsAndScheduleHide(),
    [showControlsAndScheduleHide]
  )

  const handleMouseLeave = useCallback(() => {
    if (isMobile) return
    if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current)
    setShowControls(false)
  }, [isMobile])

  useEffect(() => {
    return () => {
      if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current)
    }
  }, [])

  // ── Generating state ──
  if (isVideoGenerating) {
    return (
      <div
        className="relative overflow-hidden rounded-lg bg-gray-50 flex items-center justify-center"
        style={containerStyle}
      >
        {posterImage && (
          <>
            {/* Rotated large background image */}
            <img
              src={posterImage}
              alt=""
              className="absolute left-1/2 top-1/2 max-w-none -translate-x-1/2 -translate-y-1/2 rotate-[-11.83deg] object-cover"
              style={{
                width:
                  containerStyle.width && typeof containerStyle.width === 'number'
                    ? `${containerStyle.width * 4.5}px`
                    : '450%',
                height:
                  containerStyle.height && typeof containerStyle.height === 'number'
                    ? `${containerStyle.height * 4.5}px`
                    : '450%',
              }}
            />
            {/* Inner shadow for depth effect */}
            <div
              className="absolute inset-0 pointer-events-none"
              style={{
                boxShadow: 'inset 0 0 40px rgba(0, 0, 0, 0.05)',
              }}
            />
          </>
        )}
        {/* Gradient overlay - center opaque, edges more transparent */}
        <div
          className="absolute inset-0"
          style={{
            background:
              'radial-gradient(78.76% 78.76% at 50% 50%, rgba(0, 0, 0, 0.45) 0%, rgba(0, 0, 0, 0.35) 60%, rgba(0, 0, 0, 0.25) 100%)',
          }}
        />
        {/* Backdrop blur for frosted-glass look */}
        <div className="absolute inset-0" style={{ backdropFilter: 'blur(52.5px)' }} />
        {/* Content */}
        <div className="relative z-10 flex flex-col items-center justify-center gap-3">
          <Loader2 className="w-10 h-10 animate-spin text-white" />
          <span className="text-sm text-white" style={{ fontFamily: "'PingFang SC', sans-serif" }}>
            {t('video_generating')}
          </span>
        </div>
      </div>
    )
  }

  // ── Failed state ──
  if (hasVideoFailed) {
    return (
      <div
        className="rounded-lg overflow-hidden bg-gray-50 flex items-center justify-center relative"
        style={containerStyle}
      >
        {posterImage && (
          <img
            src={posterImage}
            alt=""
            className="absolute inset-0 w-auto h-auto max-w-full max-h-full object-contain rounded-lg opacity-20"
          />
        )}
        <div className="relative z-10 flex flex-row items-center gap-2">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <circle cx="8" cy="8" r="7.5" fill="#6B7280" />
            <rect x="7.5" y="4" width="1" height="5" fill="white" />
            <rect x="7.5" y="10.5" width="1" height="1" fill="white" />
          </svg>
          <span
            className="text-[15px] text-[#333333]"
            style={{ fontFamily: "'PingFang SC', sans-serif", lineHeight: '100%' }}
          >
            {t('video_generation_failed')}
          </span>
        </div>
      </div>
    )
  }

  // ── Pending state ──
  if (isPendingVideoGeneration) {
    return (
      <div
        className="relative flex items-center justify-center overflow-hidden rounded-lg bg-white"
        style={containerStyle}
      >
        {posterImage ? (
          <img src={posterImage} alt="" className="absolute inset-0 h-full w-full object-cover" />
        ) : (
          <div className="absolute inset-0 bg-gradient-to-br from-[#f7e6da] via-[#eee4df] to-[#ddd5d2]" />
        )}
        <div
          className="absolute inset-0 rounded-lg"
          style={{
            background: 'rgba(255, 255, 255, 0.3)',
            backdropFilter: 'blur(30px)',
            WebkitBackdropFilter: 'blur(30px)',
          }}
        />
        <div className="relative z-10 flex flex-col items-center">
          <span
            className="text-[16px] font-normal leading-6 text-[#795856]"
            style={{ fontFamily: "'PingFang SC', sans-serif" }}
          >
            分镜视频待生成
          </span>
          <button
            onClick={onPlayClick}
            className="mt-10 inline-flex h-9 items-center justify-center whitespace-nowrap rounded-[18px] bg-white px-4 py-2 text-[14px] font-medium leading-5 text-[#FF8200] transition-colors hover:bg-[#fff7ef]"
            style={{ fontFamily: "'PingFang SC', sans-serif" }}
          >
            开始生成
          </button>
        </div>
      </div>
    )
  }

  // ── Has video: single <video> element for both poster and playback ──
  // Avoids re-downloading and the first-frame flash by reusing the same element.
  if (hasVideo) {
    return (
      <div
        ref={containerRef}
        className="rounded-lg overflow-hidden bg-gray-50 relative flex items-center justify-center"
        style={isFullscreen ? { width: '100vw', height: '100vh' } : containerStyle}
        onMouseEnter={handleMouseEnter}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
      >
        <video
          ref={videoRef}
          src={videoSource}
          playsInline
          preload="auto"
          onLoadedMetadata={handleLoadedMetadata}
          onSeeked={handleSeeked}
          onTimeUpdate={handleTimeUpdate}
          onEnded={handleVideoEnded}
          onClick={togglePlay}
          className={
            isFullscreen
              ? 'h-full w-full object-contain'
              : 'h-auto w-auto max-h-full max-w-full object-contain rounded-lg'
          }
          style={{
            // Keep the poster visible until playback starts to avoid mobile first-frame previews.
            opacity: shouldShowVideoFrame ? 1 : 0,
            transition: 'opacity 0.15s',
          }}
        />

        {/* Poster fallback: keep showing the cover until the user starts playback. */}
        {!shouldShowVideoFrame && posterImage && (
          <img
            src={posterImage}
            alt=""
            className="absolute inset-0 w-full h-full object-cover rounded-lg"
          />
        )}

        {/* Play button overlay — shown when paused */}
        {!isPlaying && (
          <button
            onClick={handlePlayClick}
            className="absolute inset-0 flex items-center justify-center group z-10"
          >
            <div className="w-[62px] h-[62px] flex items-center justify-center">
              <svg
                width="33"
                height="38"
                viewBox="0 0 33 38"
                fill="none"
                style={{ filter: 'drop-shadow(0 0 2.58px rgba(0,0,0,0.3))' }}
              >
                <path
                  d="M31 17.27a2 2 0 0 1 0 3.46L3.5 36.65a2 2 0 0 1-3-1.73V3.08a2 2 0 0 1 3-1.73L31 17.27Z"
                  fill="rgba(255,255,255,0.85)"
                />
              </svg>
            </div>
          </button>
        )}

        {/* Bottom control bar overlay */}
        {(isMobile || isPlaying || showControls) && (
          <div
            className={`absolute bottom-0 left-0 right-0 z-10 flex items-center px-3 gap-2 transition-opacity duration-300 ${showControls || isMobile ? 'opacity-100' : 'opacity-0'}`}
            style={{
              height: isMobile ? 52 : 28,
              paddingBottom: isMobile ? 8 : 0,
              background: 'linear-gradient(transparent, rgba(0,0,0,0.6))',
              borderRadius: '0 0 8px 8px',
            }}
            onClick={e => e.stopPropagation()}
          >
            <button
              onClick={e => {
                e.stopPropagation()
                togglePlay()
              }}
              className="flex h-8 w-8 min-w-8 items-center justify-center rounded-full text-white transition-colors hover:bg-white/20"
              title={t(isPlaying ? 'pause' : 'play')}
              aria-label={t(isPlaying ? 'pause' : 'play')}
            >
              {isPlaying ? (
                <Pause className="h-4 w-4 fill-white text-white" strokeWidth={0} />
              ) : (
                <Play className="ml-0.5 h-4 w-4 fill-white text-white" />
              )}
            </button>
            <div
              className="flex-1 h-[3px] rounded-full overflow-hidden relative cursor-pointer"
              style={{ backgroundColor: 'rgba(0,0,0,0.3)' }}
              onClick={e => {
                e.stopPropagation()
                handleSeekClick(e)
              }}
            >
              <div
                className="h-full bg-white rounded-full transition-all"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
            <button
              onClick={e => {
                e.stopPropagation()
                handleFullscreenToggle()
              }}
              className="flex h-7 w-7 items-center justify-center rounded-full text-white transition-colors hover:bg-white/20 flex-shrink-0"
              title={isFullscreen ? t('exit_fullscreen') : t('fullscreen')}
            >
              {isFullscreen ? (
                <Minimize className="h-[14px] w-[14px]" />
              ) : (
                <Maximize className="h-[14px] w-[14px]" />
              )}
            </button>
          </div>
        )}
      </div>
    )
  }

  // ── No video yet: poster image + play button to trigger generation ──
  return (
    <div
      className="rounded-lg overflow-hidden bg-gray-50 flex items-center justify-center relative"
      style={containerStyle}
    >
      {posterImage ? (
        <img
          src={posterImage}
          alt={`${t('video')}${storyboard.sequence_number}`}
          className="w-full h-full object-cover rounded-lg"
        />
      ) : (
        <div
          className="flex items-center justify-center text-sm text-[#939393]"
          style={{ height: imageHeight }}
        >
          {t('no_image')}
        </div>
      )}

      {(posterImage || hasVideo) && (
        <button
          onClick={handlePlayClick}
          className="absolute inset-0 flex items-center justify-center group"
        >
          <div className="w-[62px] h-[62px] flex items-center justify-center">
            <svg
              width="33"
              height="38"
              viewBox="0 0 33 38"
              fill="none"
              style={{ filter: 'drop-shadow(0 0 2.58px rgba(0,0,0,0.3))' }}
            >
              <path
                d="M31 17.27a2 2 0 0 1 0 3.46L3.5 36.65a2 2 0 0 1-3-1.73V3.08a2 2 0 0 1 3-1.73L31 17.27Z"
                fill="rgba(255,255,255,0.85)"
              />
            </svg>
          </div>
        </button>
      )}
    </div>
  )
}
