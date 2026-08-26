// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Composition utility functions - 剪辑工作台纯函数
 */

import type { Storyboard } from '../storyboard/types'
import type { CompositionClip, CompositionSubtitle, CompositionBgm } from './types'

export const DEFAULT_STORYBOARD_DURATION = 15

/**
 * Format seconds to SRT timestamp "HH:MM:SS,mmm".
 */
function formatSrtTime(seconds: number): string {
  const hrs = Math.floor(seconds / 3600)
  const mins = Math.floor((seconds % 3600) / 60)
  const secs = Math.floor(seconds % 60)
  const ms = Math.floor((seconds % 1) * 1000)
  return `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')},${ms.toString().padStart(3, '0')}`
}

/**
 * Build a standard SRT string from CompositionSubtitle entries.
 * Outputs SRT using clip-local times directly. Only enabled subtitles are
 * included, sorted by clip-local start time.
 */
export function buildSrt(subtitles: CompositionSubtitle[]): string {
  const enabled = subtitles
    .filter(s => s.enabled)
    .sort((a, b) => a.clip_local_start - b.clip_local_start)
  return enabled
    .map((sub, i) => {
      const start = formatSrtTime(sub.clip_local_start)
      const end = formatSrtTime(sub.clip_local_end)
      return `${i + 1}\n${start} --> ${end}\n${sub.text}`
    })
    .join('\n\n')
}

/**
 * Parse an SRT timestamp "HH:MM:SS,mmm" to seconds.
 */
function parseSrtTime(timestamp: string): number {
  const [time, millis] = timestamp.trim().split(',')
  const [hours, minutes, seconds] = time.split(':').map(Number)
  return hours * 3600 + minutes * 60 + seconds + Number(millis) / 1000
}

/**
 * Parse an SRT string into an array of structured subtitle blocks.
 * Each block: { index, start (seconds), end (seconds), text, raw }
 */
export function parseSrt(srtText: string): {
  index: number
  start: number
  end: number
  text: string
  raw: string
}[] {
  const blocks = srtText.trim().replace(/\r\n/g, '\n').split(/\n\n+/)
  const results: { index: number; start: number; end: number; text: string; raw: string }[] = []

  for (const block of blocks) {
    const lines = block.split('\n')
    if (lines.length < 3) continue

    const index = parseInt(lines[0], 10)
    if (Number.isNaN(index)) continue

    const timeMatch = lines[1].match(/(\d{2}:\d{2}:\d{2},\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2},\d{3})/)
    if (!timeMatch) continue

    const start = parseSrtTime(timeMatch[1])
    const end = parseSrtTime(timeMatch[2])
    const text = lines.slice(2).join('\n')

    results.push({ index, start, end, text, raw: block.trim() })
  }

  return results
}

/**
 * Build CompositionSubtitle[] from an SRT string for a given storyboard.
 * SRT timestamps are used directly as clip-local times.
 * Global start/end are computed for timeline positioning.
 */
export function buildSubtitlesFromSrt(
  srtText: string,
  storyboardId: number,
  globalOffset: number
): CompositionSubtitle[] {
  const blocks = parseSrt(srtText)
  if (blocks.length === 0) return []

  return blocks.map(block => ({
    id: `sub-${storyboardId}-${block.index}`,
    storyboard_id: storyboardId,
    start: globalOffset + block.start,
    end: globalOffset + block.end,
    clip_local_start: block.start,
    clip_local_end: block.end,
    text: block.text,
    enabled: true,
    srt_raw: block.raw,
  }))
}

function normalizeDurationSeconds(duration?: number | null): number | null {
  if (!duration || duration <= 0) return null
  // Some backend media metadata paths store milliseconds.
  return duration > 1000 ? duration / 1000 : duration
}

/**
 * Get the effective video version for a storyboard.
 * Mirrors the selection logic from StoryboardPanel: prefer
 * selectedClipId > is_selected > first version, falling back to video_clip.
 */
function getEffectiveVideoClip(storyboard: Storyboard, selectedClipId?: number | null) {
  const versions = storyboard.video_versions ?? []
  if (versions.length === 0) return storyboard.video_clip

  const targetId = selectedClipId ?? storyboard.selected_video_clip_id
  if (targetId != null) {
    const matched = versions.find(v => v.id === targetId)
    if (matched) return matched
  }

  const selected = versions.find(v => v.is_selected) ?? versions[0]
  return selected ?? storyboard.video_clip
}

