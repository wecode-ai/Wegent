// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { Storyboard, StoryboardVideoVersion, VideoClip } from '../storyboard/types'
import type { CompositionClip, CompositionSubtitle } from './types'

export function selectedVideo(
  storyboard: Storyboard,
  selectedClipId?: number
): StoryboardVideoVersion | VideoClip | null {
  const versions = storyboard.video_versions ?? []
  if (selectedClipId) {
    const selected = versions.find(version => version.id === selectedClipId)
    if (selected) return selected
  }
  return (
    versions.find(version => version.id === storyboard.selected_video_clip_id) ??
    versions.find(version => version.is_selected) ??
    versions.find(version => version.generation_status === 3) ??
    storyboard.video_clip
  )
}

export function buildClips(
  storyboards: Storyboard[],
  selectedVersions: Record<number, number>
): CompositionClip[] {
  return storyboards.flatMap((storyboard, order) => {
    const video = selectedVideo(storyboard, selectedVersions[storyboard.id])
    if (!video || video.generation_status !== 3 || !video.model_video_url) return []
    const sourceDuration = Math.max(video.duration || storyboard.duration_seconds || 1, 0.1)
    const version = 'version_no' in video ? video : null
    return [
      {
        storyboard_id: storyboard.id,
        clip_id: video.id,
        order,
        source_duration: sourceDuration,
        trim_start: Math.max(version?.trim_start ?? 0, 0),
        trim_end: version?.trim_end ?? null,
        volume: video.volume ?? 1,
        enabled: version?.enabled ?? true,
        video_url: video.model_video_url,
        cover_url: video.video_cover_url || storyboard.image_urls[0] || '',
        title: `#${storyboard.sequence_number + 1}`,
      },
    ]
  })
}

function parseTimestamp(value: string): number {
  const [hours, minutes, secondsAndMilliseconds] = value.replace('.', ',').split(':')
  const [seconds, milliseconds = '0'] = (secondsAndMilliseconds || '0').split(',')
  return (
    Number(hours || 0) * 3600 +
    Number(minutes || 0) * 60 +
    Number(seconds || 0) +
    Number(milliseconds.padEnd(3, '0').slice(0, 3)) / 1000
  )
}

function formatTimestamp(value: number): string {
  const safe = Math.max(0, value)
  const hours = Math.floor(safe / 3600)
  const minutes = Math.floor((safe % 3600) / 60)
  const seconds = Math.floor(safe % 60)
  const milliseconds = Math.round((safe - Math.floor(safe)) * 1000)
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')},${String(milliseconds).padStart(3, '0')}`
}

export function parseSrt(
  srt: string | undefined,
  storyboardId: number,
  globalOffset: number
): CompositionSubtitle[] {
  if (!srt?.trim()) return []
  return srt
    .trim()
    .split(/\r?\n\r?\n+/)
    .flatMap((block, index) => {
      const lines = block.trim().split(/\r?\n/)
      const timingIndex = lines.findIndex(line => line.includes('-->'))
      if (timingIndex < 0) return []
      const [startText, endText] = lines[timingIndex].split('-->').map(value => value.trim())
      const localStart = parseTimestamp(startText)
      const localEnd = parseTimestamp(endText)
      return [
        {
          id: `${storyboardId}-${index}-${localStart}`,
          storyboard_id: storyboardId,
          start: globalOffset + localStart,
          end: globalOffset + localEnd,
          clip_local_start: localStart,
          clip_local_end: localEnd,
          text: lines.slice(timingIndex + 1).join('\n'),
          enabled: true,
        },
      ]
    })
}

export function buildSubtitles(
  storyboards: Storyboard[],
  clips: CompositionClip[]
): CompositionSubtitle[] {
  let offset = 0
  return clips.flatMap(clip => {
    const storyboard = storyboards.find(item => item.id === clip.storyboard_id)
    const source = selectedVideo(storyboard!, clip.clip_id)
    const subtitles = parseSrt(source?.subtitle_srt, clip.storyboard_id, offset)
    offset += clip.trim_end != null ? clip.trim_end - clip.trim_start : clip.source_duration
    return subtitles
  })
}

