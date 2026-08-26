// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, X } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Slider } from '@/components/ui/slider'
import type { FinalVideoCover } from '../script/types'
import type { CompositionClip } from './types'
import { VideoFilmstripSelector } from './VideoFilmstrip'
import { getClipSourceDuration } from './utils'

interface FinalCoverPickerDialogProps {
  open: boolean
  clips: CompositionClip[]
  clipCoverUrlMap: Record<number, string>
  clipVideoUrlMap: Record<number, string>
  clipDurationMap: Record<number, number>
  finalVideoCover?: FinalVideoCover | null
  localPreviewUrl?: string | null
  isSubmitting?: boolean
  ratio?: string
  onOpenChange: (open: boolean) => void
  onConfirm: (selection: {
    clip_id: number
    cover_time_in_source: number
    local_preview_url?: string
  }) => Promise<void>
}

function roundCoverTime(value: number): number {
  return Math.round(value * 1000) / 1000
}

export function FinalCoverPickerDialog({
  open,
  clips,
  clipCoverUrlMap,
  clipVideoUrlMap,
  clipDurationMap,
  finalVideoCover,
  localPreviewUrl = null,
  isSubmitting = false,
  ratio = '16:9',
  onOpenChange,
  onConfirm,
}: FinalCoverPickerDialogProps) {
  const [selectedClipId, setSelectedClipId] = useState<number | null>(
    finalVideoCover?.clip_id ?? null
  )
  const [selectedTime, setSelectedTime] = useState<number | null>(
    finalVideoCover?.cover_time_in_source ?? null
  )
  const [selectedPreviewUrl, setSelectedPreviewUrl] = useState<string>(
    localPreviewUrl ?? finalVideoCover?.cover_url ?? ''
  )
  const [zoom, setZoom] = useState(1)
  const previewVideoRef = useRef<HTMLVideoElement>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)

  const MIN_ZOOM = 1
  const MAX_ZOOM = 2
  const ZOOM_STEP = 0.5
  const BASE_CLIP_WIDTH = 480
  const clipWidth = BASE_CLIP_WIDTH * zoom

  const selectedClipVideoUrl = selectedClipId != null ? (clipVideoUrlMap[selectedClipId] ?? '') : ''

  const prevOpenRef = useRef(open)
  useEffect(() => {
    if (!open) {
      prevOpenRef.current = false
      return
    }
    // Only reset selection when the dialog freshly opens, not when
    // finalVideoCover is updated by the parent after the user confirms.
    if (prevOpenRef.current) return
    prevOpenRef.current = true
    setSelectedClipId(finalVideoCover?.clip_id ?? null)
    setSelectedTime(finalVideoCover?.cover_time_in_source ?? null)
    setSelectedPreviewUrl(localPreviewUrl ?? finalVideoCover?.cover_url ?? '')
  }, [finalVideoCover, localPreviewUrl, open])

  // When the dialog opens with no prior cover selection, default the preview
  // to the first clip's cover image so the preview area isn't empty.
  useEffect(() => {
    if (!open) return
    if (finalVideoCover?.clip_id != null || localPreviewUrl) return
    const firstClip = clips[0]
    if (!firstClip) return
    const firstCoverUrl = clipCoverUrlMap[firstClip.clip_id]
    if (!firstCoverUrl) return
    setSelectedPreviewUrl(prev => prev || firstCoverUrl)
  }, [open, clips, clipCoverUrlMap, finalVideoCover, localPreviewUrl])

  // Auto-scroll to the cover clip when the dialog opens.
  useEffect(() => {
    if (!open || selectedClipId == null) return
    const container = scrollContainerRef.current
    if (!container) return
    // Wait for the browser to lay out the timeline.
    const raf = requestAnimationFrame(() => {
      const target = container.querySelector<HTMLElement>(
        `[data-cover-clip-id="${selectedClipId}"]`
      )
      if (target) {
        target.scrollIntoView({ inline: 'center', behavior: 'instant' })
      }
    })
    return () => cancelAnimationFrame(raf)
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  // Seek the preview video when selectedTime changes (same clip, different frame)
  useEffect(() => {
    const video = previewVideoRef.current
    if (!video || selectedTime == null) return
    if (video.readyState >= 2 && Math.abs(video.currentTime - selectedTime) > 0.05) {
      video.currentTime = selectedTime
    }
  }, [selectedTime])

  const handleVideoLoaded = useCallback(() => {
    const video = previewVideoRef.current
    if (video && selectedTime != null) {
      video.currentTime = selectedTime
    }
  }, [selectedTime])

  const handleVideoSeeked = useCallback((e: React.SyntheticEvent<HTMLVideoElement>) => {
    ;(e.target as HTMLVideoElement).pause()
  }, [])

  const hasSelection = selectedClipId != null && selectedTime != null

  // When the current selection matches the saved cover, show the saved cover image
  // directly instead of loading the video — this gives instant feedback on open.
  const isShowingSavedCover =
    hasSelection &&
    finalVideoCover?.clip_id === selectedClipId &&
    finalVideoCover.cover_time_in_source === selectedTime &&
    !!finalVideoCover.cover_url

  const showVideoPreview = hasSelection && !!selectedClipVideoUrl && !isShowingSavedCover

  const previewImageUrl = useMemo(() => {
    if (!selectedClipId) {
      return selectedPreviewUrl || finalVideoCover?.cover_url || ''
    }

    if (isShowingSavedCover) {
      return selectedPreviewUrl || finalVideoCover.cover_url || ''
    }

    return selectedPreviewUrl || clipCoverUrlMap[selectedClipId] || finalVideoCover?.cover_url || ''
  }, [
    clipCoverUrlMap,
    finalVideoCover,
    selectedClipId,
    selectedPreviewUrl,
    selectedTime,
    isShowingSavedCover,
  ])

  // Design spec: the preview box is a fixed 738x415 horizontal frame regardless
  // of video ratio (the design uses image fill mode "stretch"). For vertical
  // video the media is centered inside that frame at the box height; for
  // horizontal video the media fills the whole box.
  const isVertical = ratio === '9:16'
  const innerMediaStyle: React.CSSProperties = isVertical
    ? { height: '415px', width: 'auto' }
    : { width: '738px', height: '415px' }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="!fixed left-[50%] top-[50%] z-[2147483646] flex flex-col gap-0 overflow-hidden rounded-[12px] border-0 bg-white p-0 text-[#333333] shadow-[0_4px_8.75px_0_rgba(182,182,182,0.25)]"
        hideCloseButton
        style={{ width: '1000px', height: '700px', maxWidth: 'none' }}
      >
        <DialogHeader className="relative flex-shrink-0 h-[54px] flex flex-row items-center justify-between px-6 border-b border-[#f2f2f2]">
          <DialogTitle className="text-[15px] font-medium text-[#000000]">封面设计</DialogTitle>
          <button
            type="button"
            aria-label="Close"
            onClick={() => onOpenChange(false)}
            className="inline-flex h-7 w-7 items-center justify-center rounded-sm text-[#939393] transition-opacity hover:text-[#333333] focus:outline-none"
          >
            <X className="h-4 w-4" />
          </button>
        </DialogHeader>

        <div className="flex min-h-0 flex-col bg-white">
          {/* Preview area — fixed 738x415 centered per design spec.
              Design: preview box y=75..490 (21px below header), 20px gap to
              toolbar at y=510 → container height 456. */}
          <div
            className="flex flex-shrink-0 items-center justify-center"
            style={{ paddingTop: '21px', height: '456px' }}
          >
            <div
              data-testid="cover-preview-box"
              className="relative overflow-hidden bg-[#f5f5f5]"
              style={{
                width: '738px',
                height: '415px',
                borderRadius: '10px',
              }}
            >
              <div className="flex h-full w-full items-center justify-center">
                {showVideoPreview ? (
                  <video
                    key={selectedClipId}
                    ref={previewVideoRef}
                    src={selectedClipVideoUrl}
                    poster={clipCoverUrlMap[selectedClipId!] ?? undefined}
                    data-testid="cover-preview-media"
                    className="block"
                    style={{ objectFit: 'contain', ...innerMediaStyle }}
                    muted
                    playsInline
                    preload="auto"
                    onLoadedData={handleVideoLoaded}
                    onSeeked={handleVideoSeeked}
                  />
                ) : previewImageUrl ? (
                  <img
                    src={previewImageUrl}
                    alt="封面预览"
                    data-testid="cover-preview-media"
                    className="block"
                    style={{ objectFit: 'contain', ...innerMediaStyle }}
                    draggable={false}
                  />
                ) : (
                  <div className="text-center text-sm text-[#939393]">点击下方时间轴选择封面</div>
                )}
              </div>
            </div>
          </div>

          {/* Timeline toolbar — design spec: 1px y-offset #f2f2f2 drop shadow
              (no blur) on the bottom edge, mimicking a divider line.
              Design: toolbar y=510..560 (immediately after preview area). */}
          <div
            className="flex-shrink-0 flex items-center justify-end px-5 shadow-[0_1px_0_0_#f2f2f2]"
            style={{ height: '50px' }}
          >
            <div className="flex items-center gap-2.5">
              <button
                type="button"
                className="inline-flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-[#ececec] disabled:opacity-40"
                disabled={zoom <= MIN_ZOOM}
                onClick={() => setZoom(z => Math.max(MIN_ZOOM, Number((z - ZOOM_STEP).toFixed(1))))}
              >
                <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                  <circle cx="10" cy="10" r="10" fill="#ECECEC" />
                  <path d="M6.25 10H13.75" stroke="#333333" strokeWidth="2" strokeLinecap="round" />
                </svg>
              </button>
              <Slider
                value={[zoom]}
                min={MIN_ZOOM}
                max={MAX_ZOOM}
                step={ZOOM_STEP}
                onValueChange={([value]) => setZoom(value)}
                className="w-[110px] [&_[role=slider]]:h-3 [&_[role=slider]]:w-3 [&_[role=slider]]:border-white [&_[role=slider]]:bg-[#636363]"
              />
              <button
                type="button"
                className="inline-flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-[#ececec] disabled:opacity-40"
                disabled={zoom >= MAX_ZOOM}
                onClick={() => setZoom(z => Math.min(MAX_ZOOM, Number((z + ZOOM_STEP).toFixed(1))))}
              >
                <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                  <circle cx="10" cy="10" r="10" fill="#ECECEC" />
                  <path d="M6.25 10H13.75" stroke="#333333" strokeWidth="2" strokeLinecap="round" />
                  <path d="M10 13.75V6.25" stroke="#333333" strokeWidth="2" strokeLinecap="round" />
                </svg>
              </button>
            </div>
          </div>

          {/* Filmstrip — design spec: 960px wide, 48px tall, 26px below toolbar.
              Design: filmstrip y=586..634. */}
          <div className="flex-shrink-0 flex justify-center px-5" style={{ marginTop: '26px' }}>
            <div
              className="overflow-x-auto overflow-y-hidden rounded-lg [&::-webkit-scrollbar]:hidden"
              style={{
                width: '960px',
                height: '48px',
                scrollbarWidth: 'none',
                msOverflowStyle: 'none',
              }}
              ref={scrollContainerRef}
            >
              <div className="inline-flex h-full items-stretch">
                {clips.map((clip, index) => {
                  const sourceDuration = getClipSourceDuration(clip, clipDurationMap)
                  const isSelected = clip.clip_id === selectedClipId
                  const isFirst = index === 0
                  const isLast = index === clips.length - 1

                  return (
                    <div
                      key={clip.clip_id}
                      data-cover-clip-id={clip.clip_id}
                      className={`h-full overflow-hidden transition-colors ${
                        isSelected ? 'border border-[#ff9b42] shadow-[0_0_0_1px_#ff9b42]' : ''
                      } ${isFirst ? 'rounded-l-lg' : ''} ${isLast ? 'rounded-r-lg' : ''}`}
                      style={{ width: clipWidth }}
                    >
                      <VideoFilmstripSelector
                        clipId={clip.clip_id}
                        videoUrl={clipVideoUrlMap[clip.clip_id] ?? ''}
                        posterUrl={clipCoverUrlMap[clip.clip_id] ?? ''}
                        duration={sourceDuration}
                        frameCount={10}
                        squareFrames
                        className="h-full rounded-none border-0 bg-transparent"
                        selectedTime={isSelected ? selectedTime : null}
                        onSelectTime={(time, previewUrl) => {
                          setSelectedClipId(clip.clip_id)
                          setSelectedTime(roundCoverTime(time))
                          if (previewUrl) {
                            setSelectedPreviewUrl(previewUrl)
                          }
                        }}
                        fallback={
                          clipCoverUrlMap[clip.clip_id] ? (
                            <img
                              src={clipCoverUrlMap[clip.clip_id]}
                              alt=""
                              className="h-full w-full object-cover"
                              draggable={false}
                            />
                          ) : (
                            <div className="h-full w-full bg-[#f5f5f5]" />
                          )
                        }
                      />
                    </div>
                  )
                })}
              </div>
            </div>
          </div>

          {/* Footer — cancel + confirm, centered per design spec.
              Design: 18px below filmstrip (filmstrip bottom y=634, buttons
              y=652..684), 16px below buttons to dialog bottom (700). */}
          <div
            className="flex-shrink-0 flex items-center justify-center gap-3 px-6"
            style={{ marginTop: '18px', paddingBottom: '16px' }}
          >
            <button
              type="button"
              className="inline-flex items-center justify-center gap-1 rounded-md border border-[#e1e1e1] bg-white px-3 py-1.5 text-sm font-normal text-[#333333] disabled:opacity-50"
              onClick={() => onOpenChange(false)}
              disabled={isSubmitting}
            >
              取消
            </button>
            <button
              type="button"
              className="inline-flex items-center justify-center gap-1 rounded-md bg-[#ff8200] px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
              onClick={async () => {
                if (!hasSelection || selectedClipId == null || selectedTime == null) return
                await onConfirm({
                  clip_id: selectedClipId,
                  cover_time_in_source: roundCoverTime(selectedTime),
                  local_preview_url: selectedPreviewUrl || undefined,
                })
              }}
              disabled={!hasSelection || isSubmitting}
            >
              {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              设为封面
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