export function getStoryboardSourceDuration(
  storyboard: Storyboard,
  selectedClipId?: number | null
): number {
  const clip = getEffectiveVideoClip(storyboard, selectedClipId)
  return (
    normalizeDurationSeconds(clip?.duration) ??
    normalizeDurationSeconds(storyboard.duration_seconds) ??
    normalizeDurationSeconds(storyboard.voiceover?.duration_seconds) ??
    DEFAULT_STORYBOARD_DURATION
  )
}

/**
 * Build default CompositionClip list from storyboards.
 * Sorted by sequence_number. Uses trim_start/trim_end from the video version
 * if available (e.g. for clipped videos), otherwise defaults to 0/null.
 */
export function buildDefaultClips(
  storyboards: Storyboard[],
  selectedVersionMap: Record<number, number>
): CompositionClip[] {
  const sorted = [...storyboards].sort((a, b) => a.sequence_number - b.sequence_number)

  return sorted.map((sb, index) => {
    const clip = getEffectiveVideoClip(sb, selectedVersionMap[sb.id])
    const version = clip as import('../storyboard/types').StoryboardVideoVersion | null
    // Backend may return trim_end: 0 to mean "use original end"; normalize to null.
    const rawTrimEnd = version?.trim_end ?? null
    return {
      storyboard_id: sb.id,
      clip_id: clip?.id ?? 0,
      order: index,
      source_duration: getStoryboardSourceDuration(sb, selectedVersionMap[sb.id]),
      trim_start: version?.trim_start ?? 0,
      trim_end: rawTrimEnd && rawTrimEnd > 0 ? rawTrimEnd : null,
      volume: version?.volume ?? 1,
      enabled: version?.enabled ?? true,
    }
  })
}

/**
 * Get the subtitle_srt for a specific clip_id from a storyboard.
 */
function getClipSubtitleSrt(storyboard: Storyboard, clipId: number): string | undefined {
  const versions = storyboard.video_versions ?? []
  const version = versions.find(v => v.id === clipId)
  if (version?.subtitle_srt) return version.subtitle_srt
  if (storyboard.video_clip?.id === clipId) return storyboard.video_clip.subtitle_srt
  return undefined
}

/**
 * Build default CompositionSubtitle list from storyboards.
 * If the video clip has subtitle_srt, parses that into multiple subtitles.
 * Otherwise falls back to voiceover.text > dialogue as a single subtitle.
 */
export function buildDefaultSubtitles(
  storyboards: Storyboard[],
  clips: CompositionClip[],
  clipDurationMap: Record<number, number>
): CompositionSubtitle[] {
  const storyboardMap = new Map(storyboards.map(sb => [sb.id, sb]))
  const subtitles: CompositionSubtitle[] = []
  let globalTime = 0

  for (const clip of clips) {
    if (!clip.enabled) continue

    const sb = storyboardMap.get(clip.storyboard_id)
    if (!sb) continue

    const effectiveDuration = getClipTimelineDuration(clip, clipDurationMap)

    // Prefer SRT subtitles from the video clip if available
    const srtText = getClipSubtitleSrt(sb, clip.clip_id)
    if (srtText?.trim()) {
      const srtSubs = buildSubtitlesFromSrt(srtText, sb.id, globalTime)
      subtitles.push(...srtSubs)
    } else {
      // Fallback: voiceover.text > dialogue as a single subtitle
      const text = sb.voiceover?.text?.trim() || sb.dialogue?.trim() || ''
      if (text) {
        subtitles.push({
          id: `sub-${sb.id}`,
          storyboard_id: sb.id,
          start: globalTime,
          end: globalTime + effectiveDuration,
          clip_local_start: 0,
          clip_local_end: effectiveDuration,
          text,
          enabled: true,
        })
      }
    }

    globalTime += effectiveDuration
  }

  return subtitles
}

/**
 * Get the effective duration of a clip after trimming.
 */
export function getClipEffectiveDuration(clip: CompositionClip, originalDuration: number): number {
  const end = clip.trim_end ?? originalDuration
  return Math.max(0, end - clip.trim_start)
}

/**
 * Resolve clip source duration. Timeline elements own their source duration,
 * mirroring OpenCut's element duration model.
 */
