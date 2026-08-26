// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

/**
 * ClipTimeline - Multi-track timeline with video clips, audio track, and time ruler.
 * Uses @dnd-kit for drag-to-reorder functionality on the video track.
 * Layout: [Track Labels | Timeline Content] with time ruler, video, subtitle, and audio tracks.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Minus, Plus, X } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { CompactSlider } from '@wecode/features/video/components/CompactSlider'
import type { CompositionClip, CompositionSubtitle, CompositionBgm } from './types'
import { VideoFilmstrip } from './VideoFilmstrip'
import { PencilEditIcon } from './PencilEditIcon'
import { IconAudio, IconSubtitle, IconVideo } from './TimelineTrackIcons'
import {
  computeTotalTimelineDuration,
  formatTime,
  getClipGlobalTimeRange,
  getClipSourceDuration,
  getClipTimelineDuration,
} from './utils'

interface ClipTimelineProps {
  clips: CompositionClip[]
  clipCoverUrlMap: Record<number, string>
  clipVideoUrlMap: Record<number, string>
  clipDurationMap: Record<number, number>
  finalVideoCoverPreviewUrl?: string | null
  subtitles: CompositionSubtitle[]
  selectedClipIndex: number | null
  bgm?: CompositionBgm[]
  bgmEnabled?: boolean
  currentTime?: number
  onSelectClip: (index: number | null) => void
  onTrimClip: (index: number, trimStart: number, trimEnd: number | null) => void
  onOpenCoverPicker?: () => void
  onDeleteCover?: () => void
  onMusicClick: () => void
  onSubtitleClick?: (storyboardId?: number) => void
  onSubtitleSelect?: (id: string | null) => void
  selectedSubtitleId?: string | null
  subtitlesVisible?: boolean
  onSeekTimeline?: (time: number) => void
  onBgmTimeChange?: (idx: number, field: 'start_time' | 'end_time', value: number) => void
  selectedBgmIdx?: number | null
  onBgmSelect?: (idx: number | null) => void
  onSubtitleTimeChange?: (subtitleId: string, start: number, end: number) => void
  onUndo?: () => void
  onRedo?: () => void
  canUndo?: boolean
  canRedo?: boolean
  readOnly?: boolean
}

const BASE_PIXELS_PER_SECOND = 70
const TIMELINE_FIT_ZOOM_POSITION = 0.5
const TIMELINE_ZOOM_OUT_RATIO = 0.5
const TIMELINE_ZOOM_IN_RATIO = 8
const TIMELINE_ZOOM_IN_MIN_PIXELS_PER_SECOND = BASE_PIXELS_PER_SECOND * 2
const TIMELINE_ZOOM_BUTTON_RATIO = 1.5
const MIN_CLIP_WIDTH = 24
const FIT_MODE_MIN_BLOCK_WIDTH = 1
// Left padding inside the scrollable timeline so the first clip does not start
// flush against the label column edge (per feat/video_edit UI tweaks).
const TIMELINE_START_OFFSET = 4
const TIMELINE_END_PADDING = 48
const RULER_HEIGHT = 36
const VIDEO_TRACK_HEIGHT = 108
const SUBTITLE_TRACK_HEIGHT = 30
const AUDIO_TRACK_HEIGHT = 30
const MIN_RETAINED_DURATION = 0.5
const TRACK_GAP = 6
// Cover button (per design spec 一分钟创意视频-UI.pen): a 40x40 rounded square
// sitting in a dedicated fixed column between the track-label column and the
// scrollable video track, vertically centered in the video track. It is NOT
// inside the scroll area, so it never overlaps the clip thumbnails.
const COVER_BUTTON_SIZE = 40
// Design spec: 8px gap on each side of the cover button (label column ends at
// x=91, button at x=99, clips start at x=147 → 8px left + 40 button + 8px right).
const COVER_COLUMN_WIDTH = COVER_BUTTON_SIZE + 16
// Design spec: cover button top sits 81px below the video-track row top (the
// button is offset downward so its bottom aligns near the subtitle row, matching
// 一分钟创意视频-UI.pen node h42ktx at y=861 vs video track row top at y=780).
const COVER_BUTTON_TOP_OFFSET = 81
// Match design spec track label column width (from 一分钟创意视频-UI.pen)
const TRACK_LABEL_WIDTH = 91

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function roundToTenth(value: number): number {
  return Math.round(value * 10) / 10
}

function getFiniteClientX(event: Pick<MouseEvent | PointerEvent, 'clientX'>): number {
  return Number.isFinite(event.clientX) ? event.clientX : 0
}

function normalizeTrimEnd(
  trimEnd: number | null | undefined,
  sourceDuration: number
): number | null {
  if (trimEnd == null || trimEnd >= sourceDuration - 0.05) {
    return null
  }

  return roundToTenth(trimEnd)
}

function getClipWidth(
  duration: number,
  pixelsPerSecond: number,
  minWidth = MIN_CLIP_WIDTH
): number {
  return Math.max(minWidth, duration * pixelsPerSecond)
}

function getFitPixelsPerSecond(totalDuration: number, viewportWidth: number): number {
  if (totalDuration <= 0 || viewportWidth <= TIMELINE_END_PADDING + TIMELINE_START_OFFSET) {
    return BASE_PIXELS_PER_SECOND
  }

  return (viewportWidth - TIMELINE_END_PADDING - TIMELINE_START_OFFSET) / totalDuration
}

function formatRulerTime(seconds: number): string {
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  const hundredths = Math.floor((seconds % 1) * 100)
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}.${hundredths.toString().padStart(2, '0')}`
}

function formatStoryboardDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  const hundredths = Math.floor((seconds % 1) * 100)
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}.${hundredths.toString().padStart(2, '0')}`
}

function getTickStep(pixelsPerSecond: number): number {
  const preferredTickGapPx = 40
  const minimumStep = preferredTickGapPx / Math.max(pixelsPerSecond, 0.01)
  const supportedSteps = [1, 2, 5, 10, 15, 30, 60, 120, 300]
  return supportedSteps.find(step => step >= minimumStep) ?? 600
}

function getDynamicZoomRange(fitPixelsPerSecond: number): {
  min: number
  fit: number
  max: number
} {
  const safeFitPixelsPerSecond = Math.max(fitPixelsPerSecond, 0.01)
  return {
    min: safeFitPixelsPerSecond * TIMELINE_ZOOM_OUT_RATIO,
    fit: safeFitPixelsPerSecond,
    max: Math.max(
      safeFitPixelsPerSecond * TIMELINE_ZOOM_IN_RATIO,
      TIMELINE_ZOOM_IN_MIN_PIXELS_PER_SECOND
    ),
  }
}

function getPixelsPerSecondFromZoomPosition(
  zoomPosition: number,
  fitPixelsPerSecond: number
): number {
  const range = getDynamicZoomRange(fitPixelsPerSecond)
  const safeZoomPosition = clamp(zoomPosition, 0, 1)

  if (safeZoomPosition <= TIMELINE_FIT_ZOOM_POSITION) {
    return range.min + (safeZoomPosition / TIMELINE_FIT_ZOOM_POSITION) * (range.fit - range.min)
  }

  return (
    range.fit +
    ((safeZoomPosition - TIMELINE_FIT_ZOOM_POSITION) / (1 - TIMELINE_FIT_ZOOM_POSITION)) *
      (range.max - range.fit)
  )
}

function getZoomPositionFromPixelsPerSecond(
  pixelsPerSecond: number,
  fitPixelsPerSecond: number
): number {
  const range = getDynamicZoomRange(fitPixelsPerSecond)
  const clampedPixelsPerSecond = clamp(pixelsPerSecond, range.min, range.max)

  if (clampedPixelsPerSecond <= range.fit) {
    const zoomOutRangeSize = Math.max(range.fit - range.min, 0.01)
    return ((clampedPixelsPerSecond - range.min) / zoomOutRangeSize) * TIMELINE_FIT_ZOOM_POSITION
  }

  const zoomInRangeSize = Math.max(range.max - range.fit, 0.01)
  return (
    TIMELINE_FIT_ZOOM_POSITION +
    ((clampedPixelsPerSecond - range.fit) / zoomInRangeSize) * (1 - TIMELINE_FIT_ZOOM_POSITION)
  )
}

type ClipTrimPreview = {
  trimStart: number
  trimEnd: number | null
  activeEdge: 'start' | 'end'
}

// --- Sortable Video Clip Block ---
function SortableClipBlock({
  clip,
  clipIndex,
  coverUrl,
  videoUrl,
  effectiveDuration,
  originalDuration,
  isSelected,
  onSelect,
  onTrimChange,
  pixelsPerSecond,
  minBlockWidth,
  readOnly,
}: {
  clip: CompositionClip
  clipIndex: number
  coverUrl: string
  videoUrl: string
  effectiveDuration: number
  originalDuration: number
  isSelected: boolean
  onSelect: () => void
  onTrimChange: (trimStart: number, trimEnd: number | null) => void
  pixelsPerSecond: number
  minBlockWidth: number
  readOnly?: boolean
}) {
  const [trimPreviewState, setTrimPreviewState] = useState<ClipTrimPreview | null>(null)
  const suppressTrimClickRef = useRef(false)
  const trimClickResetTimerRef = useRef<number | null>(null)
  const trimPreviewRef = useRef<ClipTrimPreview | null>(null)

  const sourceDuration = originalDuration || effectiveDuration
  const safeOriginalDuration = Math.max(sourceDuration, effectiveDuration, MIN_RETAINED_DURATION)
  const trimPreviewStartValue = trimPreviewState?.trimStart ?? clip.trim_start
  const trimPreviewEndAbsolute = trimPreviewState
    ? (trimPreviewState.trimEnd ?? safeOriginalDuration)
    : (clip.trim_end ?? safeOriginalDuration)
  const previewEffectiveDuration = Math.max(
    trimPreviewEndAbsolute - trimPreviewStartValue,
    MIN_RETAINED_DURATION
  )
  const widthPx = getClipWidth(previewEffectiveDuration, pixelsPerSecond, minBlockWidth)
  const sourcePreviewPixelsPerSecond =
    previewEffectiveDuration > 0 ? widthPx / previewEffectiveDuration : pixelsPerSecond
  const sourcePreviewWidth = safeOriginalDuration * sourcePreviewPixelsPerSecond
  const sourcePreviewLeft = -trimPreviewStartValue * sourcePreviewPixelsPerSecond
  const trimPreviewLabelTime =
    trimPreviewState?.activeEdge === 'start' ? trimPreviewStartValue : trimPreviewEndAbsolute
  const trimPreviewLabelLeft = trimPreviewState?.activeEdge === 'start' ? 0 : widthPx

  const style: React.CSSProperties = {
    width: `${widthPx}px`,
    opacity: clip.enabled ? 1 : 0.4,
  }

  const setTrimPreview = useCallback((nextPreview: ClipTrimPreview | null) => {
    trimPreviewRef.current = nextPreview
    setTrimPreviewState(nextPreview)
  }, [])

  useEffect(() => {
    return () => {
      if (trimClickResetTimerRef.current != null) {
        window.clearTimeout(trimClickResetTimerRef.current)
      }
    }
  }, [])

  const handleResizePointerDown = useCallback(
    (edge: 'start' | 'end') => (event: React.PointerEvent<HTMLButtonElement>) => {
      if (readOnly || safeOriginalDuration <= MIN_RETAINED_DURATION) return

      event.preventDefault()
      event.stopPropagation()

      onSelect()

      const initialClientX = getFiniteClientX(event)
      const initialTrimStart = clip.trim_start
      const initialTrimEnd = clip.trim_end ?? safeOriginalDuration
      const initialPreview: ClipTrimPreview = {
        trimStart: initialTrimStart,
        trimEnd: normalizeTrimEnd(clip.trim_end, safeOriginalDuration),
        activeEdge: edge,
      }
      setTrimPreview(initialPreview)

      const handlePointerMove = (moveEvent: PointerEvent) => {
        const deltaSeconds = roundToTenth(
          (getFiniteClientX(moveEvent) - initialClientX) / pixelsPerSecond
        )

        if (edge === 'start') {
          const nextStart = clamp(
            initialTrimStart + deltaSeconds,
            0,
            initialTrimEnd - MIN_RETAINED_DURATION
          )
          const roundedStart = roundToTenth(nextStart)
          const normalizedEnd = normalizeTrimEnd(initialTrimEnd, safeOriginalDuration)
          setTrimPreview({
            trimStart: roundedStart,
            trimEnd: normalizedEnd,
            activeEdge: edge,
          })
          onTrimChange(roundedStart, normalizedEnd)
          return
        }

        const nextEnd = clamp(
          initialTrimEnd + deltaSeconds,
          initialTrimStart + MIN_RETAINED_DURATION,
          safeOriginalDuration
        )
        const normalizedEnd = normalizeTrimEnd(nextEnd, safeOriginalDuration)
        setTrimPreview({
          trimStart: initialTrimStart,
          trimEnd: normalizedEnd,
          activeEdge: edge,
        })
        onTrimChange(initialTrimStart, normalizedEnd)
      }

      const handlePointerUp = () => {
        const preview = trimPreviewRef.current
        setTrimPreview(null)
        suppressTrimClickRef.current = true
        if (trimClickResetTimerRef.current != null) {
          window.clearTimeout(trimClickResetTimerRef.current)
        }
        trimClickResetTimerRef.current = window.setTimeout(() => {
          suppressTrimClickRef.current = false
          trimClickResetTimerRef.current = null
        }, 120)
        if (
          preview &&
          (preview.trimStart !== initialPreview.trimStart ||
            preview.trimEnd !== initialPreview.trimEnd)
        ) {
          onTrimChange(preview.trimStart, preview.trimEnd)
        }
        window.removeEventListener('pointermove', handlePointerMove)
        window.removeEventListener('pointerup', handlePointerUp)
      }

      window.addEventListener('pointermove', handlePointerMove)
      window.addEventListener('pointerup', handlePointerUp, { once: true })
    },
    [
      clip.trim_end,
      clip.trim_start,
      onTrimChange,
      pixelsPerSecond,
      readOnly,
      safeOriginalDuration,
      setTrimPreview,
    ]
  )

  return (
    <div
      style={style}
      data-testid={`timeline-storyboard-block-${clip.clip_id}`}
      data-timeline-selectable="clip"
      className={`
        relative z-0 flex-shrink-0 cursor-pointer rounded border bg-white
        select-none transition-none [&_*]:transition-none group overflow-visible
        ${
          isSelected
            ? 'border-[#FCAE5D] shadow-[0_0_0_1px_#FCAE5D]'
            : 'border-border hover:border-primary/50'
        }
      `}
      onClick={() => {
        if (suppressTrimClickRef.current) {
          suppressTrimClickRef.current = false
          return
        }
        onSelect()
      }}
    >
      <div className="flex flex-col">
        <div
          className="flex h-4 flex-shrink-0 items-center justify-between gap-1 overflow-hidden px-2 text-[10px] text-black"
          style={{ backgroundColor: '#F9E3CB' }}
        >
          <span className="shrink-0">分镜{clipIndex + 1}</span>
          <span className="min-w-0 truncate">
            {formatStoryboardDuration(previewEffectiveDuration)}
          </span>
        </div>
        <div className="relative h-16 overflow-hidden bg-white">
          <div
            data-testid={`timeline-trim-source-preview-${clip.clip_id}`}
            className="absolute bottom-0 top-0 bg-white"
            style={{ left: `${sourcePreviewLeft}px`, width: `${sourcePreviewWidth}px` }}
          >
            <VideoFilmstrip
              videoUrl={videoUrl}
              posterUrl={coverUrl}
              duration={safeOriginalDuration}
              clipId={clip.clip_id}
              fallback={
                coverUrl ? (
                  <img src={coverUrl} alt="" className="h-full w-full object-cover" />
                ) : (
                  <div className="h-full w-full bg-white" />
                )
              }
            />
          </div>
        </div>
      </div>

      {trimPreviewState && (
        <div
          data-testid={`timeline-trim-time-label-${clip.clip_id}`}
          className="pointer-events-none absolute -top-1 z-30 -translate-x-1/2 -translate-y-full rounded-sm bg-black/75 px-1.5 py-0.5 text-[10px] font-medium text-white shadow-sm"
          style={{ left: `${trimPreviewLabelLeft}px` }}
        >
          {formatTime(trimPreviewLabelTime)}
        </div>
      )}

      {!readOnly && (
        <>
          <button
            type="button"
            aria-label="调整片段起点"
            className={`absolute bottom-0 left-0 top-0 z-20 flex w-[7.5px] cursor-col-resize touch-none items-center justify-center ${isSelected ? 'bg-[#FCAE5D]' : ''}`}
            onPointerDown={handleResizePointerDown('start')}
            onClick={event => event.stopPropagation()}
          >
            {isSelected && <div className="h-6 w-[3px] rounded-full bg-white" />}
          </button>
          <button
            type="button"
            aria-label="调整片段终点"
            className={`absolute bottom-0 right-0 top-0 z-20 flex w-[7.5px] cursor-col-resize touch-none items-center justify-center ${isSelected ? 'bg-[#FCAE5D]' : ''}`}
            onPointerDown={handleResizePointerDown('end')}
            onClick={event => event.stopPropagation()}
          >
            {isSelected && <div className="h-6 w-[3px] rounded-full bg-white" />}
          </button>
        </>
      )}
    </div>
  )
}

// --- Time Ruler ---
function TimeRuler({
  totalDuration,
  pixelsPerSecond,
  timelineWidth,
  onSeek,
}: {
  totalDuration: number
  pixelsPerSecond: number
  timelineWidth: number
  onSeek?: (time: number) => void
}) {
  // Keep ruler labels readable across fit-to-screen and manual zoom modes.
  const ticks = useMemo(() => {
    const result: { time: number; label: string; isMajor: boolean }[] = []
    if (totalDuration <= 0) return result

    const step = getTickStep(pixelsPerSecond)
    const subStep = step / 3
    for (let t = 0; t <= totalDuration + subStep * 0.5; t += subStep) {
      const roundedTime = roundToTenth(t)
      if (roundedTime > totalDuration + 0.01) break
      const isMajor =
        Math.abs(roundedTime % step) < 0.01 || Math.abs((roundedTime % step) - step) < 0.01
      result.push({
        time: roundedTime,
        label: isMajor ? formatRulerTime(roundedTime) : '',
        isMajor,
      })
    }
    return result
  }, [pixelsPerSecond, totalDuration])

  const handleMouseDown = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (!onSeek) return
      const rect = event.currentTarget.getBoundingClientRect()
      const nextTime = clamp((event.clientX - rect.left) / pixelsPerSecond, 0, totalDuration)
      onSeek(nextTime)
    },
    [onSeek, pixelsPerSecond, totalDuration]
  )

  return (
    <div
      className="relative cursor-default select-none bg-surface"
      style={{ height: RULER_HEIGHT, width: timelineWidth }}
      onMouseDown={handleMouseDown}
    >
      <div className="absolute bottom-0 left-0 right-0 h-px bg-border" />
      {ticks.map(tick => {
        const left = tick.time * pixelsPerSecond
        return (
          <div key={tick.time} className="absolute top-0 h-full" style={{ left: `${left}px` }}>
            {tick.isMajor && (
              <span className="absolute top-1.5 left-0 text-[11px] text-text-muted leading-none px-0.5">
                {tick.label}
              </span>
            )}
            <div
              className={`absolute bottom-0 w-px ${tick.isMajor ? 'h-[10px] bg-text-muted/30' : 'h-[6px] bg-text-muted/15'}`}
            />
            {tick.time === 0 && (
              <div
                className="absolute bottom-0 left-0 h-px bg-text-muted/30"
                style={{ width: TIMELINE_START_OFFSET, transform: 'translateX(-100%)' }}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}

const MIN_SUBTITLE_DURATION = 0.2

type SubtitleDragState = {
  id: string
  storyboardId: number
  type: 'move' | 'resize-start' | 'resize-end'
  startX: number
  initialStart: number
  initialEnd: number
}

function SubtitleTrack({
  subtitles,
  totalDuration,
  pixelsPerSecond,
  minBlockWidth,
  selectedSubtitleId,
  subtitlesVisible = true,
  clips,
  clipDurationMap,
  onSelectSubtitle,
  onSubtitleClick,
  onSubtitleTimeChange,
  onEmptyClick,
  readOnly = false,
}: {
  subtitles: CompositionSubtitle[]
  totalDuration: number
  pixelsPerSecond: number
  minBlockWidth: number
  selectedSubtitleId: string | null
  subtitlesVisible?: boolean
  clips: CompositionClip[]
  clipDurationMap: Record<number, number>
  onSelectSubtitle: (id: string) => void
  onSubtitleClick?: (storyboardId?: number) => void
  onSubtitleTimeChange?: (subtitleId: string, start: number, end: number) => void
  onEmptyClick?: () => void
  readOnly?: boolean
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<SubtitleDragState | null>(null)
  const hasDraggedRef = useRef(false)
  const [hoverCursor, setHoverCursor] = useState<string>('pointer')

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

  const visibleSubtitles = subtitles.filter(sub => sub.enabled && sub.text.trim())

  const getSubtitleHit = useCallback(
    (
      clientX: number
    ): { subtitle: CompositionSubtitle; edge: 'left' | 'right' | 'body' } | null => {
      const container = containerRef.current
      if (!container || totalDuration <= 0) return null
      const rect = container.getBoundingClientRect()
      const x = clientX - rect.left
      const time = x / pixelsPerSecond

      for (const sub of visibleSubtitles) {
        if (time >= sub.start && time < sub.end) {
          const widthPx = Math.max(minBlockWidth, (sub.end - sub.start) * pixelsPerSecond)
          const leftPx = sub.start * pixelsPerSecond
          const rightPx = leftPx + widthPx
          const edgeThreshold = Math.max(8, Math.min(widthPx * 0.35, 24))
          if (x - leftPx < edgeThreshold) return { subtitle: sub, edge: 'left' }
          if (rightPx - x < edgeThreshold) return { subtitle: sub, edge: 'right' }
          return { subtitle: sub, edge: 'body' }
        }
      }
      return null
    },
    [visibleSubtitles, totalDuration, pixelsPerSecond, minBlockWidth]
  )

  const handlePointerMove = useCallback(
    (e: PointerEvent) => {
      if (!dragRef.current || !onSubtitleTimeChange) return
      e.preventDefault()
      hasDraggedRef.current = true
      const drag = dragRef.current
      const range = storyboardTimeRangeMap.get(drag.storyboardId)
      if (!range) return

      const container = containerRef.current
      if (!container) return
      const rect = container.getBoundingClientRect()
      const x = e.clientX - rect.left
      const deltaTime = (x - drag.startX) / pixelsPerSecond
      const otherSubs = visibleSubtitles.filter(s => s.id !== drag.id)

      if (drag.type === 'move') {
        const duration = drag.initialEnd - drag.initialStart
        let newStart = drag.initialStart + deltaTime
        let newEnd = drag.initialEnd + deltaTime

        // Prevent overlap with other subtitles
        const leftBound = Math.max(
          range.start,
          ...otherSubs.filter(s => s.end <= drag.initialStart).map(s => s.end)
        )
        const rightBound = Math.min(
          range.end,
          ...otherSubs.filter(s => s.start >= drag.initialEnd).map(s => s.start)
        )

        if (newStart < leftBound) {
          newStart = leftBound
          newEnd = leftBound + duration
        } else if (newEnd > rightBound) {
          newEnd = rightBound
          newStart = rightBound - duration
        }

        onSubtitleTimeChange(drag.id, roundToTenth(newStart), roundToTenth(newEnd))
      } else if (drag.type === 'resize-start') {
        const leftBound = Math.max(
          range.start,
          ...otherSubs.filter(s => s.end <= drag.initialEnd).map(s => s.end)
        )
        const newStart = Math.max(
          leftBound,
          Math.min(drag.initialEnd - MIN_SUBTITLE_DURATION, drag.initialStart + deltaTime)
        )
        onSubtitleTimeChange(drag.id, roundToTenth(newStart), drag.initialEnd)
      } else if (drag.type === 'resize-end') {
        const rightBound = Math.min(
          range.end,
          ...otherSubs.filter(s => s.start >= drag.initialStart).map(s => s.start)
        )
        const newEnd = Math.min(
          rightBound,
          Math.max(drag.initialStart + MIN_SUBTITLE_DURATION, drag.initialEnd + deltaTime)
        )
        onSubtitleTimeChange(drag.id, drag.initialStart, roundToTenth(newEnd))
      }
    },
    [onSubtitleTimeChange, pixelsPerSecond, storyboardTimeRangeMap, visibleSubtitles]
  )

  const handlePointerUp = useCallback(() => {
    dragRef.current = null
    window.removeEventListener('pointermove', handlePointerMove)
    window.removeEventListener('pointerup', handlePointerUp)
    setTimeout(() => {
      hasDraggedRef.current = false
    }, 50)
  }, [handlePointerMove])

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (readOnly || !onSubtitleTimeChange) return
      const hit = getSubtitleHit(e.clientX)
      if (!hit) return

      e.preventDefault()
      e.stopPropagation()

      onSelectSubtitle(hit.subtitle.id)
      onSubtitleClick?.(hit.subtitle.storyboard_id)

      dragRef.current = {
        id: hit.subtitle.id,
        storyboardId: hit.subtitle.storyboard_id ?? -1,
        type: hit.edge === 'body' ? 'move' : hit.edge === 'left' ? 'resize-start' : 'resize-end',
        startX: e.clientX - (containerRef.current?.getBoundingClientRect().left ?? 0),
        initialStart: hit.subtitle.start,
        initialEnd: hit.subtitle.end,
      }

      if (hit.edge === 'body') setHoverCursor('grab')
      else setHoverCursor('ew-resize')

      window.addEventListener('pointermove', handlePointerMove)
      window.addEventListener('pointerup', handlePointerUp)
    },
    [
      getSubtitleHit,
      handlePointerMove,
      handlePointerUp,
      onSubtitleTimeChange,
      readOnly,
      onSelectSubtitle,
      onSubtitleClick,
    ]
  )

  const handleHoverMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (dragRef.current || readOnly || !onSubtitleTimeChange) return
      const hit = getSubtitleHit(e.clientX)
      if (hit) {
        if (hit.edge === 'body') setHoverCursor('grab')
        else setHoverCursor('ew-resize')
      } else {
        setHoverCursor('pointer')
      }
    },
    [getSubtitleHit, onSubtitleTimeChange, readOnly]
  )

  const handleHoverLeave = useCallback(() => {
    setHoverCursor('pointer')
  }, [])

  if (!subtitlesVisible) {
    return <div className="h-full w-full" />
  }

  if (visibleSubtitles.length === 0) {
    return (
      <button
        type="button"
        className="flex h-full w-full items-center px-2 text-[11px] text-text-muted"
        onClick={() => onSubtitleClick?.()}
      >
        暂无字幕
      </button>
    )
  }

  return (
    <div
      ref={containerRef}
      className="relative h-full"
      style={{ cursor: hoverCursor }}
      onPointerDown={handlePointerDown}
      onPointerMove={handleHoverMove}
      onPointerLeave={handleHoverLeave}
      onClick={e => {
        if (e.target === e.currentTarget) {
          onEmptyClick?.()
        }
      }}
    >
      {visibleSubtitles.map(sub => {
        const clipRange =
          sub.storyboard_id != null ? storyboardTimeRangeMap.get(sub.storyboard_id) : null
        const displayStart = clipRange ? Math.max(sub.start, clipRange.start) : sub.start
        const displayEnd = clipRange ? Math.min(sub.end, clipRange.end) : sub.end

        if (displayEnd <= displayStart) return null

        const left = clamp(displayStart, 0, totalDuration) * pixelsPerSecond
        const width = Math.max(
          minBlockWidth,
          Math.max(displayEnd - displayStart, 0.2) * pixelsPerSecond
        )
        const isSelected = selectedSubtitleId === sub.id

        return (
          <div
            key={sub.id}
            data-timeline-selectable="subtitle"
            className={`absolute top-0 flex h-full items-center overflow-hidden rounded-lg px-2 text-left text-[11px] text-text-primary transition-all select-none ${
              isSelected
                ? 'bg-[#6E8FF640] shadow-[0_0_0_1px_rgb(var(--color-primary))]'
                : 'bg-[#6E8FF626]'
            }`}
            style={{ left, width }}
            title={`${formatTime(sub.start)} - ${formatTime(sub.end)} ${sub.text}`}
            onClick={e => {
              if (hasDraggedRef.current) {
                e.stopPropagation()
                return
              }
              if (sub.storyboard_id != null) {
                onSelectSubtitle(sub.id)
                onSubtitleClick?.(sub.storyboard_id)
              }
            }}
          >
            <span className="block truncate">{sub.text}</span>
          </div>
        )
      })}
    </div>
  )
}

// --- Audio Waveform Track ---
function getPseudoAmplitude(x: number, seed: number): number {
  // Deterministic pseudo-random amplitude for waveform visualization
  const n = Math.sin(x * 12.9898 + seed * 78.233) * 43758.5453
  const f = n - Math.floor(n)
  // Bias toward mid amplitudes for a natural look
  return Math.pow(f, 0.6) * 0.85 + 0.05
}

type BgmDragState = {
  idx: number
  type: 'move' | 'resize-start' | 'resize-end'
  startX: number
  initialStart: number
  initialEnd: number
}

function AudioWaveformTrack({
  bgm,
  bgmEnabled,
  totalDuration,
  pixelsPerSecond,
  timelineWidth,
  selectedBgmIdx,
  onClick,
  onBgmSelect,
  onBgmTimeChange,
  readOnly,
}: {
  bgm: CompositionBgm[]
  bgmEnabled: boolean
  totalDuration: number
  pixelsPerSecond: number
  timelineWidth: number
  selectedBgmIdx: number | null
  onClick: () => void
  onBgmSelect: (idx: number | null) => void
  onBgmTimeChange?: (idx: number, field: 'start_time' | 'end_time', value: number) => void
  readOnly: boolean
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const dragRef = useRef<BgmDragState | null>(null)
  const hasDraggedRef = useRef(false)
  const [hoverCursor, setHoverCursor] = useState<string>('pointer')

  const getSegmentAtX = useCallback(
    (clientX: number): { segment: CompositionBgm; edge: 'left' | 'right' | 'body' } | null => {
      const canvas = canvasRef.current
      if (!canvas || totalDuration <= 0) return null
      const rect = canvas.getBoundingClientRect()
      const x = clientX - rect.left
      const time = x / pixelsPerSecond

      for (const segment of bgm) {
        const segLeft = segment.start_time * pixelsPerSecond
        const segRight = Math.min(segment.end_time, totalDuration) * pixelsPerSecond
        const widthPx = segRight - segLeft
        if (time >= segment.start_time && time < segment.end_time) {
          const edgeThreshold = Math.max(8, Math.min(widthPx * 0.35, 24))
          if (x - segLeft < edgeThreshold) return { segment, edge: 'left' }
          if (segRight - x < edgeThreshold) return { segment, edge: 'right' }
          return { segment, edge: 'body' }
        }
      }
      return null
    },
    [bgm, totalDuration, pixelsPerSecond]
  )

  const handlePointerMove = useCallback(
    (e: PointerEvent) => {
      if (!dragRef.current) return
      e.preventDefault()
      hasDraggedRef.current = true
      const drag = dragRef.current
      const canvas = canvasRef.current
      if (!canvas) return
      const rect = canvas.getBoundingClientRect()
      const x = e.clientX - rect.left
      const deltaTime = (x - drag.startX) / pixelsPerSecond
      const otherBgm = bgm.filter(b => b.idx !== drag.idx)

      if (drag.type === 'move') {
        const duration = drag.initialEnd - drag.initialStart
        let newStart = drag.initialStart + deltaTime
        let newEnd = drag.initialEnd + deltaTime

        // Prevent overlap with other BGM segments
        const leftBound = Math.max(
          0,
          ...otherBgm.filter(b => b.end_time <= drag.initialStart).map(b => b.end_time)
        )
        const rightBound = Math.min(
          totalDuration,
          ...otherBgm.filter(b => b.start_time >= drag.initialEnd).map(b => b.start_time)
        )

        if (newStart < leftBound) {
          newStart = leftBound
          newEnd = leftBound + duration
        } else if (newEnd > rightBound) {
          newEnd = rightBound
          newStart = rightBound - duration
        }

        onBgmTimeChange?.(drag.idx, 'start_time', roundToTenth(Math.max(0, newStart)))
        onBgmTimeChange?.(drag.idx, 'end_time', roundToTenth(Math.max(newStart + 0.5, newEnd)))
      } else if (drag.type === 'resize-start') {
        const leftBound = Math.max(
          0,
          ...otherBgm.filter(b => b.end_time <= drag.initialEnd).map(b => b.end_time)
        )
        const newStart = Math.max(
          leftBound,
          Math.min(drag.initialEnd - 0.5, drag.initialStart + deltaTime)
        )
        onBgmTimeChange?.(drag.idx, 'start_time', roundToTenth(newStart))
      } else if (drag.type === 'resize-end') {
        const rightBound = Math.min(
          totalDuration,
          ...otherBgm.filter(b => b.start_time >= drag.initialStart).map(b => b.start_time)
        )
        const newEnd = Math.min(
          rightBound,
          Math.max(drag.initialStart + 0.5, drag.initialEnd + deltaTime)
        )
        onBgmTimeChange?.(drag.idx, 'end_time', roundToTenth(newEnd))
      }
    },
    [onBgmTimeChange, pixelsPerSecond, bgm, totalDuration]
  )

  const handlePointerUp = useCallback(() => {
    const wasMove = dragRef.current?.type === 'move'
    dragRef.current = null
    setHoverCursor(wasMove ? 'grab' : 'pointer')
    window.removeEventListener('pointermove', handlePointerMove)
    window.removeEventListener('pointerup', handlePointerUp)
    setTimeout(() => {
      hasDraggedRef.current = false
    }, 50)
  }, [handlePointerMove])

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => {
      if (readOnly || !onBgmTimeChange) return
      const hit = getSegmentAtX(e.clientX)
      if (!hit) return

      e.preventDefault()
      e.stopPropagation()

      dragRef.current = {
        idx: hit.segment.idx,
        type: hit.edge === 'body' ? 'move' : hit.edge === 'left' ? 'resize-start' : 'resize-end',
        startX: e.clientX - (canvasRef.current?.getBoundingClientRect().left ?? 0),
        initialStart: hit.segment.start_time,
        initialEnd: hit.segment.end_time,
      }

      if (hit.edge === 'body') setHoverCursor('grabbing')
      else setHoverCursor('ew-resize')

      window.addEventListener('pointermove', handlePointerMove)
      window.addEventListener('pointerup', handlePointerUp)
    },
    [getSegmentAtX, handlePointerMove, handlePointerUp, onBgmTimeChange, readOnly]
  )

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = window.devicePixelRatio || 1
    const width = timelineWidth
    const height = AUDIO_TRACK_HEIGHT
    canvas.width = Math.max(1, Math.ceil(width * dpr))
    canvas.height = Math.max(1, Math.ceil(height * dpr))
    canvas.style.width = `${width}px`
    canvas.style.height = `${height}px`

    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, canvas.width, canvas.height)

    if (totalDuration <= 0) return

    const barWidth = 2
    const barGap = 3
    const step = barWidth + barGap
    const barCount = Math.max(1, Math.floor(width / step))

    // Draw waveform bars only (no background fills or borders)
    for (let i = 0; i < barCount; i++) {
      const x = i * step
      const time = x / pixelsPerSecond

      const activeSegment = bgm.find(
        segment =>
          (segment.status === 'success' || (!segment.status && segment.audio_url)) &&
          time >= segment.start_time &&
          time < segment.end_time
      )

      const isActive = activeSegment != null && bgmEnabled
      if (!isActive) continue

      const segmentStartX = activeSegment.start_time * pixelsPerSecond
      const relativeI = i - Math.floor(segmentStartX / step)
      const amplitude = getPseudoAmplitude(relativeI, activeSegment.idx)
      const fraction = amplitude
      const barH = Math.max(1, fraction * height * 0.6)

      const barLeft = Math.round(x * dpr)
      const deviceBarW = Math.max(1, Math.round(barWidth * dpr))
      const deviceTop = Math.round(((height - barH) / 2) * dpr)
      const deviceHeight = Math.max(1, Math.round(barH * dpr))

      ctx.fillStyle = '#5AC18A'
      const radius = Math.min(deviceBarW / 2, deviceHeight / 2)
      ctx.beginPath()
      ctx.roundRect(barLeft, deviceTop, deviceBarW, deviceHeight, radius)
      ctx.fill()
    }
  }, [bgm, bgmEnabled, totalDuration, pixelsPerSecond, timelineWidth])

  const handleHoverMove = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => {
      if (dragRef.current || readOnly || !onBgmTimeChange) return
      const hit = getSegmentAtX(e.clientX)
      if (hit) {
        if (hit.edge === 'body') setHoverCursor('grab')
        else setHoverCursor('ew-resize')
      } else {
        setHoverCursor('pointer')
      }
    },
    [getSegmentAtX, onBgmTimeChange, readOnly]
  )

  const handleHoverLeave = useCallback(() => {
    setHoverCursor('pointer')
  }, [])

  return (
    <button
      type="button"
      data-timeline-selectable="bgm"
      className="relative h-full w-full overflow-hidden rounded-lg bg-surface text-left"
      style={{ cursor: hoverCursor }}
      onClick={e => {
        if (!hasDraggedRef.current) {
          const hit = getSegmentAtX(e.clientX)
          if (hit) {
            onBgmSelect(hit.segment.idx)
          } else {
            onBgmSelect(null)
          }
          onClick()
        }
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handleHoverMove}
      onPointerLeave={handleHoverLeave}
    >
      {/* Segment background blocks */}
      <div className="absolute inset-0">
        {bgm.map(segment => {
          const isSuccess = segment.status === 'success' || (!segment.status && segment.audio_url)
          const isSelected = selectedBgmIdx === segment.idx
          const leftPx = segment.start_time * pixelsPerSecond
          const widthPx =
            (Math.min(segment.end_time, totalDuration) - segment.start_time) * pixelsPerSecond
          return (
            <div
              key={`bg-${segment.idx}`}
              className={`absolute inset-y-0 rounded-sm ${
                isSelected
                  ? 'border border-[rgb(var(--color-primary))] shadow-[0_0_0_1px_rgb(var(--color-primary))]'
                  : ''
              }`}
              style={{
                left: `${leftPx}px`,
                width: `${Math.max(widthPx, 0)}px`,
                backgroundColor: isSuccess && bgmEnabled ? '#5AC18A1A' : 'transparent',
              }}
            />
          )
        })}
      </div>
      <canvas ref={canvasRef} className="absolute inset-0" />
    </button>
  )
}

