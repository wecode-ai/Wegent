// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

/**
 * ClipInspector - Right-side tabbed property panel for clip trim, volume, subtitle editing, and BGM control.
 * Uses vertical icon tabs on the right edge to switch between: Clip, Subtitle, BGM.
 */

import React, { useCallback, useEffect, useRef } from 'react'
import { CompactSlider } from '@wecode/features/video/components/CompactSlider'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Trash2, Play, Pause, RotateCw, Loader2 } from 'lucide-react'
import type { CompositionClip, CompositionSubtitle, CompositionBgm } from './types'
import { validateTrim, validateBgmNoOverlap, validateSubtitleNoOverlap } from './utils'
import { TimeInput } from './TimeInput'

export type InspectorTab = 'clip' | 'subtitle' | 'bgm'

interface ClipInspectorProps {
  clip: CompositionClip | null
  clipIndex: number | null
  clips: CompositionClip[]
  clipOriginalDuration: number
  storyboardInfo?: Record<
    number,
    {
      visual?: string
      ff_desc?: string
      shots_prompt?: string
      dialogue?: string
      mood?: string
      camera_notes?: string
    }
  >
  subtitles: CompositionSubtitle[]
  bgm?: CompositionBgm[]
  bgmEnabled?: boolean
  subtitlesVisible: boolean
  subtitleClipIndex: number
  onSubtitleClipChange: (index: number) => void
  onSelectClip: (index: number | null) => void
  activeTab: InspectorTab
  onActiveTabChange: (tab: InspectorTab) => void
  onTrimChange: (trimStart: number, trimEnd: number | null) => void
  onClipVolumeChange: (volume: number) => void
  onClipEnabledChange: (enabled: boolean) => void
  onSubtitleChange: (subtitleId: string, updates: Partial<CompositionSubtitle>) => void
  onSubtitleAdd: () => void
  onSubtitleDelete: (subtitleId: string) => void
  onSubtitlesVisibilityChange: (visible: boolean) => void
  onSubtitleRegenerate?: (storyboardId: number) => void
  regeneratingSubtitleStoryboardIds?: Set<number>
  selectedSubtitleId?: string | null
  onSubtitleFocus?: (subtitleId: string) => void
  onBgmEnabledChange?: (enabled: boolean) => void
  onBgmVolumeChange?: (idx: number, volume: number) => void
  onBgmPromptChange?: (idx: number, prompt: string) => void
  onBgmDelete?: (idx: number) => void
  onBgmAdd?: () => void
  onBgmTimeChange?: (idx: number, field: 'start_time' | 'end_time', value: number) => void
  onBgmRegenerate?: (idx: number) => void
  selectedBgmIdx?: number | null
  onBgmFocus?: (idx: number) => void
  readOnly?: boolean
}

