// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

/**
 * CompositionPreview - Sequential playback of multiple clips with subtitle overlay.
 * Uses "simulated composition" for low-latency preview.
 */

import React, { useCallback, useEffect, useRef, useState, useMemo } from 'react'
import { Maximize, Minimize, Pause, Play } from 'lucide-react'
import { SmartVideo } from '../components/SmartVideo'
import type { CompositionClip, CompositionSubtitle, CompositionBgm } from './types'
import {
  getClipEffectiveDuration,
  getClipSourceDuration,
  computeTotalTimelineDuration,
  getClipGlobalTimeRange,
  globalTimeToClipTime,
  formatTime,
} from './utils'

interface CompositionPreviewProps {
  clips: CompositionClip[]
  clipVideoUrlMap: Record<number, string>
  clipCoverUrlMap: Record<number, string>
  clipDurationMap: Record<number, number>
  subtitles: CompositionSubtitle[]
  subtitlesVisible: boolean
  bgm?: CompositionBgm[]
  bgmEnabled?: boolean
  isPlaying: boolean
  seekTime?: number | null
  onPlayStateChange: (playing: boolean) => void
  onCurrentClipIndexChange: (index: number) => void
  onGlobalTimeChange: (time: number) => void
  onSubtitlesVisibleChange?: (visible: boolean) => void
  onBgmEnabledChange?: (enabled: boolean) => void
  onSubtitleClick?: () => void
  onBgmClick?: () => void
  ratio?: string
}