// --- Main Timeline ---
export function ClipTimeline({
  clips,
  clipCoverUrlMap,
  clipVideoUrlMap,
  clipDurationMap,
  finalVideoCoverPreviewUrl,
  subtitles,
  selectedClipIndex,
  selectedSubtitleId: selectedSubtitleIdProp,
  subtitlesVisible = true,
  bgm = [],
  bgmEnabled = true,
  currentTime = 0,
  onSelectClip,
  onTrimClip,
  onOpenCoverPicker,
  onDeleteCover,
  onMusicClick,
  onSubtitleClick,
  onSubtitleSelect,
  onSeekTimeline,
  onBgmTimeChange,
  selectedBgmIdx: selectedBgmIdxProp,
  onBgmSelect: onBgmSelectProp,
  onSubtitleTimeChange,
  onUndo,
  onRedo,
  canUndo = false,
  canRedo = false,
  readOnly = false,
}: ClipTimelineProps) {
  const [zoomPosition, setZoomPosition] = useState(TIMELINE_FIT_ZOOM_POSITION)
  const [isDeleteCoverDialogOpen, setIsDeleteCoverDialogOpen] = useState(false)
  const [isCoverHovered, setIsCoverHovered] = useState(false)
  const [tracksViewportWidth, setTracksViewportWidth] = useState(0)
  const [tracksScrollLeft, setTracksScrollLeft] = useState(0)
  const tracksScrollRef = useRef<HTMLDivElement | null>(null)
  const [selectedSubtitleId, setSelectedSubtitleId] = useState<string | null>(
    selectedSubtitleIdProp ?? null
  )
  const [selectedBgmIdx, setSelectedBgmIdx] = useState<number | null>(selectedBgmIdxProp ?? null)

  // Sync internal subtitle selection from external prop
  useEffect(() => {
    setSelectedSubtitleId(selectedSubtitleIdProp ?? null)
  }, [selectedSubtitleIdProp])

  // Sync internal BGM selection from external prop
  useEffect(() => {
    setSelectedBgmIdx(selectedBgmIdxProp ?? null)
  }, [selectedBgmIdxProp])

  const totalDuration = useMemo(
    () => computeTotalTimelineDuration(clips, clipDurationMap),
    [clips, clipDurationMap]
  )

  useEffect(() => {
    const node = tracksScrollRef.current
    if (!node) return

    const updateWidth = () => setTracksViewportWidth(node.clientWidth)
    updateWidth()

    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(updateWidth)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  const fitPixelsPerSecond = useMemo(
    () => getFitPixelsPerSecond(totalDuration, tracksViewportWidth),
    [totalDuration, tracksViewportWidth]
  )
  const pixelsPerSecond = useMemo(
    () => getPixelsPerSecondFromZoomPosition(zoomPosition, fitPixelsPerSecond),
    [fitPixelsPerSecond, zoomPosition]
  )

  const handleSetPixelsPerSecond = useCallback(
    (nextPixelsPerSecond: number) => {
      setZoomPosition(getZoomPositionFromPixelsPerSecond(nextPixelsPerSecond, fitPixelsPerSecond))
    },
    [fitPixelsPerSecond]
  )

  const timelineWidth = Math.max(
    tracksViewportWidth || 0,
    totalDuration * pixelsPerSecond + TIMELINE_END_PADDING + TIMELINE_START_OFFSET
  )
  const minBlockWidth =
    zoomPosition <= TIMELINE_FIT_ZOOM_POSITION ? FIT_MODE_MIN_BLOCK_WIDTH : MIN_CLIP_WIDTH
  const scrollbarViewportWidth = Math.max(tracksViewportWidth, 1)
  const timelineHasHorizontalOverflow = timelineWidth > scrollbarViewportWidth + 1
  const timelineScrollableWidth = Math.max(timelineWidth - scrollbarViewportWidth, 0)
  const scrollbarThumbWidth = timelineHasHorizontalOverflow
    ? Math.min(
        scrollbarViewportWidth,
        Math.max(36, (scrollbarViewportWidth / timelineWidth) * scrollbarViewportWidth)
      )
    : scrollbarViewportWidth
  const scrollbarMaxThumbLeft = Math.max(scrollbarViewportWidth - scrollbarThumbWidth, 0)
  const scrollbarThumbLeft =
    timelineScrollableWidth > 0
      ? (clamp(tracksScrollLeft, 0, timelineScrollableWidth) / timelineScrollableWidth) *
        scrollbarMaxThumbLeft
      : 0

  useEffect(() => {
    const container = tracksScrollRef.current
    if (!container) return

    const nextScrollLeft = clamp(container.scrollLeft, 0, timelineScrollableWidth)
    if (container.scrollLeft !== nextScrollLeft) {
      container.scrollLeft = nextScrollLeft
    }
    setTracksScrollLeft(nextScrollLeft)
  }, [timelineScrollableWidth])

  const setTimelineScrollLeft = useCallback(
    (nextScrollLeft: number) => {
      const clampedScrollLeft = clamp(nextScrollLeft, 0, timelineScrollableWidth)
      if (tracksScrollRef.current) {
        tracksScrollRef.current.scrollLeft = clampedScrollLeft
      }
      setTracksScrollLeft(clampedScrollLeft)
    },
    [timelineScrollableWidth]
  )

  const handleTimelineScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    setTracksScrollLeft(event.currentTarget.scrollLeft)
  }, [])

  const handleHorizontalScrollbarPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!timelineHasHorizontalOverflow || scrollbarMaxThumbLeft <= 0) return

      event.preventDefault()
      event.stopPropagation()

      const trackRect = event.currentTarget.getBoundingClientRect()
      const pointerX = getFiniteClientX(event)
      const thumbOffset =
        pointerX >= trackRect.left + scrollbarThumbLeft &&
        pointerX <= trackRect.left + scrollbarThumbLeft + scrollbarThumbWidth
          ? pointerX - trackRect.left - scrollbarThumbLeft
          : scrollbarThumbWidth / 2

      const updateScrollFromPointer = (clientX: number) => {
        const nextThumbLeft = clamp(
          clientX - trackRect.left - thumbOffset,
          0,
          scrollbarMaxThumbLeft
        )
        setTimelineScrollLeft((nextThumbLeft / scrollbarMaxThumbLeft) * timelineScrollableWidth)
      }

      updateScrollFromPointer(pointerX)

      const handlePointerMove = (moveEvent: PointerEvent) => {
        updateScrollFromPointer(getFiniteClientX(moveEvent))
      }

      const handlePointerUp = () => {
        window.removeEventListener('pointermove', handlePointerMove)
        window.removeEventListener('pointerup', handlePointerUp)
      }

      window.addEventListener('pointermove', handlePointerMove)
      window.addEventListener('pointerup', handlePointerUp, { once: true })
    },
    [
      scrollbarMaxThumbLeft,
      scrollbarThumbLeft,
      scrollbarThumbWidth,
      setTimelineScrollLeft,
      timelineHasHorizontalOverflow,
      timelineScrollableWidth,
    ]
  )

  const handleTrackSeek = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (event.target !== event.currentTarget) return
      // Deselect everything when clicking empty track space
      setSelectedSubtitleId(null)
      onSubtitleSelect?.(null)
      setSelectedBgmIdx(null)
      onBgmSelectProp?.(null)
      onSelectClip(null)
      if (onSeekTimeline) {
        const rect = event.currentTarget.getBoundingClientRect()
        const nextTime = clamp((event.clientX - rect.left) / pixelsPerSecond, 0, totalDuration)
        onSeekTimeline(nextTime)
      }
    },
    [
      onSeekTimeline,
      pixelsPerSecond,
      totalDuration,
      setSelectedSubtitleId,
      onSubtitleSelect,
      setSelectedBgmIdx,
      onBgmSelectProp,
      onSelectClip,
    ]
  )

  // Playhead drag: pointer down on playhead initiates drag-to-seek
  const handlePlayheadPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!onSeekTimeline) return
      event.preventDefault()
      event.stopPropagation()

      const scrollContainer = tracksScrollRef.current

      const getTimeFromPointer = (clientX: number) => {
        const scrollLeft = scrollContainer?.scrollLeft ?? 0
        const x =
          clientX -
          (scrollContainer?.getBoundingClientRect().left ?? 0) +
          scrollLeft -
          TIMELINE_START_OFFSET
        return clamp(x / pixelsPerSecond, 0, totalDuration)
      }

      // Seek immediately on pointer down
      onSeekTimeline(getTimeFromPointer(event.clientX))

      const handlePointerMove = (moveEvent: PointerEvent) => {
        onSeekTimeline(getTimeFromPointer(moveEvent.clientX))
      }

      const handlePointerUp = () => {
        window.removeEventListener('pointermove', handlePointerMove)
        window.removeEventListener('pointerup', handlePointerUp)
      }

      window.addEventListener('pointermove', handlePointerMove)
      window.addEventListener('pointerup', handlePointerUp, { once: true })
    },
    [onSeekTimeline, pixelsPerSecond, totalDuration]
  )

  const playheadLeft =
    clamp(currentTime, 0, totalDuration) * pixelsPerSecond + TIMELINE_START_OFFSET

  // Auto-scroll to keep the playhead visible during playback
  useEffect(() => {
    const container = tracksScrollRef.current
    if (!container) return

    const viewportWidth = container.clientWidth
    const scrollLeft = container.scrollLeft
    const playheadScreenX = playheadLeft - scrollLeft

    const leftMargin = viewportWidth * 0.2
    const rightMargin = viewportWidth * 0.8

    // jsdom does not implement Element.scrollTo; guard so tests/SSR don't throw.
    if (typeof container.scrollTo !== 'function') return

    if (playheadScreenX < leftMargin) {
      // Scroll so playhead lands exactly at TIMELINE_START_OFFSET from the left edge
      const targetScroll = playheadLeft - TIMELINE_START_OFFSET
      container.scrollTo({ left: Math.max(0, targetScroll), behavior: 'smooth' })
    } else if (playheadScreenX > rightMargin) {
      // Scroll so playhead lands at ~30% from the left edge
      const targetScroll = playheadLeft - viewportWidth * 0.3
      container.scrollTo({ left: Math.max(0, targetScroll), behavior: 'smooth' })
    }
  }, [playheadLeft])

  return (
    <div className="w-full min-w-0 max-w-full h-full flex-shrink-0 overflow-hidden flex flex-col">
      <div className="flex flex-shrink-0 items-center justify-between gap-3 pl-5">
        <div className="flex items-center gap-[30px]">
          {!readOnly && (
            <>
              <button
                type="button"
                className="flex h-5 w-5 items-center justify-center rounded-md text-text-primary transition-colors hover:bg-[#f5f5f7] hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-30"
                onClick={onUndo}
                disabled={!canUndo}
                title="撤销 (Ctrl+Z)"
              >
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 20 20"
                  fill="none"
                  xmlns="http://www.w3.org/2000/svg"
                >
                  <path
                    d="M4.2041 6.99951H11.7041C14.4655 6.99951 16.7041 9.23809 16.7041 11.9995C16.7041 14.7609 14.4655 16.9995 11.7041 16.9995H6.12718"
                    stroke="#333333"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                  />
                  <path
                    d="M7.29736 3.00049L3.76877 6.52908C3.50842 6.78943 3.50842 7.21154 3.76877 7.47189L7.29736 11.0005"
                    stroke="#333333"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
              <button
                type="button"
                className="flex h-5 w-5 items-center justify-center rounded-md text-text-primary transition-colors hover:bg-[#f5f5f7] hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-30"
                onClick={onRedo}
                disabled={!canRedo}
                title="重做 (Ctrl+Y)"
              >
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 20 20"
                  fill="none"
                  xmlns="http://www.w3.org/2000/svg"
                >
                  <path
                    d="M15.7959 6.99951H8.2959C5.53447 6.99951 3.2959 9.23809 3.2959 11.9995C3.2959 14.7609 5.53448 16.9995 8.2959 16.9995H13.8728"
                    stroke="#333333"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                  />
                  <path
                    d="M12.7026 3.00049L16.2312 6.52908C16.4916 6.78943 16.4916 7.21154 16.2312 7.47189L12.7026 11.0005"
                    stroke="#333333"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            </>
          )}
        </div>

        <div
          data-testid="timeline-top-zoom-controls"
          className="flex h-[50px] w-[170px] items-center gap-2 rounded-md bg-white text-text-muted mr-6"
        >
          <button
            type="button"
            className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-[#f2f2f2] text-text-primary transition-colors hover:bg-[#e5e5e5]"
            onClick={() => handleSetPixelsPerSecond(pixelsPerSecond / TIMELINE_ZOOM_BUTTON_RATIO)}
            title="缩小时间线"
          >
            <Minus className="h-3 w-3 text-text-primary" />
            <span className="sr-only">缩小</span>
          </button>
          <CompactSlider
            className="w-28"
            value={[zoomPosition]}
            onValueChange={values => setZoomPosition(clamp(values[0], 0, 1))}
            min={0}
            max={1}
            step={0.01}
            trackClassName="bg-[#e5e5e5] h-[2px]"
            rangeClassName="bg-[#666]"
            thumbClassName="border-none bg-[#666] h-2 w-2"
          />
          <button
            type="button"
            className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-[#f2f2f2] text-text-primary transition-colors hover:bg-[#e5e5e5]"
            onClick={() => handleSetPixelsPerSecond(pixelsPerSecond * TIMELINE_ZOOM_BUTTON_RATIO)}
            title="放大时间线"
          >
            <Plus className="h-3 w-3 text-text-primary" />
            <span className="sr-only">放大</span>
          </button>
        </div>
      </div>
      <section
        className="w-full min-w-0 max-w-full flex-1 overflow-hidden rounded-sm border-x border-t border-border bg-surface flex flex-col"
        aria-label="Timeline"
      >
        <TooltipProvider delayDuration={300}>
          <div className="relative flex min-w-0 max-w-full overflow-hidden flex-1">
            <div
              className="flex-shrink-0 self-stretch border-r border-border bg-surface"
              style={{ width: TRACK_LABEL_WIDTH }}
            >
              <div
                className="relative border-b border-border flex items-center justify-center"
                style={{ height: RULER_HEIGHT }}
              />
              <Tooltip>
                <TooltipTrigger asChild>
                  <div
                    className="relative flex w-full items-center px-5"
                    style={{ height: VIDEO_TRACK_HEIGHT }}
                  >
                    <div className="flex items-center gap-1.5">
                      <IconVideo className="h-4 w-4" />
                      <span
                        className="text-[14px] text-text-primary leading-[18px] whitespace-nowrap"
                        style={{ fontFamily: "'PingFang SC', -apple-system, sans-serif" }}
                      >
                        视频
                      </span>
                    </div>
                  </div>
                </TooltipTrigger>
                <TooltipContent side="right">视频</TooltipContent>
              </Tooltip>
              <div style={{ height: TRACK_GAP }} />
              {/* Dashed separator between 视频 and 字幕 (per design spec) */}
              <div className="h-px w-full border-t border-dashed border-[#E5E8F2]" />
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className="flex w-full items-center px-5 hover:bg-[#f5f5f7]/60 transition-colors"
                    style={{ height: SUBTITLE_TRACK_HEIGHT }}
                    onClick={() => {
                      onSubtitleClick?.()
                    }}
                  >
                    <div className="flex items-center gap-1.5">
                      <IconSubtitle className="h-4 w-4" />
                      <span
                        className="text-[14px] text-text-primary leading-[18px] whitespace-nowrap"
                        style={{ fontFamily: "'PingFang SC', -apple-system, sans-serif" }}
                      >
                        字幕
                      </span>
                    </div>
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right">字幕</TooltipContent>
              </Tooltip>
              <div style={{ height: TRACK_GAP }} />
              {/* Dashed separator between 字幕 and 音频 (per design spec) */}
              <div className="h-px w-full border-t border-dashed border-[#E5E8F2]" />
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className="flex w-full items-center px-5 hover:bg-[#f5f5f7]/60 transition-colors"
                    style={{ height: AUDIO_TRACK_HEIGHT }}
                    onClick={() => {
                      onMusicClick()
                    }}
                  >
                    <div className="flex items-center gap-1.5">
                      <IconAudio className="h-4 w-4" />
                      <span
                        className="text-[14px] text-text-primary leading-[18px] whitespace-nowrap"
                        style={{ fontFamily: "'PingFang SC', -apple-system, sans-serif" }}
                      >
                        音频
                      </span>
                    </div>
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right">音频</TooltipContent>
              </Tooltip>
            </div>

            {/* Cover button column — fixed lane between the label column and the
                scrollable tracks (per design spec). Holds the cover button at the
                design-spec position (8px side margins, vertical offset per h42ktx);
                never overlaps clips since it lives outside the scroll area. */}
            {!readOnly && onOpenCoverPicker && (
              <div className="flex flex-shrink-0 flex-col" style={{ width: COVER_COLUMN_WIDTH }}>
                <div className="border-b border-border" style={{ height: RULER_HEIGHT }} />
                <div className="relative" style={{ height: VIDEO_TRACK_HEIGHT }}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        aria-label={finalVideoCoverPreviewUrl ? '重新选择封面' : '选择封面'}
                        className="absolute left-1/2 flex flex-col items-center justify-center gap-[1px] rounded bg-[#f3f3f3] hover:bg-[#e9e9e9] transition-colors overflow-visible"
                        style={{
                          width: COVER_BUTTON_SIZE,
                          height: COVER_BUTTON_SIZE,
                          top: COVER_BUTTON_TOP_OFFSET,
                          transform: 'translateX(-50%)',
                        }}
                        onClick={() => {
                          onOpenCoverPicker?.()
                        }}
                        onMouseEnter={() => setIsCoverHovered(true)}
                        onMouseLeave={() => setIsCoverHovered(false)}
                      >
                        {finalVideoCoverPreviewUrl ? (
                          <>
                            <img
                              src={finalVideoCoverPreviewUrl}
                              alt="封面缩略图"
                              className="absolute inset-0 h-full w-full object-cover"
                              draggable={false}
                            />
                            {isCoverHovered && onDeleteCover && (
                              <span
                                role="button"
                                className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-black/60 text-white hover:bg-black/80"
                                onClick={e => {
                                  e.stopPropagation()
                                  setIsDeleteCoverDialogOpen(true)
                                }}
                              >
                                <X className="h-3 w-3" />
                              </span>
                            )}
                          </>
                        ) : (
                          <>
                            <PencilEditIcon className="h-4 w-4" />
                            <span
                              className="text-[12px] text-text-primary"
                              style={{ fontFamily: "'PingFang SC', -apple-system, sans-serif" }}
                            >
                              封面
                            </span>
                          </>
                        )}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="right">
                      {finalVideoCoverPreviewUrl ? '重新选择封面' : '选择封面'}
                    </TooltipContent>
                  </Tooltip>
                </div>
                <div style={{ height: TRACK_GAP }} />
                <div className="h-px" />
                <div style={{ height: SUBTITLE_TRACK_HEIGHT }} />
                <div style={{ height: TRACK_GAP }} />
                <div className="h-px" />
                <div style={{ height: AUDIO_TRACK_HEIGHT }} />
              </div>
            )}

            <AlertDialog open={isDeleteCoverDialogOpen} onOpenChange={setIsDeleteCoverDialogOpen}>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>删除封面</AlertDialogTitle>
                  <AlertDialogDescription>
                    确定要删除当前设置的封面吗？删除后可以重新选择。
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>取消</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={() => {
                      setIsDeleteCoverDialogOpen(false)
                      onDeleteCover?.()
                    }}
                  >
                    删除
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>

            <div
              ref={tracksScrollRef}
              data-testid="timeline-tracks-scroll-viewport"
              className="w-0 min-w-0 flex-1 overflow-x-auto overflow-y-hidden overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
              onScroll={handleTimelineScroll}
            >
              <div
                className="relative min-h-full isolate"
                style={{ width: timelineWidth, paddingLeft: TIMELINE_START_OFFSET }}
              >
                <TimeRuler
                  totalDuration={totalDuration}
                  pixelsPerSecond={pixelsPerSecond}
                  timelineWidth={timelineWidth}
                  onSeek={onSeekTimeline}
                />

                <div
                  className="relative"
                  style={{ height: VIDEO_TRACK_HEIGHT }}
                  onMouseDown={handleTrackSeek}
                >
                  <div className="flex h-full items-center">
                    {clips.map((clip, index) => (
                      <SortableClipBlock
                        key={`clip-${clip.clip_id}`}
                        clip={clip}
                        clipIndex={index}
                        coverUrl={clipCoverUrlMap[clip.clip_id] ?? ''}
                        videoUrl={clipVideoUrlMap[clip.clip_id] ?? ''}
                        effectiveDuration={getClipTimelineDuration(clip, clipDurationMap)}
                        originalDuration={getClipSourceDuration(clip, clipDurationMap)}
                        isSelected={
                          selectedClipIndex === index &&
                          selectedSubtitleId === null &&
                          selectedBgmIdx === null
                        }
                        onSelect={() => {
                          setSelectedSubtitleId(null)
                          onSubtitleSelect?.(null)
                          setSelectedBgmIdx(null)
                          onSelectClip(index)
                        }}
                        onTrimChange={(trimStart, trimEnd) => onTrimClip(index, trimStart, trimEnd)}
                        pixelsPerSecond={pixelsPerSecond}
                        minBlockWidth={minBlockWidth}
                        readOnly={readOnly}
                      />
                    ))}
                  </div>
                </div>

                <div style={{ height: TRACK_GAP }} />
                <div className="h-px w-full border-t border-dashed border-[#E5E8F2]" />

                <div
                  className="relative"
                  style={{ height: SUBTITLE_TRACK_HEIGHT }}
                  onMouseDown={handleTrackSeek}
                >
                  <SubtitleTrack
                    subtitles={subtitles}
                    totalDuration={totalDuration}
                    pixelsPerSecond={pixelsPerSecond}
                    minBlockWidth={minBlockWidth}
                    selectedSubtitleId={selectedSubtitleId}
                    subtitlesVisible={subtitlesVisible}
                    clips={clips}
                    clipDurationMap={clipDurationMap}
                    onSelectSubtitle={(id: string) => {
                      setSelectedBgmIdx(null)
                      onSelectClip(null)
                      setSelectedSubtitleId(id)
                      onSubtitleSelect?.(id)
                    }}
                    onSubtitleClick={onSubtitleClick}
                    onSubtitleTimeChange={onSubtitleTimeChange}
                    onEmptyClick={() => {
                      setSelectedSubtitleId(null)
                      onSubtitleSelect?.(null)
                      setSelectedBgmIdx(null)
                      onBgmSelectProp?.(null)
                      onSelectClip(null)
                    }}
                    readOnly={readOnly}
                  />
                </div>

                <div style={{ height: TRACK_GAP }} />
                <div className="h-px w-full border-t border-dashed border-[#E5E8F2]" />

                <div
                  className="relative"
                  style={{ height: AUDIO_TRACK_HEIGHT }}
                  onMouseDown={handleTrackSeek}
                >
                  <AudioWaveformTrack
                    bgm={bgm}
                    bgmEnabled={bgmEnabled}
                    totalDuration={totalDuration}
                    pixelsPerSecond={pixelsPerSecond}
                    timelineWidth={timelineWidth}
                    selectedBgmIdx={selectedBgmIdx}
                    onClick={onMusicClick}
                    onBgmSelect={(idx: number | null) => {
                      setSelectedSubtitleId(null)
                      onSubtitleSelect?.(null)
                      onSelectClip(null)
                      setSelectedBgmIdx(idx)
                      onBgmSelectProp?.(idx)
                    }}
                    onBgmTimeChange={onBgmTimeChange}
                    readOnly={readOnly}
                  />
                </div>

                {/* Playhead - rendered last so it's always on top */}
                {totalDuration > 0 && (
                  <div
                    className="absolute bottom-0 top-0 z-[9999] cursor-ew-resize touch-none"
                    style={{ left: playheadLeft, width: '1px' }}
                    onPointerDown={handlePlayheadPointerDown}
                  >
                    <div className="absolute bottom-0 left-1/2 top-0 w-[2px] -translate-x-1/2 bg-[#FF8200]" />
                    <div className="absolute -top-[0px] left-1/2 -translate-x-1/2">
                      <svg width="11" height="16" viewBox="0 0 11 20" fill="none">
                        <line x1="5.5" y1="17" x2="5.5" y2="20" stroke="#FF8200" strokeWidth="2" />
                        <path
                          d="M 2 1 L 9 1 Q 10 1 10 2 L 10 12 L 5.5 17 L 1 12 L 1 2 Q 1 1 2 1 Z"
                          fill="white"
                          stroke="#FF8200"
                          strokeWidth="2"
                        />
                      </svg>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
          {timelineHasHorizontalOverflow && (
            <div className="flex border-t border-border bg-surface">
              <div
                className="flex-shrink-0 border-r border-border"
                style={{ width: TRACK_LABEL_WIDTH }}
              />
              {!readOnly && onOpenCoverPicker && (
                <div
                  className="flex-shrink-0 border-r border-border"
                  style={{ width: COVER_COLUMN_WIDTH }}
                />
              )}
              <div className="min-w-0 flex-1 px-2 py-1">
                <div
                  data-testid="timeline-horizontal-scrollbar"
                  role="scrollbar"
                  aria-orientation="horizontal"
                  aria-valuemin={0}
                  aria-valuemax={Math.round(timelineScrollableWidth)}
                  aria-valuenow={Math.round(clamp(tracksScrollLeft, 0, timelineScrollableWidth))}
                  className="relative h-2 cursor-ew-resize rounded-full bg-[#f5f5f7]"
                  onPointerDown={handleHorizontalScrollbarPointerDown}
                >
                  <div
                    data-testid="timeline-horizontal-scrollbar-thumb"
                    className="absolute top-0 h-full rounded-full bg-border-strong transition-colors hover:bg-text-muted"
                    style={{
                      width: `${scrollbarThumbWidth}px`,
                      transform: `translateX(${scrollbarThumbLeft}px)`,
                    }}
                  />
                </div>
              </div>
            </div>
          )}
        </TooltipProvider>
      </section>
    </div>
  )
}