export function buildSrt(subtitles: CompositionSubtitle[]): string {
  return subtitles
    .filter(subtitle => subtitle.enabled && subtitle.text.trim())
    .sort((a, b) => a.clip_local_start - b.clip_local_start)
    .map(
      (subtitle, index) =>
        `${index + 1}\n${formatTimestamp(subtitle.clip_local_start)} --> ${formatTimestamp(subtitle.clip_local_end)}\n${subtitle.text.trim()}`
    )
    .join('\n\n')
}

export function effectiveDuration(clip: CompositionClip): number {
  return Math.max((clip.trim_end ?? clip.source_duration) - clip.trim_start, 0)
}

const BGM_TASK_CACHE_PREFIX = 'wegent_bgm_task_'
const SUBTITLE_TASK_CACHE_PREFIX = 'wegent_sub_task_'

export interface BgmTaskCache {
  task_uuid: string
  idx: number
  prompt: string
  duration: number
}

export interface SubtitleTaskCache {
  task_uuid: string
  storyboard_id: number
  clip_id: number
}

function getStorageKeys(prefix: string): string[] {
  try {
    return Array.from({ length: window.localStorage.length }, (_, index) =>
      window.localStorage.key(index)
    ).filter((key): key is string => Boolean(key?.startsWith(prefix)))
  } catch {
    return []
  }
}

export function saveBgmTask(scriptId: number, task: BgmTaskCache): void {
  try {
    const key = `${BGM_TASK_CACHE_PREFIX}${scriptId}_${task.idx}`
    window.localStorage.setItem(key, JSON.stringify(task))
  } catch {
    // Task recovery is best-effort when browser storage is unavailable.
  }
}

export function removeBgmTask(scriptId: number, idx: number): void {
  try {
    window.localStorage.removeItem(`${BGM_TASK_CACHE_PREFIX}${scriptId}_${idx}`)
  } catch {
    // Task recovery is best-effort when browser storage is unavailable.
  }
}

export function loadBgmTasks(scriptId: number): BgmTaskCache[] {
  const prefix = `${BGM_TASK_CACHE_PREFIX}${scriptId}_`
  return getStorageKeys(prefix).flatMap(key => {
    try {
      const value = JSON.parse(window.localStorage.getItem(key) || '') as BgmTaskCache
      if (
        !value.task_uuid ||
        !Number.isInteger(value.idx) ||
        typeof value.prompt !== 'string' ||
        !Number.isFinite(value.duration)
      ) {
        throw new Error('Invalid BGM task cache')
      }
      return [value]
    } catch {
      window.localStorage.removeItem(key)
      return []
    }
  })
}

export function saveSubtitleTask(scriptId: number, task: SubtitleTaskCache): void {
  try {
    const key = `${SUBTITLE_TASK_CACHE_PREFIX}${scriptId}_${task.storyboard_id}`
    window.localStorage.setItem(key, JSON.stringify(task))
  } catch {
    // Task recovery is best-effort when browser storage is unavailable.
  }
}

export function removeSubtitleTask(scriptId: number, storyboardId: number): void {
  try {
    window.localStorage.removeItem(`${SUBTITLE_TASK_CACHE_PREFIX}${scriptId}_${storyboardId}`)
  } catch {
    // Task recovery is best-effort when browser storage is unavailable.
  }
}

export function loadSubtitleTasks(scriptId: number): SubtitleTaskCache[] {
  const prefix = `${SUBTITLE_TASK_CACHE_PREFIX}${scriptId}_`
  return getStorageKeys(prefix).flatMap(key => {
    try {
      const value = JSON.parse(window.localStorage.getItem(key) || '') as SubtitleTaskCache
      if (
        !value.task_uuid ||
        !Number.isInteger(value.storyboard_id) ||
        !Number.isInteger(value.clip_id)
      ) {
        throw new Error('Invalid subtitle task cache')
      }
      return [value]
    } catch {
      window.localStorage.removeItem(key)
      return []
    }
  })
}