export function getClipSourceDuration(
  clip: CompositionClip,
  clipDurationMap: Record<number, number>
): number {
  return (
    normalizeDurationSeconds(clip.source_duration) ??
    normalizeDurationSeconds(clipDurationMap[clip.clip_id]) ??
    DEFAULT_STORYBOARD_DURATION
  )
}

/**
 * Get clip duration on the composition timeline after fallback and trimming.
 */
export function getClipTimelineDuration(
  clip: CompositionClip,
  clipDurationMap: Record<number, number>
): number {
  return getClipEffectiveDuration(clip, getClipSourceDuration(clip, clipDurationMap))
}

/**
 * Compute the total duration of all enabled clips on the timeline.
 */
export function computeTotalTimelineDuration(
  clips: CompositionClip[],
  clipDurationMap: Record<number, number>
): number {
  return clips
    .filter(c => c.enabled)
    .reduce((sum, clip) => sum + getClipTimelineDuration(clip, clipDurationMap), 0)
}

/**
 * Get the global start time for a clip index on the enabled timeline.
 */
export function getClipGlobalStartTime(
  clipIndex: number,
  clips: CompositionClip[],
  clipDurationMap: Record<number, number>
): number {
  return clips.slice(0, clipIndex).reduce((sum, clip) => {
    if (!clip.enabled) return sum
    return sum + getClipTimelineDuration(clip, clipDurationMap)
  }, 0)
}

/**
 * Get the global time range for a clip index on the enabled timeline.
 */
export function getClipGlobalTimeRange(
  clipIndex: number,
  clips: CompositionClip[],
  clipDurationMap: Record<number, number>
): { start: number; end: number } {
  const clip = clips[clipIndex]
  const start = getClipGlobalStartTime(clipIndex, clips, clipDurationMap)
  const duration = clip ? getClipTimelineDuration(clip, clipDurationMap) : 0

  return { start, end: start + duration }
}

/**
 * Validate clip trim values.
 * Returns true if valid.
 */
export function validateTrim(clip: CompositionClip, originalDuration: number): boolean {
  if (clip.trim_start < 0) return false
  if (clip.trim_end !== null && clip.trim_end <= clip.trim_start) return false
  const effective = getClipEffectiveDuration(clip, originalDuration)
  if (effective < 0.5) return false
  return true
}

/**
 * Format seconds to MM:SS.ms display string.
 */