export function CompositionPreview({
  clips,
  clipVideoUrlMap,
  clipCoverUrlMap,
  clipDurationMap,
  subtitles,
  subtitlesVisible,
  bgm,
  bgmEnabled = true,
  isPlaying,
  seekTime,
  onPlayStateChange,
  onCurrentClipIndexChange,
  onGlobalTimeChange,
  ratio,
}: CompositionPreviewProps) {
  // Current playback state
  const [currentClipIndex, setCurrentClipIndex] = useState(0)
  const [globalTime, setGlobalTime] = useState(0)
  // Double-buffered playback: active slot plays current clip, inactive slot
  // preloads the next clip so transitions are instant.
  const [activeSlot, setActiveSlot] = useState<0 | 1>(0)
  const slot0VideoRef = useRef<HTMLVideoElement>(null)
  const slot1VideoRef = useRef<HTMLVideoElement>(null)
  // Always-current activeSlot, readable from async warmup callbacks.
  const activeSlotRef = useRef<0 | 1>(0)
  // Track which clip_id has been warmed up per slot, so we don't re-warm on every render.
  const slotWarmedClipIdRef = useRef<[number | null, number | null]>([null, null])
  const containerRef = useRef<HTMLDivElement>(null)
  const animationFrameRef = useRef<number>(0)
  const lastSeekTimeRef = useRef<number | null>(null)
  const [isFullscreen, setIsFullscreen] = useState(false)

  // BGM audio playback
  const bgmAudioRef = useRef<HTMLAudioElement | null>(null)
  const currentBgmSrcRef = useRef<string | null>(null)

  const getActiveVideo = useCallback((): HTMLVideoElement | null => {
    return activeSlot === 0 ? slot0VideoRef.current : slot1VideoRef.current
  }, [activeSlot])

  // Keep activeSlotRef in sync so async warmup callbacks see the latest value.
  useEffect(() => {
    activeSlotRef.current = activeSlot
  }, [activeSlot])

  // Enabled clips only for playback
  const enabledClipEntries = useMemo(
    () => clips.map((clip, index) => ({ clip, index })).filter(entry => entry.clip.enabled),
    [clips]
  )
  const enabledClips = useMemo(
    () => enabledClipEntries.map(entry => entry.clip),
    [enabledClipEntries]
  )

  // Compute total duration
  const totalDuration = useMemo(
    () => computeTotalTimelineDuration(clips, clipDurationMap),
    [clips, clipDurationMap]
  )

  // Current clip info
  const currentClip = enabledClips[currentClipIndex]

  // Slot → clip index mapping. Active slot shows current clip; inactive preloads next.
  const slotClipIndices = useMemo<[number, number]>(() => {
    const inactiveIdx = currentClipIndex + 1
    return activeSlot === 0 ? [currentClipIndex, inactiveIdx] : [inactiveIdx, currentClipIndex]
  }, [activeSlot, currentClipIndex])

  useEffect(() => {
    if (enabledClips.length === 0) return
    if (currentClipIndex < enabledClips.length) return

    const nextIndex = enabledClips.length - 1
    setCurrentClipIndex(nextIndex)
    onCurrentClipIndexChange(enabledClipEntries[nextIndex]?.index ?? nextIndex)
  }, [currentClipIndex, enabledClipEntries, enabledClips.length, onCurrentClipIndexChange])

  // Compute storyboard global time ranges for subtitle bounds filtering
  const storyboardTimeRangeMap = useMemo(() => {
    const map = new Map<number, { start: number; end: number }>()
    for (let i = 0; i < clips.length; i++) {
      const clip = clips[i]
      if (!clip.enabled) continue
      const range = getClipGlobalTimeRange(i, clips, clipDurationMap)
      map.set(clip.storyboard_id, range)
    }
    return map
  }, [clips, clipDurationMap])

  // Find active subtitle for current global time, filtered to storyboard bounds
  const activeSubtitle = useMemo(() => {
    if (!subtitlesVisible || globalTime < 0) return null
    const sub =
      subtitles.find(sub => {
        if (!sub.enabled || globalTime < sub.start || globalTime > sub.end) return false
        if (sub.storyboard_id == null) return true
        const range = storyboardTimeRangeMap.get(sub.storyboard_id)
        if (!range) return false
        return globalTime >= range.start && globalTime <= range.end
      }) ?? null
    return sub
  }, [subtitlesVisible, subtitles, globalTime, storyboardTimeRangeMap])

  const advanceToNextClip = useCallback(() => {
    if (currentClipIndex < enabledClips.length - 1) {
      const nextIndex = currentClipIndex + 1
      // Swap active slot: the inactive slot has been preloading the next clip,
      // so playback continues with no HTTP fetch / decode gap. Do NOT pre-set
      // globalTime; the RAF loop derives it from the new active video's
      // currentTime once the swap completes.
      setActiveSlot(prev => (prev === 0 ? 1 : 0) as 0 | 1)
      setCurrentClipIndex(nextIndex)
      onCurrentClipIndexChange(enabledClipEntries[nextIndex]?.index ?? nextIndex)
      return
    }

    setGlobalTime(totalDuration)
    onGlobalTimeChange(totalDuration)
    onPlayStateChange(false)
  }, [
    currentClipIndex,
    enabledClips.length,
    enabledClipEntries,
    onCurrentClipIndexChange,
    onGlobalTimeChange,
    onPlayStateChange,
    totalDuration,
  ])

  // Time tracking during playback
  const updateGlobalTime = useCallback(() => {
    const video = getActiveVideo()
    if (!video || !currentClip || video.paused) {
      if (isPlaying) {
        animationFrameRef.current = requestAnimationFrame(updateGlobalTime)
      }
      return
    }

    const clipEndTime = currentClip.trim_end ?? getClipSourceDuration(currentClip, clipDurationMap)
    // Use the trim_end boundary directly. The previous "- 0.03" early-cutoff
    // amplified the perceived gap at the next clip's opening because we left
    // the current clip 30ms before its real end. Natural end is handled by
    // the <video> onEnded handler; this branch only fires when trim_end < source.
    if (clipEndTime > currentClip.trim_start && video.currentTime >= clipEndTime) {
      advanceToNextClip()
      return
    }

    const clipLocalTime = Math.min(video.currentTime, clipEndTime || video.currentTime)
    // Calculate global time by summing durations of previous clips + current position
    let accumulated = 0
    for (let i = 0; i < currentClipIndex; i++) {
      const clip = enabledClips[i]
      if (!clip) continue
      accumulated += getClipEffectiveDuration(clip, getClipSourceDuration(clip, clipDurationMap))
    }
    const newGlobalTime = accumulated + (clipLocalTime - currentClip.trim_start)
    setGlobalTime(Math.min(newGlobalTime, totalDuration))
    onGlobalTimeChange(newGlobalTime)

    animationFrameRef.current = requestAnimationFrame(updateGlobalTime)
  }, [
    advanceToNextClip,
    currentClip,
    currentClipIndex,
    enabledClips,
    clipDurationMap,
    getActiveVideo,
    totalDuration,
    onGlobalTimeChange,
    isPlaying,
  ])

  // Start/stop time tracking
  useEffect(() => {
    if (isPlaying) {
      animationFrameRef.current = requestAnimationFrame(updateGlobalTime)
    } else {
      cancelAnimationFrame(animationFrameRef.current)
    }
    return () => cancelAnimationFrame(animationFrameRef.current)
  }, [isPlaying, updateGlobalTime])

  // Seek video when current clip changes
  useEffect(() => {
    const video = getActiveVideo()
    if (!video || !currentClip) return
    // Skip if already at trim_start (e.g., after slot swap, the now-active video
    // was already pre-positioned during preload).
    if (Math.abs(video.currentTime - currentClip.trim_start) > 0.05) {
      video.currentTime = currentClip.trim_start
    }
  }, [currentClip, currentClipIndex, getActiveVideo])

  useEffect(() => {
    if (seekTime == null || seekTime === lastSeekTimeRef.current) return
    lastSeekTimeRef.current = seekTime

    const result = globalTimeToClipTime(seekTime, enabledClips, clipDurationMap)
    if (!result) return

    setCurrentClipIndex(result.clipIndex)
    setGlobalTime(seekTime)
    onCurrentClipIndexChange(enabledClipEntries[result.clipIndex]?.index ?? result.clipIndex)
    onGlobalTimeChange(seekTime)

    requestAnimationFrame(() => {
      const video = getActiveVideo()
      if (video) {
        video.currentTime = result.localTime
      }
    })
  }, [
    clipDurationMap,
    enabledClipEntries,
    enabledClips,
    onCurrentClipIndexChange,
    onGlobalTimeChange,
    seekTime,
    getActiveVideo,
  ])

  useEffect(() => {
    const video = getActiveVideo()
    if (!video || !currentClip) return
    video.volume = currentClip.volume
  }, [currentClip, getActiveVideo])

  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(document.fullscreenElement === containerRef.current)
    }

    document.addEventListener('fullscreenchange', handleFullscreenChange)
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange)
  }, [])

  // BGM playback: find matching segment for current global time
  useEffect(() => {
    const audio = bgmAudioRef.current
    if (!audio || !bgmEnabled) {
      if (audio) {
        audio.pause()
        audio.src = ''
      }
      currentBgmSrcRef.current = null
      return
    }

    const activeBgm = bgm?.find(
      segment =>
        (segment.status === 'success' || (!segment.status && segment.audio_url)) &&
        globalTime >= segment.start_time &&
        globalTime < segment.end_time
    )

    if (activeBgm) {
      if (currentBgmSrcRef.current !== activeBgm.audio_url) {
        audio.src = activeBgm.audio_url
        currentBgmSrcRef.current = activeBgm.audio_url
        audio.currentTime = globalTime - activeBgm.start_time
      }
      audio.volume = activeBgm.volume ?? 0.15
      if (isPlaying && audio.paused) {
        audio.play().catch(() => {
          // ignore autoplay errors
        })
      } else if (!isPlaying && !audio.paused) {
        audio.pause()
      }
    } else {
      if (currentBgmSrcRef.current !== null) {
        audio.pause()
        audio.src = ''
        currentBgmSrcRef.current = null
      }
    }
  }, [bgm, bgmEnabled, globalTime, isPlaying])

  const handleFullscreenToggle = useCallback(() => {
    const container = containerRef.current
    if (!container) return

    if (document.fullscreenElement) {
      document.exitFullscreen?.()
      return
    }

    if (container.requestFullscreen) {
      container.requestFullscreen()
      return
    }

    ;(
      container as HTMLDivElement & { webkitRequestFullscreen?: () => void }
    ).webkitRequestFullscreen?.()
  }, [])

  // Play/pause control
  const togglePlayback = useCallback(() => {
    if (!currentClip) return

    // If playback has ended (at last clip, time >= totalDuration), restart from beginning
    if (!isPlaying && currentClipIndex === enabledClips.length - 1 && globalTime >= totalDuration) {
      setCurrentClipIndex(0)
      setGlobalTime(0)
      onCurrentClipIndexChange(enabledClipEntries[0]?.index ?? 0)
      onGlobalTimeChange(0)

      requestAnimationFrame(() => {
        const video = getActiveVideo()
        if (video && enabledClips[0]) {
          video.currentTime = enabledClips[0].trim_start
        }
      })
    }

    onPlayStateChange(!isPlaying)
  }, [
    currentClip,
    isPlaying,
    currentClipIndex,
    enabledClips,
    enabledClipEntries,
    globalTime,
    totalDuration,
    onPlayStateChange,
    onCurrentClipIndexChange,
    onGlobalTimeChange,
    getActiveVideo,
  ])

  if (enabledClips.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-text-muted">
        没有可预览的片段
      </div>
    )
  }

  return (
    <div
      ref={containerRef}
      className={
        isFullscreen
          ? 'flex h-screen w-screen flex-col bg-black'
          : 'flex h-full w-full min-w-0 max-w-full flex-col overflow-hidden'
      }
    >
      {/* Video area - aspect-ratio keeps width proportional to height */}
      <div className="relative min-h-0 flex-1 overflow-hidden flex items-center justify-center">
        <div
          className="relative h-full max-w-full overflow-hidden bg-black rounded-lg"
          style={{ aspectRatio: ratio || '16/9' }}
        >
          {([0, 1] as const).map(slot => {
            const slotClipIdx = slotClipIndices[slot]
            const slotClip = enabledClips[slotClipIdx]
            if (!slotClip) return null
            const url = clipVideoUrlMap[slotClip.clip_id] ?? ''
            if (!url) return null
            const cover = clipCoverUrlMap[slotClip.clip_id] ?? ''
            const isActive = slot === activeSlot
            const ref = slot === 0 ? slot0VideoRef : slot1VideoRef
            const trimStart = slotClip.trim_start
            const clipId = slotClip.clip_id
            return (
              <SmartVideo
                key={slot}
                ref={ref}
                videoUrl={url}
                poster={cover}
                data-testid={isActive ? 'video-composition-preview' : undefined}
                shouldPlay={isActive ? isPlaying : false}
                muted={false}
                playsInline
                loop={false}
                lazyLoadWithPoster={false}
                onEnded={isActive ? advanceToNextClip : undefined}
                onLoadedMetadata={(e: React.SyntheticEvent<HTMLVideoElement>) => {
                  const video = e.currentTarget
                  if (trimStart > 0 && Math.abs(video.currentTime - trimStart) > 0.05) {
                    try {
                      video.currentTime = trimStart
                    } catch {
                      // ignore
                    }
                  }
                  if (slot === activeSlotRef.current) return
                  if (slotWarmedClipIdRef.current[slot] === clipId) return
                  slotWarmedClipIdRef.current[slot] = clipId
                  const wasMuted = video.muted
                  video.muted = true
                  const playPromise = video.play()
                  const finishWarmup = () => {
                    if (slot === activeSlotRef.current) {
                      video.muted = wasMuted
                      return
                    }
                    try {
                      video.pause()
                      video.currentTime = trimStart
                    } catch {
                      // ignore
                    }
                    video.muted = wasMuted
                  }
                  if (playPromise && typeof playPromise.then === 'function') {
                    playPromise
                      .then(() => {
                        window.setTimeout(finishWarmup, 80)
                      })
                      .catch(() => {
                        slotWarmedClipIdRef.current[slot] = null
                        video.muted = wasMuted
                      })
                  }
                }}
                className={
                  isActive
                    ? 'absolute inset-0 w-full h-full object-contain z-10 opacity-100'
                    : 'absolute inset-0 w-full h-full object-contain z-0 opacity-0 pointer-events-none'
                }
              />
            )
          })}

          {/* Hidden BGM audio element */}
          <audio ref={bgmAudioRef} className="hidden" />

          {/* Subtitle overlay - inside video frame */}
          {activeSubtitle && (
            <div className="absolute inset-x-0 bottom-0 z-20 flex justify-center pb-6 pointer-events-none">
              <div
                className="px-5 py-2.5 rounded bg-black/70 text-white text-lg text-center whitespace-pre-wrap max-w-[90%]"
                style={{ textShadow: 'none' }}
              >
                {activeSubtitle.text}
              </div>
            </div>
          )}

          {/* Clip indicator */}
          <div className="absolute top-3 right-3 z-30 px-2.5 py-1 rounded bg-black/70 text-white text-sm font-medium shadow-lg">
            {currentClipIndex + 1}/{enabledClips.length}
          </div>
        </div>
      </div>

      {/* Bottom control bar */}
      <div
        className={
          isFullscreen
            ? 'flex items-center px-0 h-[60px] bg-[#FFFFFF]'
            : 'flex items-center px-0 h-[60px] bg-[#FFFFFF]'
        }
      >
        {/* Controls row */}
        <div className="flex items-center justify-between w-full">
          {/* Left: Time */}
          <div className="flex items-center gap-1.5 text-xs w-[100px] h-[22px] ml-1">
            <span className="text-black">{formatTime(globalTime)}</span>
            <span className="text-text-muted">/</span>
            <span className="text-text-muted">{formatTime(totalDuration)}</span>
          </div>

          {/* Center: Playback controls */}
          <div className="flex flex-1 items-center justify-center">
            <button
              className="flex items-center justify-center text-black"
              style={{ width: 26, height: 26 }}
              onClick={togglePlayback}
              title={isPlaying ? '暂停' : '播放'}
            >
              {isPlaying ? (
                <Pause className="w-[26px] h-[26px]" fill="currentColor" />
              ) : (
                <Play className="w-[26px] h-[26px]" fill="currentColor" />
              )}
            </button>
          </div>

          {/* Right: Toggle buttons */}
          <div className="flex items-center gap-1 w-[120px] justify-end">
            <button
              data-testid="preview-bottom-fullscreen"
              className="p-2 rounded-lg hover:bg-black/5 transition-colors text-text-secondary hover:text-text-primary"
              onClick={handleFullscreenToggle}
              title={isFullscreen ? '退出全屏' : '全屏预览'}
            >
              {isFullscreen ? <Minimize className="w-5 h-5" /> : <Maximize className="w-5 h-5" />}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