export function ClipInspector({
  clip,
  clipIndex,
  clips,
  clipOriginalDuration,
  storyboardInfo,
  subtitles,
  bgm,
  bgmEnabled = true,
  subtitlesVisible,
  subtitleClipIndex,
  onSubtitleClipChange,
  onSelectClip,
  activeTab,
  onActiveTabChange,
  onTrimChange,
  onClipVolumeChange,
  onClipEnabledChange,
  onSubtitleChange,
  onSubtitleAdd,
  onSubtitleDelete,
  onSubtitlesVisibilityChange,
  onSubtitleRegenerate,
  regeneratingSubtitleStoryboardIds,
  selectedSubtitleId,
  onSubtitleFocus,
  onBgmEnabledChange,
  onBgmVolumeChange,
  onBgmPromptChange,
  onBgmDelete,
  onBgmAdd,
  onBgmTimeChange,
  onBgmRegenerate,
  selectedBgmIdx,
  onBgmFocus,
  readOnly = false,
}: ClipInspectorProps) {
  const previewAudioRef = useRef<HTMLAudioElement | null>(null)
  const [previewingIdx, setPreviewingIdx] = React.useState<number | null>(null)
  const subtitleItemRefs = useRef<Map<string, HTMLDivElement>>(new Map())
  const bgmItemRefs = useRef<Map<number, HTMLDivElement>>(new Map())

  // Auto-scroll the subtitle item matching the timeline selection
  useEffect(() => {
    if (!selectedSubtitleId || activeTab !== 'subtitle') return
    const el = subtitleItemRefs.current.get(selectedSubtitleId)
    if (!el) return
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [selectedSubtitleId, activeTab])

  // Auto-scroll the BGM item matching the timeline selection
  useEffect(() => {
    if (selectedBgmIdx == null || activeTab !== 'bgm') return
    const el = bgmItemRefs.current.get(selectedBgmIdx)
    if (!el) return
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [selectedBgmIdx, activeTab])

  // Preview a single BGM segment
  const handlePreviewBgm = useCallback(
    (segment: CompositionBgm) => {
      const audio = previewAudioRef.current
      if (!audio) {
        const newAudio = new Audio(segment.audio_url)
        newAudio.volume = segment.volume
        previewAudioRef.current = newAudio
        newAudio.play().catch(() => {})
        setPreviewingIdx(segment.idx)
        newAudio.onended = () => setPreviewingIdx(null)
        return
      }

      if (previewingIdx === segment.idx) {
        audio.pause()
        audio.currentTime = 0
        setPreviewingIdx(null)
        return
      }

      audio.pause()
      audio.src = segment.audio_url
      audio.volume = segment.volume
      audio.currentTime = 0
      audio.play().catch(() => {})
      setPreviewingIdx(segment.idx)
      audio.onended = () => setPreviewingIdx(null)
    },
    [previewingIdx]
  )

  const tabs: { key: InspectorTab; label: string }[] = [
    { key: 'clip', label: '分镜' },
    { key: 'subtitle', label: '字幕' },
    { key: 'bgm', label: '音乐' },
  ]

  return (
    <div className="flex h-full flex-col overflow-hidden bg-base">
      <div
        data-testid="composition-inspector-tabs"
        className="flex flex-row items-center gap-[30px] h-[42px] border-b border-border/70 px-4"
      >
        {tabs.map(tab => (
          <button
            key={tab.key}
            className={`relative flex h-[30px] items-center justify-center text-sm font-medium transition-colors ${
              activeTab === tab.key ? 'text-[#FF8200]' : 'text-text-muted hover:text-text-secondary'
            }`}
            onClick={() => onActiveTabChange(tab.key)}
            title={tab.label}
          >
            {tab.label}
            {activeTab === tab.key && (
              <span className="absolute bottom-0 left-1/2 h-[2px] w-6 -translate-x-1/2 rounded-full bg-[#FF8200]" />
            )}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto p-4">
        {/* Clip Settings Tab */}
        {activeTab === 'clip' &&
          (clip ? (
            <div className="space-y-4">
              {/* Enabled toggle - top */}
              <div className="flex items-center justify-between h-[42px]">
                <label
                  className="leading-none"
                  style={{
                    fontSize: '13px',
                    fontWeight: 500,
                    color: '#333333',
                    fontFamily: "'PingFang SC', -apple-system, sans-serif",
                  }}
                >
                  启用片段
                </label>
                <Switch
                  checked={clip.enabled}
                  onCheckedChange={(checked: boolean) => onClipEnabledChange(checked)}
                  disabled={readOnly}
                  className="data-[state=checked]:bg-[#FF8200] focus-visible:ring-[#FF8200]"
                />
              </div>

              {clips.length > 0 && (
                <div
                  data-inspector-card
                  className="flex items-center h-9 rounded-[6px] border border-border bg-white px-4"
                >
                  <Select
                    value={clipIndex != null ? String(clipIndex) : ''}
                    onValueChange={val => onSelectClip(Number(val))}
                  >
                    <SelectTrigger
                      className="flex-1 h-5 text-sm font-normal border-0 shadow-none bg-transparent px-0 hover:bg-transparent focus:ring-0 [&>svg]:opacity-100"
                      style={{ fontFamily: "'PingFang SC', -apple-system, sans-serif" }}
                    >
                      <SelectValue placeholder="选择分镜" />
                    </SelectTrigger>
                    <SelectContent className="z-[2147483641]">
                      {clips.map((c, i) => (
                        <SelectItem key={c.clip_id} value={String(i)}>
                          分镜{i + 1}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              {/* Visual description - standalone card */}
              {(() => {
                const info = storyboardInfo?.[clip.storyboard_id]
                if (!info?.visual) return null
                return (
                  <div
                    data-inspector-card
                    className="rounded-[6px] border border-border bg-muted px-3 py-[10px] h-[90px] overflow-y-auto"
                  >
                    <p
                      className="text-text-primary leading-5"
                      style={{
                        fontSize: '13px',
                        fontFamily: "'PingFang SC', -apple-system, sans-serif",
                      }}
                    >
                      {info.visual}
                    </p>
                  </div>
                )
              })()}

              {/* Trim times + volume - no card wrapper */}
              <div className="space-y-4">
                {/* Trim times row */}
                <div className="flex items-center gap-2">
                  <TimeInput
                    label="开始"
                    value={clip.trim_start}
                    onCommit={seconds => {
                      const newStart = Math.max(
                        0,
                        Math.min(seconds, (clip.trim_end ?? clipOriginalDuration) - 0.5)
                      )
                      onTrimChange(newStart, clip.trim_end)
                    }}
                    disabled={readOnly}
                  />
                  <span className="text-text-muted">—</span>
                  <TimeInput
                    label="结束"
                    value={clip.trim_end ?? clipOriginalDuration}
                    onCommit={seconds => {
                      const newEnd = Math.max(
                        clip.trim_start + 0.5,
                        Math.min(seconds, clipOriginalDuration)
                      )
                      onTrimChange(
                        clip.trim_start,
                        newEnd >= clipOriginalDuration - 0.05 ? null : newEnd
                      )
                    }}
                    disabled={readOnly}
                  />
                </div>

                {!validateTrim(clip, clipOriginalDuration) && (
                  <p className="text-xs text-destructive">裁剪范围无效：有效时长不能低于 0.5 秒</p>
                )}

                {/* Volume */}
                <div className="h-[42px] flex flex-col justify-between">
                  <div className="flex items-center justify-between">
                    <label
                      className="leading-none"
                      style={{
                        fontSize: '13px',
                        fontFamily: "'PingFang SC', -apple-system, sans-serif",
                        color: '#333333',
                      }}
                    >
                      音量
                    </label>
                    <span
                      className="flex items-center justify-center h-5 min-w-[34px] px-1.5 rounded-[3px] bg-[#E6E6E6] text-text-primary"
                      style={{
                        fontSize: '13px',
                        fontFamily: "'PingFang SC', -apple-system, sans-serif",
                      }}
                    >
                      {Math.round(clip.volume * 100)}%
                    </span>
                  </div>
                  <CompactSlider
                    value={[clip.volume]}
                    onValueChange={(values: number[]) => onClipVolumeChange(values[0])}
                    min={0}
                    max={1}
                    step={0.05}
                    disabled={readOnly}
                    trackClassName="h-[3px] rounded-[2px] bg-[#F0F0F0]"
                    rangeClassName="bg-[#FFC677]"
                    thumbClassName="h-[10px] w-[10px] rounded-full border-2 border-[#FF9C34] bg-[#FF9C34] shadow-[0_0_0_2px_white] hover:shadow-[0_0_0_2px_white]"
                  />
                </div>
              </div>
            </div>
          ) : (
            <div className="text-sm text-text-muted text-center py-8">选择一个片段以编辑属性</div>
          ))}

        {/* Subtitle Tab */}
        {activeTab === 'subtitle' &&
          (() => {
            const subClip = clips[subtitleClipIndex] ?? null
            const subClipRegenerating = subClip
              ? (regeneratingSubtitleStoryboardIds?.has(subClip.storyboard_id) ?? false) ||
                subtitles.some(s => s.storyboard_id === subClip.storyboard_id && s.regenerating)
              : false
            return (
              <div className="space-y-4">
                {/* Header: 字幕 + refresh + toggle */}
                <div className="flex items-center justify-between h-[42px]">
                  <label
                    className="leading-none"
                    style={{
                      fontSize: '13px',
                      fontWeight: 500,
                      color: '#333333',
                      fontFamily: "'PingFang SC', -apple-system, sans-serif",
                    }}
                  >
                    字幕
                  </label>
                  <div className="flex items-center gap-4">
                    {!readOnly && subClip && (
                      <button
                        className="w-5 h-5 flex items-center justify-center text-text-muted hover:text-[#FF8200] transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex-shrink-0"
                        onClick={() => onSubtitleRegenerate?.(subClip.storyboard_id)}
                        disabled={subClipRegenerating}
                        title="重新生成字幕"
                      >
                        {subClipRegenerating ? (
                          <Loader2 className="w-5 h-5 animate-spin" />
                        ) : (
                          <RotateCw className="w-5 h-5" />
                        )}
                      </button>
                    )}
                    <Switch
                      checked={subtitlesVisible}
                      onCheckedChange={onSubtitlesVisibilityChange}
                      className="data-[state=checked]:bg-[#FF8200] focus-visible:ring-[#FF8200]"
                    />
                  </div>
                </div>

                {/* Clip selector */}
                {clips.length > 0 && (
                  <div
                    data-inspector-card
                    className="flex items-center h-9 rounded-[6px] border border-border bg-white px-4"
                  >
                    <Select
                      value={String(subtitleClipIndex)}
                      onValueChange={val => onSubtitleClipChange(Number(val))}
                    >
                      <SelectTrigger
                        className="flex-1 h-5 text-sm font-normal border-0 shadow-none bg-transparent px-0 hover:bg-transparent focus:ring-0 [&>svg]:opacity-100"
                        style={{ fontFamily: "'PingFang SC', -apple-system, sans-serif" }}
                      >
                        <SelectValue placeholder="选择分镜" />
                      </SelectTrigger>
                      <SelectContent className="z-[2147483641]">
                        {clips.map((c, i) => (
                          <SelectItem key={c.clip_id} value={String(i)}>
                            分镜{i + 1}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}

                {subClip ? (
                  (() => {
                    const clipSubtitles = subtitles.filter(
                      sub => sub.storyboard_id === subClip.storyboard_id
                    )
                    return clipSubtitles.length === 0 ? (
                      <p className="text-xs text-text-muted">该片段暂无字幕</p>
                    ) : (
                      <div className="space-y-3">
                        {clipSubtitles.map((sub, _idx) => (
                          <div
                            key={sub.id}
                            ref={node => {
                              if (node) subtitleItemRefs.current.set(sub.id, node)
                              else subtitleItemRefs.current.delete(sub.id)
                            }}
                            data-inspector-card
                            className={`relative rounded-[6px] border p-3 transition-colors cursor-pointer ${
                              selectedSubtitleId === sub.id
                                ? 'bg-surface border-[#FF8200] ring-1 ring-[#FF8200]'
                                : 'bg-surface border-[#FBFBFB]'
                            } ${sub.regenerating ? 'opacity-60' : ''}`}
                            onClick={e => {
                              if (
                                e.target === e.currentTarget ||
                                (e.target as HTMLElement).tagName === 'DIV'
                              ) {
                                onSubtitleFocus?.(sub.id)
                              }
                            }}
                          >
                            {sub.regenerating && (
                              <div className="absolute inset-0 z-10 flex flex-col items-center justify-center rounded-[6px] bg-white/80 backdrop-blur-[1px]">
                                <Loader2 className="w-5 h-5 text-[#FF8200] animate-spin" />
                                <span className="mt-1 text-[10px] text-text-secondary">
                                  重新生成中...
                                </span>
                              </div>
                            )}

                            {/* Time inputs + delete button in one row */}
                            <div className="flex items-center gap-2 mb-3">
                              <TimeInput
                                label="开始"
                                value={sub.clip_local_start}
                                onCommit={seconds => {
                                  const newLocalStart = Math.max(0, seconds)
                                  const delta = newLocalStart - sub.clip_local_start
                                  const updatedSub = {
                                    ...sub,
                                    clip_local_start: newLocalStart,
                                    start: sub.start + delta,
                                  }
                                  const overlapId = validateSubtitleNoOverlap(
                                    subtitles.map(s => (s.id === sub.id ? updatedSub : s)),
                                    sub.id
                                  )
                                  if (overlapId) {
                                    alert('字幕时间不能重叠')
                                    return
                                  }
                                  onSubtitleChange(sub.id, {
                                    clip_local_start: newLocalStart,
                                    start: sub.start + delta,
                                  })
                                  onSubtitleFocus?.(sub.id)
                                }}
                                onFocus={() => onSubtitleFocus?.(sub.id)}
                                disabled={readOnly || sub.regenerating}
                              />
                              <span className="text-text-muted flex-shrink-0">—</span>
                              <TimeInput
                                label="结束"
                                value={sub.clip_local_end}
                                onCommit={seconds => {
                                  const newLocalEnd = Math.max(0, seconds)
                                  const delta = newLocalEnd - sub.clip_local_end
                                  const updatedSub = {
                                    ...sub,
                                    clip_local_end: newLocalEnd,
                                    end: sub.end + delta,
                                  }
                                  const overlapId = validateSubtitleNoOverlap(
                                    subtitles.map(s => (s.id === sub.id ? updatedSub : s)),
                                    sub.id
                                  )
                                  if (overlapId) {
                                    alert('字幕时间不能重叠')
                                    return
                                  }
                                  onSubtitleChange(sub.id, {
                                    clip_local_end: newLocalEnd,
                                    end: sub.end + delta,
                                  })
                                  onSubtitleFocus?.(sub.id)
                                }}
                                onFocus={() => onSubtitleFocus?.(sub.id)}
                                disabled={readOnly || sub.regenerating}
                              />
                              {!readOnly && (
                                <button
                                  className="flex-shrink-0 flex items-center justify-center w-6 h-6 transition-opacity hover:opacity-70 disabled:opacity-30"
                                  style={{ color: '#939393' }}
                                  title="删除"
                                  onClick={() => onSubtitleDelete(sub.id)}
                                  disabled={sub.regenerating}
                                >
                                  <Trash2 className="w-4 h-4" />
                                </button>
                              )}
                            </div>

                            {/* 画面描述 label + subtitle text */}
                            <label
                              className="block text-[10px] text-text-muted mb-1"
                              style={{ fontFamily: "'PingFang SC', -apple-system, sans-serif" }}
                            >
                              字幕
                            </label>
                            <Textarea
                              value={sub.text}
                              onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
                                onSubtitleChange(sub.id, { text: e.target.value })
                              }
                              onFocus={() => onSubtitleFocus?.(sub.id)}
                              placeholder="字幕文本"
                              className="min-h-[48px] text-xs border-0 bg-transparent resize-none px-0 py-1 transition-all outline-none ring-0 focus:outline-none focus:ring-0 focus-visible:outline-none focus-visible:ring-0 focus-visible:border-transparent"
                              style={{
                                fontFamily: "'PingFang SC', -apple-system, sans-serif",
                                fontSize: '13px',
                                color: '#333333',
                              }}
                              disabled={readOnly || sub.regenerating}
                            />
                          </div>
                        ))}
                      </div>
                    )
                  })()
                ) : (
                  <p className="text-xs text-text-muted">选择片段后可编辑字幕</p>
                )}

                {/* Add subtitle button */}
                {!readOnly && subClip && (
                  <button
                    className="flex items-center justify-center gap-1 w-full text-sm min-h-[40px] rounded-[6px] transition-opacity hover:opacity-80"
                    style={{
                      backgroundColor: '#FFF7F0',
                      border: '1px dashed rgba(255, 132, 0, 0.25)',
                      color: '#FF8400',
                      fontFamily: "'PingFang SC', -apple-system, sans-serif",
                      paddingTop: '10px',
                      paddingBottom: '10px',
                    }}
                    onClick={onSubtitleAdd}
                  >
                    + 添加字幕
                  </button>
                )}
              </div>
            )
          })()}

        {/* BGM Tab */}
        {activeTab === 'bgm' && (
          <div className="space-y-4">
            {/* Header */}
            <div className="flex items-center justify-between h-[42px]">
              <label
                className="leading-none"
                style={{
                  fontSize: '13px',
                  fontWeight: 500,
                  color: '#333333',
                  fontFamily: "'PingFang SC', -apple-system, sans-serif",
                }}
              >
                背景音乐
              </label>
              <Switch
                checked={bgmEnabled}
                onCheckedChange={(checked: boolean) => onBgmEnabledChange?.(checked)}
                className="data-[state=checked]:bg-[#FF8200] focus-visible:ring-[#FF8200]"
              />
            </div>

            {bgm && bgm.length > 0 ? (
              <div className="space-y-4">
                {bgm.map(segment => {
                  const overlapIdx = validateBgmNoOverlap(bgm, segment.idx)
                  const hasOverlap = overlapIdx !== null
                  return (
                    <div
                      key={segment.idx}
                      ref={el => {
                        if (el) bgmItemRefs.current.set(segment.idx, el)
                        else bgmItemRefs.current.delete(segment.idx)
                      }}
                      data-inspector-card
                      className={`relative rounded-[6px] border p-3 cursor-pointer transition-colors ${
                        selectedBgmIdx === segment.idx
                          ? 'bg-surface border-[#FF8200] ring-1 ring-[#FF8200]'
                          : 'bg-surface border-[#FBFBFB]'
                      } ${segment.status === 'pending' ? 'opacity-60' : ''}`}
                      onClick={e => {
                        if (
                          e.target === e.currentTarget ||
                          (e.target as HTMLElement).tagName === 'DIV'
                        ) {
                          onBgmFocus?.(segment.idx)
                        }
                      }}
                    >
                      {segment.status === 'pending' && (
                        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center rounded-[6px] bg-white/80 backdrop-blur-[1px]">
                          <Loader2 className="w-6 h-6 text-[#FF8200] animate-spin" />
                          <span className="mt-1.5 text-xs text-text-secondary">生成中...</span>
                        </div>
                      )}

                      {/* Time inputs + actions row */}
                      <div className="flex items-center gap-2 mb-3">
                        {/* Play/Pause preview - left of time inputs */}
                        {segment.status === 'success' && segment.audio_url ? (
                          <button
                            className="flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center transition-opacity hover:opacity-80"
                            style={{ backgroundColor: 'rgba(255,130,0,0.08)', color: '#FF8200' }}
                            onClick={() => handlePreviewBgm(segment)}
                            title={previewingIdx === segment.idx ? '暂停试听' : '试听'}
                          >
                            {previewingIdx === segment.idx ? (
                              <Pause className="w-3 h-3" fill="currentColor" />
                            ) : (
                              <Play className="w-3 h-3" fill="currentColor" />
                            )}
                          </button>
                        ) : (
                          <div
                            className="flex-shrink-0 w-6 h-6 rounded-full"
                            style={{ backgroundColor: 'rgba(255,130,0,0.08)' }}
                          />
                        )}
                        <TimeInput
                          label="开始"
                          value={segment.start_time}
                          onCommit={seconds => {
                            const newStart = Math.max(0, seconds)
                            const updatedSegment = { ...segment, start_time: newStart }
                            const overlapIdx = validateBgmNoOverlap(
                              bgm!.map(s => (s.idx === segment.idx ? updatedSegment : s)),
                              segment.idx
                            )
                            if (overlapIdx !== null) {
                              alert('背景音乐时间不能重叠')
                              return
                            }
                            onBgmTimeChange?.(segment.idx, 'start_time', newStart)
                            onBgmFocus?.(segment.idx)
                          }}
                          onFocus={() => onBgmFocus?.(segment.idx)}
                          disabled={readOnly}
                        />
                        <span className="text-text-muted flex-shrink-0">—</span>
                        <TimeInput
                          label="结束"
                          value={segment.end_time}
                          onCommit={seconds => {
                            const newEnd = Math.max(0, seconds)
                            const updatedSegment = { ...segment, end_time: newEnd }
                            const overlapIdx = validateBgmNoOverlap(
                              bgm!.map(s => (s.idx === segment.idx ? updatedSegment : s)),
                              segment.idx
                            )
                            if (overlapIdx !== null) {
                              alert('背景音乐时间不能重叠')
                              return
                            }
                            onBgmTimeChange?.(segment.idx, 'end_time', newEnd)
                            onBgmFocus?.(segment.idx)
                          }}
                          onFocus={() => onBgmFocus?.(segment.idx)}
                          disabled={readOnly}
                        />
                        {!readOnly && (
                          <>
                            <button
                              className="flex-shrink-0 w-5 h-5 flex items-center justify-center text-text-muted hover:text-[#FF8200] transition-colors"
                              onClick={() => onBgmRegenerate?.(segment.idx)}
                              title="重新生成"
                            >
                              <RotateCw className="w-5 h-5" />
                            </button>
                            <button
                              className="flex-shrink-0 flex items-center justify-center w-5 h-5 transition-opacity hover:opacity-70"
                              style={{ color: '#939393' }}
                              title="删除"
                              onClick={() => onBgmDelete?.(segment.idx)}
                            >
                              <Trash2 className="w-5 h-5" />
                            </button>
                          </>
                        )}
                      </div>

                      {/* Volume slider - between time inputs and prompt */}
                      {segment.status === 'success' && (
                        <div className="h-[42px] flex flex-col justify-between mb-4">
                          <div className="flex items-center justify-between">
                            <label
                              className="leading-none"
                              style={{
                                fontSize: '13px',
                                fontFamily: "'PingFang SC', -apple-system, sans-serif",
                                color: '#333333',
                              }}
                            >
                              音量
                            </label>
                            <span
                              className="flex items-center justify-center h-5 min-w-[34px] px-1.5 rounded-[3px] bg-[#E6E6E6] text-text-primary"
                              style={{
                                fontSize: '13px',
                                fontFamily: "'PingFang SC', -apple-system, sans-serif",
                              }}
                            >
                              {Math.round((segment.volume ?? 0.15) * 100)}%
                            </span>
                          </div>
                          <CompactSlider
                            value={[segment.volume ?? 0.15]}
                            onValueChange={(values: number[]) => {
                              onBgmVolumeChange?.(segment.idx, values[0])
                              onBgmFocus?.(segment.idx)
                            }}
                            min={0}
                            max={1}
                            step={0.05}
                            disabled={readOnly}
                            trackClassName="h-[3px] rounded-[2px] bg-[#F0F0F0]"
                            rangeClassName="bg-[#FFC677]"
                            thumbClassName="h-[10px] w-[10px] rounded-full border-2 border-[#FF9C34] bg-[#FF9C34] shadow-[0_0_0_2px_white] hover:shadow-[0_0_0_2px_white]"
                          />
                        </div>
                      )}

                      {/* Prompt */}
                      <label
                        className="block text-[10px] text-text-muted mb-1"
                        style={{ fontFamily: "'PingFang SC', -apple-system, sans-serif" }}
                      >
                        提示词
                      </label>
                      <Textarea
                        value={segment.prompt}
                        onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
                          onBgmPromptChange?.(segment.idx, e.target.value)
                        }
                        onFocus={() => onBgmFocus?.(segment.idx)}
                        placeholder="提示词"
                        className="min-h-[60px] text-xs border-0 bg-transparent resize-none px-0 py-1 transition-all outline-none ring-0 focus:outline-none focus:ring-0 focus-visible:outline-none focus-visible:ring-0 focus-visible:border-transparent"
                        style={{
                          fontFamily: "'PingFang SC', -apple-system, sans-serif",
                          fontSize: '13px',
                          lineHeight: '20px',
                          color: '#333333',
                        }}
                        disabled={readOnly}
                      />

                      {hasOverlap && (
                        <p className="text-[10px] text-destructive mt-1">
                          时间重叠：与片段 {overlapIdx} 冲突
                        </p>
                      )}

                      {segment.status === 'pending' && (
                        <span className="text-[10px] text-text-muted">生成中...</span>
                      )}
                      {segment.status === 'draft' && (
                        <span className="text-[10px] text-text-muted">
                          未生成，填写提示词后点击重新生成
                        </span>
                      )}
                    </div>
                  )
                })}
              </div>
            ) : (
              <p className="text-xs text-text-muted">暂无背景音乐片段</p>
            )}

            {/* Add BGM button */}
            {!readOnly && (
              <button
                className="flex items-center justify-center gap-1 w-full text-sm min-h-[40px] rounded-[6px] transition-opacity hover:opacity-80"
                style={{
                  backgroundColor: '#FFF7F0',
                  border: '1px dashed rgba(255, 132, 0, 0.25)',
                  color: '#FF8400',
                  fontFamily: "'PingFang SC', -apple-system, sans-serif",
                  paddingTop: '10px',
                  paddingBottom: '10px',
                }}
                onClick={onBgmAdd}
              >
                + 添加背景音乐
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