export function formatTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return '00:00.00'
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  const hundredths = Math.floor((seconds % 1) * 100)
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}.${hundredths.toString().padStart(2, '0')}`
}

/**
 * Check if two BGM segments overlap in time.
 */
export function bgmSegmentsOverlap(a: CompositionBgm, b: CompositionBgm): boolean {
  return a.start_time < b.end_time && b.start_time < a.end_time
}

/**
 * Validate that a BGM segment does not overlap with any other segment.
 * Returns the idx of the first overlapping segment, or null if valid.
 */
export function validateBgmNoOverlap(segments: CompositionBgm[], targetIdx: number): number | null {
  const target = segments.find(s => s.idx === targetIdx)
  if (!target) return null

  for (const other of segments) {
    if (other.idx === targetIdx) continue
    if (bgmSegmentsOverlap(target, other)) {
      return other.idx
    }
  }
  return null
}

/**
 * Check if two subtitle segments overlap in clip-local time.
 */
export function subtitleSegmentsOverlap(a: CompositionSubtitle, b: CompositionSubtitle): boolean {
  return a.clip_local_start < b.clip_local_end && b.clip_local_start < a.clip_local_end
}

/**
 * Validate that a subtitle does not overlap with any other subtitle in the same clip.
 * Returns the id of the first overlapping subtitle, or null if valid.
 */
export function validateSubtitleNoOverlap(
  subtitles: CompositionSubtitle[],
  targetId: string
): string | null {
  const target = subtitles.find(s => s.id === targetId)
  if (!target) return null

  for (const other of subtitles) {
    if (other.id === targetId) continue
    if (other.storyboard_id !== target.storyboard_id) continue
    if (subtitleSegmentsOverlap(target, other)) {
      return other.id
    }
  }
  return null
}

/**
 * Generate a new unique idx for BGM segments.
 */
export function getNextBgmIdx(segments: CompositionBgm[]): number {
  return segments.length > 0 ? Math.max(...segments.map(s => s.idx)) + 1 : 0
}

// --- BGM task localStorage cache ---
// Persists in-flight BGM generation task_uuid to localStorage so that
// polling can be resumed if the user navigates away and comes back.

const BGM_TASK_CACHE_PREFIX = 'wegent_bgm_task_'

interface BgmTaskCache {
  task_uuid: string
  idx: number
}

/**
 * Save a BGM generation task to localStorage.
 */
export function saveBgmTask(scriptId: number, idx: number, taskUuid: string): void {
  try {
    const key = `${BGM_TASK_CACHE_PREFIX}${scriptId}_${idx}`
    const data: BgmTaskCache = { task_uuid: taskUuid, idx }
    localStorage.setItem(key, JSON.stringify(data))
  } catch {
    // Ignore storage errors (quota, private browsing, etc.)
  }
}

/**
 * Remove a BGM generation task from localStorage.
 */
export function removeBgmTask(scriptId: number, idx: number): void {
  try {
    const key = `${BGM_TASK_CACHE_PREFIX}${scriptId}_${idx}`
    localStorage.removeItem(key)
  } catch {
    // Ignore
  }
}

/**
 * Load all pending BGM generation tasks for a given script from localStorage.
 */
export function loadBgmTasks(scriptId: number): BgmTaskCache[] {
  try {
    const prefix = `${BGM_TASK_CACHE_PREFIX}${scriptId}_`
    const tasks: BgmTaskCache[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (!key || !key.startsWith(prefix)) continue
      const raw = localStorage.getItem(key)
      if (!raw) continue
      try {
        const data: BgmTaskCache = JSON.parse(raw)
        if (!data.task_uuid || !Number.isInteger(data.idx)) {
          localStorage.removeItem(key)
          continue
        }
        tasks.push(data)
      } catch {
        localStorage.removeItem(key)
      }
    }
    return tasks
  } catch {
    return []
  }
}

// --- Subtitle task localStorage cache ---
// Same pattern as BGM task cache — persists in-flight subtitle regeneration
// task_uuid to localStorage so polling can resume after page navigation.

const SUB_TASK_CACHE_PREFIX = 'wegent_sub_task_'

interface SubTaskCache {
  task_uuid: string
  storyboard_id: number
  clip_id: number
}

export function saveSubTask(
  scriptId: number,
  storyboardId: number,
  clipId: number,
  taskUuid: string
): void {
  try {
    const key = `${SUB_TASK_CACHE_PREFIX}${scriptId}_${storyboardId}`
    const data: SubTaskCache = { task_uuid: taskUuid, storyboard_id: storyboardId, clip_id: clipId }
    localStorage.setItem(key, JSON.stringify(data))
  } catch {
    // Ignore storage errors
  }
}

export function removeSubTask(scriptId: number, storyboardId: number): void {
  try {
    const key = `${SUB_TASK_CACHE_PREFIX}${scriptId}_${storyboardId}`
    localStorage.removeItem(key)
  } catch {
    // Ignore
  }
}

export function loadSubTasks(scriptId: number): SubTaskCache[] {
  try {
    const prefix = `${SUB_TASK_CACHE_PREFIX}${scriptId}_`
    const tasks: SubTaskCache[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (!key || !key.startsWith(prefix)) continue
      const raw = localStorage.getItem(key)
      if (!raw) continue
      try {
        const data: SubTaskCache = JSON.parse(raw)
        if (
          !data.task_uuid ||
          !Number.isInteger(data.storyboard_id) ||
          !Number.isInteger(data.clip_id)
        ) {
          localStorage.removeItem(key)
          continue
        }
        tasks.push(data)
      } catch {
        localStorage.removeItem(key)
      }
    }
    return tasks
  } catch {
    return []
  }
}

/**
 * Find which clip and local time a global time corresponds to.
 * Returns { clipIndex, localTime } or null if out of range.
 */
export function globalTimeToClipTime(
  globalTime: number,
  clips: CompositionClip[],
  clipDurationMap: Record<number, number>
): { clipIndex: number; localTime: number } | null {
  let accumulated = 0

  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i]
    if (!clip.enabled) continue

    const duration = getClipTimelineDuration(clip, clipDurationMap)
    if (globalTime < accumulated + duration) {
      const localTime = clip.trim_start + (globalTime - accumulated)
      return { clipIndex: i, localTime }
    }
    accumulated += duration
  }

  return null
}
